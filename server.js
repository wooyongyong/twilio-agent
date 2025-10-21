// server.js  (Node 18+ / package.json: { "type": "module" })
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.set("trust proxy", true); // Railway 프록시 신뢰

// 0) 헬스 체크
app.get("/", (_req, res) => res.status(200).send("ok"));

// 1) Twilio 웹훅: 즉시 TwiML 반환 (지연 로직 절대 금지)
app.post("/voice", (req, res) => {
  const host = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio-media-stream"/>
  </Connect>
</Response>`;
  res.type("text/xml").status(200).send(twiml);
});

// 2) 서버 시작
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`✅ listening on ${PORT}`);
});

// 3) WS 업그레이드: /twilio-media-stream 프리픽스 허용(쿼리 포함)
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (url.startsWith("/twilio-media-stream")) {
    console.log("[UPGRADE]", url);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    console.log("[UPGRADE] rejected:", url);
    socket.destroy();
  }
});

// 4) Twilio <-> OpenAI Realtime 브릿지
wss.on("connection", (twilioWS) => {
  console.log("📞 [WS] Twilio connected");

  // OpenAI Realtime 연결
  const openaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // sk-...
        "OpenAI-Beta": "realtime=v1",                          // 필수
        "OpenAI-Beta-Agent-Id": process.env.AGENT_ID,          // agt-...
      },
    }
  );

  openaiWS.on("open", () => {
    console.log("🤖 [WS] OpenAI connected");
    // 세션 파라미터(한국어/전화망 코덱 호환)
    openaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: "amber",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        instructions:
          "Respond in Korean unless the caller speaks English. Keep the first greeting short.",
      }
    }));
  });

  let streamSid = null;

  // Twilio → OpenAI (업스트림)
  twilioWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt.event === "start") {
        streamSid = evt.start?.streamSid;
        console.log("[Twilio] start:", streamSid);
      } else if (evt.event === "media") {
        if (openaiWS.readyState === WebSocket.OPEN) {
          openaiWS.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: evt.media.payload, // base64 μ-law
          }));
        }
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

  // OpenAI → Twilio (다운스트림: 모델 오디오)
  openaiWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "output_audio_buffer.delta" && data.audio && streamSid) {
        if (twilioWS.readyState === WebSocket.OPEN) {
          twilioWS.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: data.audio } // base64 μ-law
          }));
        }
      }
    } catch (e) {
      console.error("[OpenAI] message parse error:", e.message);
    }
  });

  // 에러/정리
  const cleanup = () => {
    safeClose(openaiWS);
    safeClose(twilioWS);
  };
  openaiWS.on("error", (e) => console.error("❌ [WS] OpenAI error:", e.message));
  twilioWS.on("error", (e) => console.error("❌ [WS] Twilio error:", e.message));
  openaiWS.on("close", () => { console.log("🧠 [WS] OpenAI closed"); cleanup(); });
  twilioWS.on("close", () => { console.log("📴 [WS] Twilio closed"); cleanup(); });
});

function safeClose(ws) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  } catch {}
}
