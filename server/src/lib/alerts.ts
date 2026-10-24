import type { AppCtx } from "../context.js";
import { log } from "./logger.js";

export type AlertType = "budget_80_percent" | "quota_exhausted" | "error_rate_high" | "internal_error" | "deletion_failed";

const lastSent = new Map<string, number>();
export const resetAlerts = () => lastSent.clear();

/**
 * Kirim alert operasional ke webhook (Slack/Discord/Telegram-bridge/sistem sendiri). Payload SELALU tanpa isi percakapan
 * dan tanpa identitas pengguna: hanya jenis kejadian dan ringkasan teknis. Satu jenis dikirim paling sering sekali per jam.
 */
export async function sendAlert(ctx: AppCtx, type: AlertType, severity: "warning" | "critical", summary: string): Promise<boolean> {
  const url = ctx.cfg.ALERT_WEBHOOK_URL;
  if (!url) return false;
  const prod = ctx.cfg.NODE_ENV === "production" || ctx.cfg.NODE_ENV === "staging";
  if (prod && !url.startsWith("https://")) {
    log("warn", { event: "alert_webhook_insecure_url" });
    return false;
  }
  const now = Date.now();
  if (now - (lastSent.get(type) ?? 0) < ctx.cfg.ALERT_MIN_INTERVAL_MINUTES * 60_000) return false;
  lastSent.set(type, now);
  const text = `[Sawala/${ctx.cfg.NODE_ENV}] ${severity.toUpperCase()} ${type}: ${summary}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "sawala", env: ctx.cfg.NODE_ENV, type, severity, summary, at: new Date().toISOString(), text, content: text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) log("warn", { event: "alert_webhook_failed", status: String(res.status) });
    return res.ok;
  } catch {
    log("warn", { event: "alert_webhook_failed" });
    return false;
  }
}

/** Periksa error rate 15 menit terakhir. Dipanggil berkala; butuh minimal 20 request agar tidak berisik. */
export async function checkErrorRate(ctx: AppCtx): Promise<boolean> {
  const since = new Date(Date.now() - 15 * 60_000);
  const rows = await ctx.d.c.usage_events.find({ createdAt: { $gte: since } }, { projection: { status: 1 } }).limit(5000).toArray();
  if (rows.length < 20) return false;
  const failed = rows.filter((r) => r.status !== "ok").length;
  const rate = failed / rows.length;
  if (rate <= ctx.cfg.ERROR_RATE_ALERT_THRESHOLD) return false;
  return sendAlert(ctx, "error_rate_high", "critical", `error rate ${(rate * 100).toFixed(0)}% dari ${rows.length} request dalam 15 menit terakhir`);
}
