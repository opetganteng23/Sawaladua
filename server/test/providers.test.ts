import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { loadConfig } from "../src/config.js";
import { makeEmbedder, makeLlm, makeStt, makeTts } from "../src/llm/index.js";
import { normalizeTurns } from "../src/llm/anthropic.js";
import { LlmQuotaError, pcm16ToWav, ProviderHttpError } from "../src/llm/types.js";
import { openaiRealtimeProvider } from "../src/voice/providers/openaiRealtime.js";
import { geminiLiveProvider } from "../src/voice/providers/geminiLive.js";
import { cosine, embeddingCompatible } from "../src/memory/service.js";
import { Vad } from "../src/voice/vad.js";
import type { RealtimeEvents } from "../src/voice/types.js";

const BASE = { SESSION_SECRET: "x".repeat(40), NODE_ENV: "test" };
const cfgWith = (extra: Record<string, string>) => loadConfig({ ...BASE, ...extra });

interface Seen { url: string; headers: IncomingMessage["headers"]; body: Buffer }
let srv: Server, base = "";
let seen: Seen[] = [];
let reply: { status: number; body: unknown; raw?: Buffer; type?: string } = { status: 200, body: {} };
beforeAll(async () => {
  srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = reply.status;
      res.setHeader("content-type", reply.type ?? "application/json");
      res.end(reply.raw ?? JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());
const last = () => seen.at(-1)!;
const lastJson = () => JSON.parse(last().body.toString());

describe("konfigurasi provider", () => {
  it("setiap kemampuan dipilih independen dan divalidasi", () => {
    expect(() => cfgWith({ LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => cfgWith({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "k" })).toThrow(/OPENAI_MODEL/);
    expect(() => cfgWith({ EMBEDDING_PROVIDER: "gemini" })).toThrow(/GEMINI/);
    expect(() => cfgWith({ REALTIME_PROVIDER: "cascade" })).toThrow(/STT_PROVIDER/);
    expect(() => cfgWith({ REALTIME_PROVIDER: "openai", OPENAI_API_KEY: "k" })).toThrow(/OPENAI_REALTIME_MODEL/);
    // campuran vendor diizinkan: LLM Anthropic + embedding OpenAI + STT/TTS Gemini
    const mixed = cfgWith({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a", ANTHROPIC_MODEL: "m", EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "o", OPENAI_EMBEDDING_MODEL: "e", STT_PROVIDER: "gemini", GEMINI_API_KEY: "g", GEMINI_STT_MODEL: "s", REALTIME_PROVIDER: "cascade" });
    expect(makeLlm(mixed).name).toBe("anthropic");
    expect(makeEmbedder(mixed).name).toBe("openai");
    expect(makeStt(mixed)!.name).toBe("gemini");
    expect(makeTts(mixed)).toBeNull();
  });

  it("staging/production menolak seluruh provider mock", () => {
    const prod = { ...BASE, NODE_ENV: "production", GOOGLE_CLIENT_ID: "id", LLM_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: "m", EMBEDDING_PROVIDER: "openai", OPENAI_EMBEDDING_MODEL: "e" };
    expect(() => loadConfig({ ...prod })).not.toThrow();
    expect(() => loadConfig({ ...prod, EMBEDDING_PROVIDER: "mock" })).toThrow(/EMBEDDING_PROVIDER=mock/);
    expect(() => loadConfig({ ...prod, STT_PROVIDER: "mock" })).toThrow(/mock/);
    expect(() => loadConfig({ ...prod, REALTIME_PROVIDER: "mock" })).toThrow(/mock/);
  });
});

describe("adapter OpenAI (HTTP)", () => {
  const cfg = () => cfgWith({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "m-chat", OPENAI_BASE_URL: base, EMBEDDING_PROVIDER: "openai", OPENAI_EMBEDDING_MODEL: "m-emb", EMBEDDING_DIMENSIONS: "8", STT_PROVIDER: "openai", OPENAI_STT_MODEL: "m-stt", TTS_PROVIDER: "openai", OPENAI_TTS_MODEL: "m-tts", OPENAI_TTS_VOICE: "nova" });

  it("chat: pemetaan permintaan/respons dan token", async () => {
    reply = { status: 200, body: { choices: [{ message: { content: "{\"ok\":1}" } }], usage: { prompt_tokens: 11, completion_tokens: 3 } } };
    const r = await makeLlm(cfg()).generate({ system: "SYS", messages: [{ role: "user", text: "hai" }, { role: "assistant", text: "yo" }], maxOutputTokens: 77, json: true });
    expect(r).toEqual({ text: "{\"ok\":1}", inputTokens: 11, outputTokens: 3 });
    expect(last().url).toBe("/chat/completions");
    expect(last().headers.authorization).toBe("Bearer sk-test");
    expect(lastJson()).toMatchObject({ model: "m-chat", max_completion_tokens: 77, response_format: { type: "json_object" }, messages: [{ role: "system", content: "SYS" }, { role: "user", content: "hai" }, { role: "assistant", content: "yo" }] });
  });

  it("429 -> LlmQuotaError, 500 -> ProviderHttpError tanpa membocorkan isi respons", async () => {
    reply = { status: 429, body: { error: { message: "rahasia" } } };
    await expect(makeLlm(cfg()).generate({ system: "s", messages: [], maxOutputTokens: 5 })).rejects.toBeInstanceOf(LlmQuotaError);
    reply = { status: 500, body: { error: { message: "isi percakapan bocor" } } };
    const e = await makeLlm(cfg()).generate({ system: "s", messages: [], maxOutputTokens: 5 }).catch((x) => x as Error);
    expect(e).toBeInstanceOf(ProviderHttpError);
    expect(e.message).toBe("openai_http_500");
  });

  it("embedding: urutan, dimensi, dan tag; dimensi salah ditolak", async () => {
    reply = { status: 200, body: { data: [{ index: 1, embedding: [2, 2, 2, 2, 2, 2, 2, 2] }, { index: 0, embedding: [1, 1, 1, 1, 1, 1, 1, 1] }] } };
    const e = makeEmbedder(cfg());
    expect(e.tag).toBe("openai/m-emb/8");
    expect(await e.embed(["a", "b"])).toEqual([[1, 1, 1, 1, 1, 1, 1, 1], [2, 2, 2, 2, 2, 2, 2, 2]]);
    expect(lastJson()).toMatchObject({ model: "m-emb", dimensions: 8, input: ["a", "b"] });
    reply = { status: 200, body: { data: [{ index: 0, embedding: [1, 2] }] } };
    await expect(e.embed(["a"])).rejects.toThrow(/dimension/);
  });

  it("STT multipart dan TTS audio", async () => {
    reply = { status: 200, body: { text: " halo dunia " } };
    const t = await makeStt(cfg())!.transcribe(pcm16ToWav(Buffer.alloc(3200), 16000), "audio/wav", { language: "id-ID" });
    expect(t.text).toBe("halo dunia");
    expect(last().url).toBe("/audio/transcriptions");
    expect(last().headers["content-type"]).toMatch(/multipart\/form-data/);
    expect(last().body.toString("latin1")).toMatch(/name="model"[\s\S]*m-stt/);
    reply = { status: 200, body: {}, raw: Buffer.from("ID3-mp3"), type: "audio/mpeg" };
    const a = await makeTts(cfg())!.synthesize("halo", { language: "id-ID" });
    expect(a.mime).toBe("audio/mpeg");
    expect(a.audio.toString()).toBe("ID3-mp3");
    expect(lastJson()).toMatchObject({ model: "m-tts", voice: "nova", input: "halo" });
  });
});

describe("adapter Anthropic", () => {
  const cfg = () => cfgWith({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "ak", ANTHROPIC_MODEL: "claude-x", ANTHROPIC_BASE_URL: base });

  it("normalisasi giliran: buang assistant di awal, gabung giliran beruntun, buang kosong", () => {
    expect(normalizeTurns([{ role: "assistant", text: "a0" }, { role: "user", text: "u1" }, { role: "user", text: "u2" }, { role: "assistant", text: "a1" }, { role: "assistant", text: " " }, { role: "user", text: "u3" }]))
      .toEqual([{ role: "user", text: "u1\n\nu2" }, { role: "assistant", text: "a1" }, { role: "user", text: "u3" }]);
    expect(normalizeTurns([{ role: "assistant", text: "saja" }])).toEqual([]);
  });

  it("pemetaan permintaan/respons, header, dan instruksi JSON", async () => {
    reply = { status: 200, body: { content: [{ type: "text", text: "{\"a\":1}" }], usage: { input_tokens: 9, output_tokens: 4 } } };
    const r = await makeLlm(cfg()).generate({ system: "SYS", messages: [{ role: "assistant", text: "x" }, { role: "user", text: "hai" }], maxOutputTokens: 50, json: true });
    expect(r).toEqual({ text: "{\"a\":1}", inputTokens: 9, outputTokens: 4 });
    expect(last().url).toBe("/v1/messages");
    expect(last().headers["x-api-key"]).toBe("ak");
    expect(last().headers["anthropic-version"]).toBe("2023-06-01");
    const b = lastJson();
    expect(b).toMatchObject({ model: "claude-x", max_tokens: 50, messages: [{ role: "user", content: "hai" }] });
    expect(b.system).toMatch(/^SYS[\s\S]*JSON/);
  });

  it("429 -> kuota", async () => {
    reply = { status: 429, body: {} };
    await expect(makeLlm(cfg()).generate({ system: "s", messages: [{ role: "user", text: "h" }], maxOutputTokens: 5 })).rejects.toBeInstanceOf(LlmQuotaError);
  });
});

describe("adapter Gemini (HTTP)", () => {
  const cfg = () => cfgWith({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gk", GEMINI_MODEL: "g-chat", GEMINI_BASE_URL: base, STT_PROVIDER: "gemini", GEMINI_STT_MODEL: "g-stt", TTS_PROVIDER: "gemini", GEMINI_TTS_MODEL: "g-tts", GEMINI_TTS_VOICE: "Kore" });

  it("chat memakai base URL, header kunci, dan memetakan peran model", async () => {
    reply = { status: 200, body: { candidates: [{ content: { parts: [{ text: "hai" }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } } };
    const r = await makeLlm(cfg()).generate({ system: "SYS", messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }], maxOutputTokens: 9, json: true });
    expect(r).toEqual({ text: "hai", inputTokens: 5, outputTokens: 2 });
    expect(last().url).toBe("/models/g-chat:generateContent");
    expect(last().headers["x-goog-api-key"]).toBe("gk");
    expect(lastJson().contents.map((c: { role: string }) => c.role)).toEqual(["user", "model"]);
  });

  it("STT mengirim audio inline base64; TTS membungkus PCM menjadi WAV", async () => {
    reply = { status: 200, body: { candidates: [{ content: { parts: [{ text: " halo " }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 2 } } };
    const t = await makeStt(cfg())!.transcribe(Buffer.from("abc"), "audio/wav", { language: "id-ID" });
    expect(t).toEqual({ text: "halo", inputTokens: 30, outputTokens: 2 });
    expect(lastJson().contents[0].parts[1].inlineData).toEqual({ mimeType: "audio/wav", data: Buffer.from("abc").toString("base64") });
    const pcm = Buffer.alloc(480);
    reply = { status: 200, body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } }] } }] } };
    const a = await makeTts(cfg())!.synthesize("halo", { language: "id-ID" });
    expect(a.mime).toBe("audio/wav");
    expect(a.audio.subarray(0, 4).toString()).toBe("RIFF");
    expect(a.audio.length).toBe(44 + 480);
    expect(lastJson().generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
  });
});

const noopEvents = (): { ev: RealtimeEvents; log: string[]; audio: Buffer[] } => {
  const log: string[] = [], audio: Buffer[] = [];
  const ev: RealtimeEvents = {
    onAudio: (b) => audio.push(b), onSpeech: () => undefined, onSpeechText: () => undefined,
    onUserTranscript: (t, f) => log.push(`u:${f ? "F" : "p"}:${t}`),
    onAssistantTranscript: (t, f) => log.push(`a:${f ? "F" : "p"}:${t}`),
    onTurnComplete: () => log.push("done"), onInterrupted: () => log.push("int"),
    onUsage: (i, o) => log.push(`usage:${i}/${o}`), onError: (e) => log.push("err:" + e.message), onClosed: () => log.push("closed"),
  };
  return { ev, log, audio };
};
const waitUntil = async (fn: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };

describe("adapter realtime terhadap server WebSocket palsu (protokol sesuai dokumentasi publik, BUKAN API asli)", () => {
  it("OpenAI Realtime: session.update, audio base64 dua arah, transkrip, usage", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const got: Record<string, unknown>[] = [];
    let hdr: IncomingMessage["headers"] = {};
    wss.on("connection", (ws, req) => {
      hdr = req.headers;
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        got.push(m);
        if (m.type === "input_audio_buffer.append") {
          ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "halo" }));
          ws.send(JSON.stringify({ type: "response.audio.delta", delta: Buffer.from([1, 2, 3, 4]).toString("base64") }));
          ws.send(JSON.stringify({ type: "response.audio_transcript.delta", delta: "Aku " }));
          ws.send(JSON.stringify({ type: "response.audio_transcript.done", transcript: "Aku dengar." }));
          ws.send(JSON.stringify({ type: "response.done", response: { usage: { input_tokens: 40, output_tokens: 12 } } }));
        }
      });
    });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const port = (wss.address() as AddressInfo).port;
    try {
      const p = openaiRealtimeProvider(cfgWith({ REALTIME_PROVIDER: "openai", OPENAI_API_KEY: "sk", OPENAI_REALTIME_MODEL: "rt-m", OPENAI_REALTIME_URL: `ws://127.0.0.1:${port}/v1/realtime`, OPENAI_REALTIME_VOICE: "verse" }));
      const { ev, log, audio } = noopEvents();
      const s = await p.open({ instructions: "INSTR", language: "id-ID", bargeIn: true }, ev);
      s.sendAudio(Buffer.from([9, 9]));
      await waitUntil(() => log.includes("done"));
      expect(hdr.authorization).toBe("Bearer sk");
      expect(got[0]).toMatchObject({ type: "session.update", session: { instructions: "INSTR", voice: "verse", input_audio_format: "pcm16", output_audio_format: "pcm16" } });
      expect(got[1]).toEqual({ type: "input_audio_buffer.append", audio: Buffer.from([9, 9]).toString("base64") });
      expect(audio[0]).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(log).toEqual(expect.arrayContaining(["u:F:halo", "a:p:Aku ", "a:F:Aku dengar.", "usage:40/12", "done"]));
      s.cancelResponse();
      await waitUntil(() => got.some((m) => m.type === "response.cancel"));
      s.close();
    } finally { wss.close(); }
  });

  it("Gemini Live: setup, realtimeInput, transkrip bertahap menjadi final saat model menjawab", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const got: Record<string, unknown>[] = [];
    let url = "";
    wss.on("connection", (ws, req) => {
      url = req.url ?? "";
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        got.push(m);
        if (m.setup) ws.send(JSON.stringify({ setupComplete: {} }));
        if (m.realtimeInput) {
          ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: "halo " } } }));
          ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: "sawala" } } }));
          ws.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.from([5, 6]).toString("base64") } }] }, outputTranscription: { text: "Hai." } } }));
          ws.send(JSON.stringify({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 20, responseTokenCount: 6 } }));
        }
      });
    });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const port = (wss.address() as AddressInfo).port;
    try {
      const p = geminiLiveProvider(cfgWith({ REALTIME_PROVIDER: "gemini", GEMINI_API_KEY: "gk", GEMINI_REALTIME_MODEL: "live-m", GEMINI_LIVE_URL: `ws://127.0.0.1:${port}/live`, GEMINI_REALTIME_VOICE: "Puck" }));
      const { ev, log, audio } = noopEvents();
      const s = await p.open({ instructions: "INSTR", language: "id-ID", bargeIn: false }, ev);
      s.sendAudio(Buffer.from([7, 7]));
      await waitUntil(() => log.includes("done"));
      expect(url).toContain("key=gk");
      expect(got[0]).toMatchObject({ setup: { model: "models/live-m", systemInstruction: { parts: [{ text: "INSTR" }] }, generationConfig: { responseModalities: ["AUDIO"] } } });
      expect(got[1]).toEqual({ realtimeInput: { audio: { data: Buffer.from([7, 7]).toString("base64"), mimeType: "audio/pcm;rate=16000" } } });
      expect(audio[0]).toEqual(Buffer.from([5, 6]));
      // transkrip bertahap "halo " + "sawala" menjadi satu final sebelum audio model diteruskan
      expect(log.indexOf("u:F:halo sawala")).toBeGreaterThan(-1);
      expect(log.indexOf("u:F:halo sawala")).toBeLessThan(log.indexOf("a:F:Hai."));
      expect(log).toContain("usage:20/6");
      s.close();
    } finally { wss.close(); }
  });

  it("gagal tersambung -> open() menolak (relay menampilkan error yang bisa dipahami)", async () => {
    const p = openaiRealtimeProvider(cfgWith({ REALTIME_PROVIDER: "openai", OPENAI_API_KEY: "sk", OPENAI_REALTIME_MODEL: "m", OPENAI_REALTIME_URL: "ws://127.0.0.1:1/x" }));
    await expect(p.open({ instructions: "i", language: "id-ID", bargeIn: false }, noopEvents().ev)).rejects.toBeTruthy();
  });
});

