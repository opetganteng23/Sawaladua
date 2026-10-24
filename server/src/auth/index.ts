import { createHash, randomBytes } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import { defaultPreferences, defaultPrivacy, type UserDoc } from "../db.js";
import { ApiError, wrap } from "../lib/http.js";
import { featureFlags } from "../features.js";

export const COOKIE = "sawala_sid";
const SESSION_DAYS = 14;
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const adminSet = (ctx: AppCtx) => new Set(ctx.cfg.ADMIN_EMAILS.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function publicUser(u: UserDoc, adminEmails: Set<string> = new Set()) {
  return {
    id: String(u._id),
    email: u.email,
    displayName: u.displayName,
    preferences: u.preferences,
    privacySettings: u.privacySettings,
    onboardingDone: u.onboardingDone,
    ageConfirmed: Boolean(u.ageConfirmedAt),
    isAdmin: adminEmails.has(u.email.toLowerCase()),
    deletionStatus: u.deletionStatus,
  };
}

async function startSession(ctx: AppCtx, req: Request, res: Response, user: UserDoc) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await ctx.d.c.sessions.insertOne({ _id: sha(token), userId: user._id, createdAt: new Date(), expiresAt, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 100) });
  const secure = ctx.cfg.NODE_ENV === "production" || ctx.cfg.NODE_ENV === "staging";
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure, expires: expiresAt, path: "/" });
}

async function upsertUser(ctx: AppCtx, p: { provider: "google" | "dev"; sub: string; email: string; name: string }) {
  const email = p.email.trim().toLowerCase();
  const existing = await ctx.d.c.users.findOne({ authProvider: p.provider, providerSub: p.sub });
  if (existing) return existing;
  const doc: UserDoc = {
    _id: undefined as never,
    email,
    displayName: p.name.slice(0, 80),
    authProvider: p.provider,
    providerSub: p.sub,
    preferences: defaultPreferences(),
    privacySettings: defaultPrivacy(),
    onboardingDone: false,
    deletionStatus: "none",
    lastGreetingAt: null,
    createdAt: new Date(),
  };
  delete (doc as Partial<UserDoc>)._id;
  try {
    const r = await ctx.d.c.users.insertOne(doc);
    return { ...doc, _id: r.insertedId } as UserDoc;
  } catch (e) {
    if ((e as { code?: number }).code === 11000)
      throw new ApiError(409, "EMAIL_IN_USE", "Email ini sudah terhubung ke metode login lain.");
    throw e;
  }
}

/** Proteksi CSRF untuk sesi berbasis cookie: cek Origin dan header kustom pada request mutasi. */
export function csrfGuard(ctx: AppCtx) {
  const allowed = new Set(ctx.cfg.ALLOWED_ORIGINS.split(",").map((s) => s.trim()));
  return (req: Request, _res: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) return next(new ApiError(403, "BAD_ORIGIN", "Asal permintaan tidak diizinkan."));
    if (req.headers["x-requested-with"] !== "sawala")
      return next(new ApiError(403, "CSRF", "Permintaan tidak valid."));
    next();
  };
}

export function loadUser(ctx: AppCtx) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = readCookie(req, COOKIE);
      if (token) {
        const s = await ctx.d.c.sessions.findOne({ _id: sha(token), expiresAt: { $gt: new Date() } });
        if (s) req.user = (await ctx.d.c.users.findOne({ _id: s.userId })) ?? undefined;
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function requireAuth(opts: { allowPendingDeletion?: boolean } = {}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new ApiError(401, "UNAUTHENTICATED", "Silakan masuk dahulu."));
    if (req.user.deletionStatus === "deletion_pending" && !opts.allowPendingDeletion)
      return next(new ApiError(403, "DELETION_PENDING", "Akun sedang dalam proses penghapusan."));
    next();
  };
}

export function authRouter(ctx: AppCtx) {
  const r = Router();
  const google = ctx.cfg.GOOGLE_CLIENT_ID ? new OAuth2Client(ctx.cfg.GOOGLE_CLIENT_ID) : null;

  r.get("/session", (req, res) => {
    res.json({
      user: req.user ? publicUser(req.user, adminSet(ctx)) : null,
      features: featureFlags(ctx),
      auth: { google: Boolean(google), clientId: ctx.cfg.GOOGLE_CLIENT_ID || null, dev: ctx.cfg.AUTH_DEV_LOGIN },
    });
  });

  r.post("/google", wrap(async (req, res) => {
    if (!google) throw new ApiError(503, "OAUTH_NOT_CONFIGURED", "Login Google belum dikonfigurasi.");
    const { credential } = z.object({ credential: z.string().min(10).max(5000) }).strict().parse(req.body);
    let payload;
    try {
      const ticket = await google.verifyIdToken({ idToken: credential, audience: ctx.cfg.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch {
      throw new ApiError(401, "INVALID_CREDENTIAL", "Login Google gagal diverifikasi.");
    }
    if (!payload?.sub || !payload.email || !payload.email_verified)
      throw new ApiError(401, "INVALID_CREDENTIAL", "Email Google belum terverifikasi.");
    const user = await upsertUser(ctx, { provider: "google", sub: payload.sub, email: payload.email, name: payload.name ?? payload.email });
    if (user.deletionStatus === "deletion_pending") throw new ApiError(403, "DELETION_PENDING", "Akun sedang dalam proses penghapusan.");
    await startSession(ctx, req, res, user);
    res.json({ user: publicUser(user, adminSet(ctx)) });
  }));

  r.post("/dev", wrap(async (req, res) => {
    if (!ctx.cfg.AUTH_DEV_LOGIN) throw new ApiError(404, "NOT_FOUND", "Tidak ditemukan.");
    const b = z.object({ email: z.string().email().max(200), displayName: z.string().min(1).max(80).optional() }).strict().parse(req.body);
    const user = await upsertUser(ctx, { provider: "dev", sub: b.email.toLowerCase(), email: b.email, name: b.displayName ?? b.email.split("@")[0]! });
    if (user.deletionStatus === "deletion_pending") throw new ApiError(403, "DELETION_PENDING", "Akun sedang dalam proses penghapusan.");
    await startSession(ctx, req, res, user);
    res.json({ user: publicUser(user, adminSet(ctx)) });
  }));

  r.post("/logout", wrap(async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) await ctx.d.c.sessions.deleteOne({ _id: sha(token) });
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  }));

  return r;
}
