// Dev tanpa instalasi database: MongoDB in-memory (data hilang saat berhenti). Hanya untuk data uji.
import { MongoMemoryServer } from "mongodb-memory-server";

const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri();
process.env.SESSION_SECRET ??= "dev-only-secret-dev-only-secret-dev-only";
process.env.AUTH_DEV_LOGIN ??= "true";
process.env.ALLOWED_ORIGINS ??= "http://localhost:5173,http://localhost:8787";
for (const f of ["FEATURE_LONG_TERM_MEMORY", "FEATURE_MOOD_THEMES", "FEATURE_PROACTIVE_GREETING", "FEATURE_DATA_EXPORT", "FEATURE_VOICE_CALLS"]) process.env[f] ??= "true";
process.env.REALTIME_PROVIDER ??= "mock";
process.env.STT_PROVIDER ??= "mock";
process.env.TTS_PROVIDER ??= "mock";
console.log("MongoDB in-memory:", process.env.MONGODB_URI);
await import("../src/index.js");
