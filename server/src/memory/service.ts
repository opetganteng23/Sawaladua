import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import type { MemoryDoc, MemoryType, UserDoc } from "../db.js";
import { log } from "../lib/logger.js";
import { recordOp } from "../lib/ops.js";

export const MAX_MEMORY_CHARS = 300;
const DUP_SIM = 0.9;
const CONFLICT_SIM = 0.62;

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0; // dimensi beda = embedding dari model lain; jangan dibandingkan
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Vektor kompatibel jika dibuat oleh embedding yang sama (tag), atau (data lama tanpa tag) berdimensi sama. */
export const embeddingCompatible = (ctx: AppCtx, doc: { embedding?: number[]; embeddingTag?: string }) =>
  doc.embeddingTag ? doc.embeddingTag === ctx.embedder.tag : doc.embedding?.length === ctx.embedder.dimensions;

export const fingerprint = (s: string) =>
  createHash("sha256")
    .update(s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 32);

export const memoryEnabled = (ctx: AppCtx, u: UserDoc) => ctx.flags.get().longTermMemory && u.privacySettings.longTermMemory;

const candidateSchema = z.object({
  type: z.enum(["episodic", "semantic"]),
  content: z.string().min(3).max(MAX_MEMORY_CHARS),
  importance: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(0.5),
  sensitivity: z.enum(["none", "personal", "sensitive"]).default("none"),
});
export type Candidate = z.infer<typeof candidateSchema>;

/** Validasi kandidat dari model: schema, panjang, kebijakan sensitivitas. */
export function validateCandidates(raw: unknown, allowSensitive: boolean): Candidate[] {
  const list = (raw as { memories?: unknown[] })?.memories;
  if (!Array.isArray(list)) return [];
  const out: Candidate[] = [];
  for (const item of list.slice(0, 8)) {
    const p = candidateSchema.safeParse(item);
    if (!p.success) continue;
    if (p.data.sensitivity === "sensitive" && !allowSensitive) continue;
    // Jangan simpan inferensi lemah sebagai memori.
    if (p.data.confidence < 0.5) continue;
    out.push({ ...p.data, content: p.data.content.trim() });
  }
  return out;
}

const EXTRACT_SYSTEM = `[TUGAS:EKSTRAKSI_MEMORI]
Dari percakapan, usulkan memori jangka panjang yang berguna untuk kesinambungan: fakta stabil (semantic) atau kejadian spesifik (episodic).
Aturan:
- Hanya informasi yang dinyatakan pengguna sendiri. Jangan menyimpulkan diagnosis, identitas sensitif, atau kepribadian.
- Jangan simpan detail krisis atau menyakiti diri.
- Tulis ringkas dalam Bahasa Indonesia, maksimal ${MAX_MEMORY_CHARS} karakter, sudut pandang ketiga ("Pengguna ...").
- sensitivity: "sensitive" untuk kesehatan, agama, orientasi, politik, keuangan detail; "personal" untuk hal pribadi biasa; "none" selain itu.
- Jika tidak ada yang layak disimpan, kembalikan {"memories": []}.
Kembalikan JSON saja: {"memories":[{"type","content","importance","confidence","sensitivity"}]}`;

export async function extractCandidates(ctx: AppCtx, recent: { role: "user" | "assistant"; text: string }[], allowSensitive: boolean) {
  const r = await ctx.llm.generate({ system: EXTRACT_SYSTEM, messages: recent, maxOutputTokens: 500, json: true });
  try {
    return validateCandidates(JSON.parse(r.text), allowSensitive);
  } catch {
    return [];
  }
}

