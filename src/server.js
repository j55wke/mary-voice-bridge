import http from "node:http";
import express from "express";
import twilio from "twilio";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 10000);
const FLOOT_BASE_URL = String(process.env.FLOOT_BASE_URL || "").replace(/\/$/, "");
const MARY_BRIDGE_SECRET = process.env.MARY_BRIDGE_SECRET || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const PUBLIC_WSS_URL = process.env.PUBLIC_WSS_URL || "";

const app = express();
app.disable("x-powered-by");
app.get("/", (_req, res) => res.json({ service: "mary-voice-bridge", ok: true }));
app.get("/health", (_req, res) => res.json({ ok: true, configured: Boolean(FLOOT_BASE_URL && MARY_BRIDGE_SECRET && TWILIO_AUTH_TOKEN) }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function publicRequestUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}${req.url}`;
}

function validateTwilioUpgrade(req) {
  if (!TWILIO_AUTH_TOKEN) return false;
  const signature = req.headers["x-twilio-signature"];
  if (typeof signature !== "string" || !signature) return false;
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, publicRequestUrl(req), {});
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function phraseChunks(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  return text.split(/(?<=[.!?])\s+|(?<=,)\s+(?=\S)/).map((x) => x.trim()).filter(Boolean);
}

async function askMary({ speech, callSid, from, signal }) {
  const response = await fetch(`${FLOOT_BASE_URL}/_api/twilio/bridge-turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mary-bridge-secret": MARY_BRIDGE_SECRET,
    },
    body: JSON.stringify({ speech, callSid, from: from || null }),
    signal,
  });
  if (!response.ok) throw new Error(`Mary brain returned ${response.status}`);
  const data = await response.json();
  return data?.json ?? data;
}

wss.on("connection", (ws) => {
  const session = { callSid: "", from: null, abort: null, closed: false };

  ws.on("message", async (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }

    if (message.type === "setup") {
      session.callSid = message.callSid || message.call_sid || message.sessionId || "";
      session.from = message.from || message.customParameters?.from || null;
      return;
    }

    if (message.type === "interrupt") {
      session.abort?.abort();
      session.abort = null;
      return;
    }

    if (message.type === "error") {
      console.error("ConversationRelay error", { callSid: session.callSid, description: message.description || message.error });
      return;
    }

    if (message.type !== "prompt" || message.last !== true) return;
    const speech = String(message.voicePrompt || message.prompt || "").trim();
    if (!speech || !session.callSid) return;

    session.abort?.abort();
    const controller = new AbortController();
    session.abort = controller;

    try {
      const result = await askMary({ speech, callSid: session.callSid, from: session.from, signal: controller.signal });
      if (controller.signal.aborted) return;
      const chunks = Array.isArray(result.replyChunks) && result.replyChunks.length ? result.replyChunks : phraseChunks(result.reply);
      chunks.forEach((chunk, index) => send(ws, { type: "text", token: chunk, last: index === chunks.length - 1 }));
      if (result.finished) setTimeout(() => send(ws, { type: "end" }), 250);
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.error("Mary bridge turn failed", { callSid: session.callSid, error: error?.message || String(error) });
      send(ws, { type: "text", token: "Sorry, I didn't quite catch that. Could you say that again for me?", last: true });
    }
  });

  ws.on("close", () => {
    session.closed = true;
    session.abort?.abort();
  });
});

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname !== "/conversation-relay") return socket.destroy();
  if (!validateTwilioUpgrade(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mary voice bridge listening on ${PORT}`);
  if (PUBLIC_WSS_URL) console.log(`ConversationRelay endpoint: ${PUBLIC_WSS_URL}`);
});
