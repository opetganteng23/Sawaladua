import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { bubblesFrom, login, parseSse, setup, until } from "./helpers.js";
import { resetBudgetCache } from "../src/lib/budget.js";
import { sweepCalls } from "../src/lib/calls.js";
import { LlmQuotaError } from "../src/llm/types.js";

type U = Awaited<ReturnType<typeof login>>;
let n = 0;
const cid = () => `p34-msg-${Date.now()}-${n++}`;
const chat = async (u: U, body: Record<string, unknown>) => {
  const r = await u.call("post", "/api/chat", { clientMessageId: cid(), ...body });
  return { status: r.status, events: r.status === 200 ? parseSse(r.text) : [], body: r.body };
};

describe("gerbang usia, anggaran, kuota, admin", () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { env = await setup({ DAILY_TOKEN_BUDGET_PER_USER: "500" }); });
  afterAll(async () => { await env.stop(); });

  it("chat ditolak tanpa konfirmasi usia 18+ (ditegakkan server)", async () => {
    const u = await login(env.app, "muda@x.com", { confirmAge: false });
    const r = await chat(u, { text: "halo" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("AGE_CONFIRMATION_REQUIRED");
    expect((await u.call("post", "/api/calls", { transcriptConsent: false })).status).toBe(403);
    await u.call("patch", "/api/settings", { ageConfirmed: true });
    expect((await chat(u, { text: "halo" })).status).toBe(200);
    expect((await u.call("patch", "/api/settings", { ageConfirmed: false })).status).toBe(400);
  });

  it("anggaran per pengguna habis -> pesan jujur & tersimpan; pengguna berisiko tetap dijawab", async () => {
    resetBudgetCache();
    const u = await login(env.app, "budget@x.com");
    expect((await chat(u, { text: "halo" })).events.at(-1)!.event).toBe("message_completed"); // memakai >500 token (mock)
    const over = await chat(u, { text: "halo lagi" });
    const err = over.events.find((e) => e.event === "error")!;
    expect(err.data.code).toBe("QUOTA_EXHAUSTED");
    expect(err.data.retryable).toBe(false);
    expect(err.data.userMessage).toMatch(/sudah tersimpan/);
    const convId = over.events[0]!.data.conversationId;
    const roles = (await u.call("get", `/api/conversations/${convId}/messages`)).body.items.map((m: { role: string }) => m.role);
    expect(roles.filter((r: string) => r === "user").length).toBeGreaterThanOrEqual(1);

    const risky = await chat(u, { text: "aku pengen mati aja rasanya" });
    expect(risky.events.find((e) => e.event === "error")).toBeUndefined();
    expect(bubblesFrom(risky.events).join(" ")).toMatch(/layanan darurat/);
  });

  it("provider menolak karena kuota -> QUOTA_EXHAUSTED; level risiko tetap dapat respons aman", async () => {
    const orig = env.ctx.llm.generate;
    env.ctx.llm.generate = async () => { throw new LlmQuotaError(); };
    try {
      const u = await login(env.app, "quota@x.com");
      const r = await chat(u, { text: "halo" });
      expect(r.events.find((e) => e.event === "error")!.data.code).toBe("QUOTA_EXHAUSTED");
      const risky = await chat(u, { text: "kadang aku pengen mati aja" });
      expect(bubblesFrom(risky.events).join(" ")).toMatch(/tidak bisa memantau/);
    } finally { env.ctx.llm.generate = orig; }
  });

  it("admin usage: hanya admin, agregat tanpa isi percakapan, biaya tidak dikarang", async () => {
    const admin = await login(env.app, "admin@x.com");
    const user = await login(env.app, "bukanadmin@x.com");
    expect((await user.call("get", "/api/admin/usage")).status).toBe(404);
    const r = await admin.call("get", "/api/admin/usage?days=7");
    expect(r.status).toBe(200);
    expect(r.body.daily.length).toBeGreaterThan(0);
    expect(r.body.daily[0].estimatedCost).toBeNull();
    expect(r.body.costNote).toMatch(/belum dikonfigurasi/);
    expect(JSON.stringify(r.body)).not.toMatch(/halo|namaku|userId/);
  });
});

