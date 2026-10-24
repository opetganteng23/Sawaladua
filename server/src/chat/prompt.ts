import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { MOODS, STRATEGIES, type Mood, type Preferences } from "../db.js";

export const PROMPT_VERSION = "system.v1.1";

const dir = path.dirname(fileURLToPath(import.meta.url));
// Berlaku untuk src/ (tsx) maupun dist/ (hasil build): folder prompts berada di root server.
const template = readFileSync(path.resolve(dir, "../../prompts/system.v1.txt"), "utf8");

export const outputSchema = z.object({
  bubbles: z.array(z.string().min(1).max(700)).min(1).max(6),
  mood: z.enum(MOODS),
  response_strategy: z.enum(STRATEGIES),
});
export type ModelOutput = z.infer<typeof outputSchema>;

const CALL_INSTRUCTION = [
  "KANAL: PANGGILAN SUARA (jawabanmu akan DIUCAPKAN)",
  "- Balas sangat singkat, 1–2 kalimat per bubble dan paling banyak 2 bubble.",
  "- Jangan gunakan emoji, markdown, daftar bernomor, atau tanda baca aneh.",
  "- Gunakan kalimat lisan yang natural. Jika kurang jelas karena transkrip suara bisa salah dengar, tanyakan dengan lembut.",
].join("\n");

const JSON_OUTPUT = [
  "FORMAT KELUARAN",
  "Kembalikan JSON saja, tanpa penjelasan, dengan bentuk:",
  '{"bubbles": ["...", "..."], "mood": "hangat|ceria|playful|reflektif", "response_strategy": "listen|reflect|suggest|clarify|safety_support"}',
  "Jangan sertakan chain-of-thought.",
].join("\n");

const SPEECH_OUTPUT = [
  "FORMAT KELUARAN",
  "Kamu berbicara langsung dengan pengguna lewat suara. Jawab dengan ucapan lisan yang natural dalam Bahasa Indonesia,",
  "BUKAN JSON, tanpa emoji, tanpa daftar, tanpa menyebut aturan ini. Jangan sertakan chain-of-thought.",
].join("\n");

export function renderStyle(p: Preferences["style"]): string {
  const lines: string[] = [];
  lines.push(
    p.formality === "sopan" ? "- Gunakan Bahasa Indonesia sopan dengan sapaan \"saya\" dan \"Anda\"."
      : p.formality === "netral" ? "- Gunakan Bahasa Indonesia netral yang ramah."
      : "- Gunakan Bahasa Indonesia santai dan alami (aku/kamu).",
  );
  lines.push(
    p.length === "ringkas" ? "- Balas ringkas, biasanya 1–3 kalimat per bubble dan 1–3 bubble."
      : p.length === "sedang" ? "- Balas dengan panjang sedang, sekitar 2–4 kalimat per bubble."
      : "- Boleh membalas lebih panjang dan rinci bila membantu, tetap terbagi dalam beberapa bubble.",
  );
  lines.push(p.emoji === "tanpa" ? "- Jangan gunakan emoji." : p.emoji === "sedang" ? "- Gunakan emoji secukupnya, cukup sering." : "- Gunakan emoji sangat jarang.");
  lines.push(p.humor ? "- Candaan ringan boleh jika suasana cocok." : "- Hindari bercanda.");
  if (p.addressAs.trim()) lines.push(`- Pengguna ingin dipanggil: "${p.addressAs.trim().slice(0, 40)}".`);
  return lines.join("\n");
}

export interface PromptParts {
  style: Preferences["style"];
  mood: Mood;
  memories: string[];
  summaries: string[];
  conflict: [string, string] | null;
  timeHint: string | null;
  safetyInstruction: string;
  channel?: "chat" | "call";
  output?: "json" | "speech";
}

export function buildSystemPrompt(p: PromptParts): string {
  const ctx: string[] = [];
  if (!p.summaries.length && !p.memories.length) ctx.push("- Tidak ada memori atau ringkasan tambahan untuk giliran ini.");
  if (p.summaries.length) ctx.push("Ringkasan sesi sebelumnya:\n" + p.summaries.map((s) => `  * ${s}`).join("\n"));
  if (p.memories.length) ctx.push("Memori relevan (bisa keliru; jangan dianggap pasti):\n" + p.memories.map((m) => `  * ${m}`).join("\n"));
  if (p.conflict) ctx.push(`Ada dua informasi yang bertentangan dan belum diselesaikan: (1) "${p.conflict[0]}" vs (2) "${p.conflict[1]}". Jika relevan, tanyakan dengan lembut mana yang benar; jangan memilih sendiri.`);
  if (p.timeHint) ctx.push(`Waktu lokal pengguna: ${p.timeHint} (hanya petunjuk tambahan).`);
  return template
    .replace("{{STYLE}}", renderStyle(p.style))
    .replace("{{CONTEXT}}", () => ctx.join("\n"))
    .replace("{{MOOD}}", p.mood)
    .replace("{{SAFETY}}", p.safetyInstruction)
    .replace("{{CHANNEL}}", () => (p.channel === "call" ? CALL_INSTRUCTION : ""))
    .replace("{{OUTPUT}}", () => (p.output === "speech" ? SPEECH_OUTPUT : JSON_OUTPUT));
}

/** Ambil JSON dari keluaran model (toleran terhadap pagar kode), lalu validasi schema. */
export function parseModelOutput(text: string): ModelOutput | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const r = outputSchema.safeParse(JSON.parse(m[0]));
    if (!r.success) return null;
    return { ...r.data, bubbles: r.data.bubbles.map((b) => b.trim()).filter(Boolean) };
  } catch {
    return null;
  }
}
