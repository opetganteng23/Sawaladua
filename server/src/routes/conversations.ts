import { Router } from "express";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import { oid } from "../db.js";
import { ApiError, wrap } from "../lib/http.js";
import { handleChat } from "../chat/orchestrator.js";

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().datetime().optional(),
});

export function conversationsRouter(ctx: AppCtx) {
  const r = Router();
  const { c } = ctx.d;

  r.get("/conversations", wrap(async (req, res) => {
    const q = pageSchema.parse(req.query);
    const filter = { userId: req.user!._id, deletedAt: null, ...(q.before ? { updatedAt: { $lt: new Date(q.before) } } : {}) };
    const rows = await c.conversations.find(filter).sort({ updatedAt: -1 }).limit(q.limit + 1).toArray();
    const page = rows.slice(0, q.limit);
    res.json({
      items: page.map((x) => ({ id: String(x._id), title: x.title, updatedAt: x.updatedAt, ephemeral: Boolean(x.ephemeral) })),
      nextBefore: rows.length > q.limit ? page[page.length - 1]!.updatedAt : null,
    });
  }));

  r.post("/conversations", wrap(async (req, res) => {
    z.object({ title: z.string().max(80).optional() }).strict().parse(req.body ?? {});
    const now = new Date();
    const ephemeral = !req.user!.privacySettings.saveHistory;
    const doc = { userId: req.user!._id, title: "Percakapan baru", createdAt: now, updatedAt: now, deletedAt: null, ephemeral, expiresAt: ephemeral ? new Date(now.getTime() + 864e5) : null };
    const ins = await c.conversations.insertOne(doc as never);
    res.status(201).json({ id: String(ins.insertedId), title: doc.title, ephemeral });
  }));

  r.get("/conversations/:id/messages", wrap(async (req, res) => {
    const id = oid(String(req.params.id));
    const q = pageSchema.parse(req.query);
    const conv = id ? await c.conversations.findOne({ _id: id, userId: req.user!._id, deletedAt: null }) : null;
    if (!conv) throw new ApiError(404, "NOT_FOUND", "Percakapan tidak ditemukan.");
    const rows = await c.messages
      .find({ userId: req.user!._id, conversationId: conv._id, $nor: [{ status: "failed", text: "" }], ...(q.before ? { createdAt: { $lt: new Date(q.before) } } : {}) })
      .sort({ createdAt: -1 }).limit(q.limit + 1).toArray();
    const page = rows.slice(0, q.limit).reverse();
    res.json({
      items: page.map((m) => ({ id: String(m._id), role: m.role, text: m.text, bubbles: m.bubbles ?? [m.text], status: m.status, mood: m.mood ?? null, createdAt: m.createdAt })),
      nextBefore: rows.length > q.limit ? page[0]!.createdAt : null,
    });
  }));

  r.delete("/conversations/:id", wrap(async (req, res) => {
    const id = oid(String(req.params.id));
    const alsoMemories = req.query.deleteMemories === "true";
    const user = req.user!;
    const conv = id ? await c.conversations.findOne({ _id: id, userId: user._id }) : null;
    if (!conv) throw new ApiError(404, "NOT_FOUND", "Percakapan tidak ditemukan.");
    const msgIds = (await c.messages.find({ userId: user._id, conversationId: conv._id }, { projection: { _id: 1 } }).toArray()).map((m) => m._id);
    if (alsoMemories && msgIds.length) {
      // Hapus memori yang seluruh sumbernya berasal dari percakapan ini.
      const set = new Set(msgIds.map(String));
      const mems = await c.memories.find({ userId: user._id, sourceMessageIds: { $in: msgIds } }).toArray();
      const only = mems.filter((m) => m.sourceMessageIds.length > 0 && m.sourceMessageIds.every((s) => set.has(String(s))));
      const { deleteMemories } = await import("../memory/service.js");
      if (only.length) await deleteMemories(ctx, user, only.map((m) => m._id));
    }
    await c.messages.deleteMany({ userId: user._id, conversationId: conv._id });
    await c.session_summaries.deleteMany({ userId: user._id, conversationId: conv._id });
    if (msgIds.length) await c.memories.updateMany({ userId: user._id }, { $pull: { sourceMessageIds: { $in: msgIds } } } as never);
    await c.conversations.deleteOne({ _id: conv._id, userId: user._id });
    res.json({ ok: true, memoriesDeleted: alsoMemories });
  }));

  r.post("/chat", wrap(async (req, res) => {
    await handleChat(ctx, req, res);
  }));

  return r;
}
