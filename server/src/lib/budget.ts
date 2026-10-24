import type { ObjectId } from "mongodb";
import type { AppCtx } from "../context.js";
import { sendAlert } from "./alerts.js";
import { log } from "./logger.js";

export type BudgetState = "ok" | "global_exhausted" | "user_exhausted";

const startOfUtcDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

async function tokensToday(ctx: AppCtx, userId?: ObjectId): Promise<number> {
  const r = await ctx.d.c.usage_events
    .aggregate<{ total: number }>([
      { $match: { createdAt: { $gte: startOfUtcDay() }, ...(userId ? { userId } : {}) } },
      { $group: { _id: null, total: { $sum: { $add: ["$inputTokens", "$outputTokens"] } } } },
    ])
    .toArray();
  return r[0]?.total ?? 0;
}

let globalCache: { at: number; value: number } | null = null;
let lastAlertAt = 0;

/** Periksa anggaran token harian (global dan per pengguna). 0 = nonaktif. Alert dicatat maksimal sekali per jam. */
export async function checkBudget(ctx: AppCtx, userId: ObjectId): Promise<BudgetState> {
  const { DAILY_TOKEN_BUDGET_GLOBAL: g, DAILY_TOKEN_BUDGET_PER_USER: u } = ctx.cfg;
  if (g > 0) {
    if (!globalCache || Date.now() - globalCache.at > 15_000) globalCache = { at: Date.now(), value: await tokensToday(ctx) };
    const used = globalCache.value;
    if (used >= g) return "global_exhausted";
    if (used >= g * 0.8 && Date.now() - lastAlertAt > 3600_000) {
      lastAlertAt = Date.now();
      log("warn", { event: "budget_alert", status: "80_percent_of_daily_global_budget" });
      void sendAlert(ctx, "budget_80_percent", "warning", `pemakaian token harian mencapai ${Math.round((used / g) * 100)}% dari anggaran global`);
    }
  }
  if (u > 0 && (await tokensToday(ctx, userId)) >= u) return "user_exhausted";
  return "ok";
}

export function resetBudgetCache() {
  globalCache = null;
  lastAlertAt = 0;
}

export const QUOTA_MESSAGE =
  "Sawala sedang mencapai batas penggunaan dan istirahat dulu. Pesanmu sudah tersimpan. Coba lagi nanti, ya. Kalau kamu butuh bantuan segera, hubungi orang tepercaya atau layanan darurat setempat.";
