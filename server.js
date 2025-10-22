// server.js (Node 18+, package.json: { "type": "module" })
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.set("trust proxy", true);

// health check
app.get("/", (_req, res) => res.status(200).send("ok"));

// Twilio webhook → 즉시 TwiML
app.post("/voice", (req, res) => {
  const host = req.headers.host;
  res.type("text/xml").status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio-media-stream"/>
  </Connect>
</Response>`);
});

// (옵션) 루프백 테스트용 웹훅
app.post("/voice-loopback", (req, res) => {
  const host = req.headers.host;
  res.type("text/xml").status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio-media-stream?mode=loopback"/>
  </Connect>
</Response>`);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`✅ listening on ${PORT}`);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (url.startsWith("/twilio-media-stream")) {
    console.log("[UPGRADE]", url);
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } else {
    console.log("[UPGRADE] rejected:", url);
    socket.destroy();
  }
});

wss.on("connection", (twilioWS, req) => {
  const isLoopback = (req.url || "").includes("mode=loopback");
  console.log("📞 [WS] Twilio connected", isLoopback ? "(loopback)" : "");

  if (isLoopback) {
    // 루프백: 들어온 오디오를 그대로 에코 → 이게 되면 Twilio↔서버 WS는 정상
    let sid = null;
    twilioWS.on("message", raw => {
      try {
        const evt = JSON.parse(raw.toString());
        if (evt.event === "start") { sid = evt.start?.streamSid; console.log("[Twilio] start:", sid); }
        if (evt.event === "media" && sid && twilioWS.readyState === WebSocket.OPEN) {
          twilioWS.send(JSON.stringify({ event: "media", streamSid: sid, media: { payload: evt.media.payload } }));
        }
      } catch (e) { console.error("[Loopback] parse error:", e.message); }
    });
    twilioWS.on("close", (c, r) => console.log("📴 [WS] Twilio closed (loopback):", c, r?.toString?.()));
    twilioWS.on("error", e => console.error("❌ [WS] Twilio error (loopback):", e.message));
    return;
  }

  // ===== OpenAI Realtime 연결 =====
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "OpenAI-Beta": "realtime=v1",
  };
  // AGENT_ID가 있을 때만 붙임 (Agent 문제가 원인이면 쉽게 분리)
  if (process.env.AGENT_ID) headers["OpenAI-Beta-Agent-Id"] = process.env.AGENT_ID;

  const openaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    { headers }
  );

  // keepalive (일부 환경에서 필요)
  const ka = setInterval(() => {
    try {
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: "ping" }));
      }
    } catch {}
  }, 10000);

  openaiWS.on("open", () => {
    console.log("🤖 [WS] OpenAI connected",
      process.env.AGENT_ID ? `(agent: ${process.env.AGENT_ID})` : "(no agent header)");

    // 세션 업데이트 + 첫 인사
    openaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        // Twilio <Stream>은 8kHz μ-law
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // Agent 헤더를 뺐다면 직접 지시문도 넣어둠 (fallback)
        instructions: process.env.AGENT_ID
          ? undefined
          : "Respond in Korean unless the caller speaks English. Keep the first greeting short."
      }
    }));
    // 통화 시작 즉시 말하게 트리거
    openaiWS.send(JSON.stringify({ type: "response.create" }));
  });

  let streamSid = null;
  let idleTimer = null;
  const IDLE_MS = 800;
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({ type: "response.create" }));
      }
    }, IDLE_MS);
  };

  // Twilio → OpenAI
  twilioWS.on("message", raw => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt.event === "start") {
        streamSid = evt.start?.streamSid;
        console.log("[Twilio] start:", streamSid);
        bumpIdle();
      } else if (evt.event === "media") {
        if (openaiWS.readyState === WebSocket.OPEN) {
          openaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: evt.media.payload }));
        }
        bumpIdle();
      } else if (evt.event === "stop") {
        console.log("[Twilio] stop");
        try {
          if (openaiWS.readyState === WebSocket.OPEN) {
            openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            openaiWS.send(JSON.stringify({ type: "response.create" }));
          }
        } finally {
          safeClose(openaiWS);
          safeClose(twilioWS);
        }
      }
    } catch (e) {
      console.error("[Twilio] message parse error:", e.message);
    }
  });

  // OpenAI → Twilio
  openaiWS.on("message", msg => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "output_audio_buffer.delta" && data.audio && streamSid) {
        if (twilioWS.readyState === WebSocket.OPEN) {
          twilioWS.send(JSON.stringify({ event: "media", streamSid: streamSid, media: { payload: data.audio } }));
        }
      }
    } catch (e) {
      console.error("[OpenAI] message parse error:", e.message);
    }
  });

  // 상세 로그(코드/이유)
  openaiWS.on("close", (code, reason) => {
    console.log("🧠 [WS] OpenAI closed:", code, reason?.toString?.());
    clearInterval(ka);
  });
  twilioWS.on("close", (code, reason) => {
    console.log("📴 [WS] Twilio closed:", code, reason?.toString?.());
  });
  openaiWS.on("error", e => console.error("❌ [WS] OpenAI error:", e.message));
  twilioWS.on("error", e => console.error("❌ [WS] Twilio error:", e.message));

  const safeClose = ws => { try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch {} };
});