/** Simpan kandidat: dedup, merge, dan penandaan konflik. Semua query difilter userId. */
export async function storeCandidates(ctx: AppCtx, user: UserDoc, cands: Candidate[], sourceIds: ObjectId[]) {
  const none = { created: 0, merged: 0, conflicts: 0, superseded: 0 };
  if (!memoryEnabled(ctx, user) || cands.length === 0) return none;
  // Baca ulang pengaturan: pengguna bisa mematikan memori saat proses tertunda berjalan.
  const fresh = await ctx.d.c.users.findOne({ _id: user._id }, { projection: { forgottenHashes: 1, privacySettings: 1 } });
  if (!fresh || !fresh.privacySettings.longTermMemory) return none;
  const forgotten = new Set(fresh.forgottenHashes ?? []);
  const vectors = await ctx.embedder.embed(cands.map((c) => c.content));
  const existing = (await ctx.d.c.memories.find({ userId: user._id, status: { $in: ["active", "conflict"] } }).limit(1000).toArray()).filter((m) => embeddingCompatible(ctx, m));
  let created = 0, merged = 0, conflicts = 0, superseded = 0;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]!;
    const v = vectors[i]!;
    if (forgotten.has(fingerprint(c.content))) continue;
    let best: { m: MemoryDoc; sim: number } | null = null;
    for (const m of existing) {
      const sim = cosine(v, m.embedding);
      if (!best || sim > best.sim) best = { m, sim };
    }
    const now = new Date();
    if (best && best.sim >= DUP_SIM) {
      const keep = best.m.userConfirmed;
      await ctx.d.c.memories.updateOne(
        { _id: best.m._id, userId: user._id },
        {
          $set: {
            content: keep ? best.m.content : c.content,
            embedding: keep ? best.m.embedding : v,
            embeddingTag: keep ? best.m.embeddingTag : ctx.embedder.tag,
            importance: Math.max(best.m.importance, c.importance),
            updatedAt: now,
          },
          $addToSet: { sourceMessageIds: { $each: sourceIds } },
        },
      );
      merged++;
      continue;
    }
    const doc: Omit<MemoryDoc, "_id"> = {
      userId: user._id, type: c.type as MemoryType, content: c.content, importance: c.importance, confidence: c.confidence,
      sensitivity: c.sensitivity, sourceMessageIds: sourceIds, embedding: v, embeddingTag: ctx.embedder.tag, status: "active", userConfirmed: false,
      createdAt: now, updatedAt: now, lastUsedAt: null, useCount: 0, supersededBy: null, conflictWith: null,
    };
    // Informasi semantik mirip tetapi tidak sama: kemungkinan perubahan/pertentangan. Jangan memilih sendiri.
    if (best && best.sim >= CONFLICT_SIM && c.type === "semantic" && best.m.type === "semantic" && best.m.status === "active") {
      doc.status = "conflict";
      doc.conflictWith = best.m._id;
      conflicts++;
    } else created++;
    const r = await ctx.d.c.memories.insertOne(doc as MemoryDoc);
    existing.push({ ...(doc as MemoryDoc), _id: r.insertedId });
    // Pembaruan status KEJADIAN (mis. "wawancara minggu depan" -> "wawancara sudah selesai"): yang lama ditandai tergantikan
    // otomatis. Fakta stabil (semantic) tidak pernah ditimpa otomatis; itu jalur konflik yang diputuskan pengguna.
    if (best && best.sim >= CONFLICT_SIM && best.sim < DUP_SIM && c.type === "episodic" && best.m.type === "episodic" && best.m.status === "active" && !best.m.userConfirmed) {
      await ctx.d.c.memories.updateOne({ _id: best.m._id, userId: user._id }, { $set: { status: "superseded", supersededBy: r.insertedId, updatedAt: now } });
      best.m.status = "superseded";
      superseded++;
    }
  }
  return { created, merged, conflicts, superseded };
}

export interface Retrieved { memory: MemoryDoc; score: number; sim: number }

function recencyScore(m: MemoryDoc, now: number) {
  const ageDays = (now - m.updatedAt.getTime()) / 864e5;
  const half = m.type === "episodic" ? 45 : 365; // kejadian cepat usang, fakta stabil lebih lama
  return Math.pow(0.5, ageDays / half);
}

