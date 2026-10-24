import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import WebSocket from "ws";
import { ObjectId } from "mongodb";
import { setup } from "./helpers.js";
import { attachVoice } from "../src/voice/ws.js";

type Env = Awaited<ReturnType<typeof setup>>;
type Msg = Record<string, unknown> & { type: string };
const ORIGIN = "http://localhost:5173";

async function cookieLogin(app: Env["app"], email: string, opts: { age?: boolean } = {}) {
  const r = await request(app).post("/api/auth/dev").set("X-Requested-With", "sawala").send({ email });
  const cookie = (r.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
  if (opts.age !== false) await request(app).patch("/api/settings").set("X-Requested-With", "sawala").set("Cookie", cookie).send({ ageConfirmed: true });
  const call = (method: "get" | "post" | "patch" | "delete", url: string, body?: object) => {
    const t = request(app)[method](url).set("X-Requested-With", "sawala").set("Cookie", cookie);
    return body === undefined ? t : t.send(body);
  };
  return { cookie, call, userId: r.body.user.id as string };
}

interface Conn {
  ws: WebSocket; msgs: Msg[]; frames: Buffer[]; status: number | null;
  waitFor(pred: (m: Msg) => boolean, ms?: number): Promise<Msg>;
  sleep(ms: number): Promise<void>;
  close(): void;
}
function connect(port: number, callId: string, cookie: string | null, opts: { origin?: string | null; query?: string } = {}): Promise<Conn> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/calls/${callId}/realtime${opts.query ?? ""}`, { headers });
    const msgs: Msg[] = [], frames: Buffer[] = [];
    const conn: Conn = {
      ws, msgs, frames, status: null,
      async waitFor(pred, ms = 5000) {
        const end = Date.now() + ms;
        for (;;) {
          const m = msgs.find(pred);
          if (m) return m;
          if (Date.now() > end) throw new Error("timeout; pesan diterima: " + msgs.map((x) => x.type).join(","));
          await new Promise((r) => setTimeout(r, 15));
        }
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      close: () => ws.close(),
    };
    ws.on("message", (d, bin) => { if (bin) frames.push(d as Buffer); else msgs.push(JSON.parse(d.toString())); });
    ws.on("unexpected-response", (_req, res) => { conn.status = res.statusCode ?? 0; resolve(conn); });
    ws.on("error", () => resolve(conn));
    ws.on("open", () => resolve(conn));
  });
}
const txt = (s: string) => Buffer.from(`TXT:${s}\n`);

let env: Env;
let server: Server;
let port: number;
beforeAll(async () => {
  env = await setup({ REALTIME_PROVIDER: "mock", STT_PROVIDER: "mock", TTS_PROVIDER: "mock" });
  server = env.app.listen(0);
  attachVoice(server, env.ctx);
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { server.close(); await env.stop(); });

const newCall = async (u: Awaited<ReturnType<typeof cookieLogin>>, consent: boolean) =>
  (await u.call("post", "/api/calls", { transcriptConsent: consent })).body.id as string;

describe("WebSocket suara realtime: akses", () => {
  it("menolak tanpa Origin terdaftar, tanpa sesi, panggilan orang lain, dan sesi ganda", async () => {
    const a = await cookieLogin(env.app, "rt-a@x.com");
    const b = await cookieLogin(env.app, "rt-b@x.com");
    const id = await newCall(a, false);
    expect((await connect(port, id, a.cookie, { origin: null })).status).toBe(403);
    expect((await connect(port, id, a.cookie, { origin: "https://jahat.example" })).status).toBe(403);
    expect((await connect(port, id, null)).status).toBe(401);
    expect((await connect(port, id, b.cookie)).status).toBe(404);
    expect((await connect(port, "507f1f77bcf86cd799439011", a.cookie)).status).toBe(404);
    const ok = await connect(port, id, a.cookie);
    await ok.waitFor((m) => m.type === "ready");
    expect((await connect(port, id, a.cookie)).status).toBe(409); // satu relay per pengguna
    ok.close();
  });

  it("menolak jika usia belum dikonfirmasi atau fitur suara dimatikan operator", async () => {
    const young = await cookieLogin(env.app, "rt-young@x.com", { age: false });
    expect((await connect(port, "507f1f77bcf86cd799439011", young.cookie)).status).toBe(403);
    const u = await cookieLogin(env.app, "rt-flag@x.com");
    const id = await newCall(u, false);
    await env.ctx.flags.setKilled(["voiceCalls"]);
    try { expect((await connect(port, id, u.cookie)).status).toBe(404); } finally { await env.ctx.flags.setKilled([]); }
  });
});

describe("relay native (mock): alur normal", () => {
  it("ready -> transkrip -> audio balasan -> selesai; riwayat tersimpan hanya dengan persetujuan", async () => {
    const u = await cookieLogin(env.app, "rt-ok@x.com");
    const id = await newCall(u, true);
    const c = await connect(port, id, u.cookie);
    const ready = await c.waitFor((m) => m.type === "ready");
    expect(ready).toMatchObject({ mode: "native", inputRate: 16000, outputRate: 24000 });
    c.ws.send(txt("halo sawala, aku lagi capek"));
    await c.waitFor((m) => m.type === "transcript" && m.role === "user" && m.final === true);
    await c.waitFor((m) => m.type === "transcript" && m.role === "assistant" && m.final === true);
    expect(c.frames.length).toBeGreaterThanOrEqual(3);
    expect(c.frames[0]!.length).toBe(4800); // 2400 sampel PCM16
    c.ws.send(JSON.stringify({ type: "end" }));
    const ended = await c.waitFor((m) => m.type === "ended");
    expect(ended.transcriptKept).toBe(true);
    const msgs = await env.ctx.d.c.messages.find({ userId: new ObjectId(u.userId) }).sort({ createdAt: 1 }).toArray();
    expect(msgs.map((m) => `${m.role}:${m.channel}`)).toEqual(["user:call", "assistant:call"]);
  });

  it("tanpa persetujuan transkrip: teks dihapus saat panggilan berakhir dan memori tidak dibuat", async () => {
    const u = await cookieLogin(env.app, "rt-priv@x.com");
    const id = await newCall(u, false);
    const c = await connect(port, id, u.cookie);
    await c.waitFor((m) => m.type === "ready");
    c.ws.send(txt("namaku Rani"));
    await c.waitFor((m) => m.type === "transcript" && m.role === "assistant" && m.final === true);
    c.close();
    await c.sleep(300);
    const uid = new ObjectId(u.userId);
    expect(await env.ctx.d.c.messages.countDocuments({ userId: uid })).toBe(0);
    expect(await env.ctx.d.c.memories.countDocuments({ userId: uid })).toBe(0);
    expect((await env.ctx.d.c.call_sessions.findOne({ userId: uid }))!.status).toBe("ended");
  });

  it("frame audio terlalu besar ditolak dan panggilan diakhiri", async () => {
    const u = await cookieLogin(env.app, "rt-big@x.com");
    const c = await connect(port, await newCall(u, false), u.cookie);
    await c.waitFor((m) => m.type === "ready");
    c.ws.send(Buffer.alloc(40_000));
    expect((await c.waitFor((m) => m.type === "error")).code).toBe("FRAME_TOO_LARGE");
  });
});

describe("relay native: keselamatan", () => {
  it("risiko berat: audio model tidak pernah sampai, respons tinjauan-manusia diucapkan, LLM tidak dipanggil", async () => {
    const u = await cookieLogin(env.app, "rt-crisis@x.com");
    const id = await newCall(u, true);
    const orig = env.ctx.llm.generate;
    let called = 0;
    env.ctx.llm.generate = async (r) => { called++; return orig(r); };
    try {
      const c = await connect(port, id, u.cookie);
      await c.waitFor((m) => m.type === "ready");
      c.ws.send(txt("aku mau bunuh diri malam ini"));
      await c.waitFor((m) => m.type === "interrupted");
      const speak = await c.waitFor((m) => m.type === "speak_audio" || m.type === "speak_text");
      expect(speak).toBeTruthy();
      await c.sleep(900); // lewati jendela penahanan: tetap tidak ada audio model
      expect(c.frames.length).toBe(0);
      expect(called).toBe(0);
      const tr = c.msgs.filter((m) => m.type === "transcript" && m.role === "assistant").map((m) => String(m.text)).join(" ");
      expect(tr).toMatch(/layanan darurat/);
      expect(tr).toMatch(/tidak bisa memantau/);

      // giliran berikutnya tetap lewat jalur tervalidasi (bukan audio model)
      c.ws.send(txt("aku capek"));
      await c.waitFor((m) => m.type === "transcript" && m.role === "assistant" && String(m.text).includes("berat") === true || m.type === "transcript" && m.role === "assistant" && c.msgs.filter((x) => x.type === "transcript" && x.role === "assistant").length >= 2);
      await c.sleep(400);
      expect(c.frames.length).toBe(0);
      c.close();
      await c.sleep(200);
      const saved = await env.ctx.d.c.messages.find({ userId: new ObjectId(u.userId), role: "assistant" }).toArray();
      expect(saved.some((m) => m.safetyLevel === 3 && /layanan darurat/.test(m.text))).toBe(true);
    } finally { env.ctx.llm.generate = orig; }
  });

  it("transkrip pengguna tiba terlambat: audio yang ditahan dibuang, tidak pernah terdengar", async () => {
    const u = await cookieLogin(env.app, "rt-late@x.com");
    const c = await connect(port, await newCall(u, false), u.cookie);
    await c.waitFor((m) => m.type === "ready");
    c.ws.send(txt("LATE:aku mau bunuh diri malam ini"));
    await c.waitFor((m) => m.type === "interrupted", 3000);
    await c.sleep(800);
    expect(c.frames.length).toBe(0);
  });

  it("pemantau output: model mengucapkan hal berbahaya -> diputus dan diganti respons aman", async () => {
    const u = await cookieLogin(env.app, "rt-bad@x.com");
    const c = await connect(port, await newCall(u, false), u.cookie);
    await c.waitFor((m) => m.type === "ready");
    c.ws.send(txt("BAD:halo"));
    await c.waitFor((m) => m.type === "interrupted");
    await c.waitFor((m) => m.type === "speak_audio" || m.type === "speak_text");
    await c.sleep(300);
    const asst = c.msgs.filter((m) => m.type === "transcript" && m.role === "assistant").map((m) => String(m.text)).join(" ");
    expect(asst).not.toMatch(/cara bunuh diri/);
  });

  it("audio model ditahan sampai transkrip lolos gate (ucapan aman: audio tetap sampai)", async () => {
    const u = await cookieLogin(env.app, "rt-hold@x.com");
    const c = await connect(port, await newCall(u, false), u.cookie);
    await c.waitFor((m) => m.type === "ready");
    c.ws.send(txt("LATE:halo, apa kabar"));
    await c.waitFor((m) => m.type === "transcript" && m.role === "user" && m.final === true);
    await c.sleep(200);
    expect(c.frames.length).toBeGreaterThanOrEqual(3); // dilepas setelah transkrip lolos
  });
});

describe("relay cascade (STT + LLM + TTS)", () => {
  let env2: Env, server2: Server, port2: number;
  beforeAll(async () => {
    env2 = await setup({ REALTIME_PROVIDER: "cascade", STT_PROVIDER: "mock", TTS_PROVIDER: "mock" });
    server2 = env2.app.listen(0);
    attachVoice(server2, env2.ctx);
    port2 = (server2.address() as AddressInfo).port;
  });
  afterAll(async () => { server2.close(); await env2.stop(); });

  const tone = (ms: number, amp = 8000) => {
    const n = (16000 * ms) / 1000, b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / 16000) * amp), i * 2);
    return b;
  };
  const feed = async (c: Conn, pcm: Buffer) => { for (let o = 0; o < pcm.length; o += 640) { c.ws.send(pcm.subarray(o, o + 640)); await c.sleep(1); } };

  it("ucapan -> transkrip -> balasan tervalidasi -> klip TTS; hening tidak memicu giliran", async () => {
    const u = await cookieLogin(env2.app, "cas-1@x.com");
    const id = (await u.call("post", "/api/calls", { transcriptConsent: true })).body.id;
    const c = await connect(port2, id, u.cookie);
    expect((await c.waitFor((m) => m.type === "ready")).mode).toBe("cascade");
    await feed(c, Buffer.alloc(16000 * 2)); // 1 dtk hening
    await c.sleep(150);
    expect(c.msgs.some((m) => m.type === "transcript")).toBe(false);
    await feed(c, Buffer.concat([tone(1200), Buffer.alloc(16000 * 2)])); // ucapan lalu jeda
    expect((await c.waitFor((m) => m.type === "transcript" && m.role === "user")).text).toBe("halo sawala, aku lagi capek");
    const clip = await c.waitFor((m) => m.type === "speak_audio");
    expect(clip.mime).toBe("audio/wav");
    expect(Buffer.from(String(clip.data), "base64").subarray(0, 4).toString()).toBe("RIFF");
    expect(c.frames.length).toBe(0); // cascade memakai klip, bukan frame PCM
    const msgs = await env2.ctx.d.c.messages.find({ userId: new ObjectId(u.userId) }).toArray();
    expect(msgs.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
    c.close();
  });

  it("cascade pada ucapan berisiko memakai safety gate yang sama", async () => {
    const orig = env2.ctx.stt!.transcribe;
    env2.ctx.stt!.transcribe = async () => ({ text: "aku mau bunuh diri malam ini", inputTokens: 0, outputTokens: 0 });
    try {
      const u = await cookieLogin(env2.app, "cas-2@x.com");
      const id = (await u.call("post", "/api/calls", { transcriptConsent: false })).body.id;
      const c = await connect(port2, id, u.cookie);
      await c.waitFor((m) => m.type === "ready");
      await feed(c, Buffer.concat([tone(1200), Buffer.alloc(16000 * 2)]));
      await c.waitFor((m) => m.type === "speak_audio" || m.type === "speak_text");
      const a = c.msgs.filter((m) => m.type === "transcript" && m.role === "assistant").map((m) => String(m.text)).join(" ");
      expect(a).toMatch(/layanan darurat/);
      c.close();
    } finally { env2.ctx.stt!.transcribe = orig; }
  });
});

describe("anggaran pada suara", () => {
  it("anggaran habis -> error QUOTA_EXHAUSTED jujur dan panggilan ditutup", async () => {
    const env3 = await setup({ REALTIME_PROVIDER: "mock", DAILY_TOKEN_BUDGET_PER_USER: "100" });
    const s = env3.app.listen(0);
    attachVoice(s, env3.ctx);
    try {
      const u = await cookieLogin(env3.app, "bud@x.com");
      await env3.ctx.d.c.usage_events.insertOne({ userId: new ObjectId(u.userId), requestId: "x", provider: "mock", model: "m", inputTokens: 500, outputTokens: 0, latencyMs: 1, status: "ok", createdAt: new Date() } as never);
      const id = (await u.call("post", "/api/calls", { transcriptConsent: false })).body.id;
      const c = await connect((s.address() as AddressInfo).port, id, u.cookie);
      expect((await c.waitFor((m) => m.type === "error")).code).toBe("QUOTA_EXHAUSTED");
    } finally { s.close(); await env3.stop(); }
  });
});
