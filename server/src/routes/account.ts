import { Router } from "express";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import { THEMES } from "../db.js";
import { adminSet, publicUser, requireAuth } from "../auth/index.js";
import { ApiError, wrap } from "../lib/http.js";
import { DELETION_NOTICE, jobView, requestDeletion, runDeletionJob, sha } from "../lib/deletion.js";
import { cosine, embeddingCompatible, memoryEnabled } from "../memory/service.js";

const hour = z.number().int().min(0).max(23);

const settingsBody = z
  .object({
    displayName: z.string().min(1).max(80).optional(),
    onboardingDone: z.boolean().optional(),
    ageConfirmed: z.literal(true).optional(),
    preferences: z
      .object({
        theme: z.enum(THEMES).optional(),
        moodThemes: z.boolean().optional(),
        showMood: z.boolean().optional(),
        style: z
          .object({
            length: z.enum(["ringkas", "sedang", "panjang"]).optional(),
            formality: z.enum(["santai", "netral", "sopan"]).optional(),
            emoji: z.enum(["tanpa", "sedikit", "sedang"]).optional(),
            humor: z.boolean().optional(),
            addressAs: z.string().max(40).optional(),
          })
          .strict()
          .optional(),
        greeting: z
          .object({
            enabled: z.boolean().optional(),
            quietStartHour: hour.optional(),
            quietEndHour: hour.optional(),
            utcOffsetMinutes: z.number().int().min(-720).max(840).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    privacySettings: z
      .object({
        longTermMemory: z.boolean().optional(),
        allowSensitiveMemory: z.boolean().optional(),
        saveHistory: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Saat mematikan memori: hapus juga yang sudah tersimpan? Dijelaskan di UI; default tidak menghapus.
    deleteExistingMemories: z.boolean().optional(),
  })
  .strict();

function flatten(prefix: string, obj: Record<string, unknown>, out: Record<string, unknown>) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(`${prefix}.${k}`, v as Record<string, unknown>, out);
    else out[`${prefix}.${k}`] = v;
  }
}

function localHour(offsetMin: number) {
  return new Date(Date.now() + offsetMin * 60_000).getUTCHours();
}
function inQuiet(h: number, start: number, end: number) {
  return start === end ? false : start < end ? h >= start && h < end : h >= start || h < end;
}

export function accountRouter(ctx: AppCtx) {
  const r = Router();
  const { c } = ctx.d;

  r.get("/settings", (req, res) => res.json(publicUser(req.user!, adminSet(ctx))));

  r.patch("/settings", wrap(async (req, res) => {
    const b = settingsBody.parse(req.body);
    const user = req.user!;
    if (b.preferences?.moodThemes && !ctx.flags.get().moodThemes) throw new ApiError(400, "FEATURE_DISABLED", "Tema mengikuti mood belum tersedia.");
    if (b.preferences?.greeting?.enabled && !ctx.flags.get().proactiveGreeting) throw new ApiError(400, "FEATURE_DISABLED", "Sapaan proaktif belum tersedia.");
    if (b.privacySettings?.longTermMemory && !ctx.flags.get().longTermMemory) throw new ApiError(400, "FEATURE_DISABLED", "Memori jangka panjang belum tersedia.");
    const $set: Record<string, unknown> = {};
    if (b.displayName !== undefined) $set.displayName = b.displayName;
    if (b.onboardingDone !== undefined) $set.onboardingDone = b.onboardingDone;
    if (b.ageConfirmed && !user.ageConfirmedAt) $set.ageConfirmedAt = new Date();
    if (b.preferences) flatten("preferences", b.preferences, $set);
    if (b.privacySettings) flatten("privacySettings", b.privacySettings, $set);
    if (Object.keys($set).length) await c.users.updateOne({ _id: user._id }, { $set });
    if (b.privacySettings?.longTermMemory === false && b.deleteExistingMemories) {
      await c.memories.deleteMany({ userId: user._id });
      await c.session_summaries.deleteMany({ userId: user._id });
    }
    if (b.privacySettings?.allowSensitiveMemory === false && b.deleteExistingMemories) {
      await c.memories.deleteMany({ userId: user._id, sensitivity: "sensitive" });
    }
    res.json(publicUser((await c.users.findOne({ _id: user._id }))!, adminSet(ctx)));
  }));

  // Fase 2: pencarian percakapan. Selalu difilter userId; hanya percakapan yang belum dihapus.
  r.get("/search", wrap(async (req, res) => {
    const q = z.object({ q: z.string().trim().min(2).max(100), limit: z.coerce.number().int().min(1).max(30).default(15) }).parse(req.query);
    const userId = req.user!._id;
    const convs = await c.conversations.find({ userId, deletedAt: null }, { projection: { _id: 1, title: 1, updatedAt: 1 } }).toArray();
    const byId = new Map(convs.map((x) => [String(x._id), x]));
    const esc = q.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(esc, "i");
    // Regex agar mendukung potongan kata ("sepeda" cocok "bersepeda"); dibatasi per pengguna dan jumlah hasil.
    const rows = await c.messages
      .find({ userId, status: "complete", text: { $regex: re }, conversationId: { $in: convs.map((x) => x._id) } })
      .sort({ createdAt: -1 }).limit(q.limit * 3).toArray();
    const seen = new Set<string>();
    const results = [];
    for (const m of rows) {
      const cid = String(m.conversationId);
      const conv = byId.get(cid);
      if (!conv) continue;
      const idx = m.text.search(re);
      const start = Math.max(0, idx - 40);
      results.push({
        conversationId: cid, title: conv.title, messageId: String(m._id), role: m.role, createdAt: m.createdAt,
        snippet: (start > 0 ? "…" : "") + m.text.slice(start, idx + q.q.length + 80),
        firstInConversation: !seen.has(cid),
      });
      seen.add(cid);
      if (results.length >= q.limit) break;
    }
    const titleHits = convs.filter((x) => re.test(x.title) && !seen.has(String(x._id))).slice(0, 5)
      .map((x) => ({ conversationId: String(x._id), title: x.title, messageId: null, role: null, createdAt: x.updatedAt, snippet: x.title, firstInConversation: true }));
    // Pencarian semantik (opsional, ?semantic=1): cocokkan makna dengan ringkasan sesi milik pengguna sendiri.
    let similar: { conversationId: string; title: string; snippet: string; score: number }[] = [];
    if (req.query.semantic === "1" && memoryEnabled(ctx, req.user!)) {
      try {
        const [qv] = await ctx.embedder.embed([q.q]);
        const sums = (await c.session_summaries.find({ userId, embedding: { $exists: true } }).limit(200).toArray()).filter((x) => embeddingCompatible(ctx, x));
        similar = sums
          .map((s) => ({ s, score: cosine(qv!, s.embedding!) }))
          .filter((x) => x.score >= 0.3 && byId.has(String(x.s.conversationId)))
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((x) => ({ conversationId: String(x.s.conversationId), title: byId.get(String(x.s.conversationId))!.title, snippet: x.s.summary, score: Number(x.score.toFixed(2)) }));
      } catch { similar = []; /* embedding gagal: hasil teks biasa tetap dikembalikan */ }
    }
    res.json({ results: [...titleHits, ...results].slice(0, q.limit), similar });
  }));

  // Fase 2: sapaan opsional. Bukan push; hanya ditampilkan ketika pengguna membuka aplikasi, maksimal sekali per ~20 jam,
  // tidak di jam tenang, tanpa menyinggung ketidakhadiran dan tanpa isi curhat.
  r.get("/greeting", wrap(async (req, res) => {
    const u = req.user!;
    const g = u.preferences.greeting;
    if (!ctx.flags.get().proactiveGreeting || !g.enabled) return res.json({ greeting: null });
    const h = localHour(g.utcOffsetMinutes);
    if (inQuiet(h, g.quietStartHour, g.quietEndHour)) return res.json({ greeting: null });
    if (u.lastGreetingAt && Date.now() - u.lastGreetingAt.getTime() < 20 * 3600_000) return res.json({ greeting: null });
    const part = h < 11 ? "pagi" : h < 15 ? "siang" : h < 18 ? "sore" : "malam";
    const name = u.preferences.style.addressAs.trim();
    const lines = [
      `Selamat ${part}${name ? `, ${name}` : ""}. Kalau lagi pengin ngobrol, aku di sini. Kalau nggak, juga nggak apa-apa.`,
      `Hai${name ? ` ${name}` : ""}, semoga ${part} ini berjalan lumayan. Kapan pun kamu mau cerita, silakan.`,
      `Selamat ${part}. Nggak ada kewajiban apa-apa di sini, cuma ruang kalau kamu butuh.`,
    ];
    await c.users.updateOne({ _id: u._id }, { $set: { lastGreetingAt: new Date() } });
    res.json({ greeting: { text: lines[Math.floor(Math.random() * lines.length)]! } });
  }));

  r.get("/mood", wrap(async (req, res) => {
    const m = await c.mood_state.findOne({ userId: req.user!._id });
    res.json({ mood: m?.mood ?? "hangat" });
  }));

  // Ekspor dialirkan per dokumen (tidak memuat semuanya ke memori) agar aman untuk akun besar.
  r.post("/data/export", wrap(async (req, res) => {
    if (!ctx.flags.get().dataExport) throw new ApiError(404, "NOT_FOUND", "Ekspor data belum tersedia.");
    const user = req.user!;
    const userId = user._id;
    res.set({ "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="sawala-data.json"', "Cache-Control": "no-store" });
    const w = (x: string) => void res.write(x);
    const arr = async (key: string, cursor: AsyncIterable<unknown>, last = false) => {
      w(`"${key}":[`);
      let first = true;
      for await (const doc of cursor) { w((first ? "" : ",") + JSON.stringify(doc)); first = false; }
      w("]" + (last ? "" : ","));
    };
    try {
      w(`{"exportedAt":${JSON.stringify(new Date().toISOString())},"account":${JSON.stringify({ email: user.email, displayName: user.displayName, createdAt: user.createdAt, preferences: user.preferences, privacySettings: user.privacySettings })},`);
      await arr("conversations", c.conversations.find({ userId }).map((x) => ({ id: String(x._id), title: x.title, createdAt: x.createdAt, updatedAt: x.updatedAt })));
      await arr("messages", c.messages.find({ userId, $nor: [{ status: "failed", text: "" }] }).sort({ createdAt: 1 }).map((m) => ({ id: String(m._id), conversationId: String(m.conversationId), role: m.role, channel: m.channel, text: m.text, status: m.status, createdAt: m.createdAt })));
      await arr("memories", c.memories.find({ userId }, { projection: { embedding: 0 } }).map((m) => ({ id: String(m._id), type: m.type, content: m.content, status: m.status, sensitivity: m.sensitivity, createdAt: m.createdAt, updatedAt: m.updatedAt })));
      await arr("calls", c.call_sessions.find({ userId }).map((x) => ({ id: String(x._id), startedAt: x.startedAt, endedAt: x.endedAt, transcriptConsent: x.transcriptConsent, turns: x.turns })));
      await arr("summaries", c.session_summaries.find({ userId }).map((x) => ({ conversationId: String(x.conversationId), summary: x.summary, updatedAt: x.updatedAt })), true);
      w("}");
      res.end();
    } catch {
      res.destroy(); // jangan kirim JSON terpotong yang tampak valid
    }
  }));

  r.delete("/me", wrap(async (req, res) => {
    z.object({ confirm: z.literal("HAPUS") }).strict().parse(req.body);
    const { jobId, token } = await requestDeletion(ctx, req.user!._id);
    // Akun ditandai pending; workflow berjalan di latar belakang (sesi dicabut pada langkah pertama). Pantau lewat token.
    const job = await ctx.d.c.deletion_jobs.findOne({ _id: jobId });
    void runDeletionJob(ctx, jobId).catch(() => undefined);
    res.clearCookie("sawala_sid", { path: "/" });
    res.status(202).json({ statusToken: token, ...(job ? jobView(job) : {}), notice: DELETION_NOTICE });
  }));

  return r;
}

export function deletionStatusRouter(ctx: AppCtx) {
  const r = Router();
  r.get("/deletion-status", wrap(async (req, res) => {
    const token = z.string().min(10).max(100).parse(req.query.token);
    const job = await ctx.d.c.deletion_jobs.findOne({ tokenHash: sha(token) });
    if (!job) throw new ApiError(404, "NOT_FOUND", "Status tidak ditemukan.");
    res.json(jobView(job));
  }));
  return r;
}

export { requireAuth };
