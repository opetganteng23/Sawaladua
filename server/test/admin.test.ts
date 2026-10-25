import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { ObjectId } from "mongodb";
import { login, parseSse, setup, until } from "./helpers.js";
import { decryptSecret, encryptSecret, maskSecret } from "../src/lib/crypto.js";

const KEY = randomBytes(32).toString("base64");
type U = Awaited<ReturnType<typeof login>>;

// server HTTP palsu bergaya OpenAI untuk membuktikan penggantian provider saat runtime
interface Seen { url: string; auth: string | undefined; body: Record<string, unknown> }
let fake: Server, fakeUrl = "";
const seen: Seen[] = [];
beforeAll(async () => {
  fake = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { if (/json/.test(req.headers["content-type"] ?? "")) body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* multipart/biner: abaikan */ }
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/chat/completions") return void res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ bubbles: ["Halo dari provider OpenAI palsu."], mood: "hangat", response_strategy: "listen" }) } }], usage: { prompt_tokens: 7, completion_tokens: 5 } }));
      if (req.url === "/embeddings") { const n = (body.input as string[]).length, d = body.dimensions as number; return void res.end(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: Array.from({ length: d }, (_, j) => (j === i % d ? 1 : 0.01)) })) })); }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(() => fake.close());

let env: Awaited<ReturnType<typeof setup>>;
let n = 0;
const cid = () => `adm-msg-${Date.now()}-${n++}`;
const email = (t: string) => `${t}-${Date.now()}-${n++}@x.com`;
beforeAll(async () => { env = await setup({ ADMIN_EMAILS: "owner@x.com", SETTINGS_ENCRYPTION_KEY: KEY, OPENAI_BASE_URL: fakeUrl, DAILY_MESSAGE_LIMIT: "200" }); });
afterAll(async () => { await env.stop(); });

const chat = async (u: U, text = "halo") => { const r = await u.call("post", "/api/chat", { clientMessageId: cid(), text }); return { status: r.status, events: r.status === 200 ? parseSse(r.text) : [], body: r.body }; };
const makeAdmin = async (): Promise<U> => {
  const owner = await login(env.app, "owner@x.com");
  const a = await login(env.app, email("adm"));
  const r = await owner.call("patch", `/api/admin/users/${a.user.id}`, { role: "admin" });
  expect(r.status).toBe(200);
  return a;
};
const resetSettings = async () => (await login(env.app, "owner@x.com")).call("post", "/api/admin/settings/reset", { section: "all" });

describe("hak akses dasbor", () => {
  it("pengguna biasa tidak melihat apa pun (404); admin vs pemilik dibedakan", async () => {
    const owner = await login(env.app, "owner@x.com");
    const admin = await makeAdmin();
    const user = await login(env.app, email("u"));
    for (const [m, url] of [["get", "/api/admin/users"], ["get", "/api/admin/settings"], ["get", "/api/admin/providers"], ["get", "/api/admin/audit"], ["get", "/api/admin/invites"], ["put", "/api/admin/providers"]] as const)
      expect((await user.call(m, url, m === "put" ? {} : undefined)).status, `${m} ${url}`).toBe(404);
    expect((await admin.call("get", "/api/admin/users")).status).toBe(200);
    expect((await admin.call("get", "/api/admin/settings")).status).toBe(200);
    expect((await admin.call("get", "/api/admin/providers")).status).toBe(200); // lihat (dimask)
    expect((await admin.call("put", "/api/admin/providers", { keys: { openai: "sk-12345678" } })).status).toBe(404); // ubah: hanya pemilik
    expect((await admin.call("post", "/api/admin/providers/test", { capability: "llm" })).status).toBe(404);
    expect((await owner.call("get", "/api/auth/session")).body.user.adminRole).toBe("owner");
    expect((await admin.call("get", "/api/auth/session")).body.user.adminRole).toBe("admin");
    expect((await user.call("get", "/api/auth/session")).body.user.adminRole).toBeNull();
  });
});

