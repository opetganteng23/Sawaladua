import type { Config } from "../config.js";
import { anthropicLlm } from "./anthropic.js";
import { geminiEmbedder, geminiLlm, geminiStt, geminiTts } from "./gemini.js";
import { mockEmbedder, mockLlm, mockStt, mockTts } from "./mock.js";
import { openaiEmbedder, openaiLlm, openaiStt, openaiTts } from "./openai.js";
import type { Embedder, LlmProvider, SttProvider, TtsProvider } from "./types.js";

/** Pabrik provider. Tiap kemampuan dipilih independen lewat env; mengganti vendor tidak mengubah kode lain. */
export const makeLlm = (cfg: Config): LlmProvider => {
  switch (cfg.LLM_PROVIDER) {
    case "gemini": return geminiLlm(cfg);
    case "openai": return openaiLlm(cfg);
    case "anthropic": return anthropicLlm(cfg);
    default: return mockLlm();
  }
};

export const makeEmbedder = (cfg: Config): Embedder => {
  switch (cfg.EMBEDDING_PROVIDER) {
    case "gemini": return geminiEmbedder(cfg);
    case "openai": return openaiEmbedder(cfg);
    default: return mockEmbedder(cfg.EMBEDDING_DIMENSIONS);
  }
};

export const makeStt = (cfg: Config): SttProvider | null => {
  switch (cfg.STT_PROVIDER) {
    case "gemini": return geminiStt(cfg);
    case "openai": return openaiStt(cfg);
    case "mock": return mockStt();
    default: return null;
  }
};

export const makeTts = (cfg: Config): TtsProvider | null => {
  switch (cfg.TTS_PROVIDER) {
    case "gemini": return geminiTts(cfg);
    case "openai": return openaiTts(cfg);
    case "mock": return mockTts();
    default: return null;
  }
};