describe("kompatibilitas embedding & VAD", () => {
  const ctxLike = (tag: string, dims: number) => ({ embedder: { tag, dimensions: dims } }) as never;
  it("vektor beda tag/dimensi tidak dibandingkan", () => {
    expect(embeddingCompatible(ctxLike("openai/m/8", 8), { embedding: [0], embeddingTag: "openai/m/8" })).toBe(true);
    expect(embeddingCompatible(ctxLike("openai/m/8", 8), { embedding: [0], embeddingTag: "gemini/g/8" })).toBe(false);
    expect(embeddingCompatible(ctxLike("x", 4), { embedding: [1, 2, 3, 4] })).toBe(true); // data lama tanpa tag: cocok jika dimensi sama
    expect(embeddingCompatible(ctxLike("x", 4), { embedding: [1, 2, 3] })).toBe(false);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  it("VAD: hening tidak memicu, ucapan terpotong setelah jeda, bising pendek diabaikan", () => {
    const frame = (amp: number) => { const b = Buffer.alloc(640); for (let i = 0; i < 320; i++) b.writeInt16LE(Math.round(Math.sin(i / 3) * amp), i * 2); return b; };
    const run = (frames: number[]) => { const v = new Vad({ sampleRate: 16000 }); const out = []; for (const a of frames) { const u = v.push(frame(a)); if (u) out.push(u); } return out; };
    expect(run(Array(100).fill(0))).toHaveLength(0);
    const speech = run([...Array(50).fill(0), ...Array(40).fill(8000), ...Array(60).fill(0)]);
    expect(speech).toHaveLength(1);
    expect(speech[0]!.durationMs).toBeGreaterThan(700);
    expect(run([...Array(50).fill(0), ...Array(3).fill(8000), ...Array(60).fill(0)])).toHaveLength(0); // klik pendek
  });
});

import { parseWav, pcmToBuffer, resamplePcm16 as serverResample } from "../src/voice/audio.js";

describe("audio util (uji asap suara)", () => {
  it("WAV PCM16 dibaca benar (termasuk stereo -> kanal pertama) dan format lain ditolak jelas", () => {
    const s = new Int16Array([100, -100, 2000, -2000]);
    const wav = pcm16ToWav(pcmToBuffer(s), 24000);
    expect(parseWav(wav)).toEqual({ samples: s, rate: 24000 });
    expect(() => parseWav(Buffer.from("bukan wav sama sekali, hanya teks panjang yang cukup untuk melewati cek panjang minimum"))).toThrow(/WAV/);
    const bad = Buffer.from(wav); bad.writeUInt16LE(3, 20); // format float
    expect(() => parseWav(bad)).toThrow(/PCM 16-bit/);
    expect(serverResample(new Int16Array([0, 100, 200, 300]), 16000, 8000).length).toBe(2);
  });
});