describe("pengguna: daftar, filter, urutan, tanpa isi percakapan", () => {
  it("paginasi, pencarian, filter, hitungan agregat; respons tidak memuat isi chat", async () => {
    const owner = await login(env.app, "owner@x.com");
    const tag = `lst${Date.now()}`;
    const users: U[] = [];
    for (let i = 0; i < 5; i++) users.push(await login(env.app, `${tag}-${i}@x.com`));
    await chat(users[0]!, "rahasia pribadi nomor satu");
    await until(async () => (await owner.call("get", `/api/admin/users?q=${tag}`)).body.items.some((x: { counts: { messages: number } }) => x.counts.messages >= 2));
    const p1 = (await owner.call("get", `/api/admin/users?q=${tag}&limit=2&page=1&sort=email&dir=asc`)).body;
    expect(p1.total).toBe(5); expect(p1.pages).toBe(3); expect(p1.items).toHaveLength(2);
    expect(p1.items[0].email).toBe(`${tag}-0@x.com`);
    const p3 = (await owner.call("get", `/api/admin/users?q=${tag}&limit=2&page=3&sort=email&dir=asc`)).body;
    expect(p3.items).toHaveLength(1);
    const first = (await owner.call("get", `/api/admin/users?q=${tag}-0`)).body.items[0];
    expect(first.counts).toMatchObject({ conversations: 1, messages: 2 });
    expect(first.counts.tokens30d).toBeGreaterThan(0);
    expect(JSON.stringify(p1) + JSON.stringify(first)).not.toMatch(/rahasia pribadi/);
    expect((await owner.call("get", "/api/admin/users?role=owner")).body.items.map((x: { email: string }) => x.email)).toContain("owner@x.com");
    expect((await owner.call("get", `/api/admin/users?q=${tag}&status=suspended`)).body.total).toBe(0);
    expect((await owner.call("get", "/api/admin/users?limit=500")).status).toBe(400);
    expect((await owner.call("get", "/api/admin/users?sort=password")).status).toBe(400);
    expect((await owner.call("get", `/api/admin/users/${users[0]!.user.id}`)).body.activeSessions).toBeGreaterThanOrEqual(1);
    expect((await owner.call("get", "/api/admin/users/bukan-id")).status).toBe(404);
  });
});

