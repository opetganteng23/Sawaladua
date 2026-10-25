import { Router } from "express";
import type { Filter } from "mongodb";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import type { AuditDoc } from "../db.js";
import { escapeRegex, pageOf, pageQuery, requireAdminRole } from "../lib/adminAuth.js";
import { wrap } from "../lib/http.js";

/** Log audit tindakan admin (siapa, kapan, apa). Tidak memuat rahasia maupun isi percakapan. Disimpan 365 hari. */
export function adminAuditRouter(ctx: AppCtx) {
  const r = Router();
  r.get("/admin/audit", requireAdminRole(ctx, "admin"), wrap(async (req, res) => {
    const q = pageQuery.extend({ action: z.string().trim().max(60).optional() }).parse(req.query);
    const and: Filter<AuditDoc>[] = [];
    if (q.q) and.push({ $or: [{ actor: { $regex: escapeRegex(q.q), $options: "i" } }, { target: { $regex: escapeRegex(q.q), $options: "i" } }] });
    if (q.action) and.push({ action: { $regex: `^${escapeRegex(q.action)}` } });
    const filter: Filter<AuditDoc> = and.length ? { $and: and } : {};
    const total = await ctx.d.c.audit_log.countDocuments(filter);
    const rows = await ctx.d.c.audit_log.find(filter).sort({ at: q.dir === "asc" ? 1 : -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).toArray();
    res.json({ items: rows.map((a) => ({ id: String(a._id), at: a.at, actor: a.actor, action: a.action, target: a.target ?? "", detail: a.detail ?? {}, ip: a.ip ?? "" })), ...pageOf(total, q.page, q.limit) });
  }));
  return r;
}
