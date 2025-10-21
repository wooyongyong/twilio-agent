// server.js  (Node 18+ / "type":"module")
// Env: OPENAI_API_KEY, AGENT_ID

import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AGENT_ID = process.env.AGENT_ID;

if (!OPENAI_API_KEY || !AGENT_ID) {
  console.warn("[WARN] Set OPENAI_API_KEY and AGENT_ID in env.");
}

const app = express();

/** 0) Health check (브라우저/로드밸런서 확인용) */
app.get("/", (_req, res) => res.status(200).send("ok"));

/** 1) Twilio Webhook: 전화 수신 시 TwiML 반환
 *   - track 속성 제거(호환성 최상) */
app.post("/voice", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/twilio-media-stream"/>
  </Connect>
</Response>`;
  res.type("text/xml").status(200).send(twiml);
});

/** 2) HTTP→WS 업그레이드: Twilio 미디어 스트림 */
const server = app.listen(PORT, () =>
  console.log(`[BOOT] listening on ${PORT}`)
);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media-stream") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req)
    );
  } else {
    socket.destroy();
  }
});

/** 3) Twilio <-> OpenAI Realtime 브릿지 */
wss.on("connection", async (twilioWS) => {
  console.log("[WS] Twilio connected");

  // OpenAI Realtime(Agent Builder의 Agent로 연결)
  const openaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta-Agent-Id": AGENT_ID,
      },
    }
  );

  // 세션 파라미터: 한국어/전화망 코덱 맞춤
  openaiWS.on("open", () => {
    console.log("[WS] OpenAI connected");
    openaiWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          // 한국어 발음 자연스러운 보이스(원하면 alloy/verse로 변경)
          voice: "amber",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          instructions:
            "Respond in Korean unless the caller speaks English. Keep the first greeting under 8 seconds.",
        },
      })
    );
  });

  // Twilio -> OpenAI 업스트림
  let streamSid = null;
  let inactivityTimer = null;
  const COMMIT_IDLE_MS = 800;

  const triggerCommit = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({ type: "response.create" }));
      }
    }, COMMIT_IDLE_MS);
  };

  twilioWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt.event === "start") {
        streamSid = evt.start?.streamSid;
        console.log("[Twilio] start", streamSid);
      } else if (evt.event === "media") {
        if (openaiWS.readyState === WebSocket.OPEN) {
          openaiWS.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: evt.media.payload, // base64 μ-law
            })
          );
        }
        triggerCommit(); // 잠시 멈추면 입력 커밋 & 응답 생성
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
      console.error("[ERR] Twilio msg parse:", e);
    }
  });

  // OpenAI -> Twilio 다운스트림(TTS 오디오 청크)
  openaiWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "output_audio_buffer.delta" && data.audio && streamSid) {
        if (twilioWS.readyState === WebSocket.OPEN) {
          twilioWS.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: data.audio }, // base64 μ-law
            })
          );
        }
      }
    } catch (e) {
      console.error("[ERR] OpenAI msg parse:", e);
    }
  });

  // 하트비트 & 정리
  const heartbeat = setInterval(() => {
    try {
      twilioWS.readyState === WebSocket.OPEN && twilioWS.ping();
      openaiWS.readyState === WebSocket.OPEN && openaiWS.ping();
    } catch {}
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clearTimeout(inactivityTimer);
  };

  twilioWS.on("close", () => {
    console.log("[WS] Twilio closed");
    cleanup();
    safeClose(openaiWS);
  });
  openaiWS.on("close", () => {
    console.log("[WS] OpenAI closed");
    cleanup();
    safeClose(twilioWS);
  });
  twilioWS.on("error", (e) => console.error("[WS] Twilio error:", e.message));
  openaiWS.on("error", (e) => console.error("[WS] OpenAI error:", e.message));
});

function safeClose(ws) {
  try {
    ws && ws.readyState === WebSocket.OPEN && ws.close();
  } catch {}
}
