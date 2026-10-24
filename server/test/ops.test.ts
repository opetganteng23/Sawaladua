import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { parse } from "yaml";
import { login, parseSse, setup } from "./helpers.js";
import { collectRoutes } from "./routes.js";
import { runMigrations, migrations } from "../src/migrations/index.js";
import { vectorIndexDefinition } from "../src/memory/vectorIndex.js";
import { decayMemories } from "../src/lib/decay.js";
import { checkErrorRate, resetAlerts, sendAlert } from "../src/lib/alerts.js";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.stop(); });
let n = 0;
const cid = () => `ops-msg-${Date.now()}-${n++}`;

describe("OpenAPI", () => {
  it("setiap rute terdaftar ada di docs/openapi.yaml dan sebaliknya", () => {
    const spec = parse(readFileSync(new URL("../../docs/openapi.yaml", import.meta.url), "utf8")) as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set<string>();
    for (const [p, ops] of Object.entries(spec.paths))
      for (const m of Object.keys(ops)) if (["get", "post", "patch", "delete", "put"].includes(m)) documented.add(`${m.toUpperCase()} ${p}`);
    const actual = new Set(collectRoutes(env.app).filter((r) => !r.includes("^")));
    expect([...actual].filter((r) => !documented.has(r)), "rute belum terdokumentasi").toEqual([]);
    expect([...documented].filter((r) => !actual.has(r)), "dokumentasi tanpa rute").toEqual([]);
  });
});

describe("migrasi database", () => {
  it("idempoten dan tercatat berurutan", async () => {
    const applied = await env.ctx.d.c.migrations.find().sort({ _id: 1 }).toArray();
    expect(applied.map((m) => m._id)).toEqual(migrations.map((m) => m.id));
    expect(await runMigrations(env.ctx.d)).toEqual([]);
  });

  it("validator database menolak dokumen yang melanggar skema kritis, menerima yang valid", async () => {
    const c = env.ctx.d.c;
    const bad = { userId: new ObjectId(), conversationId: new ObjectId(), role: "hacker", text: "x", createdAt: new Date() };
    await expect(c.messages.insertOne(bad as never)).rejects.toThrow();
    const noUser = { conversationId: new ObjectId(), role: "user", text: "x", createdAt: new Date() };
    await expect(c.messages.insertOne(noUser as never)).rejects.toThrow();
    const ok = { userId: new ObjectId(), conversationId: new ObjectId(), role: "user", text: "x", status: "complete", channel: "chat", createdAt: new Date() };
    await expect(c.messages.insertOne(ok as never)).resolves.toBeTruthy();
    await c.messages.deleteOne({ _id: (ok as { _id?: ObjectId })._id });
  });

  it("migrasi 002 mengisi default pada pengguna lama", async () => {
    const c = env.ctx.d.c;
    await c.migrations.deleteOne({ _id: "002-user-defaults" });
    const id = new ObjectId();
    await c.users.insertOne({ _id: id, email: "lama@x.com", displayName: "l", authProvider: "dev", providerSub: "lama@x.com", preferences: {}, privacySettings: {}, onboardingDone: true, deletionStatus: "none", lastGreetingAt: null, createdAt: new Date() } as never);
    expect(await runMigrations(env.ctx.d)).toEqual(["002-user-defaults"]);
    const u = await c.users.findOne({ _id: id });
    expect(u!.ageConfirmedAt).toBeNull();
    expect(u!.forgottenHashes).toEqual([]);
  });
});

describe("Atlas vector index", () => {
  it("definisi memuat dimensi, cosine, dan filter kepemilikan/status", () => {
    const d = vectorIndexDefinition(256);
    expect(d.fields.find((f) => f.type === "vector")).toMatchObject({ path: "embedding", numDimensions: 256, similarity: "cosine" });
    expect(d.fields.filter((f) => f.type === "filter").map((f) => f.path).sort()).toEqual(["status", "userId"]);
  });
});

