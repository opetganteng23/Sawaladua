import type { Config } from "../config.js";
import { LlmQuotaError, ProviderHttpError, type LlmProvider, type LlmRequest, type LlmResult } from "./types.js";

type Turn = { role: "user" | "assistant"; text: string };

/**
 * Messages API Anthropic mensyaratkan giliran bergantian dan diawali "user". Riwayat kita bisa berawal dari assistant
 * atau memiliki giliran beruntun (mis. ringkasan), jadi dinormalkan: buang assistant di awal, gabung giliran sejenis.
 */
export function normalizeTurns(messages: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const m of messages) {
    if (!m.text.trim()) continue;
    const last = out.at(-1);
    if (last && last.role === m.role) last.text += "\n\n" + m.text;
    else out.push({ ...m });
  }
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}

export function anthropicLlm(cfg: Config): LlmProvider {
  return {
    name: "anthropic",
    model: cfg.ANTHROPIC_MODEL,
    async generate(req: LlmRequest): Promise<LlmResult> {
      const turns = normalizeTurns(req.messages);
      const res = await fetch(`${cfg.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": cfg.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        signal: req.signal,
        body: JSON.stringify({
          model: cfg.ANTHROPIC_MODEL,
          max_tokens: req.maxOutputTokens,
          // Anthropic tidak punya "JSON mode": format dijaga lewat instruksi sistem; parser dan validator di server tetap berlaku.
          system: req.json ? `${req.system}\n\nJawab HANYA dengan satu objek JSON valid, tanpa teks lain.` : req.system,
          messages: turns.map((t) => ({ role: t.role, content: t.text })),
        }),
      });
      if (res.status === 429) throw new LlmQuotaError();
      if (!res.ok) throw new ProviderHttpError("anthropic", res.status);
      const j = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      const text = (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 };
    },
  };
}
