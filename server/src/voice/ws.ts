import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { COOKIE, readCookie, sha } from "../auth/index.js";
import type { AppCtx } from "../context.js";
import { oid } from "../db.js";
import { log } from "../lib/logger.js";
import type { ClientLink } from "./types.js";
import { makeRealtime } from "./index.js";
import { VoiceRelay } from "./relay.js";

const PATH = /^\/api\/calls\/([a-f0-9]{24})\/realtime$/;
const MAX_SESSIONS = 50;

function reject(socket: Duplex, status: number, msg: string) {
  socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * WebSocket /api/calls/:id/realtime. Autentikasi memakai cookie sesi yang sama seperti REST; Origin wajib terdaftar
 * (perlindungan cross-site WebSocket hijacking). Satu relay per pengguna, dengan batas total sesi.
 */
export function attachVoice(server: Server, ctx: AppCtx) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const allowed = new Set(ctx.cfg.ALLOWED_ORIGINS.split(",").map((s) => s.trim()));
  const active = new Map<string, VoiceRelay>(); // userId -> relay

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    const m = PATH.exec(url.pathname);
    if (!m) return; // bukan milik kita: biarkan handler lain/koneksi ditutup oleh server
    try {
      const origin = req.headers.origin;
      if (!origin || !allowed.has(origin)) return reject(socket, 403, "Forbidden");
      if (!ctx.flags.get().voiceCalls) return reject(socket, 404, "Not Found");
      const provider = makeRealtime(ctx);
      if (!provider) return reject(socket, 404, "Not Found");

      const token = readCookie(req as never, COOKIE);
      const sess = token ? await ctx.d.c.sessions.findOne({ _id: sha(token), expiresAt: { $gt: new Date() } }) : null;
      const user = sess ? await ctx.d.c.users.findOne({ _id: sess.userId }) : null;
      if (!user) return reject(socket, 401, "Unauthorized");
      if (user.deletionStatus !== "none" || !user.ageConfirmedAt || user.status === "suspended") return reject(socket, 403, "Forbidden");

      const callId = oid(m[1]!);
      const call = callId ? await ctx.d.c.call_sessions.findOne({ _id: callId, userId: user._id, status: "active" }) : null;
      if (!call) return reject(socket, 404, "Not Found");
      const conv = await ctx.d.c.conversations.findOne({ _id: call.conversationId, userId: user._id });
      if (!conv) return reject(socket, 404, "Not Found");
      if (active.has(String(user._id))) return reject(socket, 409, "Conflict");
      if (active.size >= MAX_SESSIONS) return reject(socket, 503, "Service Unavailable");

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const link: ClientLink = {
          sendJson: (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
          sendAudio: (pcm) => { if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1_000_000) ws.send(pcm, { binary: true }); },
          close: (code, reason) => { try { ws.close(code ?? 1000, reason); } catch { /* sudah tertutup */ } },
        };
        const relay = new VoiceRelay({ ctx, user, call, conv, link, provider, bargeIn: url.searchParams.get("bargeIn") === "1" });
        active.set(String(user._id), relay);
        ws.on("message", (data, isBinary) => {
          if (isBinary) return relay.onClientAudio(data as Buffer);
          try { relay.onClientJson(JSON.parse(data.toString())); } catch { /* abaikan JSON rusak */ }
        });
        ws.on("close", () => { active.delete(String(user._id)); void relay.end("user"); });
        ws.on("error", () => { active.delete(String(user._id)); void relay.end("error"); });
        void relay.start().catch(() => { log("error", { event: "voice_start_failed" }); void relay.end("error"); });
      });
    } catch {
      log("error", { event: "voice_upgrade_failed" });
      reject(socket, 500, "Internal Server Error");
    }
  });

  return { close: () => wss.close(), activeCount: () => active.size };
}
