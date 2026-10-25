import type { Collection } from "mongodb";
import { z } from "zod";
import type { Config } from "../config.js";
import { THEMES } from "../db.js";
import type { AppSettingDoc } from "../db.js";
import { decryptSecret, encryptSecret, encryptionAvailable, maskSecret } from "./crypto.js";

/* ---------- Pengaturan situs (dapat diubah dari dasbor, tidak hard-code) ---------- */

const nullableInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable().default(null);
const httpsUrlOrEmpty = z.string().max(500).refine((v) => v === "" || /^https:\/\/[^\s]+$/.test(v), "URL harus diawali https:// atau dikosongkan").default("");

export const siteSchema = z.object({
  name: z.string().trim().min(1).max(40).default("Sawala"),
  tagline: z.string().trim().max(120).default("Teman ngobrol berbasis AI"),
  supportEmail: z.string().trim().max(120).refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Email tidak valid").default(""),
  defaultTheme: z.enum(THEMES).default("terang"),
  ui: z.object({
    emptyLines: z.array(z.string().trim().min(1).max(140)).length(3).default(["Lagi pengin cerita tentang apa?", "Kamu boleh mulai dari hal kecil.", "Kalau belum tahu mau mulai dari mana, nggak apa-apa."]),
    disclaimer: z.string().trim().min(1).max(300).default("Sawala adalah AI, bisa salah, dan bukan pengganti bantuan profesional. Dalam keadaan darurat, hubungi layanan darurat setempat."),
  }).strict().prefault({}),
  legal: z.object({
    privacy: z.string().max(40_000).default(""), // kosong = pakai halaman bawaan
    terms: z.string().max(40_000).default(""),
  }).strict().prefault({}),
  safety: z.object({
    crisisResourcesText: z.string().max(2000).default(""), // kosong = pakai nilai env
  }).strict().prefault({}),
  persona: z.object({
    extraInstructions: z.string().max(1000).default(""), // tambahan dari operator; tidak bisa mengalahkan aturan keselamatan
  }).strict().prefault({}),
  // null = pakai nilai bawaan dari env
  limits: z.object({
    dailyMessageLimit: nullableInt(1, 100_000),
    maxMessageChars: nullableInt(100, 20_000),
    maxOutputTokens: nullableInt(50, 8000),
    callMaxMinutes: nullableInt(1, 120),
    chatRetentionDays: nullableInt(0, 3650),
    dailyTokenBudgetGlobal: nullableInt(0, 2_000_000_000),
    dailyTokenBudgetPerUser: nullableInt(0, 2_000_000_000),
  }).strict().prefault({}),
  costs: z.object({
    inputPer1M: z.number().min(0).max(1_000_000).nullable().default(null),
    outputPer1M: z.number().min(0).max(1_000_000).nullable().default(null),
    currency: z.string().trim().min(1).max(8).nullable().default(null),
  }).strict().prefault({}),
  alerts: z.object({
    webhookUrl: httpsUrlOrEmpty,
    minIntervalMinutes: nullableInt(0, 1440),
    errorRateThreshold: z.number().min(0).max(1).nullable().default(null),
  }).strict().prefault({}),
  voice: z.object({
    safetyHoldMs: nullableInt(0, 3000),
  }).strict().prefault({}),
  access: z.object({
    registrationOpen: z.boolean().default(true),
    allowedEmailDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Domain tidak valid")).max(50).default([]),
    maintenance: z.object({ enabled: z.boolean().default(false), message: z.string().trim().max(300).default("Sawala sedang dalam pemeliharaan. Coba lagi sebentar lagi.") }).strict().prefault({}),
  }).strict().prefault({}),
}).strict();
export type SiteSettings = z.infer<typeof siteSchema>;
export const defaultSite = (): SiteSettings => siteSchema.parse({});

/* ---------- Konfigurasi provider (dapat diganti dari dasbor) ---------- */

const model = z.string().trim().regex(/^[A-Za-z0-9._:/-]{1,100}$/, "Nama model hanya boleh huruf, angka, titik, titik dua, garis, dan slash");
const voice = z.string().trim().regex(/^[A-Za-z0-9._-]{0,60}$/, "Nama suara tidak valid");

export const llmS = z.object({ provider: z.enum(["gemini", "openai", "anthropic", "mock"]), model }).strict();
export const embS = z.object({ provider: z.enum(["gemini", "openai", "mock"]), model, dimensions: z.number().int().min(8).max(3072) }).strict();
export const sttS = z.object({ provider: z.enum(["none", "gemini", "openai", "mock"]), model }).strict();
export const ttsS = z.object({ provider: z.enum(["none", "gemini", "openai", "mock"]), model, voice }).strict();
export const rtS = z.object({ provider: z.enum(["none", "gemini", "openai", "cascade", "mock"]), model, voice }).strict();
export const providersSchema = z.object({ llm: llmS.optional(), embedding: embS.optional(), stt: sttS.optional(), tts: ttsS.optional(), realtime: rtS.optional() }).strict();
export type ProviderOverrides = z.infer<typeof providersSchema>;

