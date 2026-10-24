import { z } from "zod";
import type { AppCtx } from "../context.js";
import type { ConversationDoc, UserDoc } from "../db.js";
import { log } from "../lib/logger.js";
import { recordOp } from "../lib/ops.js";
import { memoryEnabled } from "../memory/service.js";

const SUMMARY_EVERY = 10;
const SYSTEM = `[TUGAS:RINGKASAN_SESI]
Ringkas percakapan berikut untuk kesinambungan sesi berikutnya, dalam Bahasa Indonesia, maksimal 400 karakter.
Sertakan topik utama dan tindak lanjut yang belum selesai. Jangan sertakan detail krisis, diagnosis, atau data identitas yang tidak perlu.
Jika ada ringkasan sebelumnya, gabungkan dengan percakapan baru.
Kembalikan JSON saja: {"summary": "..."}`;

export async function maybeSummarize(ctx: AppCtx, user: UserDoc, conv: ConversationDoc) {
  try {
    if (conv.ephemeral || !memoryEnabled(ctx, user)) return;
    const prev = await ctx.d.c.session_summaries.findOne({ userId: user._id, conversationId: conv._id });
    const since = new Date(Math.max(prev?.sourceUpTo.getTime() ?? 0, conv.summaryFloor?.getTime() ?? 0));
    const msgs = await ctx.d.c.messages
      .find({ userId: user._id, conversationId: conv._id, createdAt: { $gt: since }, status: "complete" })
      .sort({ createdAt: 1 })
      .limit(60)
      .toArray();
    if (msgs.length < SUMMARY_EVERY) return;
    const input = msgs.map((m) => ({ role: m.role, text: m.text.slice(0, 600) }));
    if (prev) input.unshift({ role: "user", text: `Ringkasan sebelumnya: ${prev.summary}` });
    const r = await ctx.llm.generate({ system: SYSTEM, messages: input, maxOutputTokens: 300, json: true });
    const parsed = z.object({ summary: z.string().min(5).max(500) }).safeParse(JSON.parse(/\{[\s\S]*\}/.exec(r.text)?.[0] ?? "{}"));
    if (!parsed.success) return;
    // Pengguna bisa menonaktifkan memori / menghapus percakapan saat ringkasan dibuat.
    const still = await ctx.d.c.conversations.findOne({ _id: conv._id, userId: user._id, deletedAt: null });
    const u = await ctx.d.c.users.findOne({ _id: user._id });
    if (!still || !u || !memoryEnabled(ctx, u)) return;
    const emb = await ctx.embedder.embed([parsed.data.summary]).then((v) => v[0]).catch(() => undefined);
    const now = new Date();
    await ctx.d.c.session_summaries.updateOne(
      { userId: user._id, conversationId: conv._id },
      { $set: { summary: parsed.data.summary, sourceUpTo: msgs[msgs.length - 1]!.createdAt, updatedAt: now, ...(emb ? { embedding: emb, embeddingTag: ctx.embedder.tag } : {}) }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  } catch {
    log("warn", { event: "summary_failed" });
    recordOp(ctx, "summary_failed");
  }
}

export async function contextSummaries(ctx: AppCtx, user: UserDoc, conversationId: ConversationDoc["_id"]) {
  if (!memoryEnabled(ctx, user)) return [];
  const rows = await ctx.d.c.session_summaries.find({ userId: user._id }).sort({ updatedAt: -1 }).limit(4).toArray();
  return rows
    .sort((a, b) => Number(String(b.conversationId) === String(conversationId)) - Number(String(a.conversationId) === String(conversationId)))
    .slice(0, 3)
    .map((r) => r.summary);
}
