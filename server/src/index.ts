import { createApp } from "./app.js";
import { createCtx } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { connectDb } from "./db.js";
import { checkErrorRate } from "./lib/alerts.js";
import { sweepCalls } from "./lib/calls.js";
import { decayMemories } from "./lib/decay.js";
import { resumePendingDeletions, sweepEphemeral } from "./lib/deletion.js";
import { recordOp } from "./lib/ops.js";
import { sweepRetention } from "./lib/retention.js";
import { log } from "./lib/logger.js";
import { attachVoice } from "./voice/index.js";

try { process.loadEnvFile(".env"); } catch { /* .env opsional */ }

const cfg = loadConfig();
const d = await connectDb(cfg.MONGODB_URI, cfg.MONGODB_DB);
const ctx = await createCtx(cfg, d); // migrasi database dijalankan di sini sebelum menerima trafik
const app = createApp(ctx);

await resumePendingDeletions(ctx);

const safe = (event: string, fn: () => Promise<unknown>) => void fn().catch(() => log("warn", { event }));
let tick = 0;
setInterval(() => {
  tick++;
  safe("sweep_failed", () => sweepEphemeral(ctx));
  safe("sweep_calls_failed", () => sweepCalls(ctx));
  safe("resume_deletion_failed", () => resumePendingDeletions(ctx));
  safe("db_ping_failed", async () => { const t = Date.now(); await d.db.command({ ping: 1 }); recordOp(ctx, "db_ping_ms", Date.now() - t); });
  if (tick % 15 === 0) safe("retention_failed", () => sweepRetention(ctx)); // ~30 menit
  if (tick % 3 === 0) safe("error_rate_check_failed", () => checkErrorRate(ctx)); // ~6 menit
  if (tick % 180 === 0) safe("decay_failed", () => decayMemories(ctx)); // ~6 jam
}, 2 * 60_000).unref();
setInterval(() => { void ctx.flags.refresh(); void ctx.settings.refresh(); }, 10_000).unref(); // pengaturan situs/provider/kill switch berlaku lintas instance tanpa restart
// // kill switch berlaku lintas instance tanpa restart

const server = app.listen(cfg.PORT, () => log("info", { event: "listening", status: String(cfg.PORT) }));

attachVoice(server, ctx); // WebSocket suara realtime: /api/calls/:id/realtime

// Shutdown rapi untuk PM2 (reload/restart): berhenti menerima koneksi, tutup DB, lalu keluar.
let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  log("info", { event: "shutdown", status: signal });
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  server.close(() => void d.client.close().finally(() => process.exit(0)));
  server.closeIdleConnections?.();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
