import { createHash } from "node:crypto";
import { pcm16ToWav, type Embedder, type LlmProvider, type LlmRequest, type LlmResult, type SttProvider, type TtsProvider } from "./types.js";

/** Provider deterministik untuk development/test. Hanya untuk data sintetis. */
export function mockLlm(): LlmProvider {
  return {
    name: "mock",
    model: "mock-1",
    async generate(req: LlmRequest): Promise<LlmResult> {
      const last = [...req.messages].reverse().find((m) => m.role === "user")?.text ?? "";
      let text: string;
      if (req.system.includes("[TUGAS:EKSTRAKSI_MEMORI]")) {
        const m = /nama (?:aku|saya) (\w+)/i.exec(last) ?? /namaku (\w+)/i.exec(last);
        const items = [];
        if (m) items.push({ type: "semantic", content: `Pengguna bernama ${m[1]}`, importance: 0.8, confidence: 0.9, sensitivity: "none" });
        const w = /(?:kerja|bekerja) (?:di|sebagai) ([^.,!?]+)/i.exec(last);
        if (w) items.push({ type: "semantic", content: `Pengguna bekerja ${w[0].split(" ").slice(1).join(" ")}`, importance: 0.6, confidence: 0.8, sensitivity: "personal" });
        text = JSON.stringify({ memories: items });
      } else if (req.system.includes("[TUGAS:RINGKASAN_SESI]")) {
        text = JSON.stringify({ summary: `Pengguna membahas: ${last.slice(0, 120)}` });
      } else {
        const ask = /(saran|solusi|gimana caranya|harus gimana)/i.test(last);
        const happy = /(senang|berhasil|lulus|diterima|alhamdulillah)/i.test(last);
        const sad = /(sedih|capek|lelah|cemas|takut|kesal|marah)/i.test(last);
        text = JSON.stringify({
          bubbles: ask
            ? ["Oke, ini beberapa langkah kecil yang bisa dicoba.", "Mulai dari yang paling ringan dulu ya."]
            : sad
              ? ["Aku dengar kamu, dan itu kedengarannya berat.", "Aku di sini kalau mau cerita lebih banyak."]
              : happy
                ? ["Wah, selamat ya! Itu kabar bagus 🎉"]
                : ["Hmm, begitu ya. Ceritakan lebih banyak kalau kamu mau."],
          mood: happy ? "ceria" : sad ? "hangat" : "hangat",
          response_strategy: ask ? "suggest" : sad ? "listen" : "clarify",
        });
      }
      return { text, inputTokens: Math.ceil(req.system.length / 4), outputTokens: Math.ceil(text.length / 4) };
    },
  };
}

/** Embedding hashing bag-of-words: deterministik dan cukup untuk menguji pipeline retrieval. */
export function mockEmbedder(dimensions: number): Embedder {
  return {
    name: "mock",
    model: "mock",
    dimensions,
    tag: `mock/mock/${dimensions}`,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(dimensions).fill(0);
        for (const tok of t.toLowerCase().match(/[a-z0-9À-ɏ]+/g) ?? []) {
          const h = createHash("md5").update(tok).digest();
          v[h.readUInt16BE(0) % dimensions]! += h[2]! % 2 ? 1 : -1;
          v[h.readUInt16BE(3) % dimensions]! += 0.5;
        }
        return v;
      });
    },
  };
}

/** STT mock: audio terlalu pendek dianggap tanpa ucapan; selain itu mengembalikan kalimat tetap (untuk tes alur). */
export function mockStt(): SttProvider {
  return {
    name: "mock", model: "mock-stt",
    async transcribe(audio) {
      return { text: audio.length < 100 ? "" : "halo sawala, aku lagi capek", inputTokens: 0, outputTokens: 0 };
    },
  };
}

/** TTS mock: menghasilkan WAV hening singkat yang valid. */
export function mockTts(): TtsProvider {
  return {
    name: "mock", model: "mock-tts",
    async synthesize() {
      return { audio: pcm16ToWav(Buffer.alloc(24000 * 2 * 0.2), 24000), mime: "audio/wav", inputTokens: 0, outputTokens: 0 };
    },
  };
}
