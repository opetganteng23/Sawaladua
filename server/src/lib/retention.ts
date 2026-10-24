import type { AppCtx } from "../context.js";

/**
 * Retensi riwayat chat (CHAT_RETENTION_DAYS; 0 = nonaktif). Percakapan tanpa aktivitas lebih lama dari batas dihapus beserta
 * pesan dan ringkasannya. Memori jangka panjang TIDAK ikut dihapus (dikendalikan pengguna), tetapi referensi sumbernya dibersihkan.
 */
export async function sweepRetention(ctx: AppCtx, now = Date.now()): Promise<number> {
  const days = ctx.cfg.CHAT_RETENTION_DAYS;
  if (days <= 0) return 0;
  const { c } = ctx.d;
  const cutoff = new Date(now - days * 864e5);
  const old = await c.conversations.find({ updatedAt: { $lt: cutoff } }).limit(200).toArray();
  for (const conv of old) {
    const ids = (await c.messages.find({ userId: conv.userId, conversationId: conv._id }, { projection: { _id: 1 } }).toArray()).map((m) => m._id);
    await c.messages.deleteMany({ userId: conv.userId, conversationId: conv._id });
    await c.session_summaries.deleteMany({ userId: conv.userId, conversationId: conv._id });
    if (ids.length) await c.memories.updateMany({ userId: conv.userId }, { $pull: { sourceMessageIds: { $in: ids } } } as never);
    await c.conversations.deleteOne({ _id: conv._id, userId: conv.userId });
  }
  return old.length;
}
