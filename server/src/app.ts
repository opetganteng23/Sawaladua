import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { authRouter, csrfGuard, loadUser, requireAuth } from "./auth/index.js";
import type { AppCtx } from "./context.js";
import { ZodError } from "zod";
import { sendAlert } from "./lib/alerts.js";
import { ApiError, errorHandler, sendError } from "./lib/http.js";
import { rateLimit } from "./lib/ratelimit.js";
import { accountRouter, deletionStatusRouter } from "./routes/account.js";
import { adminRouter } from "./routes/admin.js";
import { adminAuditRouter } from "./routes/adminAudit.js";
import { adminProvidersRouter } from "./routes/adminProviders.js";
import { adminSettingsRouter } from "./routes/adminSettings.js";
import { adminUsersRouter } from "./routes/adminUsers.js";
import { adminRoleOf } from "./lib/adminAuth.js";
import { legalHtml, publicSite } from "./lib/publicSite.js";
import { callsRouter } from "./routes/calls.js";
import { conversationsRouter } from "./routes/conversations.js";
import { memoriesRouter } from "./routes/memories.js";
import { sessionsRouter } from "./routes/sessions.js";

export function createApp(ctx: AppCtx) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  // CSP untuk PWA + Google Identity Services. API hanya JSON sehingga tidak terpengaruh.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "https://accounts.google.com/gsi/client"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com/gsi/style"],
          imgSrc: ["'self'", "data:", "https://*.googleusercontent.com"],
          connectSrc: ["'self'", "https://accounts.google.com/gsi/"],
          frameSrc: ["https://accounts.google.com/gsi/"],
          manifestSrc: ["'self'"],
          workerSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }, // dibutuhkan popup Google Sign-In
    }),
  );

  const allowed = new Set(ctx.cfg.ALLOWED_ORIGINS.split(",").map((s) => s.trim()));
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.requestId = randomUUID();
    res.set("X-Request-Id", res.locals.requestId);
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.set({
        "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin",
        "Access-Control-Allow-Headers": "content-type,x-requested-with",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      });
    }
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: "32kb" }));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  const rl = ctx.d.c.rate_limits;
  const ipLimit = rateLimit(rl, { name: "ip", windowMs: 60_000, max: 120 * ctx.cfg.RATE_LIMIT_SCALE, key: (r) => String(r.ip) });
  const authLimit = rateLimit(rl, { name: "auth", windowMs: 60_000, max: 20 * ctx.cfg.RATE_LIMIT_SCALE, key: (r) => String(r.ip) });
  const chatLimit = rateLimit(rl, { name: "chat", windowMs: 60_000, max: 20 * ctx.cfg.RATE_LIMIT_SCALE, key: (r) => String(r.user?._id ?? r.ip) });
  const exportLimit = rateLimit(rl, { name: "export", windowMs: 3600_000, max: 5 * ctx.cfg.RATE_LIMIT_SCALE, key: (r) => String(r.user?._id ?? r.ip) });

  const api = express.Router();
  api.use(ipLimit, csrfGuard(ctx), loadUser(ctx));
  api.use("/auth", authLimit, authRouter(ctx));
  api.use(deletionStatusRouter(ctx));
  api.get("/site", (_req, res) => res.json(publicSite(ctx))); // pengaturan situs publik (tanpa rahasia)
  // Mode pemeliharaan (Pengaturan Situs): selain admin, API privat menjawab 503 yang jujur dan bisa dicoba lagi.
  api.use((req, res, next) => {
    const m = ctx.settings.site().access.maintenance;
    if (!m.enabled || /^\/(auth|admin|site|deletion-status)(\/|$)/.test(req.path)) return next();
    if (req.user && adminRoleOf(ctx, req.user)) return next();
    sendError(res, 503, "MAINTENANCE", m.message, true);
  });
  api.use(requireAuth());
  api.post("/chat", chatLimit);
  api.post("/data/export", exportLimit);
  api.use(conversationsRouter(ctx));
  api.use(callsRouter(ctx));
  api.use(sessionsRouter(ctx));
  api.use(adminRouter(ctx));
  api.use(adminUsersRouter(ctx));
  api.use(adminSettingsRouter(ctx));
  api.use(adminProvidersRouter(ctx));
  api.use(adminAuditRouter(ctx));
  api.use(memoriesRouter(ctx));
  api.use(accountRouter(ctx));
  api.use((_req, res) => sendError(res, 404, "NOT_FOUND", "Tidak ditemukan."));
  app.use("/api", api);

  // Halaman hukum buatan admin (Pengaturan Situs); jika kosong, jatuh ke halaman bawaan di web/public.
  const legal = (file: "privasi" | "ketentuan") => (_req: Request, res: Response, next: NextFunction) => {
    const s = ctx.settings.site();
    const text = file === "privasi" ? s.legal.privacy : s.legal.terms;
    if (!text) return next();
    res.set("Cache-Control", "no-cache").type("html").send(legalHtml(s.name, file === "privasi" ? "Kebijakan Privasi" : "Ketentuan Penggunaan", text));
  };
  app.get("/privasi.html", legal("privasi"));
  app.get("/ketentuan.html", legal("ketentuan"));

  // Satu proses: API + PWA hasil build (web/dist). Aktif otomatis jika folder build ada.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(ctx.cfg.WEB_DIST_DIR || path.join(here, "../../web/dist"));
  if (existsSync(path.join(webDist, "index.html"))) {
    app.use(
      express.static(webDist, {
        index: false,
        setHeaders: (res, file) => {
          const base = path.basename(file);
          const volatile = base === "index.html" || base === "sw.js" || base === "manifest.webmanifest";
          res.setHeader("Cache-Control", volatile ? "no-cache" : "public, max-age=31536000, immutable");
        },
      }),
    );
    app.get(/^\/(?!api(\/|$)).*/, (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  // Kegagalan tak terduga memicu alert operator (hanya nama error + id request, tanpa data pengguna).
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const known = err instanceof ApiError || err instanceof ZodError || (err as { type?: string })?.type === "entity.too.large";
    if (!known) void sendAlert(ctx, "internal_error", "critical", `${(err as Error)?.name ?? "Error"} (request ${res.locals.requestId})`);
    next(err);
  });
  app.use(errorHandler);
  return app;
}
