import type { Config } from "../config.js";
import {
  LlmQuotaError, ProviderHttpError, pcm16ToWav,
  type Embedder, type LlmProvider, type LlmRequest, type LlmResult, type SttProvider, type TtsProvider,
} from "./types.js";

type GenResponse = {
  candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

async function call(cfg: Config, model: string, method: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${cfg.GEMINI_BASE_URL}/models/${model}:${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": cfg.GEMINI_API_KEY },
    signal,
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new LlmQuotaError();
  if (!res.ok) throw new ProviderHttpError("gemini", res.status);
  return res;
}

export function geminiLlm(cfg: Config): LlmProvider {
  return {
    name: "gemini",
    model: cfg.GEMINI_MODEL,
    async generate(req: LlmRequest): Promise<LlmResult> {
      const res = await call(cfg, cfg.GEMINI_MODEL, "generateContent", {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.messages.map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.text }] })),
        generationConfig: { maxOutputTokens: req.maxOutputTokens, ...(req.json ? { responseMimeType: "application/json" } : {}) },
      }, req.signal);
      const j = (await res.json()) as GenResponse;
      const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      return { text, inputTokens: j.usageMetadata?.promptTokenCount ?? 0, outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0 };
    },
  };
}

export function geminiEmbedder(cfg: Config): Embedder {
  const model = cfg.GEMINI_EMBEDDING_MODEL;
  return {
    name: "gemini", model, dimensions: cfg.EMBEDDING_DIMENSIONS, tag: `gemini/${model}/${cfg.EMBEDDING_DIMENSIONS}`,
    async embed(texts) {
      const res = await call(cfg, model, "batchEmbedContents", {
        requests: texts.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t }] }, outputDimensionality: cfg.EMBEDDING_DIMENSIONS })),
      });
      const j = (await res.json()) as { embeddings?: { values: number[] }[] };
      const out = j.embeddings?.map((e) => e.values) ?? [];
      if (out.length !== texts.length || out.some((v) => v.length !== cfg.EMBEDDING_DIMENSIONS)) throw new Error("gemini_embed_dimension_mismatch");
      return out;
    },
  };
}

export function geminiStt(cfg: Config): SttProvider {
  return {
    name: "gemini", model: cfg.GEMINI_STT_MODEL,
    async transcribe(audio, mime, opts) {
      const res = await call(cfg, cfg.GEMINI_STT_MODEL, "generateContent", {
        contents: [{ role: "user", parts: [
          { text: `Transkripsikan ucapan pada audio ini apa adanya (bahasa: ${opts.language}). Keluarkan HANYA teks transkrip tanpa komentar. Jika tidak ada ucapan yang jelas, keluarkan teks kosong.` },
          { inlineData: { mimeType: mime, data: audio.toString("base64") } },
        ] }],
        generationConfig: { maxOutputTokens: 500, temperature: 0 },
      }, opts.signal);
      const j = (await res.json()) as GenResponse;
      const text = (j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "").trim();
      return { text, inputTokens: j.usageMetadata?.promptTokenCount ?? 0, outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0 };
    },
  };
}

export function geminiTts(cfg: Config): TtsProvider {
  return {
    name: "gemini", model: cfg.GEMINI_TTS_MODEL,
    async synthesize(text, opts) {
      const res = await call(cfg, cfg.GEMINI_TTS_MODEL, "generateContent", {
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          ...(cfg.GEMINI_TTS_VOICE ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.GEMINI_TTS_VOICE } } } } : {}),
        },
      }, opts.signal);
      const j = (await res.json()) as GenResponse;
      const inline = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
      if (!inline?.data) throw new Error("gemini_tts_empty");
      const raw = Buffer.from(inline.data, "base64");
      const mimeType = inline.mimeType ?? "";
      // Gemini TTS umumnya mengembalikan PCM 16-bit mentah (mis. "audio/L16;codec=pcm;rate=24000"); bungkus jadi WAV.
      if (/L16|pcm/i.test(mimeType)) {
        const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24000);
        return { audio: pcm16ToWav(raw, rate), mime: "audio/wav", inputTokens: j.usageMetadata?.promptTokenCount ?? 0, outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0 };
      }
      return { audio: raw, mime: mimeType || "audio/wav", inputTokens: j.usageMetadata?.promptTokenCount ?? 0, outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0 };
    },
  };
}
