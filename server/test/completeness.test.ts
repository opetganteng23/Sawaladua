import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { loadConfig } from "../src/config.js";
import { login, parseSse, setup, until } from "./helpers.js";
import { storeCandidates, deleteMemories } from "../src/memory/service.js";
import { maybeSummarize } from "../src/chat/summary.js";
import { sweepRetention } from "../src/lib/retention.js";
import { recordOp } from "../src/lib/ops.js";
import { scan, scanText } from "../../scripts/scan-secrets.mjs";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.stop(); });
let n = 0;
const cid = () => `cmp-msg-${Date.now()}-${n++}`;
const opsCount = (type: string) => env.ctx.d.c.ops_events.countDocuments({ type });

describe("bawaan flag fitur", () => {
  it("memori, tema mood, sapaan, ekspor, dan suara menyala tanpa env; dev login tetap mati", () => {
    const c = loadConfig({ SESSION_SECRET: "x".repeat(40) });
    expect([c.FEATURE_LONG_TERM_MEMORY, c.FEATURE_MOOD_THEMES, c.FEATURE_PROACTIVE_GREETING, c.FEATURE_DATA_EXPORT, c.FEATURE_VOICE_CALLS]).toEqual([true, true, true, true, true]);
    expect(c.AUTH_DEV_LOGIN).toBe(false);
    expect(loadConfig({ SESSION_SECRET: "x".repeat(40), FEATURE_DATA_EXPORT: "false" }).FEATURE_DATA_EXPORT).toBe(false);
  });
});

describe("siklus hidup memori: supersede otomatis dan konflik", () => {
  const unit = (angleDeg: number) => { const r = (angleDeg * Math.PI) / 180; return [Math.cos(r), Math.sin(r), 0, 0, 0, 0, 0, 0]; };
  it("kejadian yang berubah status menandai yang lama tergantikan; fakta stabil tetap jalur konflik; yang dikonfirmasi tidak disentuh", async () => {
    const u = await login(env.app, "life@x.com");
    const user = (await env.ctx.d.c.users.findOne({ _id: new ObjectId(u.user.id) }))!;
    const orig = env.ctx.embedder.embed;
    const vecs: Record<string, number[]> = {
      "Pengguna akan wawancara kerja minggu depan": unit(0),
      "Pengguna sudah selesai wawancara kerja": unit(40), // cos 40 deg ~ 0.77: mirip tapi bukan duplikat
      "Pengguna tinggal di Bandung": unit(90),
      "Pengguna tinggal di Jakarta": unit(130),
      "Pengguna ingin liburan ke Bali": unit(180),
      "Pengguna batal liburan ke Bali": unit(220),
    };
    env.ctx.embedder.embed = async (t) => t.map((x) => vecs[x] ?? unit(270));
    try {
      const mk = (type: "episodic" | "semantic", content: string) => ({ type, content, importance: 0.6, confidence: 0.9, sensitivity: "none" as const });
      await storeCandidates(env.ctx, user, [mk("episodic", "Pengguna akan wawancara kerja minggu depan")], []);
      const r1 = await storeCandidates(env.ctx, user, [mk("episodic", "Pengguna sudah selesai wawancara kerja")], []);
      expect(r1.superseded).toBe(1);
      const mems = await env.ctx.d.c.memories.find({ userId: user._id }).toArray();
      const old = mems.find((m) => m.content.includes("akan wawancara"))!;
      const nw = mems.find((m) => m.content.includes("sudah selesai"))!;
      expect(old.status).toBe("superseded");
      expect(String(old.supersededBy)).toBe(String(nw._id));
      expect(nw.status).toBe("active");

      await storeCandidates(env.ctx, user, [mk("semantic", "Pengguna tinggal di Bandung")], []);
      const r2 = await storeCandidates(env.ctx, user, [mk("semantic", "Pengguna tinggal di Jakarta")], []);
      expect(r2.conflicts).toBe(1);
      expect(r2.superseded).toBe(0);
      const bandung = await env.ctx.d.c.memories.findOne({ userId: user._id, content: "Pengguna tinggal di Bandung" });
      expect(bandung!.status).toBe("active"); // tidak ditimpa diam-diam

      const bali = await storeCandidates(env.ctx, user, [mk("episodic", "Pengguna ingin liburan ke Bali")], []);
      expect(bali.created).toBe(1);
      await env.ctx.d.c.memories.updateOne({ userId: user._id, content: "Pengguna ingin liburan ke Bali" }, { $set: { userConfirmed: true } });
      const r3 = await storeCandidates(env.ctx, user, [mk("episodic", "Pengguna batal liburan ke Bali")], []);
      expect(r3.superseded).toBe(0); // dikonfirmasi pengguna: hanya pengguna yang boleh mengubah
    } finally { env.ctx.embedder.embed = orig; }
  });
});

