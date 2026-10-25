import type { AppCtx } from "../context.js";

export interface ReembedStatus {
  status: "idle" | "running" | "completed" | "failed";
  total: number;
  done: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  tag: string | null;
  startedBy: string | null;
}

const idle = (): ReembedStatus => ({ status: "idle", total: 0, done: 0, startedAt: null, finishedAt: null, tag: null, startedBy: null });
let running = false;

const stale = (ctx: AppCtx, doc: { embedding?: number[]; embeddingTag?: string }) =>
  doc.embeddingTag ? doc.embeddingTag !== ctx.embedder.tag : doc.embedding?.length !== ctx.embedder.dimensions;

export async function reembedStatus(ctx: AppCtx): Promise<ReembedStatus> {
  const d = await ctx.d.c.app_settings.findOne({ _id: "reembed" as never }) as unknown as ({ value?: ReembedStatus } | null);
  return d?.value ?? idle();
}

async function save(ctx: AppCtx, v: ReembedStatus) {
  await ctx.d.c.app_settings.updateOne({ _id: "reembed" as never }, { $set: { value: v, updatedAt: new Date() } } as never, { upsert: true });
}

/** Jumlah dokumen yang vektornya berasal dari model embedding lain (tidak dipakai retrieval sampai dihitung ulang). */
export async function countStale(ctx: AppCtx): Promise<{ memories: number; summaries: number }> {
  const [m, s] = await Promise.all([
    ctx.d.c.memories.find({}, { projection: { embedding: 1, embeddingTag: 1 } }).toArray(),
    ctx.d.c.session_summaries.find({ embedding: { $exists: true } }, { projection: { embedding: 1, embeddingTag: 1 } }).toArray(),
  ]);
  return { memories: m.filter((x) => stale(ctx, x)).length, summaries: s.filter((x) => stale(ctx, x)).length };
}

/** Hitung ulang embedding di latar belakang dengan model aktif. Satu proses pada satu waktu; kemajuan tersimpan di database. */
export async function startReembed(ctx: AppCtx, actor: string): Promise<{ started: boolean; reason?: string }> {
  if (running) return { started: false, reason: "Penghitungan ulang sedang berjalan." };
  const cur = await reembedStatus(ctx);
  if (cur.status === "running" && cur.startedAt && Date.now() - cur.startedAt.getTime() < 3600_000) return { started: false, reason: "Penghitungan ulang sedang berjalan di instance lain." };
  running = true;
  void (async () => {
    const tag = ctx.embedder.tag;
    const st: ReembedStatus = { status: "running", total: 0, done: 0, startedAt: new Date(), finishedAt: null, tag, startedBy: actor };
    try {
      const mems = (await ctx.d.c.memories.find({}, { projection: { content: 1, embedding: 1, embeddingTag: 1 } }).toArray()).filter((m) => stale(ctx, m));
      const sums = (await ctx.d.c.session_summaries.find({ embedding: { $exists: true } }, { projection: { summary: 1, embedding: 1, embeddingTag: 1 } }).toArray()).filter((m) => stale(ctx, m));
      st.total = mems.length + sums.length;
      await save(ctx, st);
      for (let i = 0; i < mems.length; i += 50) {
        const batch = mems.slice(i, i + 50);
        const vecs = await ctx.embedder.embed(batch.map((m) => m.content));
        for (let j = 0; j < batch.length; j++) await ctx.d.c.memories.updateOne({ _id: batch[j]!._id }, { $set: { embedding: vecs[j]!, embeddingTag: tag } });
        st.done += batch.length;
        await save(ctx, st);
      }
      for (let i = 0; i < sums.length; i += 50) {
        const batch = sums.slice(i, i + 50);
        const vecs = await ctx.embedder.embed(batch.map((s) => s.summary));
        for (let j = 0; j < batch.length; j++) await ctx.d.c.session_summaries.updateOne({ _id: batch[j]!._id }, { $set: { embedding: vecs[j]!, embeddingTag: tag } });
        st.done += batch.length;
        await save(ctx, st);
      }
      st.status = "completed"; st.finishedAt = new Date();
    } catch {
      st.status = "failed"; st.finishedAt = new Date();
    } finally {
      running = false;
      await save(ctx, st).catch(() => undefined);
    }
  })();
  return { started: true };
}