export const VENDORS = ["gemini", "openai", "anthropic"] as const;
export type Vendor = (typeof VENDORS)[number];
const KEY_FIELD: Record<Vendor, "GEMINI_API_KEY" | "OPENAI_API_KEY" | "ANTHROPIC_API_KEY"> = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

interface ProvidersDoc { _id: "providers"; value?: ProviderOverrides; keys?: Partial<Record<Vendor, string>>; updatedAt: Date; updatedBy?: string }
interface SiteDoc { _id: "site"; value: unknown; updatedAt: Date; updatedBy?: string }

export interface SettingsStore {
  site(): SiteSettings;
  siteMeta(): { updatedAt: Date | null; updatedBy: string | null };
  providerOverrides(): ProviderOverrides;
  providersMeta(): { updatedAt: Date | null; updatedBy: string | null };
  keyInfo(): Record<Vendor, { source: "db" | "env" | "none"; masked: string }>;
  encryption(): boolean;
  /** Muat dari database dan terapkan ke cfg (mutasi in-place) lalu panggil onProvidersChanged bila konfigurasi provider berubah. */
  refresh(): Promise<void>;
  saveSite(v: SiteSettings, actor: string): Promise<void>;
  saveProviders(v: ProviderOverrides, actor: string): Promise<void>;
  setKey(vendor: Vendor, secret: string | null, actor: string): Promise<void>;
  /** Hitung cfg efektif dari env + override tanpa menerapkannya (untuk validasi/uji sebelum disimpan). */
  preview(opts: { providers?: ProviderOverrides; keys?: Partial<Record<Vendor, string | null>> }): Config;
  /** Nilai dasar dari env (sebelum override), untuk menampilkan "bawaan". */
  base(): Readonly<Config>;
}

