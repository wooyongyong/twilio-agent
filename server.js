import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.set("trust proxy", true);                // ✅ Railway 프록시 신뢰

// 헬스체크
app.get("/", (_req, res) => res.status(200).send("ok"));

// 1) TwiML: 즉시 반환 (지연 금지)
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

const server = app.listen(process.env.PORT || 3000, () =>
  console.log("listening on", process.env.PORT || 3000)
);

// 2) WS 업그레이드 (쿼리 허용)
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (url.startsWith("/twilio-media-stream")) {
    console.log("[UPGRADE]", url);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// 3) Twilio <-> OpenAI 브릿지
wss.on("connection", (twilioWS) => {
  console.log("[WS] Twilio connected");

  const openaiWS = new WebSocket(
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
  {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // sk-...
      "OpenAI-Beta": "realtime=v1",                          // ✅ 필수
      "OpenAI-Beta-Agent-Id": process.env.AGENT_ID           // ✅ agt-...
    }
  }
);
openaiWS.on("open", () => {
  console.log("[WS] OpenAI connected");
  openaiWS.send(JSON.stringify({
    type: "session.update",
    session: {
      voice: "amber",
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw"
    }
  }));
});

  openaiWS.on("open", () => {
    console.log("[WS] OpenAI connected");
    openaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: "amber",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        instructions: "Respond in Korean unless the caller speaks English. Keep the first greeting short."
      }
    }));
  });

  let sid = null;
  twilioWS.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.event === "start") sid = evt.start.streamSid;
    else if (evt.event === "media") {
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: evt.media.payload }));
      }
    } else if (evt.event === "stop") {
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({ type: "response.create" }));
      }
      openaiWS.close(); twilioWS.close();
    }
  });

  openaiWS.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.type === "output_audio_buffer.delta" && data.audio && sid && twilioWS.readyState === WebSocket.OPEN) {
      twilioWS.send(JSON.stringify({ event: "media", streamSid: sid, media: { payload: data.audio } }));
    }
  });

  const cleanup = () => { try { openaiWS.close(); } catch {} try { twilioWS.close(); } catch {} };
  twilioWS.on("close", cleanup);
  openaiWS.on("close", cleanup);
  twilioWS.on("error", (e) => console.error("[WS] Twilio error:", e.message));
  openaiWS.on("error", (e) => console.error("[WS] OpenAI error:", e.message));
});
