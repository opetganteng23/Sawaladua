// Jalankan migrasi database secara eksplisit (dipakai skrip deploy agar kegagalan terlihat sebelum reload).
// Pakai: npm -w server run db:migrate
import { connectDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/migrations/index.js";

try { process.loadEnvFile(".env"); } catch { /* opsional */ }
const cfg = loadConfig();
const d = await connectDb(cfg.MONGODB_URI, cfg.MONGODB_DB);
try {
  const applied = await runMigrations(d);
  console.log(applied.length ? `Migrasi diterapkan: ${applied.join(", ")}` : "Tidak ada migrasi baru.");
} finally {
  await d.client.close();
}
