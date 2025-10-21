import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.set("trust proxy", true); // ✅ Railway 프록시 신뢰

// === 1️⃣ Twilio Voice Webhook ===
app.post("/voice", (req, res) => {
  const domain = process.env.RAILWAY_URL || req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${domain}/twilio-media-stream" track="inbound_track"/>
  </Connect>
</Response>`;
  console.log("[TwiML] Responding with TwiML for domain:", domain);
  res.type("text/xml").send(twiml);
});

// === 2️⃣ WebSocket Upgrade ===
const server = app.listen(process.env.PORT || 3000, () =>
  console.log("✅ Server listening on port", process.env.PORT || 3000)
);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/twilio-media-stream")) {
    console.log("[UPGRADE] Twilio media stream upgrade request");
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("[UPGRADE] Upgrade successful ✅");
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// === 3️⃣ Twilio ↔ OpenAI Realtime Bridge ===
wss.on("connection", async (twilioWS) => {
  console.log("[WS] Twilio connected ✅");

  const openaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1", // ✅ 필수
        "OpenAI-Beta-Agent-Id": process.env.AGENT_ID,
      },
    }
  );

  openaiWS.on("open", () => console.log("[WS] OpenAI connected ✅"));
  openaiWS.on("error", (err) => console.error("[WS] OpenAI Error ❌", err.message));
  openaiWS.on("close", (code, reason) =>
    console.log("[WS] OpenAI Closed:", code, reason.toString())
  );

  twilioWS.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.event === "start") {
      twilioWS._sid = evt.start.streamSid;
      console.log("[Twilio] Stream started:", twilioWS._sid);
    } else if (evt.event === "media") {
      openaiWS.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: evt.media.payload,
        })
      );
    } else if (evt.event === "stop") {
      console.log("[Twilio] Stream stopped");
      openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      openaiWS.send(JSON.stringify({ type: "response.create" }));
      twilioWS.close();
      openaiWS.close();
    }
  });

  openaiWS.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.type === "output_audio_buffer.delta" && data.audio) {
      twilioWS.send(
        JSON.stringify({
          event: "media",
          streamSid: twilioWS._sid,
          media: { payload: data.audio },
        })
      );
    }
  });
});
