import { Router, type Response } from "express";
import { ZodError } from "zod";
import type { AppCtx } from "../context.js";
import { audit, requireAdminRole } from "../lib/adminAuth.js";
import { wrap } from "../lib/http.js";
import { defaultSite, siteSchema, type SiteSettings } from "../lib/siteSettings.js";
import { z } from "zod";

/** Kembalikan galat validasi per-field agar formulir dasbor bisa menandai kolom yang salah. */
export function sendFieldErrors(res: Response, code: string, message: string, fields: { path: string; message: string }[]) {
  res.status(400).json({ error: { code, message, retryable: false, requestId: res.locals.requestId, fields } });
}
const fieldsOf = (e: ZodError) => e.issues.map((i) => ({ path: i.path.join(".").replace(/^value./, ""), message: i.message }));

/** Daftar path daun yang berubah (tanpa nilai panjang) untuk log audit. */
function diffPaths(a: unknown, b: unknown, prefix = ""): string[] {
  if (typeof a === "object" && a && typeof b === "object" && b && !Array.isArray(a)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) => diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

const LIMIT_FIELDS: [keyof SiteSettings["limits"], string][] = [
  ["dailyMessageLimit", "DAILY_MESSAGE_LIMIT"], ["maxMessageChars", "MAX_MESSAGE_CHARS"], ["maxOutputTokens", "MAX_OUTPUT_TOKENS"],
  ["callMaxMinutes", "CALL_MAX_MINUTES"], ["chatRetentionDays", "CHAT_RETENTION_DAYS"],
  ["dailyTokenBudgetGlobal", "DAILY_TOKEN_BUDGET_GLOBAL"], ["dailyTokenBudgetPerUser", "DAILY_TOKEN_BUDGET_PER_USER"],
];

export function adminSettingsRouter(ctx: AppCtx) {
  const r = Router();

  /** Nilai yang SEDANG berlaku (cfg) beserta sumbernya, agar admin tahu apa yang efektif. */
  const view = () => {
    const site = ctx.settings.site();
    const base = ctx.settings.base() as unknown as Record<string, unknown>;
    const cfg = ctx.cfg as unknown as Record<string, unknown>;
    const effective: Record<string, { value: unknown; envDefault: unknown; source: "db" | "env" }> = {};
    for (const [k, env] of LIMIT_FIELDS) effective[`limits.${k}`] = { value: cfg[env], envDefault: base[env], source: site.limits[k] === null ? "env" : "db" };
    effective["costs.inputPer1M"] = { value: cfg.COST_PER_1M_INPUT_TOKENS, envDefault: base.COST_PER_1M_INPUT_TOKENS, source: site.costs.inputPer1M === null ? "env" : "db" };
    effective["costs.outputPer1M"] = { value: cfg.COST_PER_1M_OUTPUT_TOKENS, envDefault: base.COST_PER_1M_OUTPUT_TOKENS, source: site.costs.outputPer1M === null ? "env" : "db" };
    effective["costs.currency"] = { value: cfg.COST_CURRENCY, envDefault: base.COST_CURRENCY, source: site.costs.currency === null ? "env" : "db" };
    effective["alerts.minIntervalMinutes"] = { value: cfg.ALERT_MIN_INTERVAL_MINUTES, envDefault: base.ALERT_MIN_INTERVAL_MINUTES, source: site.alerts.minIntervalMinutes === null ? "env" : "db" };
    effective["alerts.errorRateThreshold"] = { value: cfg.ERROR_RATE_ALERT_THRESHOLD, envDefault: base.ERROR_RATE_ALERT_THRESHOLD, source: site.alerts.errorRateThreshold === null ? "env" : "db" };
    effective["voice.safetyHoldMs"] = { value: cfg.VOICE_SAFETY_HOLD_MS, envDefault: base.VOICE_SAFETY_HOLD_MS, source: site.voice.safetyHoldMs === null ? "env" : "db" };
    return { value: site, defaults: defaultSite(), effective, meta: ctx.settings.siteMeta(), alertWebhookConfigured: Boolean(ctx.cfg.ALERT_WEBHOOK_URL), crisisTextConfigured: Boolean(ctx.cfg.CRISIS_RESOURCES_TEXT) };
  };

  r.get("/admin/settings", requireAdminRole(ctx, "admin"), wrap(async (_req, res) => res.json(view())));

  r.put("/admin/settings", requireAdminRole(ctx, "admin"), wrap(async (req, res) => {
    const parsed = z.object({ value: siteSchema }).strict().safeParse(req.body);
    if (!parsed.success) return sendFieldErrors(res, "INVALID_SETTINGS", "Ada isian yang tidak valid.", fieldsOf(parsed.error));
    const next = parsed.data.value;
    // Jangan sampai admin mengunci dirinya: maintenance aktif tetap membolehkan admin; pendaftaran tertutup tetap membolehkan pengguna lama.
    const changed = diffPaths(ctx.settings.site(), next);
    if (!changed.length) return res.json(view());
    await ctx.settings.saveSite(next, req.user!.email);
    await audit(ctx, req, "settings.update", "site", { changed });
    res.json(view());
  }));

  // Kembalikan satu bagian (atau semua) ke bawaan: nilai batas kembali mengikuti env.
  r.post("/admin/settings/reset", requireAdminRole(ctx, "admin"), wrap(async (req, res) => {
    const { section } = z.object({ section: z.enum(["all", "name", "ui", "legal", "safety", "persona", "limits", "costs", "alerts", "voice", "access"]) }).strict().parse(req.body);
    const cur = ctx.settings.site();
    const def = defaultSite();
    const next: SiteSettings = section === "all" ? def : section === "name" ? { ...cur, name: def.name, tagline: def.tagline, supportEmail: def.supportEmail, defaultTheme: def.defaultTheme } : { ...cur, [section]: def[section] };
    await ctx.settings.saveSite(next, req.user!.email);
    await audit(ctx, req, "settings.reset", "site", { section });
    res.json(view());
  }));

  return r;
}
