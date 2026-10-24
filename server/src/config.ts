import { z } from "zod";

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const boolOn = z
  .enum(["true", "false"])
  .default("true")
  .transform((v) => v === "true");

const str = z.string().default("");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().default(8787),
  MONGODB_URI: z.string().default("mongodb://localhost:27017"),
  MONGODB_DB: z.string().default("sawala"),
  SESSION_SECRET: z.string().min(32),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
  GOOGLE_CLIENT_ID: str,
  AUTH_DEV_LOGIN: bool,

  // Provider AI. Setiap kemampuan dipilih sendiri-sendiri, jadi bebas dicampur (mis. LLM Anthropic + embedding OpenAI).
  LLM_PROVIDER: z.enum(["gemini", "openai", "anthropic", "mock"]).default("mock"),
  EMBEDDING_PROVIDER: z.enum(["gemini", "openai", "mock"]).default("mock"),
  STT_PROVIDER: z.enum(["none", "gemini", "openai", "mock"]).default("none"),
  TTS_PROVIDER: z.enum(["none", "gemini", "openai", "mock"]).default("none"),
  // Suara realtime dua arah. gemini/openai = model speech-to-speech native; cascade = STT + LLM (vendor mana pun) + TTS.
  REALTIME_PROVIDER: z.enum(["none", "gemini", "openai", "cascade", "mock"]).default("none"),
  GEMINI_REALTIME_MODEL: str,
  GEMINI_REALTIME_VOICE: str,
  GEMINI_LIVE_URL: z.string().default("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"),
  OPENAI_REALTIME_MODEL: str,
  OPENAI_REALTIME_VOICE: str,
  OPENAI_REALTIME_URL: z.string().default("wss://api.openai.com/v1/realtime"),
  OPENAI_REALTIME_TRANSCRIBE_MODEL: str,
  // Jeda singkat menahan audio balasan model native sampai transkrip ucapan pengguna tersedia untuk pemeriksaan keselamatan.
  VOICE_SAFETY_HOLD_MS: z.coerce.number().int().min(0).max(3000).default(600),
  // Gemini
  GEMINI_API_KEY: str,
  GEMINI_BASE_URL: z.string().default("https://generativelanguage.googleapis.com/v1beta"),
  GEMINI_MODEL: str,
  GEMINI_EMBEDDING_MODEL: str,
  GEMINI_STT_MODEL: str,
  GEMINI_TTS_MODEL: str,
  GEMINI_TTS_VOICE: str,
  // OpenAI (juga untuk endpoint yang kompatibel lewat OPENAI_BASE_URL)
  OPENAI_API_KEY: str,
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_MODEL: str,
  OPENAI_EMBEDDING_MODEL: str,
  OPENAI_STT_MODEL: str,
  OPENAI_TTS_MODEL: str,
  OPENAI_TTS_VOICE: str,
  // Anthropic (tidak punya embedding/STT/TTS sendiri)
  ANTHROPIC_API_KEY: str,
  ANTHROPIC_BASE_URL: z.string().default("https://api.anthropic.com"),
  ANTHROPIC_MODEL: str,

  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(8).max(3072).default(256),
  STT_MAX_AUDIO_BYTES: z.coerce.number().int().min(10_000).max(10_000_000).default(2_000_000),
  MAX_MESSAGE_CHARS: z.coerce.number().int().default(4000),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().default(700),
  DAILY_MESSAGE_LIMIT: z.coerce.number().int().default(200),
  RATE_LIMIT_SCALE: z.coerce.number().min(1).default(1),
  CRISIS_RESOURCES_TEXT: str,
  VECTOR_SEARCH_INDEX: str,
  WEB_DIST_DIR: str,
  // Anggaran penggunaan (0 = nonaktif). Harga TIDAK ditanam di kode: isi sendiri dari harga provider yang sudah diverifikasi.
  DAILY_TOKEN_BUDGET_GLOBAL: z.coerce.number().int().min(0).default(0),
  DAILY_TOKEN_BUDGET_PER_USER: z.coerce.number().int().min(0).default(0),
  COST_PER_1M_INPUT_TOKENS: z.coerce.number().min(0).default(0),
  COST_PER_1M_OUTPUT_TOKENS: z.coerce.number().min(0).default(0),
  COST_CURRENCY: z.string().default("USD"),
  ADMIN_EMAILS: str,
  ALERT_WEBHOOK_URL: str, // webhook JSON (Slack/Discord/dll). Payload tanpa isi percakapan
  ALERT_MIN_INTERVAL_MINUTES: z.coerce.number().min(0).default(60),
  ERROR_RATE_ALERT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.2),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(100).default(45_000),
  // Retensi riwayat chat (hari). 0 = disimpan sampai pengguna menghapus. Memori jangka panjang diatur terpisah oleh pengguna.
  CHAT_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  CALL_MAX_MINUTES: z.coerce.number().int().min(1).max(120).default(30),
  // Fitur yang disetujui menyala secara default; matikan dengan false atau kill switch /admin.
  FEATURE_LONG_TERM_MEMORY: boolOn,
  FEATURE_MOOD_THEMES: boolOn,
  FEATURE_PROACTIVE_GREETING: boolOn,
  FEATURE_VOICE_CALLS: boolOn, // menyala secara default (disetujui pemilik layanan); matikan dengan false atau kill switch /admin
  FEATURE_DATA_EXPORT: boolOn,
});