describe("pengguna: tangguhkan, pulihkan, peran, hapus, proteksi", () => {
  it("tangguhkan mencabut sesi dan memblokir login; pulihkan mengembalikan akses; semua tercatat di audit", async () => {
    const owner = await login(env.app, "owner@x.com");
    const mail = email("susp");
    const u = await login(env.app, mail);
    expect((await u.call("get", "/api/conversations")).status).toBe(200);
    const r = await owner.call("patch", `/api/admin/users/${u.user.id}`, { status: "suspended", note: "uji" });
    expect(r.body).toMatchObject({ status: "suspended", note: "uji" });
    expect((await u.call("get", "/api/conversations")).status).toBe(401); // sesi dicabut
    const again = await request(env.app).post("/api/auth/dev").set("X-Requested-With", "sawala").send({ email: mail });
    expect(again.status).toBe(403); expect(again.body.error.code).toBe("ACCOUNT_SUSPENDED");
    expect((await owner.call("patch", `/api/admin/users/${u.user.id}`, { status: "active" })).body.status).toBe("active");
    expect((await request(env.app).post("/api/auth/dev").set("X-Requested-With", "sawala").send({ email: mail })).status).toBe(200);
    const log = (await owner.call("get", `/api/admin/audit?q=${mail}`)).body.items.map((a: { action: string }) => a.action);
    expect(log).toEqual(expect.arrayContaining(["user.suspend", "user.restore"]));
  });

  it("proteksi: tidak bisa mengubah diri sendiri/pemilik; admin tidak bisa mengubah admin lain atau peran; hanya pemilik mengangkat admin", async () => {
    const owner = await login(env.app, "owner@x.com");
    const adminA = await makeAdmin(), adminB = await makeAdmin();
    const user = await login(env.app, email("t"));
    expect((await owner.call("patch", `/api/admin/users/${owner.user.id}`, { status: "suspended" })).body.error.code).toBe("OWNER_PROTECTED");
    expect((await adminA.call("patch", `/api/admin/users/${adminA.user.id}`, { status: "suspended" })).body.error.code).toBe("SELF_PROTECTED");
    expect((await adminA.call("patch", `/api/admin/users/${owner.user.id}`, { status: "suspended" })).body.error.code).toBe("OWNER_PROTECTED");
    expect((await adminA.call("patch", `/api/admin/users/${adminB.user.id}`, { status: "suspended" })).body.error.code).toBe("OWNER_REQUIRED");
    expect((await adminA.call("patch", `/api/admin/users/${user.user.id}`, { role: "admin" })).body.error.code).toBe("OWNER_REQUIRED");
    expect((await adminA.call("patch", `/api/admin/users/${user.user.id}`, { status: "suspended" })).status).toBe(200); // admin boleh pada pengguna biasa
    expect((await adminA.call("patch", `/api/admin/users/${user.user.id}`, {})).status).toBe(400);
    expect((await adminA.call("patch", `/api/admin/users/${user.user.id}`, { email: "x@y.com" })).status).toBe(400); // field asing ditolak
    expect((await owner.call("patch", `/api/admin/users/${adminB.user.id}`, { role: "user" })).body.role).toBe("user");
  });

  it("hapus pengguna: wajib konfirmasi email; menjalankan workflow penghapusan sampai selesai", async () => {
    const owner = await login(env.app, "owner@x.com");
    const mail = email("del");
    const u = await login(env.app, mail);
    await chat(u, "namaku Budi");
    expect((await owner.call("delete", `/api/admin/users/${u.user.id}`, { confirmEmail: "salah@x.com" })).body.error.code).toBe("CONFIRM_MISMATCH");
    expect((await owner.call("delete", `/api/admin/users/${owner.user.id}`, { confirmEmail: "owner@x.com" })).body.error.code).toBe("SELF_PROTECTED");
    const r = await owner.call("delete", `/api/admin/users/${u.user.id}`, { confirmEmail: mail });
    expect(r.status).toBe(202);
    const uid = new ObjectId(u.user.id);
    await until(async () => (await env.ctx.d.c.users.countDocuments({ _id: uid })) === 0);
    expect(await env.ctx.d.c.messages.countDocuments({ userId: uid })).toBe(0);
    expect((await owner.call("get", `/api/admin/audit?action=user.delete`)).body.items.some((a: { target: string }) => a.target === mail)).toBe(true);
  });

  it("cabut sesi pengguna lain", async () => {
    const owner = await login(env.app, "owner@x.com");
    const u = await login(env.app, email("rs"));
    expect((await owner.call("post", `/api/admin/users/${u.user.id}/revoke-sessions`, {})).body.revoked).toBeGreaterThanOrEqual(1);
    expect((await u.call("get", "/api/conversations")).status).toBe(401);
  });
});

