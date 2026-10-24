import { Router } from "express";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import type { MemoryDoc } from "../db.js";
import { oid } from "../db.js";
import { ApiError, wrap } from "../lib/http.js";
import { deleteMemories, findForgetTargets, MAX_MEMORY_CHARS } from "../memory/service.js";

const view = (m: MemoryDoc) => ({
  id: String(m._id),
  type: m.type,
  content: m.content,
  importance: m.importance,
  confidence: m.confidence,
  sensitivity: m.sensitivity,
  status: m.status,
  userConfirmed: m.userConfirmed,
  conflictWith: m.conflictWith ? String(m.conflictWith) : null,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
  lastUsedAt: m.lastUsedAt,
  sourceCount: m.sourceMessageIds.length,
});

const patchBody = z
  .object({
    content: z.string().min(3).max(MAX_MEMORY_CHARS).optional(),
    action: z.enum(["flag_wrong", "unflag", "confirm", "resolve"]).optional(),
    keep: z.enum(["this", "other"]).optional(),
  })
  .strict();

export function memoriesRouter(ctx: AppCtx) {
  const r = Router();
  const { c } = ctx.d;

  r.get("/memories", wrap(async (req, res) => {
    const q = z.object({ status: z.enum(["active", "conflict", "flagged_wrong", "superseded", "all"]).default("all") }).parse(req.query);
    const rows = await c.memories
      .find({ userId: req.user!._id, ...(q.status === "all" ? {} : { status: q.status }) }, { projection: { embedding: 0 } })
      .sort({ updatedAt: -1 }).limit(500).toArray();
    res.json({ items: rows.map(view), enabled: ctx.flags.get().longTermMemory && req.user!.privacySettings.longTermMemory });
  }));

  r.get("/memories/:id", wrap(async (req, res) => {
    const id = oid(String(req.params.id));
    const m = id ? await c.memories.findOne({ _id: id, userId: req.user!._id }, { projection: { embedding: 0 } }) : null;
    if (!m) throw new ApiError(404, "NOT_FOUND", "Memori tidak ditemukan.");
    const src = await c.messages.find({ userId: req.user!._id, _id: { $in: m.sourceMessageIds.slice(0, 5) } }).toArray();
    res.json({
      ...view(m),
      sources: src.map((s) => ({ messageId: String(s._id), conversationId: String(s.conversationId), excerpt: s.text.slice(0, 200), createdAt: s.createdAt })),
    });
  }));

  r.patch("/memories/:id", wrap(async (req, res) => {
    const id = oid(String(req.params.id));
    const body = patchBody.parse(req.body);
    const userId = req.user!._id;
    const m = id ? await c.memories.findOne({ _id: id, userId }) : null;
    if (!m) throw new ApiError(404, "NOT_FOUND", "Memori tidak ditemukan.");
    const now = new Date();
    const set: Partial<MemoryDoc> = { updatedAt: now };
    if (body.content !== undefined) {
      const [v] = await ctx.embedder.embed([body.content.trim()]);
      Object.assign(set, { content: body.content.trim(), embedding: v, embeddingTag: ctx.embedder.tag, userConfirmed: true, confidence: 1 });
    }
    if (body.action === "flag_wrong") set.status = "flagged_wrong";
    if (body.action === "unflag" && m.status === "flagged_wrong") set.status = "active";
    if (body.action === "confirm") { set.userConfirmed = true; set.confidence = 1; if (m.status === "conflict") set.status = "active"; }
    if (body.action === "resolve") {
      // Hanya pengguna yang memilih fakta mana yang benar.
      if (m.status !== "conflict" || !m.conflictWith || !body.keep) throw new ApiError(400, "INVALID_REQUEST", "Tidak ada konflik untuk diselesaikan.");
      const other = await c.memories.findOne({ _id: m.conflictWith, userId });
      if (body.keep === "this") {
        set.status = "active"; set.userConfirmed = true; set.conflictWith = null;
        if (other) await c.memories.updateOne({ _id: other._id, userId }, { $set: { status: "superseded", supersededBy: m._id, updatedAt: now } });
      } else {
        await c.memories.deleteOne({ _id: m._id, userId });
        if (other) await c.memories.updateOne({ _id: other._id, userId }, { $set: { userConfirmed: true, updatedAt: now } });
        return res.json({ ok: true, removed: true });
      }
    }
    await c.memories.updateOne({ _id: m._id, userId }, { $set: set });
    const updated = await c.memories.findOne({ _id: m._id, userId }, { projection: { embedding: 0 } });
    res.json(view(updated!));
  }));

  r.delete("/memories/:id", wrap(async (req, res) => {
    const id = oid(String(req.params.id));
    const n = id ? await deleteMemories(ctx, req.user!, [id]) : 0;
    if (!n) throw new ApiError(404, "NOT_FOUND", "Memori tidak ditemukan.");
    res.json({ ok: true });
  }));

  // Dua langkah: cari target dulu (query), lalu konfirmasi eksplisit (ids). Tidak ada penghapusan dari tebakan.
  r.post("/memories/forget", wrap(async (req, res) => {
    const body = z.union([
      z.object({ query: z.string().min(2).max(200) }).strict(),
      z.object({ ids: z.array(z.string()).min(1).max(50) }).strict(),
    ]).parse(req.body);
    if ("query" in body) {
      const targets = await findForgetTargets(ctx, req.user!, body.query);
      return res.json({ candidates: targets.map((t) => ({ id: String(t.memory._id), content: t.memory.content, similarity: Number(t.sim.toFixed(2)) })) });
    }
    const ids = body.ids.map(oid).filter((x): x is NonNullable<typeof x> => x !== null);
    const deleted = ids.length ? await deleteMemories(ctx, req.user!, ids) : 0;
    res.json({ deleted });
  }));

  return r;
}