describe("hapus memori membersihkan ringkasan sesi (MTS 7.7)", () => {
  it("ringkasan dari percakapan sumber dihapus dan tidak dibuat ulang dari pesan lama", async () => {
    const u = await login(env.app, "scrub@x.com");
    const user = (await env.ctx.d.c.users.findOne({ _id: new ObjectId(u.user.id) }))!;
    const uid = user._id;
    const convId = new ObjectId();
    const now = Date.now();
    await env.ctx.d.c.conversations.insertOne({ _id: convId, userId: uid, title: "t", createdAt: new Date(now - 1e6), updatedAt: new Date(), deletedAt: null } as never);
    const old = Array.from({ length: 12 }, (_, i) => ({ userId: uid, conversationId: convId, role: i % 2 ? "assistant" : "user", text: `pesan lama ${i}`, status: "complete", channel: "chat", createdAt: new Date(now - 900_000 + i * 1000) }));
    const ins = await env.ctx.d.c.messages.insertMany(old as never);
    const src = ins.insertedIds[0]!;
    await env.ctx.d.c.session_summaries.insertOne({ userId: uid, conversationId: convId, summary: "Pengguna punya rahasia X", sourceUpTo: new Date(now - 800_000), createdAt: new Date(), updatedAt: new Date() } as never);
    const mem = await env.ctx.d.c.memories.insertOne({ userId: uid, type: "semantic", content: "rahasia X", importance: 0.5, confidence: 0.9, sensitivity: "none", sourceMessageIds: [src], embedding: new Array(256).fill(0.1), embeddingTag: env.ctx.embedder.tag, status: "active", userConfirmed: false, createdAt: new Date(), updatedAt: new Date(), lastUsedAt: null, useCount: 0, supersededBy: null, conflictWith: null } as never);

    expect(await deleteMemories(env.ctx, user, [mem.insertedId])).toBe(1);
    expect(await env.ctx.d.c.session_summaries.countDocuments({ userId: uid })).toBe(0);
    let conv = (await env.ctx.d.c.conversations.findOne({ _id: convId }))!;
    expect(conv.summaryFloor).toBeTruthy();

    // 12 pesan lama ada sebelum floor: ringkasan tidak boleh dibuat ulang dari mereka
    await maybeSummarize(env.ctx, user, conv);
    expect(await env.ctx.d.c.session_summaries.countDocuments({ userId: uid })).toBe(0);
    // setelah 10 pesan BARU, ringkasan boleh dibuat lagi (hanya dari pesan baru)
    const fresh = Array.from({ length: 10 }, (_, i) => ({ userId: uid, conversationId: convId, role: i % 2 ? "assistant" : "user", text: `pesan baru ${i}`, status: "complete", channel: "chat", createdAt: new Date(Date.now() + 5000 + i * 1000) }));
    await env.ctx.d.c.messages.insertMany(fresh as never);
    conv = (await env.ctx.d.c.conversations.findOne({ _id: convId }))!;
    await maybeSummarize(env.ctx, user, conv);
    const s = await env.ctx.d.c.session_summaries.findOne({ userId: uid });
    expect(s).toBeTruthy();
    expect(s!.summary).not.toMatch(/rahasia X/);
  });
});

