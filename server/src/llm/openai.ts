import type { Config } from "../config.js";
import {
  LlmQuotaError, ProviderHttpError, mimeToExt,
  type Embedder, type LlmProvider, type LlmRequest, type LlmResult, type SttProvider, type TtsProvider,
} from "./types.js";

/** Semua pemanggilan lewat OPENAI_BASE_URL, sehingga endpoint yang kompatibel dengan API OpenAI juga bisa dipakai. */
async function call(cfg: Config, path: string, init: { json?: unknown; form?: FormData; signal?: AbortSignal }): Promise<Response> {
  const res = await fetch(`${cfg.OPENAI_BASE_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.OPENAI_API_KEY}`, ...(init.json ? { "content-type": "application/json" } : {}) },
    body: init.json ? JSON.stringify(init.json) : init.form,
    signal: init.signal,
  });
  // 429 mencakup rate limit dan kuota habis; keduanya diperlakukan sebagai "batas penggunaan".
  if (res.status === 429) throw new LlmQuotaError();
  if (!res.ok) throw new ProviderHttpError("openai", res.status);
  return res;
}

export function openaiLlm(cfg: Config): LlmProvider {
  return {
    name: "openai",
    model: cfg.OPENAI_MODEL,
    async generate(req: LlmRequest): Promise<LlmResult> {
      const res = await call(cfg, "/chat/completions", {
        signal: req.signal,
        json: {
          model: cfg.OPENAI_MODEL,
          messages: [{ role: "system", content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.text }))],
          max_completion_tokens: req.maxOutputTokens,
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
        },
      });
      const j = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return { text: j.choices?.[0]?.message?.content ?? "", inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 };
    },
  };
}

export function openaiEmbedder(cfg: Config): Embedder {
  const model = cfg.OPENAI_EMBEDDING_MODEL;
  return {
    name: "openai", model, dimensions: cfg.EMBEDDING_DIMENSIONS, tag: `openai/${model}/${cfg.EMBEDDING_DIMENSIONS}`,
    async embed(texts) {
      const res = await call(cfg, "/embeddings", { json: { model, input: texts, dimensions: cfg.EMBEDDING_DIMENSIONS } });
      const j = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
      const out = (j.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
      if (out.length !== texts.length || out.some((v) => v.length !== cfg.EMBEDDING_DIMENSIONS)) throw new Error("openai_embed_dimension_mismatch");
      return out;
    },
  };
}

export function openaiStt(cfg: Config): SttProvider {
  return {
    name: "openai", model: cfg.OPENAI_STT_MODEL,
    async transcribe(audio, mime, opts) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `audio.${mimeToExt(mime)}`);
      form.append("model", cfg.OPENAI_STT_MODEL);
      form.append("language", opts.language.slice(0, 2));
      form.append("response_format", "json");
      const res = await call(cfg, "/audio/transcriptions", { form, signal: opts.signal });
      const j = (await res.json()) as { text?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      return { text: (j.text ?? "").trim(), inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 };
    },
  };
}

export function openaiTts(cfg: Config): TtsProvider {
  return {
    name: "openai", model: cfg.OPENAI_TTS_MODEL,
    async synthesize(text, opts) {
      const res = await call(cfg, "/audio/speech", {
        signal: opts.signal,
        json: { model: cfg.OPENAI_TTS_MODEL, voice: cfg.OPENAI_TTS_VOICE || "alloy", input: text, response_format: "mp3" },
      });
      return { audio: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg", inputTokens: 0, outputTokens: 0 };
    },
  };
}
