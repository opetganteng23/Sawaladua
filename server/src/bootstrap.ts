import type { Config } from "./config.js";
import type { AppCtx } from "./context.js";
import type { Database } from "./db.js";
import { createFlags } from "./lib/flags.js";
import { makeEmbedder, makeLlm, makeStt, makeTts } from "./llm/index.js";
import { runMigrations } from "./migrations/index.js";

/** Rakit konteks aplikasi: migrasi database, kill switch runtime, dan adapter provider. */
export async function createCtx(cfg: Config, d: Database, overrides: Partial<AppCtx> = {}): Promise<AppCtx> {
  await runMigrations(d);
  const flags = createFlags(cfg, d.c.app_settings);
  await flags.refresh();
  return { cfg, d, llm: makeLlm(cfg), embedder: makeEmbedder(cfg), stt: makeStt(cfg), tts: makeTts(cfg), flags, ...overrides };
}