/** Ranking multi-faktor + MMR agar hasil tidak redundan. Filter status dan sensitivitas diterapkan sebelum ranking. */
export function rankMemories(
  queryVec: number[],
  mems: MemoryDoc[],
  opts: { limit: number; allowSensitive: boolean; minSim?: number; now?: number },
): Retrieved[] {
  const now = opts.now ?? Date.now();
  const minSim = opts.minSim ?? 0.2;
  const scored = mems
    .filter((m) => m.status === "active" && (opts.allowSensitive || m.sensitivity !== "sensitive"))
    .map((m) => {
      const sim = cosine(queryVec, m.embedding);
      const score = 0.55 * sim + 0.15 * m.importance + 0.1 * m.confidence + 0.1 * recencyScore(m, now) + (m.userConfirmed ? 0.1 : 0);
      return { memory: m, score, sim };
    })
    .filter((s) => s.sim >= minSim)
    .sort((a, b) => b.score - a.score);
  const picked: Retrieved[] = [];
  while (picked.length < opts.limit && scored.length) {
    let bi = 0, bv = -Infinity;
    scored.forEach((s, i) => {
      const redundancy = picked.reduce((mx, p) => Math.max(mx, cosine(s.memory.embedding, p.memory.embedding)), 0);
      const v = 0.6 * s.score - 0.4 * redundancy;
      if (v > bv) { bv = v; bi = i; }
    });
    picked.push(scored.splice(bi, 1)[0]!);
  }
  return picked;
}

export async function retrieveMemories(
  ctx: AppCtx,
  user: UserDoc,
  queryText: string,
  limit = 5,
): Promise<{ items: Retrieved[]; conflict: [MemoryDoc, MemoryDoc] | null }> {
  if (!memoryEnabled(ctx, user)) return { items: [], conflict: null };
  const t0 = Date.now();
  const [qv] = await ctx.embedder.embed([queryText]);
  const allowSensitive = user.privacySettings.allowSensitiveMemory;
  let pool: MemoryDoc[] | null = null;
  if (ctx.cfg.VECTOR_SEARCH_INDEX) {
    const tv = Date.now();
    try {
      pool = await ctx.d.c.memories
        .aggregate<MemoryDoc>([
          {
            $vectorSearch: {
              index: ctx.cfg.VECTOR_SEARCH_INDEX, path: "embedding", queryVector: qv, numCandidates: 100, limit: 30,
              filter: { userId: user._id, status: "active" },
            },
          },
        ])
        .toArray();
      recordOp(ctx, "vector_ms", Date.now() - tv);
    } catch {
      pool = null; // fallback aman ke cosine di aplikasi
    }
  }
  if (!pool) pool = await ctx.d.c.memories.find({ userId: user._id, status: "active" }).sort({ updatedAt: -1 }).limit(500).toArray();
  pool = pool.filter((m) => embeddingCompatible(ctx, m));
  const items = rankMemories(qv!, pool, { limit, allowSensitive });
  recordOp(ctx, "retrieval_ms", Date.now() - t0);
  if (items.length) {
    await ctx.d.c.memories.updateMany(
      { userId: user._id, _id: { $in: items.map((i) => i.memory._id) } },
      { $set: { lastUsedAt: new Date() }, $inc: { useCount: 1 } },
    );
  }
  let conflict: [MemoryDoc, MemoryDoc] | null = null;
  const conf = await ctx.d.c.memories.findOne({ userId: user._id, status: "conflict" });
  if (conf?.conflictWith) {
    const other = await ctx.d.c.memories.findOne({ _id: conf.conflictWith, userId: user._id });
    if (other && cosine(qv!, conf.embedding) >= 0.25) conflict = [other, conf];
  }
  return { items, conflict };
}

/**
 * MTS 7.7: informasi dari memori yang dihapus tidak boleh bertahan di ringkasan sesi. Ringkasan dari percakapan sumber dihapus
 * dan tidak dibuat ulang dari pesan lama (summaryFloor). Riwayat chat itu sendiri tetap ada sampai pengguna menghapusnya.
 */
