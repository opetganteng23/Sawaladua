import type { Collection } from "mongodb";
import type { Config } from "../config.js";
import type { AppSettingDoc } from "../db.js";

export const FLAG_NAMES = ["longTermMemory", "moodThemes", "proactiveGreeting", "voiceCalls", "dataExport"] as const;
export type FlagName = (typeof FLAG_NAMES)[number];
export type Features = Record<FlagName, boolean>;

export interface FlagStore {
  get(): Features;
  killed(): FlagName[];
  refresh(): Promise<void>;
  setKilled(names: FlagName[]): Promise<void>;
}

/**
 * Flag efektif = flag environment AND NOT kill switch runtime.
 * Environment adalah batas atas: kill switch hanya bisa MEMATIKAN fitur (aman, bisa dilakukan tanpa restart),
 * tidak bisa menyalakan fitur yang belum disetujui lewat konfigurasi.
 */
export function createFlags(cfg: Config, store: Collection<AppSettingDoc>): FlagStore {
  const env: Features = {
    longTermMemory: cfg.FEATURE_LONG_TERM_MEMORY,
    moodThemes: cfg.FEATURE_MOOD_THEMES,
    proactiveGreeting: cfg.FEATURE_PROACTIVE_GREETING,
    voiceCalls: cfg.FEATURE_VOICE_CALLS,
    dataExport: cfg.FEATURE_DATA_EXPORT,
  };
  let killed: FlagName[] = [];
  let effective: Features = { ...env };
  const recompute = () => {
    effective = { ...env };
    for (const k of killed) effective[k] = false;
  };
  return {
    get: () => effective,
    killed: () => killed,
    async refresh() {
      try {
        const doc = await store.findOne({ _id: "flags" });
        killed = (doc?.killed ?? []).filter((k): k is FlagName => (FLAG_NAMES as readonly string[]).includes(k));
        recompute();
      } catch {
        /* database sementara tidak tersedia: pertahankan nilai terakhir */
      }
    },
    async setKilled(names) {
      await store.updateOne({ _id: "flags" }, { $set: { killed: names, updatedAt: new Date() } }, { upsert: true });
      killed = names;
      recompute();
    },
  };
}
