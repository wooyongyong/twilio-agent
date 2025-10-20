import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const app = express();

// 1) Twilio가 전화를 걸 때 치는 웹훅: TwiML 반환
app.post("/voice", (req, res) => {
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/twilio-media-stream" track="both_tracks"/>
  </Connect>
</Response>`);
});

// 2) 업그레이드: /twilio-media-stream 경로를 WebSocket으로 승격
const server = app.listen(process.env.PORT || 3000, () =>
  console.log("listening on " + (process.env.PORT || 3000))
);

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media-stream") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// 3) Twilio <-> OpenAI Realtime 양방향 브릿지
wss.on("connection", async (twilioWS) => {
  const openaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta-Agent-Id": process.env.AGENT_ID
      }
    }
  );

  twilioWS.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.event === "start") twilioWS._sid = evt.start.streamSid;
    else if (evt.event === "media") {
      openaiWS.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: evt.media.payload
      }));
    } else if (evt.event === "stop") {
      openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      openaiWS.send(JSON.stringify({ type: "response.create" }));
      openaiWS.close(); twilioWS.close();
    }
  });

  openaiWS.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.type === "output_audio_buffer.delta" && data.audio) {
      twilioWS.send(JSON.stringify({
        event: "media",
        streamSid: twilioWS._sid,
        media: { payload: data.audio }
      }));
    }
  });
});