export async function scrubSummaries(ctx: AppCtx, user: UserDoc, sourceMessageIds: ObjectId[]) {
  if (!sourceMessageIds.length) return 0;
  const convIds = await ctx.d.c.messages.distinct("conversationId", { userId: user._id, _id: { $in: sourceMessageIds } });
  if (!convIds.length) return 0;
  const del = await ctx.d.c.session_summaries.deleteMany({ userId: user._id, conversationId: { $in: convIds } });
  await ctx.d.c.conversations.updateMany({ userId: user._id, _id: { $in: convIds } }, { $set: { summaryFloor: new Date() } });
  return del.deletedCount;
}

export async function deleteMemories(ctx: AppCtx, user: UserDoc, ids: ObjectId[]) {
  const docs = await ctx.d.c.memories.find({ userId: user._id, _id: { $in: ids } }).toArray();
  if (!docs.length) return 0;
  const hashes = docs.map((d) => fingerprint(d.content));
  // Cegah ekstraksi tertunda memunculkan kembali fakta yang sama; hanya hash, bukan isi.
  await ctx.d.c.users.updateOne({ _id: user._id }, { $push: { forgottenHashes: { $each: hashes, $slice: -300 } } });
  const r = await ctx.d.c.memories.deleteMany({ userId: user._id, _id: { $in: docs.map((d) => d._id) } });
  await scrubSummaries(ctx, user, docs.flatMap((d) => d.sourceMessageIds));
  await ctx.d.c.memories.updateMany(
    { userId: user._id, conflictWith: { $in: docs.map((d) => d._id) } },
    { $set: { conflictWith: null, status: "active" } },
  );
  await ctx.d.c.memories.updateMany({ userId: user._id, supersededBy: { $in: docs.map((d) => d._id) } }, { $set: { supersededBy: null } });
  return r.deletedCount;
}

export async function addExplicitMemory(ctx: AppCtx, user: UserDoc, content: string, sourceIds: ObjectId[]) {
  if (!memoryEnabled(ctx, user)) return null;
  const clean = content.trim().slice(0, MAX_MEMORY_CHARS);
  const [v] = await ctx.embedder.embed([clean]);
  const now = new Date();
  const doc: Omit<MemoryDoc, "_id"> = {
    userId: user._id, type: "semantic", content: clean, importance: 0.8, confidence: 1, sensitivity: "personal",
    sourceMessageIds: sourceIds, embedding: v!, embeddingTag: ctx.embedder.tag, status: "active", userConfirmed: true, createdAt: now, updatedAt: now,
    lastUsedAt: null, useCount: 0, supersededBy: null, conflictWith: null,
  };
  const r = await ctx.d.c.memories.insertOne(doc as MemoryDoc);
  await ctx.d.c.users.updateOne({ _id: user._id }, { $pull: { forgottenHashes: fingerprint(clean) } });
  return r.insertedId;
}

export async function findForgetTargets(ctx: AppCtx, user: UserDoc, query: string) {
  const [qv] = await ctx.embedder.embed([query]);
  const mems = (await ctx.d.c.memories.find({ userId: user._id, status: { $in: ["active", "conflict"] } }).limit(1000).toArray()).filter((m) => embeddingCompatible(ctx, m));
  return mems
    .map((m) => ({ memory: m, sim: cosine(qv!, m.embedding) }))
    .filter((x) => x.sim >= 0.25)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 5);
}

/** Ekstraksi asinkron setelah giliran chat. Kegagalan tidak boleh memengaruhi chat. */
export async function extractAndStore(
  ctx: AppCtx,
  user: UserDoc,
  recent: { role: "user" | "assistant"; text: string }[],
  sourceIds: ObjectId[],
) {
  try {
    if (!memoryEnabled(ctx, user)) return;
    const cands = await extractCandidates(ctx, recent, user.privacySettings.allowSensitiveMemory);
    await storeCandidates(ctx, user, cands, sourceIds);
  } catch {
    log("warn", { event: "memory_extraction_failed" });
    recordOp(ctx, "memory_extraction_failed");
  }
}