describe("undangan dan aturan pendaftaran (CRUD)", () => {
  it("pendaftaran ditutup: pengguna baru ditolak, pengguna lama tetap bisa; undangan membuka akses dengan peran yang ditetapkan", async () => {
    const owner = await login(env.app, "owner@x.com");
    const existing = email("old");
    await login(env.app, existing);
    const adm = await makeAdmin(); // dibuat sebelum pendaftaran ditutup
    const s = (await owner.call("get", "/api/admin/settings")).body.value;
    s.access.registrationOpen = false;
    expect((await owner.call("put", "/api/admin/settings", { value: s })).status).toBe(200);
    try {
      const newcomer = email("new");
      const denied = await request(env.app).post("/api/auth/dev").set("X-Requested-With", "sawala").send({ email: newcomer });
      expect(denied.status).toBe(403); expect(denied.body.error.code).toBe("REGISTRATION_CLOSED");
      expect((await request(env.app).post("/api/auth/dev").set("X-Requested-With", "sawala").send({ email: existing })).status).toBe(200);

      // Create
      const inv = await owner.call("post", "/api/admin/invites", { email: newcomer.toUpperCase(), role: "user" });
      expect(inv.status).toBe(201);
      expect((await owner.call("post", "/api/admin/invites", { email: newcomer })).body.error.code).toBe("INVITE_EXISTS");
      expect((await owner.call("post", "/api/admin/invites", { email: existing })).body.error.code).toBe("USER_EXISTS");
      expect((await owner.call("post", "/api/admin/invites", { email: "bukan-email" })).status).toBe(400);
      // Read
      const list = (await owner.call("get", `/api/admin/invites?q=${newcomer.slice(0, 8)}`)).body;
      expect(list.items.some((i: { email: string; usedAt: unknown }) => i.email === newcomer && i.usedAt === null)).toBe(true);
      // Use -> Update (usedAt)
      expect((await request(env.app).post("/api/auth/dev").set("X-Requested-With", "sawala").send({ email: newcomer })).status).toBe(200);
      expect((await owner.call("get", `/api/admin/invites?q=${newcomer.slice(0, 8)}`)).body.items[0].usedAt).not.toBeNull();
      // admin diundang oleh pemilik mendapat peran admin; admin biasa tidak boleh mengundang admin
      const adminMail = email("invadm");
      expect((await owner.call("post", "/api/admin/invites", { email: adminMail, role: "admin" })).status).toBe(201);
      await request(env.app).post("/api/auth/dev").set("X-Requested-With", "sawala").send({ email: adminMail });
      expect((await env.ctx.d.c.users.findOne({ email: adminMail }))!.role).toBe("admin");
      expect((await adm.call("post", "/api/admin/invites", { email: email("x"), role: "admin" })).body.error.code).toBe("OWNER_REQUIRED");
      // Delete
      const toDel = (await owner.call("post", "/api/admin/invites", { email: email("tmp") })).body.id;
      expect((await owner.call("delete", `/api/admin/invites/${toDel}`)).status).toBe(200);
      expect((await owner.call("delete", `/api/admin/invites/${toDel}`)).status).toBe(404);
    } finally { await resetSettings(); }
  });

  it("daftar domain email yang diizinkan", async () => {
    const owner = await login(env.app, "owner@x.com");
    const s = (await owner.call("get", "/api/admin/settings")).body.value;
    s.access.allowedEmailDomains = ["kampus.ac.id"];
    await owner.call("put", "/api/admin/settings", { value: s });
    try {
      const bad = await request(env.app).post("/api/auth/dev").set("X-Requested-With", "sawala").send({ email: email("dom") });
      expect(bad.body.error.code).toBe("EMAIL_DOMAIN_NOT_ALLOWED");
      expect((await request(env.app).post("/api/auth/dev").set("X-Requested-With", "sawala").send({ email: `ok-${Date.now()}@kampus.ac.id` })).status).toBe(200);
    } finally { await resetSettings(); }
  });
});

