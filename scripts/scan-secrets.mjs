// Pemindai secret sederhana tanpa dependensi (MTS 11.1/14.1: tidak ada secret di source control atau bundle frontend).
// Pakai: node scripts/scan-secrets.mjs [dir]   -> exit 1 jika ada temuan. Dijalankan di CI dan di tes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PATTERNS = [
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "Kunci gaya OpenAI/Anthropic (sk-...)", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "Kredensial di URI database", re: /mongodb(?:\+srv)?:\/\/[^:\s/@]+:(?!\.\.\.)(?![^@\s]*(?:PASSWORD|password|contoh|example|xxxx|CHANGEME))[A-Za-z0-9%_.-]{8,}@/ },
  { name: "Google OAuth client secret", re: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".results", "reports", "logs", ".cache", "playwright-report", "test-results"]);
const SKIP_FILES = new Set(["package-lock.json"]);
const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|html|css|txt|env|example|sh|toml|cjs|mjs)$/i;

export function scanText(text, file = "(teks)") {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const p of PATTERNS) if (p.re.test(line)) hits.push({ file, line: i + 1, type: p.name });
  });
  return hits;
}

export function scan(root) {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.size < 1_000_000 && (TEXT_EXT.test(name) || name.startsWith(".env"))) {
        // berkas .env sungguhan (bukan contoh) tidak boleh ada di pohon yang akan di-commit
        if (/^\.env(\.(?!example)[a-z]+)?$/.test(name) && !name.endsWith(".example")) hits.push({ file: path.relative(root, full), line: 0, type: "Berkas .env di pohon proyek (jangan commit)" });
        else hits.push(...scanText(readFileSync(full, "utf8"), path.relative(root, full)));
      }
    }
  };
  walk(root);
  const gi = path.join(root, ".gitignore");
  if (existsSync(gi) && !/^\.env$/m.test(readFileSync(gi, "utf8"))) hits.push({ file: ".gitignore", line: 0, type: ".env tidak ada di .gitignore" });
  return hits;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(process.argv[2] ?? ".");
  const hits = scan(root);
  if (hits.length) {
    console.error(`Ditemukan ${hits.length} kemungkinan secret:`);
    for (const h of hits) console.error(` - ${h.file}:${h.line}  ${h.type}`);
    process.exit(1);
  }
  console.log("Tidak ada secret yang terdeteksi.");
}