export type Config = z.infer<typeof schema>;

type Vendor = "gemini" | "openai" | "anthropic";
const KEY: Record<Vendor, keyof Config> = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
const MODEL: Record<string, keyof Config> = {
  "llm:gemini": "GEMINI_MODEL", "llm:openai": "OPENAI_MODEL", "llm:anthropic": "ANTHROPIC_MODEL",
  "embedding:gemini": "GEMINI_EMBEDDING_MODEL", "embedding:openai": "OPENAI_EMBEDDING_MODEL",
  "stt:gemini": "GEMINI_STT_MODEL", "stt:openai": "OPENAI_STT_MODEL",
  "tts:gemini": "GEMINI_TTS_MODEL", "tts:openai": "OPENAI_TTS_MODEL",
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cfg = schema.parse(env);
  const prod = cfg.NODE_ENV === "production" || cfg.NODE_ENV === "staging";
  if (prod) {
    if (cfg.AUTH_DEV_LOGIN) throw new Error("AUTH_DEV_LOGIN harus false di staging/production");
    if (cfg.LLM_PROVIDER === "mock") throw new Error("LLM_PROVIDER=mock tidak boleh dipakai di staging/production");
    if (cfg.EMBEDDING_PROVIDER === "mock") throw new Error("EMBEDDING_PROVIDER=mock tidak boleh dipakai di staging/production");
    if (cfg.STT_PROVIDER === "mock" || cfg.TTS_PROVIDER === "mock") throw new Error("STT/TTS_PROVIDER=mock tidak boleh dipakai di staging/production");
    if (!cfg.GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID wajib diisi");
  }
  const need = (cap: "llm" | "embedding" | "stt" | "tts", vendor: string) => {
    if (vendor === "mock" || vendor === "none") return;
    const v = vendor as Vendor;
    const keyName = KEY[v], modelName = MODEL[`${cap}:${v}`];
    if (!modelName) throw new Error(`${vendor} tidak menyediakan ${cap} (anthropic: hanya LLM; embedding/STT/TTS pakai gemini atau openai)`);
    if (!cfg[keyName] || !cfg[modelName]) throw new Error(`${String(keyName)} dan ${String(modelName)} wajib diisi untuk ${cap.toUpperCase()} dengan provider ${vendor}`);
  };
  need("llm", cfg.LLM_PROVIDER);
  need("embedding", cfg.EMBEDDING_PROVIDER);
  need("stt", cfg.STT_PROVIDER);
  need("tts", cfg.TTS_PROVIDER);
  if (cfg.REALTIME_PROVIDER === "gemini" && (!cfg.GEMINI_API_KEY || !cfg.GEMINI_REALTIME_MODEL)) throw new Error("GEMINI_API_KEY dan GEMINI_REALTIME_MODEL wajib diisi untuk REALTIME_PROVIDER=gemini");
  if (cfg.REALTIME_PROVIDER === "openai" && (!cfg.OPENAI_API_KEY || !cfg.OPENAI_REALTIME_MODEL)) throw new Error("OPENAI_API_KEY dan OPENAI_REALTIME_MODEL wajib diisi untuk REALTIME_PROVIDER=openai");
  if (cfg.REALTIME_PROVIDER === "cascade" && cfg.STT_PROVIDER === "none") throw new Error("REALTIME_PROVIDER=cascade membutuhkan STT_PROVIDER (gemini/openai). TTS_PROVIDER opsional; tanpa TTS suara dibuat browser");
  if (prod && cfg.REALTIME_PROVIDER === "mock") throw new Error("REALTIME_PROVIDER=mock tidak boleh dipakai di staging/production");
  return cfg;
}