describe("pengaturan situs: baca, ubah, validasi, berlaku seketika, reset", () => {
  it("nilai tersimpan, tampil di /api/site publik, dan divalidasi ketat per field", async () => {
    const owner = await login(env.app, "owner@x.com");
    const cur = (await owner.call("get", "/api/admin/settings")).body;
    expect(cur.defaults.name).toBe("Sawala");
    const v = structuredClone(cur.value);
    v.name = "Teman Cerita"; v.tagline = "Ruang ngobrolmu"; v.supportEmail = "bantuan@contoh.id"; v.defaultTheme = "senja";
    v.ui.disclaimer = "Ini AI, bukan tenaga profesional.";
    const ok = await owner.call("put", "/api/admin/settings", { value: v });
    expect(ok.status).toBe(200);
    const pub = (await request(env.app).get("/api/site")).body;
    expect(pub).toMatchObject({ name: "Teman Cerita", tagline: "Ruang ngobrolmu", defaultTheme: "senja", ui: { disclaimer: "Ini AI, bukan tenaga profesional." } });
    expect(JSON.stringify(pub)).not.toMatch(/crisis|webhook|apiKey/i);
    expect((await request(env.app).get("/api/auth/session")).body.site.name).toBe("Teman Cerita");
    // tema bawaan situs dipakai pengguna baru
    const fresh = await login(env.app, email("thm"));
    expect((await fresh.call("get", "/api/settings")).body.preferences.theme).toBe("senja");
    // validasi
    const bad = structuredClone(v);
    bad.supportEmail = "bukan-email"; bad.limits.dailyMessageLimit = -5; bad.alerts.webhookUrl = "http://tidak-aman.example";
    const r = await owner.call("put", "/api/admin/settings", { value: bad });
    expect(r.status).toBe(400); expect(r.body.error.code).toBe("INVALID_SETTINGS");
    expect(r.body.error.fields.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(["supportEmail", "limits.dailyMessageLimit", "alerts.webhookUrl"]));
    expect((await owner.call("put", "/api/admin/settings", { value: { ...v, rahasia: 1 } })).status).toBe(400); // field asing ditolak
    expect((await owner.call("put", "/api/admin/settings", { value: { ...v, ui: { ...v.ui, emptyLines: ["satu"] } } })).status).toBe(400);
    await resetSettings();
    expect((await request(env.app).get("/api/site")).body.name).toBe("Sawala");
  });

  it("batas dan teks krisis berlaku seketika tanpa restart; reset mengembalikan nilai env", async () => {
    const owner = await login(env.app, "owner@x.com");
    const u = await login(env.app, email("lim"));
    const v = (await owner.call("get", "/api/admin/settings")).body.value;
    v.limits.dailyMessageLimit = 1; v.limits.maxMessageChars = 100;
    v.safety.crisisResourcesText = "Hubungi layanan uji 119 (teks sintetis)";
    const saved = (await owner.call("put", "/api/admin/settings", { value: v })).body;
    expect(saved.effective["limits.dailyMessageLimit"]).toMatchObject({ value: 1, source: "db", envDefault: 200 });
    expect((await chat(u, "pesan pertama")).status).toBe(200);
    const second = await chat(u, "pesan kedua");
    expect(second.status).toBe(429); expect(second.body.error.code).toBe("DAILY_LIMIT");
    const u2 = await login(env.app, email("lim2"));
    expect((await chat(u2, "x".repeat(101))).status).toBe(413);
    const crisis = await chat(u2, "aku mau bunuh diri malam ini");
    expect(crisis.events.filter((e) => e.event === "bubble_delta").map((e) => e.data.text).join("")).toContain("layanan uji 119");
    await owner.call("post", "/api/admin/settings/reset", { section: "limits" });
    expect((await owner.call("get", "/api/admin/settings")).body.effective["limits.dailyMessageLimit"]).toMatchObject({ value: 200, source: "env" });
    expect((await chat(u, "lagi")).status).toBe(200);
    await resetSettings();
  });

  it("catatan persona operator masuk ke prompt, tanpa menghapus aturan keselamatan", async () => {
    const owner = await login(env.app, "owner@x.com");
    const u = await login(env.app, email("per"));
    const v = (await owner.call("get", "/api/admin/settings")).body.value;
    v.persona.extraInstructions = "Sapa dengan ramah dan sebut cuaca pesisir.";
    await owner.call("put", "/api/admin/settings", { value: v });
    const orig = env.ctx.llm.generate;
    let sys = "";
    env.ctx.llm.generate = async (r) => { if (!r.system.includes("[TUGAS")) sys = r.system; return orig(r); };
    try { await chat(u, "halo"); } finally { env.ctx.llm.generate = orig; await resetSettings(); }
    expect(sys).toMatch(/sebut cuaca pesisir/);
    expect(sys).toMatch(/tidak boleh mengalahkan aturan keselamatan/);
    expect(sys).toMatch(/Jangan mendiagnosis/);
  });

  it("mode pemeliharaan: pengguna biasa 503, admin tetap bisa, auth/site tetap terbuka", async () => {
    const owner = await login(env.app, "owner@x.com");
    const u = await login(env.app, email("mnt"));
    const v = (await owner.call("get", "/api/admin/settings")).body.value;
    v.access.maintenance = { enabled: true, message: "Sedang pemeliharaan uji." };
    await owner.call("put", "/api/admin/settings", { value: v });
    try {
      const r = await u.call("get", "/api/conversations");
      expect(r.status).toBe(503); expect(r.body.error).toMatchObject({ code: "MAINTENANCE", message: "Sedang pemeliharaan uji.", retryable: true });
      expect((await u.call("get", "/api/auth/session")).status).toBe(200);
      expect((await request(env.app).get("/api/site")).body.maintenance.enabled).toBe(true);
      expect((await owner.call("get", "/api/conversations")).status).toBe(200);
      expect((await owner.call("get", "/api/admin/settings")).status).toBe(200);
    } finally { await resetSettings(); }
    expect((await u.call("get", "/api/conversations")).status).toBe(200);
  });

  it("halaman hukum buatan admin dirender aman (tanpa HTML mentah); kosong = halaman bawaan", async () => {
    const owner = await login(env.app, "owner@x.com");
    const v = (await owner.call("get", "/api/admin/settings")).body.value;
    v.legal.privacy = "# Kebijakan Kami\n\nParagraf <script>alert(1)</script> pertama.\n\n## Data\n- satu\n- dua & tiga";
    await owner.call("put", "/api/admin/settings", { value: v });
    try {
      const page = await request(env.app).get("/privasi.html");
      expect(page.status).toBe(200);
      expect(page.text).toContain("<h1>Kebijakan Kami</h1>");
      expect(page.text).toContain("&lt;script&gt;");
      expect(page.text).not.toContain("<script>alert");
      expect(page.text).toContain("<li>dua &amp; tiga</li>");
    } finally { await resetSettings(); }
    const def = await request(env.app).get("/privasi.html");
    expect(def.text).not.toContain("Kebijakan Kami");
  });
});

