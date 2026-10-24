// Harness evaluasi kualitas AI. Memakai komponen produksi (safety gate, prompt, parser, pemeriksa output).
// Jalankan: npm -w server run eval   (LLM_PROVIDER=gemini + kunci di server/.env untuk model nyata)
// Pengecekan otomatis hanya penyaring kasar. Keputusan kualitas/rilis tetap butuh tinjauan manusia.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { buildSystemPrompt, parseModelOutput } from "../src/chat/prompt.js";
import { defaultPreferences, type Mood } from "../src/db.js";
import type { LlmProvider } from "../src/llm/types.js";
import { assessMessage, outputIsSafe, reviewedImminentResponse, safetyInstruction } from "../src/safety/gate.js";

export interface EvalCase {
  id: string; category: string; user: string; note?: string;
  memories?: string[]; conflict?: [string, string];
  prefs?: Partial<ReturnType<typeof defaultPreferences>["style"]>;
  expectStrategy?: string[]; expectMood?: string[];
  mustMatch?: string[]; mustNotMatch?: string[]; mustNotMatchEmoji?: boolean;
  minBubbles?: number; expectSafetyLevelMin?: number; expectSafetyLevelMax?: number;
}

export interface EvalResult {
  id: string; category: string; passed: boolean; failures: string[]; bubbles: string[];
  strategy: string | null; mood: string | null; safetyLevel: number; endsWithQuestion: boolean; needsHumanReview: boolean;
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

export async function runCase(llm: LlmProvider, c: EvalCase): Promise<EvalResult> {
  const failures: string[] = [];
  const level = assessMessage(c.user).level;
  let bubbles: string[] = [];
  let strategy: string | null = null;
  let mood: string | null = null;

  if (level >= 3) {
    bubbles = reviewedImminentResponse(""); strategy = "safety_support"; mood = "hangat";
  } else {
    const style = { ...defaultPreferences().style, ...c.prefs };
    const system = buildSystemPrompt({
      style, mood: "hangat" as Mood, memories: level >= 2 ? [] : c.memories ?? [], summaries: [],
      conflict: level >= 2 ? null : c.conflict ?? null, timeHint: null, safetyInstruction: safetyInstruction(level),
    });
    try {
      const r = await llm.generate({ system, messages: [{ role: "user", text: c.user }], maxOutputTokens: 700, json: true });
      const parsed = parseModelOutput(r.text);
      if (!parsed) failures.push("output tidak sesuai schema");
      else {
        bubbles = parsed.bubbles; strategy = parsed.response_strategy; mood = parsed.mood;
        if (level >= 2) strategy = "safety_support"; // server memaksa; model dinilai pada isi, bukan label
        else if (strategy === "safety_support") strategy = "listen";
        if (!outputIsSafe(bubbles, level)) failures.push("output ditolak pemeriksa keselamatan");
      }
    } catch (e) {
      failures.push(`provider error: ${(e as Error).message}`);
    }
  }

  const text = bubbles.join(" ");
  if (c.expectStrategy && strategy && !c.expectStrategy.includes(strategy)) failures.push(`strategi ${strategy} di luar ${c.expectStrategy.join("/")}`);
  if (c.expectMood && mood && !c.expectMood.includes(mood)) failures.push(`mood ${mood} di luar ${c.expectMood.join("/")}`);
  if (c.minBubbles && bubbles.length < c.minBubbles) failures.push("bubble kurang");
  if (bubbles.length > 4) failures.push("terlalu banyak bubble (>4)");
  for (const re of c.mustMatch ?? []) if (!new RegExp(re, "i").test(text)) failures.push(`tidak memuat /${re}/`);
  for (const re of c.mustNotMatch ?? []) if (new RegExp(re, "i").test(text)) failures.push(`memuat terlarang /${re}/`);
  if (c.mustNotMatchEmoji && EMOJI.test(text)) failures.push("memuat emoji padahal dimatikan");
  if (c.expectSafetyLevelMin !== undefined && level < c.expectSafetyLevelMin) failures.push(`level keselamatan ${level} < ${c.expectSafetyLevelMin}`);
  if (c.expectSafetyLevelMax !== undefined && level > c.expectSafetyLevelMax) failures.push(`level keselamatan ${level} > ${c.expectSafetyLevelMax}`);

  return {
    id: c.id, category: c.category, passed: failures.length === 0, failures, bubbles, strategy, mood, safetyLevel: level,
    endsWithQuestion: /\?\s*$/.test(bubbles.at(-1) ?? ""),
    // Hal yang tidak bisa dinilai mesin: nada, empati, ketepatan penggunaan memori, penanganan konflik.
    needsHumanReview: Boolean(c.note) || level >= 2 || c.category.startsWith("memori") || c.category === "klaim perasaan",
  };
}

export async function runQualityEval(llm: LlmProvider, cases: EvalCase[]) {
  const results: EvalResult[] = [];
  for (const c of cases) results.push(await runCase(llm, c));
  const answered = results.filter((r) => r.bubbles.length);
  const summary = {
    provider: llm.name, model: llm.model, total: results.length, passed: results.filter((r) => r.passed).length,
    questionEndingRate: answered.length ? Number((answered.filter((r) => r.endsWithQuestion).length / answered.length).toFixed(2)) : 0,
    needsHumanReview: results.filter((r) => r.needsHumanReview).map((r) => r.id),
    warnings: [] as string[],
  };
  if (summary.questionEndingRate > 0.7) summary.warnings.push("Sawala terlalu sering mengakhiri balasan dengan pertanyaan (>70%).");
  return { summary, results };
}

export function loadCases(): EvalCase[] {
  return (JSON.parse(readFileSync(new URL("./quality.cases.json", import.meta.url), "utf8")) as { cases: EvalCase[] }).cases;
}

// CLI
if (process.argv[1] && /eval[\\/]run\.ts$/.test(process.argv[1])) {
  try { process.loadEnvFile(".env"); } catch { /* opsional */ }
  const { loadConfig } = await import("../src/config.js");
  const { makeLlm } = await import("../src/llm/index.js");
  const cfg = loadConfig({ SESSION_SECRET: "x".repeat(40), ...process.env } as Record<string, string>);
  const report = await runQualityEval(makeLlm(cfg), loadCases());
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  const file = new URL(`./reports/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
  for (const r of report.results.filter((x) => !x.passed)) console.log(`GAGAL ${r.id}: ${r.failures.join("; ")}`);
  console.log(`\nLaporan lengkap: ${file.pathname}\nCATATAN: lulus otomatis BUKAN pengganti tinjauan manusia.`);
  process.exit(report.summary.passed === report.summary.total ? 0 : 1);
}
