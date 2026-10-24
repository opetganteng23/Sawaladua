// Laporan agregat pengujian keselamatan (MTS 13.2): menjalankan dataset skenario terhadap safety gate dan menulis ringkasan JSON.
// Pakai: npm -w server run eval:safety   (exit 1 jika ada kasus yang tidak sesuai). Hasil WAJIB ditinjau manusia (MTS 12.5).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { assessMessage } from "../src/safety/gate.js";

interface Case { text: string; min: number; max: number; tag: string }
interface Seq { turns: string[]; minLast?: number; maxLast?: number; tag: string }
const data = JSON.parse(readFileSync(new URL("../eval/safety.cases.json", import.meta.url), "utf8")) as { cases: Case[]; sequences: Seq[] };

const failed: { tag: string; text: string; level: number; expected: string }[] = [];
const byTag: Record<string, { total: number; passed: number }> = {};
let falseNegatives = 0, falsePositives = 0;

for (const c of data.cases) {
  const level = assessMessage(c.text).level;
  const ok = level >= c.min && level <= c.max;
  const t = (byTag[c.tag] ??= { total: 0, passed: 0 });
  t.total++; if (ok) t.passed++;
  if (!ok) {
    failed.push({ tag: c.tag, text: c.text, level, expected: `${c.min}-${c.max}` });
    if (level < c.min && c.min >= 2) falseNegatives++;
    if (level > c.max) falsePositives++;
  }
}
for (const s of data.sequences) {
  const hist: string[] = [];
  let level = 0;
  for (const t of s.turns) { level = assessMessage(t, hist).level; hist.push(t); }
  const ok = (s.minLast === undefined || level >= s.minLast) && (s.maxLast === undefined || level <= s.maxLast);
  const t = (byTag[s.tag] ??= { total: 0, passed: 0 });
  t.total++; if (ok) t.passed++; else failed.push({ tag: s.tag, text: s.turns.join(" | "), level, expected: `${s.minLast ?? 0}-${s.maxLast ?? 3}` });
}

const total = data.cases.length + data.sequences.length;
const report = {
  generatedAt: new Date().toISOString(), total, passed: total - failed.length, failed, falseNegatives, falsePositives, byTag,
  note: "Dataset sintetis. Lulus otomatis BUKAN jaminan keselamatan; tinjauan manusia dan perluasan skenario tetap wajib.",
};
mkdirSync(new URL("../eval/reports/", import.meta.url), { recursive: true });
writeFileSync(new URL("../eval/reports/safety-latest.json", import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ total: report.total, passed: report.passed, falseNegatives, falsePositives, failed: failed.length }, null, 2));
for (const f of failed) console.log(`GAGAL [${f.tag}] level ${f.level}, diharapkan ${f.expected}: ${f.text}`);
process.exit(failed.length ? 1 : 0);
