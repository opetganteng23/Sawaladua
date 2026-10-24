import type { AppCtx } from "../context.js";

const DAY = 864e5;

/**
 * Peluruhan memori (MTS 7.4 langkah 9): memori kejadian yang lama tidak dipakai diturunkan prioritasnya, BUKAN dihapus.
 * Memori yang dikonfirmasi pengguna tidak disentuh. Satu memori meluruh paling sering sekali per 30 hari.
 */
export async function decayMemories(ctx: AppCtx, now = Date.now(), batch = 500): Promise<number> {
  const stale = new Date(now - 90 * DAY);
  const lastDecay = new Date(now - 30 * DAY);
  const rows = await ctx.d.c.memories
    .find(
      {
        status: "active", type: "episodic", userConfirmed: false, importance: { $gt: 0.15 }, updatedAt: { $lt: stale },
        $and: [
          { $or: [{ lastUsedAt: null }, { lastUsedAt: { $lt: stale } }] },
          { $or: [{ decayedAt: { $exists: false } }, { decayedAt: null }, { decayedAt: { $lt: lastDecay } }] },
        ],
      },
      { projection: { _id: 1, importance: 1 } },
    )
    .limit(batch)
    .toArray();
  for (const m of rows) {
    await ctx.d.c.memories.updateOne(
      { _id: m._id },
      { $set: { importance: Math.max(0.1, Number((m.importance * 0.85).toFixed(3))), decayedAt: new Date(now) } },
    );
  }
  return rows.length;
}
