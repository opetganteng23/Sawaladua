import { Router } from "express";
import { COOKIE, readCookie, sha } from "../auth/index.js";
import type { AppCtx } from "../context.js";
import { ApiError, wrap } from "../lib/http.js";

/** Daftar dan pencabutan sesi login milik pengguna sendiri. ID publik = 12 karakter awal hash token (token asli tidak pernah dikirim). */
export function sessionsRouter(ctx: AppCtx) {
  const r = Router();
  const { sessions } = ctx.d.c;
  const currentHash = (req: Parameters<typeof readCookie>[0]) => {
    const t = readCookie(req, COOKIE);
    return t ? sha(t) : null;
  };

  r.get("/sessions", wrap(async (req, res) => {
    const cur = currentHash(req);
    const rows = await sessions.find({ userId: req.user!._id, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json({
      items: rows.map((s) => ({ id: s._id.slice(0, 12), current: s._id === cur, createdAt: s.createdAt, device: s.userAgent || "Perangkat tidak dikenal" })),
    });
  }));

  r.delete("/sessions/:id", wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-f0-9]{12}$/.test(id)) throw new ApiError(400, "INVALID_REQUEST", "ID sesi tidak valid.");
    const del = await sessions.deleteOne({ userId: req.user!._id, _id: { $regex: `^${id}` } as never });
    if (!del.deletedCount) throw new ApiError(404, "NOT_FOUND", "Sesi tidak ditemukan.");
    res.json({ ok: true });
  }));

  r.post("/sessions/revoke-others", wrap(async (req, res) => {
    const cur = currentHash(req);
    const del = await sessions.deleteMany({ userId: req.user!._id, ...(cur ? { _id: { $ne: cur } } : {}) });
    res.json({ ok: true, revoked: del.deletedCount });
  }));

  return r;
}