describe("retensi riwayat chat", () => {
  it("default tidak menghapus apa pun; dengan batas hari, percakapan lama dihapus dan memori tetap", async () => {
    const u = await login(env.app, "ret@x.com");
    const uid = new ObjectId(u.user.id);
    const mk = async (daysAgo: number) => {
      const id = new ObjectId();
      const at = new Date(Date.now() - daysAgo * 864e5);
      await env.ctx.d.c.conversations.insertOne({ _id: id, userId: uid, title: `k${daysAgo}`, createdAt: at, updatedAt: at, deletedAt: null } as never);
      const m = await env.ctx.d.c.messages.insertOne({ userId: uid, conversationId: id, role: "user", text: "x", status: "complete", channel: "chat", createdAt: at } as never);
      return { id, msg: m.insertedId };
    };
    const old = await mk(40), recent = await mk(2);
    const mem = await env.ctx.d.c.memories.insertOne({ userId: uid, type: "semantic", content: "tetap ada", importance: 0.5, confidence: 0.9, sensitivity: "none", sourceMessageIds: [old.msg], embedding: [0], status: "active", userConfirmed: false, createdAt: new Date(), updatedAt: new Date(), lastUsedAt: null, useCount: 0, supersededBy: null, conflictWith: null } as never);

    expect(await sweepRetention(env.ctx)).toBe(0); // CHAT_RETENTION_DAYS=0
    env.ctx.cfg.CHAT_RETENTION_DAYS = 30;
    try { expect(await sweepRetention(env.ctx)).toBe(1); } finally { env.ctx.cfg.CHAT_RETENTION_DAYS = 0; }
    expect(await env.ctx.d.c.conversations.countDocuments({ _id: old.id })).toBe(0);
    expect(await env.ctx.d.c.messages.countDocuments({ conversationId: old.id })).toBe(0);
    expect(await env.ctx.d.c.conversations.countDocuments({ _id: recent.id })).toBe(1);
    const m = await env.ctx.d.c.memories.findOne({ _id: mem.insertedId });
    expect(m).toBeTruthy();
    expect(m!.sourceMessageIds).toEqual([]);
  });
});

describe("metrik operasional (MTS 13.2)", () => {
  it("mencatat level keselamatan, retrieval, output tidak valid; dasbor admin mengagregat tanpa isi percakapan", async () => {
    const admin = await login(env.app, "admin@x.com");
    const u = await login(env.app, "ops@x.com");
    await u.call("post", "/api/chat", { clientMessageId: cid(), text: "namaku Rani" });
    await until(async () => (await u.call("get", "/api/memories")).body.items[0]);
    await u.call("post", "/api/chat", { clientMessageId: cid(), text: "siapa namaku Rani" });
    await u.call("post", "/api/chat", { clientMessageId: cid(), text: "aku mau bunuh diri malam ini" });
    const orig = env.ctx.llm.generate;
    env.ctx.llm.generate = async () => ({ text: "bukan json", inputTokens: 1, outputTokens: 1 });
    try { await u.call("post", "/api/chat", { clientMessageId: cid(), text: "halo lagi" }); } finally { env.ctx.llm.generate = orig; }
    recordOp(env.ctx, "db_ping_ms", 7);
    await until(async () => (await opsCount("safety_level_3")) >= 1 && (await opsCount("output_invalid")) >= 1 && (await opsCount("retrieval_ms")) >= 1 && (await opsCount("db_ping_ms")) >= 1);
    const r = (await admin.call("get", "/api/admin/usage?days=1")).body.ops;
    expect(r.safety.level3).toBeGreaterThanOrEqual(1);
    expect(r.invalidOutputRate).toBeGreaterThan(0);
    expect(r.retrieval.samples).toBeGreaterThanOrEqual(1);
    expect(r.dbPing.p95Ms).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(r)).not.toMatch(/Rani|bunuh|namaku/);
    const sample = await env.ctx.d.c.ops_events.findOne({ type: "safety_level_3" });
    expect(Object.keys(sample!).sort()).toEqual(["_id", "at", "type"]); // tanpa userId/isi
  });
});

