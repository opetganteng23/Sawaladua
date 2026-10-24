export interface LlmRequest {
  system: string;
  messages: { role: "user" | "assistant"; text: string }[];
  maxOutputTokens: number;
  json?: boolean;
  signal?: AbortSignal;
}
export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}
export interface LlmProvider {
  name: string;
  model: string;
  generate(req: LlmRequest): Promise<LlmResult>;
}
export interface Embedder {
  name: string;
  model: string;
  dimensions: number;
  /** Penanda versi embedding yang disimpan bersama vektor; vektor beda penanda tidak boleh dibandingkan. */
  tag: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface SttResult { text: string; inputTokens: number; outputTokens: number }
/** Speech-to-text. `audio` hanya ada di memori; implementasi tidak boleh menyimpannya ke disk atau log. */
export interface SttProvider {
  name: string;
  model: string;
  transcribe(audio: Buffer, mime: string, opts: { language: string; signal?: AbortSignal }): Promise<SttResult>;
}

export interface TtsResult { audio: Buffer; mime: string; inputTokens: number; outputTokens: number }
export interface TtsProvider {
  name: string;
  model: string;
  synthesize(text: string, opts: { language: string; signal?: AbortSignal }): Promise<TtsResult>;
}

/** Provider menolak karena kuota/rate limit. Dipetakan ke pesan "batas penggunaan", bukan error generik. */
export class LlmQuotaError extends Error {
  constructor() { super("llm_quota"); }
}

/** Kegagalan provider yang aman ditampilkan: hanya kode status, tanpa isi respons provider. */
export class ProviderHttpError extends Error {
  constructor(public vendor: string, public status: number) { super(`${vendor}_http_${status}`); }
}

export const mimeToExt = (mime: string) =>
  /webm/.test(mime) ? "webm" : /ogg/.test(mime) ? "ogg" : /mp4|m4a|aac/.test(mime) ? "m4a" : /wav|wave/.test(mime) ? "wav" : /mpeg|mp3/.test(mime) ? "mp3" : "bin";

/** Bungkus PCM 16-bit little-endian mono menjadi WAV agar bisa diputar <audio>. */
export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
