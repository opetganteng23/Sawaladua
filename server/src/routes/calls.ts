import { Router } from "express";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import { oid, type CallSessionDoc } from "../db.js";
import { ApiError, wrap } from "../lib/http.js";
import { finishCall } from "../lib/calls.js";
import { recordOp } from "../lib/ops.js";

export function callsRouter(ctx: AppCtx) {
  const r = Router();
  const { c } = ctx.d;

  const requireVoice = () => {
    if (!ctx.flags.get().voiceCalls) throw new ApiError(404, "FEATURE_DISABLED", "Panggilan suara belum tersedia.");
  };

  r.post("/calls", wrap(async (req, res) => {
    requireVoice();
    const user = req.user!;
    if (!user.ageConfirmedAt) throw new ApiError(403, "AGE_CONFIRMATION_REQUIRED", "Konfirmasi usia diperlukan.");
    const body = z.object({ transcriptConsent: z.boolean() }).strict().parse(req.body);
    // Satu panggilan aktif per pengguna: akhiri yang lama dengan aman.
    for (const old of await c.call_sessions.find({ userId: user._id, status: "active" }).toArray()) await finishCall(ctx, old, "user");
    const now = new Date();
    // Tanpa persetujuan transkrip, percakapan bersifat sementara (juga dibersihkan sweeper jika klien hilang).
    const ephemeral = !body.transcriptConsent || !user.privacySettings.saveHistory;
    const conv = await c.conversations.insertOne({
      userId: user._id, title: "Panggilan suara", createdAt: now, updatedAt: now, deletedAt: null,
      ephemeral, expiresAt: ephemeral ? new Date(now.getTime() + 2 * 3600_000) : null,
    } as never);
    const doc: Omit<CallSessionDoc, "_id"> = {
      userId: user._id, conversationId: conv.insertedId, status: "active", transcriptConsent: body.transcriptConsent,
      startedAt: now, lastActivityAt: now, endedAt: null, turns: 0,
    };
    const ins = await c.call_sessions.insertOne(doc as CallSessionDoc);
    recordOp(ctx, "call_started");
    res.status(201).json({ id: String(ins.insertedId), conversationId: String(conv.insertedId), maxMinutes: ctx.cfg.CALL_MAX_MINUTES, transcriptConsent: body.transcriptConsent });
  }));

  r.post("/calls/:id/end", wrap(async (req, res) => {
    requireVoice();
    const id = oid(String(req.params.id));
    const body = z.object({ avgLatencyMs: z.number().min(0).max(120_000).optional(), clientTurns: z.number().int().min(0).max(10_000).optional() }).strict().parse(req.body ?? {});
    const call = id ? await c.call_sessions.findOne({ _id: id, userId: req.user!._id }) : null;
    if (!call) throw new ApiError(404, "NOT_FOUND", "Panggilan tidak ditemukan.");
    const r2 = await finishCall(ctx, call, "user", body);
    res.json({ ok: true, transcriptKept: r2.transcriptKept });
  }));

  return r;
}