describe("fase 3: panggilan suara", () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { env = await setup(); });
  afterAll(async () => { await env.stop(); });

  it("tanpa persetujuan transkrip: teks sementara dipakai selama panggilan lalu dihapus, tanpa memori", async () => {
    const u = await login(env.app, "call1@x.com");
    const c = await u.call("post", "/api/calls", { transcriptConsent: false });
    expect(c.status).toBe(201);
    const orig = env.ctx.llm.generate;
    let sys = "";
    env.ctx.llm.generate = async (r) => { if (!r.system.includes("[TUGAS")) sys = r.system; return orig(r); };
    try {
      const r = await chat(u, { text: "namaku Citra, aku lagi capek", callId: c.body.id });
      expect(r.events.at(-1)!.event).toBe("message_completed");
      expect(sys).toMatch(/PANGGILAN SUARA/);
      expect(sys).toMatch(/tanpa emoji|Jangan gunakan emoji/);
    } finally { env.ctx.llm.generate = orig; }
    const uid = new ObjectId(u.user.id);
    const msgs = await env.ctx.d.c.messages.find({ userId: uid }).toArray();
    expect(msgs.length).toBe(2);
    expect(msgs.every((m) => m.channel === "call")).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    expect(await env.ctx.d.c.memories.countDocuments({ userId: uid })).toBe(0);

    const end = await u.call("post", `/api/calls/${c.body.id}/end`, { avgLatencyMs: 900, clientTurns: 1 });
    expect(end.body.transcriptKept).toBe(false);
    expect(await env.ctx.d.c.messages.countDocuments({ userId: uid })).toBe(0);
    expect(await env.ctx.d.c.conversations.countDocuments({ userId: uid })).toBe(0);
    // idempoten + panggilan berakhir tidak bisa dipakai lagi
    expect((await u.call("post", `/api/calls/${c.body.id}/end`, {})).status).toBe(200);
    const again = await chat(u, { text: "halo", callId: c.body.id });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("CALL_NOT_ACTIVE");
  });

  it("dengan persetujuan transkrip: riwayat tersimpan dan memori boleh dibuat", async () => {
    const u = await login(env.app, "call2@x.com");
    const c = await u.call("post", "/api/calls", { transcriptConsent: true });
    await chat(u, { text: "namaku Dewi", callId: c.body.id });
    await until(async () => (await u.call("get", "/api/memories")).body.items[0]);
    expect((await u.call("post", `/api/calls/${c.body.id}/end`, {})).body.transcriptKept).toBe(true);
    const convs = (await u.call("get", "/api/conversations")).body.items;
    expect(convs.some((x: { title: string }) => x.title === "Panggilan suara")).toBe(true);
  });

  it("pesan krisis di panggilan memakai jalur keselamatan yang sama", async () => {
    const u = await login(env.app, "call3@x.com");
    const c = await u.call("post", "/api/calls", { transcriptConsent: false });
    const orig = env.ctx.llm.generate;
    let called = 0;
    env.ctx.llm.generate = async (r) => { called++; return orig(r); };
    try {
      const r = await chat(u, { text: "aku mau bunuh diri malam ini", callId: c.body.id });
      expect(called).toBe(0);
      expect(bubblesFrom(r.events).join(" ")).toMatch(/layanan darurat/);
    } finally { env.ctx.llm.generate = orig; }
  });

  it("isolasi: panggilan pengguna lain tidak bisa dipakai atau diakhiri", async () => {
    const a = await login(env.app, "call4a@x.com");
    const b = await login(env.app, "call4b@x.com");
    const c = await a.call("post", "/api/calls", { transcriptConsent: false });
    expect((await chat(b, { text: "halo", callId: c.body.id })).status).toBe(404);
    expect((await b.call("post", `/api/calls/${c.body.id}/end`, {})).status).toBe(404);
  });

  it("durasi maksimum dan panggilan terlantar diakhiri otomatis", async () => {
    const u = await login(env.app, "call5@x.com");
    const c = await u.call("post", "/api/calls", { transcriptConsent: false });
    const id = new ObjectId(c.body.id);
    await env.ctx.d.c.call_sessions.updateOne({ _id: id }, { $set: { startedAt: new Date(Date.now() - 31 * 60_000) } });
    const r = await chat(u, { text: "halo", callId: c.body.id });
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("CALL_EXPIRED");

    const c2 = await u.call("post", "/api/calls", { transcriptConsent: false });
    await env.ctx.d.c.call_sessions.updateOne({ _id: new ObjectId(c2.body.id) }, { $set: { lastActivityAt: new Date(Date.now() - 11 * 60_000) } });
    expect(await sweepCalls(env.ctx)).toBeGreaterThanOrEqual(1);
    expect((await env.ctx.d.c.call_sessions.findOne({ _id: new ObjectId(c2.body.id) }))!.status).toBe("ended");
  });

  it("hapus akun menghapus data panggilan; ekspor memuat metadata tanpa audio", async () => {
    const u = await login(env.app, "call6@x.com");
    await u.call("post", "/api/calls", { transcriptConsent: true });
    const exp = await u.call("post", "/api/data/export", {});
    expect(exp.body.calls.length).toBe(1);
    expect(JSON.stringify(exp.body.calls)).not.toMatch(/audio/i);
    const del = await u.call("delete", "/api/me", { confirm: "HAPUS" });
    await until(async () => (await env.ctx.d.c.deletion_jobs.findOne({ userId: new ObjectId(u.user.id) }))?.status === "completed");
    void del;
    expect(await env.ctx.d.c.call_sessions.countDocuments({ userId: new ObjectId(u.user.id) })).toBe(0);
  });
});

describe("fase 3 dimatikan lewat flag", () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { env = await setup({ FEATURE_VOICE_CALLS: "false" }); });
  afterAll(async () => { await env.stop(); });
  it("endpoint panggilan tidak tersedia", async () => {
    const u = await login(env.app, "off@x.com");
    expect((await u.call("post", "/api/calls", { transcriptConsent: false })).status).toBe(404);
    expect((await u.call("get", "/api/auth/session")).body.features.voiceCalls).toBe(false);
    expect((await chat(u, { text: "halo", callId: "507f1f77bcf86cd799439011" })).status).toBe(404);
  });
});
