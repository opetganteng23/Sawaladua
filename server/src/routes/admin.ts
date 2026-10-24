import { Router } from "express";
import { z } from "zod";
import type { AppCtx } from "../context.js";
import { adminSet } from "../auth/index.js";
import { FLAG_NAMES, type FlagName } from "../lib/flags.js";
import { ApiError, wrap } from "../lib/http.js";

const pct = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

/**
 * Metrik penggunaan agregat untuk operator (email di ADMIN_EMAILS). Tidak memuat isi percakapan
 * maupun identitas pengguna. Estimasi biaya hanya muncul jika harga diisi lewat konfigurasi.
 */
export function adminRouter(ctx: AppCtx) {
  const r = Router();
  const admins = adminSet(ctx);
  const requireAdmin = (email: string) => {
    // 404 (bukan 403) agar keberadaan endpoint tidak terungkap ke non-admin.
    if (!admins.has(email.toLowerCase())) throw new ApiError(404, "NOT_FOUND", "Tidak ditemukan.");
  };

  r.get("/admin/usage", wrap(async (req, res) => {
    requireAdmin(req.user!.email);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
    const since = new Date(Date.now() - days * 864e5);
    const rows = await ctx.d.c.usage_events
      .find({ createdAt: { $gte: since } }, { projection: { _id: 0, userId: 0, requestId: 0 } })
      .limit(100_000)
      .toArray();
    const byDay = new Map<string, { requests: number; ok: number; failed: number; inputTokens: number; outputTokens: number; lat: number[] }>();
    const byModel = new Map<string, { requests: number; inputTokens: number; outputTokens: number }>();
    for (const e of rows) {
      const d = e.createdAt.toISOString().slice(0, 10);
      const x = byDay.get(d) ?? { requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, lat: [] };
      x.requests++; e.status === "ok" ? x.ok++ : x.failed++;
      x.inputTokens += e.inputTokens; x.outputTokens += e.outputTokens; x.lat.push(e.latencyMs);
      byDay.set(d, x);
      const mk = `${e.provider}/${e.model}`;
      const m = byModel.get(mk) ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
      m.requests++; m.inputTokens += e.inputTokens; m.outputTokens += e.outputTokens;
      byModel.set(mk, m);
    }
    const priced = ctx.cfg.COST_PER_1M_INPUT_TOKENS > 0 || ctx.cfg.COST_PER_1M_OUTPUT_TOKENS > 0;
    const cost = (i: number, o: number) =>
      priced ? Number(((i / 1e6) * ctx.cfg.COST_PER_1M_INPUT_TOKENS + (o / 1e6) * ctx.cfg.COST_PER_1M_OUTPUT_TOKENS).toFixed(4)) : null;
    // Metrik operasional (MTS 13.2): hanya hitungan dan durasi, tanpa isi percakapan atau identitas.
    const ops = await ctx.d.c.ops_events.find({ at: { $gte: since } }, { projection: { _id: 0 } }).limit(200_000).toArray();
    const counts: Record<string, number> = {};
    const series: Record<string, number[]> = {};
    for (const o of ops) { counts[o.type] = (counts[o.type] ?? 0) + 1; if (o.ms !== undefined) (series[o.type] ??= []).push(o.ms); }
    const latency = (t: string) => ({ samples: series[t]?.length ?? 0, p50Ms: pct(series[t] ?? [], 50), p95Ms: pct(series[t] ?? [], 95) });
    const total = rows.length;
    res.json({
      ops: {
        counts,
        streamDisconnectRate: total ? Number(((counts.stream_disconnect ?? 0) / total).toFixed(3)) : 0,
        invalidOutputRate: total ? Number(((counts.output_invalid ?? 0) / total).toFixed(3)) : 0,
        retrieval: latency("retrieval_ms"), vectorSearch: latency("vector_ms"), dbPing: latency("db_ping_ms"),
        safety: { level1: counts.safety_level_1 ?? 0, level2: counts.safety_level_2 ?? 0, level3: counts.safety_level_3 ?? 0, voiceLatched: counts.call_latched ?? 0 },
        failures: { memoryExtraction: counts.memory_extraction_failed ?? 0, summary: counts.summary_failed ?? 0, deletionStep: counts.deletion_step_failed ?? 0 },
      },
      days,
      currency: ctx.cfg.COST_CURRENCY,
      costNote: priced ? "Estimasi dari harga yang diisi operator; bukan tagihan resmi." : "Harga belum dikonfigurasi (COST_PER_1M_*), estimasi biaya tidak tersedia.",
      budget: { dailyGlobal: ctx.cfg.DAILY_TOKEN_BUDGET_GLOBAL || null, dailyPerUser: ctx.cfg.DAILY_TOKEN_BUDGET_PER_USER || null },
      daily: [...byDay.entries()].sort().map(([date, x]) => ({
        date, requests: x.requests, ok: x.ok, failed: x.failed, errorRate: Number((x.failed / x.requests).toFixed(3)),
        inputTokens: x.inputTokens, outputTokens: x.outputTokens, latencyP50Ms: pct(x.lat, 50), latencyP95Ms: pct(x.lat, 95),
        estimatedCost: cost(x.inputTokens, x.outputTokens),
      })),
      models: [...byModel.entries()].map(([model, m]) => ({ model, ...m, estimatedCost: cost(m.inputTokens, m.outputTokens) })),
    });
  }));

  const flagsView = () => ({ effective: ctx.flags.get(), killed: ctx.flags.killed(), names: FLAG_NAMES });

  r.get("/admin/flags", wrap(async (req, res) => {
    requireAdmin(req.user!.email);
    res.json(flagsView());
  }));

  // Kill switch runtime: hanya bisa MEMATIKAN fitur yang menyala di environment (tanpa restart; lintas instance dalam ~10 dtk).
  r.patch("/admin/flags", wrap(async (req, res) => {
    requireAdmin(req.user!.email);
    const body = z.object({ killed: z.array(z.enum(FLAG_NAMES)).max(FLAG_NAMES.length) }).strict().parse(req.body);
    await ctx.flags.setKilled([...new Set(body.killed)] as FlagName[]);
    res.json(flagsView());
  }));

  return r;
}