describe("kill switch fitur saat runtime", () => {
  it("admin dapat mematikan fitur tanpa restart; non-admin tidak bisa; env tetap batas atas", async () => {
    const admin = await login(env.app, "admin@x.com");
    const user = await login(env.app, "biasa@x.com");
    expect((await user.call("get", "/api/admin/flags")).status).toBe(404);
    expect((await user.call("patch", "/api/admin/flags", { killed: ["voiceCalls"] })).status).toBe(404);
    expect((await admin.call("get", "/api/auth/session")).body.user.isAdmin).toBe(true);
    expect((await user.call("get", "/api/auth/session")).body.user.isAdmin).toBe(false);

    expect((await user.call("post", "/api/calls", { transcriptConsent: false })).status).toBe(201);
    const r = await admin.call("patch", "/api/admin/flags", { killed: ["voiceCalls", "voiceCalls"] });
    expect(r.body.killed).toEqual(["voiceCalls"]);
    expect(r.body.effective.voiceCalls).toBe(false);
    expect((await user.call("post", "/api/calls", { transcriptConsent: false })).status).toBe(404);
    expect((await user.call("get", "/api/auth/session")).body.features.voiceCalls).toBe(false);
    expect((await admin.call("patch", "/api/admin/flags", { killed: ["bukanFlag"] })).status).toBe(400);

    // flag memori dimatikan -> memori tidak dipakai/dibuat walau pengguna mengaktifkannya
    await admin.call("patch", "/api/admin/flags", { killed: ["longTermMemory"] });
    const c = await user.call("post", "/api/chat", { clientMessageId: cid(), text: "namaku Budi" });
    expect(parseSse(c.text).at(-1)!.event).toBe("message_completed");
    await new Promise((res) => setTimeout(res, 300));
    expect((await user.call("get", "/api/memories")).body.enabled).toBe(false);
    expect(await env.ctx.d.c.memories.countDocuments({ userId: new ObjectId(user.user.id) })).toBe(0);

    await admin.call("patch", "/api/admin/flags", { killed: [] });
    expect((await user.call("post", "/api/calls", { transcriptConsent: false })).status).toBe(201);
  });
});

describe("alert operasional", () => {
  let hook: Server;
  let url = "";
  const received: Record<string, unknown>[] = [];
  beforeAll(async () => {
    hook = createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => { received.push(JSON.parse(b)); res.end("ok"); });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;
  });
  afterAll(() => { env.ctx.cfg.ALERT_WEBHOOK_URL = ""; hook.close(); });

  it("tanpa URL: tidak mengirim apa pun", async () => {
    env.ctx.cfg.ALERT_WEBHOOK_URL = "";
    expect(await sendAlert(env.ctx, "quota_exhausted", "warning", "x")).toBe(false);
  });

  it("mengirim payload tanpa isi percakapan dan dibatasi sekali per jam per jenis", async () => {
    resetAlerts();
    env.ctx.cfg.ALERT_WEBHOOK_URL = url;
    expect(await sendAlert(env.ctx, "budget_80_percent", "warning", "pemakaian 85%")).toBe(true);
    expect(await sendAlert(env.ctx, "budget_80_percent", "warning", "pemakaian 90%")).toBe(false); // dedup
    expect(await sendAlert(env.ctx, "deletion_failed", "critical", "langkah gagal")).toBe(true);
    expect(received.length).toBe(2);
    expect(received[0]).toMatchObject({ app: "sawala", type: "budget_80_percent", severity: "warning" });
    expect(JSON.stringify(received)).not.toMatch(/namaku|curhat|email/i);
  });

  it("error rate tinggi memicu alert; di production URL non-HTTPS ditolak", async () => {
    resetAlerts();
    env.ctx.cfg.ALERT_WEBHOOK_URL = url;
    const now = new Date();
    const ev = (status: string) => ({ userId: new ObjectId(), requestId: "r", provider: "mock", model: "m", inputTokens: 1, outputTokens: 1, latencyMs: 5, status, createdAt: now });
    await env.ctx.d.c.usage_events.insertMany([...Array(15).fill(0).map(() => ev("provider_error")), ...Array(10).fill(0).map(() => ev("ok"))] as never);
    expect(await checkErrorRate(env.ctx)).toBe(true);
    expect(received.at(-1)).toMatchObject({ type: "error_rate_high", severity: "critical" });
    await env.ctx.d.c.usage_events.deleteMany({ provider: "mock", model: "m", latencyMs: 5 });

    resetAlerts();
    const prev = env.ctx.cfg.NODE_ENV;
    env.ctx.cfg.NODE_ENV = "production";
    try { expect(await sendAlert(env.ctx, "quota_exhausted", "warning", "x")).toBe(false); } finally { env.ctx.cfg.NODE_ENV = prev; }
  });
});

