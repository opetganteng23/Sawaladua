import type { Config } from "./config.js";
import type { AppCtx } from "./context.js";
import type { Database } from "./db.js";
import { createFlags } from "./lib/flags.js";
import { createSettingsStore } from "./lib/siteSettings.js";
import { makeEmbedder, makeLlm, makeStt, makeTts } from "./llm/index.js";
import { runMigrations } from "./migrations/index.js";

/**
 * Rakit konteks aplikasi: migrasi database, kill switch runtime, pengaturan situs, dan adapter provider.
 * Provider dibangun ulang otomatis saat admin mengubah provider/kunci/model lewat dasbor (tanpa restart).
 */
export async function createCtx(cfg: Config, d: Database, overrides: Partial<AppCtx> = {}): Promise<AppCtx> {
  await runMigrations(d);
  const flags = createFlags(cfg, d.c.app_settings);
  await flags.refresh();
  const ctx: AppCtx = { cfg, d, llm: makeLlm(cfg), embedder: makeEmbedder(cfg), stt: makeStt(cfg), tts: makeTts(cfg), flags, settings: undefined as never, ...overrides };
  ctx.settings = createSettingsStore(cfg, d.c.app_settings, () => {
    try {
      ctx.llm = makeLlm(cfg); ctx.embedder = makeEmbedder(cfg); ctx.stt = makeStt(cfg); ctx.tts = makeTts(cfg);
    } catch { /* konfigurasi tidak valid: pertahankan adapter sebelumnya */ }
  });
  await ctx.settings.refresh();
  return ctx;
}
