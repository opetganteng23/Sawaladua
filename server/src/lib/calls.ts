import type { AppCtx } from "../context.js";
import type { CallSessionDoc } from "../db.js";

/**
 * Akhiri panggilan. Tanpa persetujuan transkrip, teks sementara yang disimpan selama panggilan
 * (dibutuhkan untuk konteks) dihapus bersama percakapannya. Audio tidak pernah disimpan server.
 */
export async function finishCall(
  ctx: AppCtx,
  call: CallSessionDoc,
  reason: NonNullable<CallSessionDoc["endReason"]>,
  metrics?: CallSessionDoc["metrics"],
) {
  const { c } = ctx.d;
  const upd = await c.call_sessions.updateOne(
    { _id: call._id, userId: call.userId, status: "active" },
    { $set: { status: "ended", endedAt: new Date(), endReason: reason, ...(metrics ? { metrics } : {}) } },
  );
  if (!upd.modifiedCount) return { transcriptKept: call.transcriptConsent }; // sudah berakhir (idempoten)
  if (!call.transcriptConsent) {
    const msgIds = (await c.messages.find({ userId: call.userId, conversationId: call.conversationId }, { projection: { _id: 1 } }).toArray()).map((m) => m._id);
    await c.messages.deleteMany({ userId: call.userId, conversationId: call.conversationId });
    await c.session_summaries.deleteMany({ userId: call.userId, conversationId: call.conversationId });
    await c.conversations.deleteOne({ _id: call.conversationId, userId: call.userId });
    if (msgIds.length) await c.memories.updateMany({ userId: call.userId }, { $pull: { sourceMessageIds: { $in: msgIds } } } as never);
  }
  return { transcriptKept: call.transcriptConsent };
}

/** Panggilan yang ditinggalkan (tanpa aktivitas) atau melewati durasi maksimum diakhiri otomatis. */
export async function sweepCalls(ctx: AppCtx) {
  const idle = new Date(Date.now() - 10 * 60_000);
  const tooLong = new Date(Date.now() - (ctx.cfg.CALL_MAX_MINUTES + 5) * 60_000);
  const stale = await ctx.d.c.call_sessions
    .find({ status: "active", $or: [{ lastActivityAt: { $lt: idle } }, { startedAt: { $lt: tooLong } }] })
    .limit(100)
    .toArray();
  for (const call of stale) await finishCall(ctx, call, call.startedAt < tooLong ? "max_duration" : "timeout");
  return stale.length;
}