describe("ketahanan (MTS 14.1 resilience)", () => {
  let server: Server, port: number;
  beforeAll(() => { server = env.app.listen(0); port = (server.address() as AddressInfo).port; });
  afterAll(() => { server.close(); });

  it("provider menggantung -> timeout menjadi error yang jujur dan bisa diulang; pesan pengguna tersimpan", async () => {
    const orig = env.ctx.llm.generate;
    const prev = env.ctx.cfg.LLM_TIMEOUT_MS;
    env.ctx.cfg.LLM_TIMEOUT_MS = 150;
    env.ctx.llm.generate = (req) => new Promise((_, rej) => req.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    try {
      const u = await login(env.app, "timeout@x.com");
      const t0 = Date.now();
      const r = await u.call("post", "/api/chat", { clientMessageId: cid(), text: "halo" });
      const ev = parseSse(r.text);
      expect(Date.now() - t0).toBeLessThan(3000);
      const err = ev.find((e) => e.event === "error")!;
      expect(err.data).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
      expect(JSON.stringify(err.data)).not.toMatch(/aborted|stack/);
      const items = (await u.call("get", `/api/conversations/${ev[0]!.data.conversationId}/messages`)).body.items;
      expect(items.map((m: { role: string }) => m.role)).toEqual(["user"]);
    } finally { env.ctx.llm.generate = orig; env.ctx.cfg.LLM_TIMEOUT_MS = prev; }
  });

  it("klien terputus saat balasan dibuat -> balasan ditandai tidak lengkap, bukan final, dan dicatat sebagai stream_disconnect", async () => {
    const orig = env.ctx.llm.generate;
    env.ctx.llm.generate = async (r) => { if (!r.system.includes("[TUGAS")) await new Promise((res) => setTimeout(res, 400)); return orig(r); };
    try {
      const u = await login(env.app, "discon@x.com");
      const before = await opsCount("stream_disconnect");
      const cookie = ((await u.agent.get("/api/auth/session").set("X-Requested-With", "sawala")).request as unknown as { header: Record<string, string> }).header?.Cookie ?? "";
      void cookie;
      // ambil cookie dari login ulang
      const raw = await import("supertest").then((m) => m.default(env.app).post("/api/auth/dev").set("X-Requested-With", "sawala").send({ email: "discon@x.com" }));
      const ck = (raw.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
      await new Promise<void>((resolve) => {
        const req = httpRequest({ port, method: "POST", path: "/api/chat", headers: { "content-type": "application/json", "x-requested-with": "sawala", cookie: ck } }, (res) => {
          res.once("data", () => { req.destroy(); resolve(); }); // putus setelah event pertama (message_started)
        });
        req.on("error", () => resolve());
        req.end(JSON.stringify({ clientMessageId: cid(), text: "halo" }));
      });
      await until(async () => (await opsCount("stream_disconnect")) > before);
      const asst = await env.ctx.d.c.messages.findOne({ userId: new ObjectId(u.user.id), role: "assistant" });
      expect(asst!.status).toBe("incomplete");
    } finally { env.ctx.llm.generate = orig; }
  });

  it("database gagal saat menyimpan pesan -> error generik tanpa stack, tidak mengklaim tersimpan", async () => {
    const u = await login(env.app, "dbfail@x.com");
    const col = env.ctx.d.c.messages as unknown as { insertOne: unknown };
    const orig = col.insertOne;
    col.insertOne = async () => { throw new Error("mongo down: secret-host:27017"); };
    try {
      const r = await u.call("post", "/api/chat", { clientMessageId: cid(), text: "halo" });
      expect(r.status).toBe(500);
      expect(r.body.error).toMatchObject({ code: "INTERNAL", retryable: true });
      expect(JSON.stringify(r.body)).not.toMatch(/secret-host|mongo down|at .*\.ts/);
      expect(r.body.error.message).not.toMatch(/tersimpan/);
    } finally { col.insertOne = orig; }
  });
});

describe("pemindai secret (MTS 11.1)", () => {
  it("mendeteksi pola secret umum dan tidak menandai placeholder", () => {
    const fake = (parts: string[]) => parts.join("");
    expect(scanText(fake(["const k = '", "AIza", "SyA1234567890abcdefghijklmnopqrstuvw", "';"])).length).toBe(1);
    expect(scanText(fake(["OPENAI_API_KEY=", "sk-", "proj_abcdefghijklmnopqrstuvwxyz0123456789"])).length).toBe(1);
    expect(scanText(fake(["-----BEGIN ", "PRIVATE KEY", "-----"])).length).toBe(1);
    expect(scanText(fake(["MONGODB_URI=mongodb+srv://", "admin:", "SuperRahasia9", "@cluster0.abc.mongodb.net"])).length).toBe(1);
    expect(scanText("MONGODB_URI=mongodb+srv://USER_STAGING:...@cluster-staging.example.mongodb.net")).toEqual([]);
    expect(scanText("OPENAI_API_KEY=sk-test")).toEqual([]);
    expect(scanText("GEMINI_API_KEY=")).toEqual([]);
  });

  it("repositori bersih dari secret dan .env tidak ikut ter-commit", () => {
    expect(scan(new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))).toEqual([]);
  });
});