describe("peluruhan memori", () => {
  it("menurunkan importance memori kejadian lama, tidak menghapus, tidak menyentuh yang dikonfirmasi, dan tidak meluruh dua kali", async () => {
    const uid = new ObjectId();
    const old = new Date(Date.now() - 200 * 864e5);
    const base = { userId: uid, type: "episodic", content: "k", importance: 0.8, confidence: 0.8, sensitivity: "none", sourceMessageIds: [], embedding: [0, 1], status: "active", userConfirmed: false, createdAt: old, updatedAt: old, lastUsedAt: null, useCount: 0, supersededBy: null, conflictWith: null };
    const a = await env.ctx.d.c.memories.insertOne({ ...base, content: "usang" } as never);
    const b = await env.ctx.d.c.memories.insertOne({ ...base, content: "dikonfirmasi", userConfirmed: true } as never);
    const c = await env.ctx.d.c.memories.insertOne({ ...base, content: "baru dipakai", lastUsedAt: new Date() } as never);
    const d = await env.ctx.d.c.memories.insertOne({ ...base, content: "fakta", type: "semantic" } as never);
    expect(await decayMemories(env.ctx)).toBe(1);
    expect((await env.ctx.d.c.memories.findOne({ _id: a.insertedId }))!.importance).toBeCloseTo(0.68, 2);
    for (const id of [b.insertedId, c.insertedId, d.insertedId]) expect((await env.ctx.d.c.memories.findOne({ _id: id }))!.importance).toBe(0.8);
    expect(await decayMemories(env.ctx)).toBe(0);
    expect(await decayMemories(env.ctx, Date.now() + 31 * 864e5)).toBe(1); // 30 hari kemudian boleh lagi
    expect((await env.ctx.d.c.memories.findOne({ _id: a.insertedId }))).toBeTruthy();
  });
});

describe("manajemen sesi", () => {
  it("daftar, cabut satu, cabut lainnya; tidak bisa menyentuh sesi pengguna lain", async () => {
    const a1 = await login(env.app, "sesi1@x.com");
    const a2 = await login(env.app, "sesi1@x.com"); // sesi kedua akun yang sama
    const other = await login(env.app, "sesi2@x.com");
    const list = (await a1.call("get", "/api/sessions")).body.items as { id: string; current: boolean }[];
    expect(list.length).toBe(2);
    expect(list.filter((s) => s.current).length).toBe(1);
    expect(JSON.stringify(list)).not.toMatch(/sawala_sid/);
    const otherId = ((await other.call("get", "/api/sessions")).body.items as { id: string }[])[0]!.id;
    expect((await a1.call("delete", `/api/sessions/${otherId}`)).status).toBe(404);
    expect((await a1.call("delete", "/api/sessions/bukan-id")).status).toBe(400);
    const notCurrent = list.find((s) => !s.current)!;
    expect((await a1.call("delete", `/api/sessions/${notCurrent.id}`)).status).toBe(200);
    expect((await a1.call("get", "/api/conversations")).status).toBe(200);
    expect((await a2.call("get", "/api/conversations")).status === 401 || (await a1.call("get", "/api/sessions")).body.items.length === 1).toBe(true);
    const a3 = await login(env.app, "sesi1@x.com");
    const r = await a1.call("post", "/api/sessions/revoke-others", {});
    expect(r.body.ok).toBe(true);
    expect((await a3.call("get", "/api/conversations")).status).toBe(401);
    expect((await a1.call("get", "/api/conversations")).status).toBe(200);
  });
});

describe("pencarian semantik & ekspor streaming", () => {
  it("mencocokkan ringkasan sesi milik sendiri secara makna", async () => {
    const u = await login(env.app, "sem@x.com");
    const other = await login(env.app, "sem2@x.com");
    const conv = await u.call("post", "/api/conversations", {});
    const uid = new ObjectId(u.user.id);
    const text = "Pengguna membahas kecemasan menghadapi wawancara kerja";
    const [emb] = await env.ctx.embedder.embed([text]);
    await env.ctx.d.c.session_summaries.insertOne({ userId: uid, conversationId: new ObjectId(conv.body.id), summary: text, sourceUpTo: new Date(), embedding: emb, createdAt: new Date(), updatedAt: new Date() } as never);
    const hit = (await u.call("get", "/api/search?q=cemas%20wawancara%20kerja&semantic=1")).body;
    expect(hit.similar[0].conversationId).toBe(conv.body.id);
    expect((await u.call("get", "/api/search?q=cemas%20wawancara%20kerja")).body.similar).toEqual([]); // tanpa flag semantic
    expect((await other.call("get", "/api/search?q=cemas%20wawancara%20kerja&semantic=1")).body.similar).toEqual([]);
  });

  it("ekspor dialirkan sebagai JSON valid dan memuat semua bagian", async () => {
    const u = await login(env.app, "exp@x.com");
    await u.call("post", "/api/chat", { clientMessageId: cid(), text: "halo" });
    const r = await u.call("post", "/api/data/export", {});
    expect(r.headers["content-disposition"]).toMatch(/attachment/);
    for (const k of ["account", "conversations", "messages", "memories", "calls", "summaries"]) expect(r.body, k).toHaveProperty(k);
    expect(r.body.messages.length).toBe(2);
  });
});