describe("provider AI: ganti saat runtime, kunci terenkripsi dan dimask", () => {
  it("kriptografi: round-trip, kunci salah dan data rusak ditolak, masking", () => {
    const blob = encryptSecret("sk-rahasia-12345678", KEY);
    expect(blob).not.toContain("rahasia");
    expect(decryptSecret(blob, KEY)).toBe("sk-rahasia-12345678");
    expect(() => decryptSecret(blob, randomBytes(32).toString("base64"))).toThrow();
    expect(() => decryptSecret(blob.slice(0, -3) + "AAA", KEY)).toThrow();
    expect(() => encryptSecret("x", "pendek")).toThrow(/32 byte/);
    expect(maskSecret("sk-rahasia-12345678")).toBe("••••5678");
    expect(maskSecret("abc")).toBe("••••");
    expect(maskSecret("")).toBe("");
  });

  it("owner mengganti LLM ke OpenAI + menyimpan kunci: chat langsung memakainya; kunci tidak bocor di DB/respons/audit", async () => {
    const owner = await login(env.app, "owner@x.com");
    const u = await login(env.app, email("prov"));
    const before = (await owner.call("get", "/api/admin/providers")).body;
    expect(before.capabilities.find((c: { capability: string }) => c.capability === "llm")).toMatchObject({ provider: "mock", source: "env" });
    expect(before.encryptionConfigured).toBe(true);

    const secret = "sk-uji-rahasia-9876";
    const put = await owner.call("put", "/api/admin/providers", { providers: { llm: { provider: "openai", model: "model-uji-1" } }, keys: { openai: secret } });
    expect(put.status).toBe(200);
    const llm = put.body.capabilities.find((c: { capability: string }) => c.capability === "llm");
    expect(llm).toMatchObject({ provider: "openai", model: "model-uji-1", source: "db" });
    expect(put.body.keys.openai).toEqual({ source: "db", masked: "••••9876" });
    expect(JSON.stringify(put.body)).not.toContain(secret);

    seen.length = 0;
    const r = await chat(u, "halo provider baru");
    expect(r.events.filter((e) => e.event === "bubble_delta").map((e) => e.data.text).join("")).toContain("OpenAI palsu");
    const call = seen.find((s) => s.url === "/chat/completions")!;
    expect(call.auth).toBe(`Bearer ${secret}`);
    expect(call.body.model).toBe("model-uji-1");

    // DB hanya menyimpan ciphertext
    const raw = JSON.stringify(await env.ctx.d.c.app_settings.find().toArray());
    expect(raw).not.toContain(secret);
    expect(raw).toContain("v1.");
    // audit mencatat nama vendor, bukan nilainya
    const audit = JSON.stringify((await owner.call("get", "/api/admin/audit?action=providers")).body.items);
    expect(audit).not.toContain(secret);
    expect(audit).toContain("openai:diganti");

    // uji koneksi memakai konfigurasi berlaku
    const t = await owner.call("post", "/api/admin/providers/test", { capability: "llm" });
    expect(t.body).toMatchObject({ ok: true, capability: "llm" });

    // kembali ke bawaan env: chat memakai mock lagi, kunci DB dihapus
    const back = await owner.call("put", "/api/admin/providers", { providers: { llm: null }, keys: { openai: null } });
    expect(back.body.capabilities.find((c: { capability: string }) => c.capability === "llm")).toMatchObject({ provider: "mock", source: "env" });
    expect(back.body.keys.openai.source).toBe("none");
    seen.length = 0;
    await chat(u, "balik ke mock");
    expect(seen.some((s) => s.url === "/chat/completions")).toBe(false);
  });

  it("validasi: kombinasi tidak sah, nama model berbahaya, bidang asing, dan kunci terlalu pendek ditolak dengan galat per-field", async () => {
    const owner = await login(env.app, "owner@x.com");
    const bad1 = await owner.call("put", "/api/admin/providers", { providers: { embedding: { provider: "anthropic", model: "x", dimensions: 256 } } });
    expect(bad1.status).toBe(400);
    const bad2 = await owner.call("put", "/api/admin/providers", { providers: { llm: { provider: "openai", model: "../../etc/passwd?x=1" } } });
    expect(bad2.status).toBe(400); expect(bad2.body.error.fields[0].path).toContain("llm.model");
    const bad3 = await owner.call("put", "/api/admin/providers", { providers: { llm: { provider: "anthropic", model: "claude-uji" } } }); // tanpa kunci anthropic
    expect(bad3.status).toBe(400); expect(bad3.body.error.code).toBe("INVALID_PROVIDERS");
    expect(bad3.body.error.fields[0].message).toMatch(/anthropic/i);
    expect((await owner.call("put", "/api/admin/providers", { baseUrl: "http://169.254.169.254" })).status).toBe(400); // base URL tidak bisa diubah (SSRF)
    expect((await owner.call("put", "/api/admin/providers", { keys: { openai: "pendek" } })).status).toBe(400);
    expect((await owner.call("get", "/api/admin/providers")).body.capabilities.find((c: { capability: string }) => c.capability === "llm").provider).toBe("mock"); // tidak ada yang berubah
  });

  it("mengganti embedding: butuh konfirmasi, vektor lama tidak dipakai, lalu dihitung ulang di latar belakang", async () => {
    const owner = await login(env.app, "owner@x.com");
    const u = await login(env.app, email("emb"));
    const uid = new ObjectId(u.user.id);
    await chat(u, "namaku Rani");
    await until(async () => (await u.call("get", "/api/memories")).body.items[0]);
    const body = { providers: { embedding: { provider: "openai", model: "emb-uji", dimensions: 8 } }, keys: { openai: "sk-uji-embedding-1" } };
    const need = await owner.call("put", "/api/admin/providers", body);
    expect(need.status).toBe(409); expect(need.body.error.code).toBe("EMBEDDING_CHANGE_NEEDS_CONFIRM");
    expect((await owner.call("get", "/api/admin/providers")).body.embeddingTag).toBe("mock/mock/256"); // belum berubah
    const ok = await owner.call("put", "/api/admin/providers", { ...body, confirmEmbeddingChange: true });
    expect(ok.status).toBe(200);
    expect(ok.body.embeddingTag).toBe("openai/emb-uji/8");
    expect(ok.body.stale.memories).toBeGreaterThanOrEqual(1);
    // vektor lama tidak ikut retrieval
    const orig = env.ctx.llm.generate;
    let sys = "";
    env.ctx.llm.generate = async (r) => { if (!r.system.includes("[TUGAS")) sys = r.system; return orig(r); };
    try { await chat(u, "siapa namaku Rani"); } finally { env.ctx.llm.generate = orig; }
    expect(sys).not.toMatch(/bernama Rani/);
    // hitung ulang
    expect((await owner.call("post", "/api/admin/reembed", {})).status).toBe(202);
    await until(async () => (await owner.call("get", "/api/admin/providers")).body.reembed.status === "completed");
    const done = (await owner.call("get", "/api/admin/providers")).body;
    expect(done.stale).toEqual({ memories: 0, summaries: 0 });
    const m = await env.ctx.d.c.memories.findOne({ userId: uid });
    expect(m!.embeddingTag).toBe("openai/emb-uji/8");
    expect(m!.embedding).toHaveLength(8);
    // kembalikan ke mock agar tes lain tidak terpengaruh
    await owner.call("put", "/api/admin/providers", { providers: { embedding: null }, keys: { openai: null }, confirmEmbeddingChange: true });
    await owner.call("post", "/api/admin/reembed", {});
    await until(async () => (await owner.call("get", "/api/admin/providers")).body.stale.memories === 0);
  });

  it("menyimpan kunci tanpa SETTINGS_ENCRYPTION_KEY ditolak (tidak pernah menyimpan plaintext)", async () => {
    const env2 = await setup({ ADMIN_EMAILS: "owner@x.com" });
    try {
      const owner = await login(env2.app, "owner@x.com");
      expect((await owner.call("get", "/api/admin/providers")).body.encryptionConfigured).toBe(false);
      const r = await owner.call("put", "/api/admin/providers", { keys: { gemini: "kunci-uji-12345678" } });
      expect(r.status).toBe(400); expect(r.body.error.code).toBe("ENCRYPTION_KEY_MISSING");
      expect(JSON.stringify(await env2.ctx.d.c.app_settings.find().toArray())).not.toContain("kunci-uji");
    } finally { await env2.stop(); }
  });

  it("uji koneksi: galat provider tidak diteruskan apa adanya", async () => {
    const owner = await login(env.app, "owner@x.com");
    const r = await owner.call("post", "/api/admin/providers/test", { capability: "llm", provider: { llm: { provider: "openai", model: "x" } }, keys: { openai: "sk-uji-test-12345" } });
    // fake server mengembalikan 200 untuk chat; untuk embedding endpoint ada. Untuk stt endpoint tidak ada -> 404
    expect(r.body.ok).toBe(true);
    const bad = await owner.call("post", "/api/admin/providers/test", { capability: "stt", provider: { stt: { provider: "openai", model: "stt-x" } }, keys: { openai: "sk-uji-test-12345" } });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toBe("openai_http_404");
    expect(JSON.stringify(bad.body)).not.toContain("sk-uji");
  });
});

describe("log audit dan kill switch tercatat", () => {
  it("daftar berpaginasi, bisa difilter, dan memuat perubahan kill switch", async () => {
    const owner = await login(env.app, "owner@x.com");
    await owner.call("patch", "/api/admin/flags", { killed: ["dataExport"] });
    await owner.call("patch", "/api/admin/flags", { killed: [] });
    const all = (await owner.call("get", "/api/admin/audit?limit=5&page=1")).body;
    expect(all.items.length).toBeLessThanOrEqual(5);
    expect(all.total).toBeGreaterThan(5);
    const flags = (await owner.call("get", "/api/admin/audit?action=flags")).body.items;
    expect(flags.length).toBeGreaterThanOrEqual(2);
    expect(flags[0]).toMatchObject({ actor: "owner@x.com", action: "flags.update" });
    expect((await owner.call("get", "/api/admin/audit?limit=1000")).status).toBe(400);
    const u = await login(env.app, email("au"));
    expect((await u.call("get", "/api/admin/audit")).status).toBe(404);
  });
});
