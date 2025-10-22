// server.js  (Node 18+, package.json: { "type": "module", "start": "node server.js" })
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.set("trust proxy", true);

// ───────────────────────────────────────────────────────────────
// 0) 헬스체크
// ───────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.status(200).send("ok"));

// ───────────────────────────────────────────────────────────────
// 1) Twilio webhook → 즉시 TwiML (양방향 오디오)
//    ※ track="both_tracks" 가 핵심: 듣기/말하기 둘 다 활성화
// ───────────────────────────────────────────────────────────────
app.post("/voice", (req, res) => {
  const host = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio-media-stream" track="both_tracks"/>
  </Connect>
</Response>`;
  res.type("text/xml").status(200).send(twiml);
});

// (옵션) 루프백 테스트용: 본인 목소리 에코 여부로 Twilio↔서버 WS 확인
app.post("/voice-loopback", (req, res) => {
  const host = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio-media-stream?mode=loopback" track="both_tracks"/>
  </Connect>
</Response>`;
  res.type("text/xml").status(200).send(twiml);
});

// ───────────────────────────────────────────────────────────────
// 2) WebSocket 업그레이드
// ───────────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────────
// 3) Twilio <-> OpenAI Realtime 브릿지
// ───────────────────────────────────────────────────────────────
wss.on("connection", (twilioWS, req) => {
  const isLoopback = (req.url || "").includes("mode=loopback");
  console.log("📞 [WS] Twilio connected", isLoopback ? "(loopback)" : "");

  // ── (A) 루프백 모드: Twilio ↔ 서버 WS 확인용 ──────────────────
  if (isLoopback) {
    let sid = null;
    twilioWS.on("message", raw => {
      try {
        const evt = JSON.parse(raw.toString());
        if (evt.event === "start") { sid = evt.start?.streamSid; console.log("[Twilio] start:", sid); }
        if (evt.event === "media" && sid && twilioWS.readyState === WebSocket.OPEN) {
          // 받은 오디오를 그대로 돌려보냄
          twilioWS.send(JSON.stringify({ event: "media", streamSid: sid, media: { payload: evt.media.payload } }));
        }
      } catch (e) { console.error("❌ [Loopback] parse:", e.message); }
    });
    twilioWS.on("close", (c, r) => console.log("📴 [WS] Twilio closed (loopback):", c, r?.toString?.()));
    twilioWS.on("error", e => console.error("❌ [WS] Twilio error (loopback):", e.message));
    return;
  }

  // ── (B) OpenAI Realtime 연결 ─────────────────────────────────
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "OpenAI-Beta": "realtime=v1",
  };
  if (process.env.AGENT_ID) headers["OpenAI-Beta-Agent-Id"] = process.env.AGENT_ID; // Agent에 Vector Store/File Search 붙어있으면 자동 활용

  const openaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    { headers }
  );

  // 간헐적 연결유지(일부 호스팅에서 필요)
  const keepAlive = setInterval(() => {
    try {
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: "ping" }));
      }
    } catch {}
  }, 10000);

  openaiWS.on("open", () => {
    console.log(
      "🤖 [WS] OpenAI connected",
      process.env.AGENT_ID ? `(agent: ${process.env.AGENT_ID})` : "(no agent header)"
    );

    // 세션 설정: 포맷은 Twilio와 동일(8kHz μ-law), 보이스는 Agent 설정 사용(VOICE로 덮어쓰기 가능)
    const session = {
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
    };
    if (process.env.VOICE) session.voice = process.env.VOICE; // 예: Marin / Amber / Alloy ...

    // Agent를 쓰지 않는 경우엔 지시문 기본값
    if (!process.env.AGENT_ID) {
      session.instructions = "Respond in Korean unless the caller speaks English. Keep the first greeting short.";
    }

    openaiWS.send(JSON.stringify({ type: "session.update", session }));

    // 연결 직후 첫 인사를 강제로 트리거 (AI가 가만히 있지 않도록)
    openaiWS.send(JSON.stringify({ type: "response.create" }));
  });

  // ── Twilio → OpenAI
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

  twilioWS.on("message", raw => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt.event === "start") {
        streamSid = evt.start?.streamSid;
        console.log("[Twilio] start:", streamSid);
        bumpIdle();
      } else if (evt.event === "media") {
        if (openaiWS.readyState === WebSocket.OPEN) {
          // Twilio base64(μ-law)를 그대로 전달 (세션 포맷 일치)
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
      console.error("❌ [Twilio] parse:", e.message);
    }
  });

  // ── OpenAI → Twilio
  openaiWS.on("message", msg => {
    try {
      const data = JSON.parse(msg.toString());

      // 모델이 음성 청크를 보낼 때
      if (data.type === "output_audio_buffer.delta" && data.audio && streamSid) {
        if (twilioWS.readyState === WebSocket.OPEN) {
          twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: data.audio } }));
        }
      }

      // 디버그 로그(말을 하고 있는지 확인)
      if (data.type === "response.output_text.delta" && data.delta) {
        console.log("📝 [AI delta]", data.delta);
      }
      if (data.type === "response.completed") {
        console.log("✅ [AI response completed]");
      }
    } catch (e) {
      console.error("❌ [OpenAI] parse:", e.message);
    }
  });

  // ── 종료/에러 로깅
  openaiWS.on("close", (code, reason) => {
    console.log("🧠 [WS] OpenAI closed:", code, reason?.toString?.());
    clearInterval(keepAlive);
  });
  twilioWS.on("close", (code, reason) => {
    console.log("📴 [WS] Twilio closed:", code, reason?.toString?.());
  });
  openaiWS.on("error", e => console.error("❌ [WS] OpenAI error:", e.message));
  twilioWS.on("error", e => console.error("❌ [WS] Twilio error:", e.message));

  const safeClose = ws => { try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch {} };
});