export function createSettingsStore(cfg: Config, coll: Collection<AppSettingDoc>, onProvidersChanged: () => void): SettingsStore {
  const base: Config = structuredClone(cfg);
  const col = coll as unknown as Collection<SiteDoc | ProvidersDoc>;
  let site = defaultSite();
  let siteMeta: { updatedAt: Date | null; updatedBy: string | null } = { updatedAt: null, updatedBy: null };
  let prov: ProviderOverrides = {};
  let provMeta: { updatedAt: Date | null; updatedBy: string | null } = { updatedAt: null, updatedBy: null };
  let encKeys: Partial<Record<Vendor, string>> = {};
  let lastFingerprint = "";

  const decrypt = (blob?: string): string => {
    if (!blob) return "";
    try { return decryptSecret(blob, base.SETTINGS_ENCRYPTION_KEY); } catch { return ""; } // kunci enkripsi diganti/rusak: anggap tidak ada
  };

  /** Terapkan override ke objek cfg tertentu (mutasi). */
  function applyTo(target: Config, s: SiteSettings, p: ProviderOverrides, keys: Partial<Record<Vendor, string>>) {
    const pick = <T,>(v: T | null | undefined, d: T): T => (v === null || v === undefined ? d : v);
    target.DAILY_MESSAGE_LIMIT = pick(s.limits.dailyMessageLimit, base.DAILY_MESSAGE_LIMIT);
    target.MAX_MESSAGE_CHARS = pick(s.limits.maxMessageChars, base.MAX_MESSAGE_CHARS);
    target.MAX_OUTPUT_TOKENS = pick(s.limits.maxOutputTokens, base.MAX_OUTPUT_TOKENS);
    target.CALL_MAX_MINUTES = pick(s.limits.callMaxMinutes, base.CALL_MAX_MINUTES);
    target.CHAT_RETENTION_DAYS = pick(s.limits.chatRetentionDays, base.CHAT_RETENTION_DAYS);
    target.DAILY_TOKEN_BUDGET_GLOBAL = pick(s.limits.dailyTokenBudgetGlobal, base.DAILY_TOKEN_BUDGET_GLOBAL);
    target.DAILY_TOKEN_BUDGET_PER_USER = pick(s.limits.dailyTokenBudgetPerUser, base.DAILY_TOKEN_BUDGET_PER_USER);
    target.COST_PER_1M_INPUT_TOKENS = pick(s.costs.inputPer1M, base.COST_PER_1M_INPUT_TOKENS);
    target.COST_PER_1M_OUTPUT_TOKENS = pick(s.costs.outputPer1M, base.COST_PER_1M_OUTPUT_TOKENS);
    target.COST_CURRENCY = pick(s.costs.currency, base.COST_CURRENCY);
    target.ALERT_WEBHOOK_URL = s.alerts.webhookUrl || base.ALERT_WEBHOOK_URL;
    target.ALERT_MIN_INTERVAL_MINUTES = pick(s.alerts.minIntervalMinutes, base.ALERT_MIN_INTERVAL_MINUTES);
    target.ERROR_RATE_ALERT_THRESHOLD = pick(s.alerts.errorRateThreshold, base.ERROR_RATE_ALERT_THRESHOLD);
    target.VOICE_SAFETY_HOLD_MS = pick(s.voice.safetyHoldMs, base.VOICE_SAFETY_HOLD_MS);
    target.CRISIS_RESOURCES_TEXT = s.safety.crisisResourcesText || base.CRISIS_RESOURCES_TEXT;

    // provider: mulai dari nilai env, timpa dengan override
    target.LLM_PROVIDER = base.LLM_PROVIDER; target.GEMINI_MODEL = base.GEMINI_MODEL; target.OPENAI_MODEL = base.OPENAI_MODEL; target.ANTHROPIC_MODEL = base.ANTHROPIC_MODEL;
    target.EMBEDDING_PROVIDER = base.EMBEDDING_PROVIDER; target.GEMINI_EMBEDDING_MODEL = base.GEMINI_EMBEDDING_MODEL; target.OPENAI_EMBEDDING_MODEL = base.OPENAI_EMBEDDING_MODEL; target.EMBEDDING_DIMENSIONS = base.EMBEDDING_DIMENSIONS;
    target.STT_PROVIDER = base.STT_PROVIDER; target.GEMINI_STT_MODEL = base.GEMINI_STT_MODEL; target.OPENAI_STT_MODEL = base.OPENAI_STT_MODEL;
    target.TTS_PROVIDER = base.TTS_PROVIDER; target.GEMINI_TTS_MODEL = base.GEMINI_TTS_MODEL; target.OPENAI_TTS_MODEL = base.OPENAI_TTS_MODEL; target.GEMINI_TTS_VOICE = base.GEMINI_TTS_VOICE; target.OPENAI_TTS_VOICE = base.OPENAI_TTS_VOICE;
    target.REALTIME_PROVIDER = base.REALTIME_PROVIDER; target.GEMINI_REALTIME_MODEL = base.GEMINI_REALTIME_MODEL; target.OPENAI_REALTIME_MODEL = base.OPENAI_REALTIME_MODEL; target.GEMINI_REALTIME_VOICE = base.GEMINI_REALTIME_VOICE; target.OPENAI_REALTIME_VOICE = base.OPENAI_REALTIME_VOICE;
    if (p.llm) {
      target.LLM_PROVIDER = p.llm.provider;
      if (p.llm.provider === "gemini") target.GEMINI_MODEL = p.llm.model;
      if (p.llm.provider === "openai") target.OPENAI_MODEL = p.llm.model;
      if (p.llm.provider === "anthropic") target.ANTHROPIC_MODEL = p.llm.model;
    }
    if (p.embedding) {
      target.EMBEDDING_PROVIDER = p.embedding.provider; target.EMBEDDING_DIMENSIONS = p.embedding.dimensions;
      if (p.embedding.provider === "gemini") target.GEMINI_EMBEDDING_MODEL = p.embedding.model;
      if (p.embedding.provider === "openai") target.OPENAI_EMBEDDING_MODEL = p.embedding.model;
    }
    if (p.stt) {
      target.STT_PROVIDER = p.stt.provider;
      if (p.stt.provider === "gemini") target.GEMINI_STT_MODEL = p.stt.model;
      if (p.stt.provider === "openai") target.OPENAI_STT_MODEL = p.stt.model;
    }
    if (p.tts) {
      target.TTS_PROVIDER = p.tts.provider;
      if (p.tts.provider === "gemini") { target.GEMINI_TTS_MODEL = p.tts.model; target.GEMINI_TTS_VOICE = p.tts.voice; }
      if (p.tts.provider === "openai") { target.OPENAI_TTS_MODEL = p.tts.model; target.OPENAI_TTS_VOICE = p.tts.voice; }
    }
    if (p.realtime) {
      target.REALTIME_PROVIDER = p.realtime.provider;
      if (p.realtime.provider === "gemini") { target.GEMINI_REALTIME_MODEL = p.realtime.model; target.GEMINI_REALTIME_VOICE = p.realtime.voice; }
      if (p.realtime.provider === "openai") { target.OPENAI_REALTIME_MODEL = p.realtime.model; target.OPENAI_REALTIME_VOICE = p.realtime.voice; }
    }
    for (const v of VENDORS) target[KEY_FIELD[v]] = keys[v] || base[KEY_FIELD[v]];
  }

  const fingerprint = (c: Config) => JSON.stringify([
    c.LLM_PROVIDER, c.GEMINI_MODEL, c.OPENAI_MODEL, c.ANTHROPIC_MODEL, c.EMBEDDING_PROVIDER, c.GEMINI_EMBEDDING_MODEL, c.OPENAI_EMBEDDING_MODEL, c.EMBEDDING_DIMENSIONS,
    c.STT_PROVIDER, c.GEMINI_STT_MODEL, c.OPENAI_STT_MODEL, c.TTS_PROVIDER, c.GEMINI_TTS_MODEL, c.OPENAI_TTS_MODEL, c.GEMINI_TTS_VOICE, c.OPENAI_TTS_VOICE,
    c.GEMINI_API_KEY, c.OPENAI_API_KEY, c.ANTHROPIC_API_KEY,
  ]);

  function apply() {
    const decrypted: Partial<Record<Vendor, string>> = {};
    for (const v of VENDORS) { const d = decrypt(encKeys[v]); if (d) decrypted[v] = d; }
    applyTo(cfg, site, prov, decrypted);
    const fp = fingerprint(cfg);
    if (fp !== lastFingerprint) { lastFingerprint = fp; onProvidersChanged(); }
  }

  return {
    site: () => site,
    siteMeta: () => siteMeta,
    providerOverrides: () => prov,
    providersMeta: () => provMeta,
    encryption: () => encryptionAvailable(base.SETTINGS_ENCRYPTION_KEY),
    keyInfo() {
      const out = {} as Record<Vendor, { source: "db" | "env" | "none"; masked: string }>;
      for (const v of VENDORS) {
        const d = decrypt(encKeys[v]);
        const env = base[KEY_FIELD[v]];
        out[v] = d ? { source: "db", masked: maskSecret(d) } : env ? { source: "env", masked: maskSecret(env) } : { source: "none", masked: "" };
      }
      return out;
    },
    base: () => base,
    async refresh() {
      try {
        const [s, p] = await Promise.all([col.findOne({ _id: "site" }) as Promise<SiteDoc | null>, col.findOne({ _id: "providers" }) as Promise<ProvidersDoc | null>]);
        const parsedSite = s ? siteSchema.safeParse(s.value) : null;
        site = parsedSite?.success ? parsedSite.data : defaultSite();
        siteMeta = { updatedAt: s?.updatedAt ?? null, updatedBy: s?.updatedBy ?? null };
        const parsedProv = p?.value ? providersSchema.safeParse(p.value) : null;
        prov = parsedProv?.success ? parsedProv.data : {};
        encKeys = p?.keys ?? {};
        provMeta = { updatedAt: p?.updatedAt ?? null, updatedBy: p?.updatedBy ?? null };
        apply();
      } catch { /* database sementara tidak tersedia: pertahankan nilai terakhir */ }
    },
    async saveSite(v, actor) {
      await col.updateOne({ _id: "site" }, { $set: { value: v, updatedAt: new Date(), updatedBy: actor } }, { upsert: true });
      site = v; siteMeta = { updatedAt: new Date(), updatedBy: actor };
      apply();
    },
    async saveProviders(v, actor) {
      await col.updateOne({ _id: "providers" }, { $set: { value: v, updatedAt: new Date(), updatedBy: actor } }, { upsert: true });
      prov = v; provMeta = { updatedAt: new Date(), updatedBy: actor };
      apply();
    },
    async setKey(vendor, secret, actor) {
      if (secret === null) {
        await col.updateOne({ _id: "providers" }, { $unset: { [`keys.${vendor}`]: "" }, $set: { updatedAt: new Date(), updatedBy: actor } }, { upsert: true });
        delete encKeys[vendor];
      } else {
        const blob = encryptSecret(secret, base.SETTINGS_ENCRYPTION_KEY);
        await col.updateOne({ _id: "providers" }, { $set: { [`keys.${vendor}`]: blob, updatedAt: new Date(), updatedBy: actor } }, { upsert: true });
        encKeys[vendor] = blob;
      }
      provMeta = { updatedAt: new Date(), updatedBy: actor };
      apply();
    },
    preview({ providers, keys }) {
      const tmp = structuredClone(cfg);
      const decrypted: Partial<Record<Vendor, string>> = {};
      for (const v of VENDORS) {
        const d = decrypt(encKeys[v]);
        if (d) decrypted[v] = d;
        const k = keys?.[v];
        if (k) decrypted[v] = k;
        else if (k === null) delete decrypted[v];
      }
      applyTo(tmp, site, providers ?? prov, decrypted);
      return tmp;
    },
  };
}
