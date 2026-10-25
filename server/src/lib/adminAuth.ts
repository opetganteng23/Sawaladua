import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import type { UserDoc } from "../db.js";
import { ApiError } from "./http.js";

export type AdminRole = "owner" | "admin";

/** Pemilik (owner) = email di ADMIN_EMAILS (env). Admin = pengguna dengan role "admin" yang diangkat pemilik. */
export const adminSet = (ctx: AppCtx) => new Set(ctx.cfg.ADMIN_EMAILS.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));

export function adminRoleOf(ctx: AppCtx, u: Pick<UserDoc, "email" | "role" | "status">): AdminRole | null {
  if (adminSet(ctx).has(u.email.toLowerCase())) return "owner";
  if (u.role === "admin" && u.status !== "suspended") return "admin";
  return null;
}

/**
 * Pembatas akses dasbor. Non-admin menerima 404 (bukan 403) agar keberadaan endpoint tidak terungkap.
 * "owner" dibutuhkan untuk hal yang berisiko tinggi: kunci API/provider, mengangkat admin.
 */
export function requireAdminRole(ctx: AppCtx, minimum: AdminRole = "admin") {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user ? adminRoleOf(ctx, req.user) : null;
    if (!role || (minimum === "owner" && role !== "owner")) return next(new ApiError(404, "NOT_FOUND", "Tidak ditemukan."));
    res.locals.adminRole = role;
    next();
  };
}

/**
 * Catat tindakan admin (log audit). `detail` TIDAK BOLEH memuat rahasia (kunci API) maupun isi percakapan;
 * catat hanya nama bagian/field yang berubah.
 */
export async function audit(ctx: AppCtx, req: Request, action: string, target?: string, detail?: Record<string, unknown>) {
  await ctx.d.c.audit_log.insertOne({ at: new Date(), actor: req.user!.email, action, ...(target ? { target } : {}), ...(detail ? { detail } : {}), ip: req.ip } as never).catch(() => undefined);
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

export const pageOf = (total: number, page: number, limit: number) => ({ total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
