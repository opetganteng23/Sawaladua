// Uji asap suara realtime TERHADAP API ASLI (butuh kunci Anda). Memastikan adapter vendor cocok dengan protokol terkini
// SEBELUM dipakai pengguna: urutan event, kualitas transkrip, waktu ke audio pertama, token.
//
// Pakai (di server/.env isi REALTIME_PROVIDER=gemini|openai beserta kunci/modelnya):
//   npm -w server run voice:smoke -- --wav ucapan.wav          # WAV PCM16 berisi ucapan SINTETIS
//   npm -w server run voice:smoke -- --say "Halo Sawala, aku agak capek hari ini"   # butuh TTS_PROVIDER=gemini (menghasilkan WAV)
// Hanya gunakan ucapan sintetis/tanpa data pribadi. Tidak ada audio yang ditulis ke disk.
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { makeLlm, makeStt, makeTts } from "../src/llm/index.js";
import { parseWav, pcmToBuffer, resamplePcm16 } from "../src/voice/audio.js";
import { geminiLiveProvider } from "../src/voice/providers/geminiLive.js";
import { mockRealtimeProvider } from "../src/voice/providers/mock.js";
import { openaiRealtimeProvider } from "../src/voice/providers/openaiRealtime.js";
import type { RealtimeEvents } from "../src/voice/types.js";

try { process.loadEnvFile(".env"); } catch { /* opsional */ }
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const cfg = loadConfig({ SESSION_SECRET: "x".repeat(40), ...process.env } as Record<string, string>);

const provider =
  cfg.REALTIME_PROVIDER === "gemini" ? geminiLiveProvider(cfg)
  : cfg.REALTIME_PROVIDER === "openai" ? openaiRealtimeProvider(cfg)
  : cfg.REALTIME_PROVIDER === "mock" ? mockRealtimeProvider()
  : null;
if (!provider) {
  console.error("Isi REALTIME_PROVIDER=gemini atau openai di server/.env (uji asap hanya untuk provider native).");
  process.exit(2);
}

// 1) siapkan audio ucapan
let wav: Buffer;
if (arg("--wav")) wav = readFileSync(arg("--wav")!);
else if (arg("--say")) {
  const tts = makeTts(cfg);
  if (!tts) { console.error("--say butuh TTS_PROVIDER (gemini menghasilkan WAV). Atau berikan --wav."); process.exit(2); }
  const clip = await tts.synthesize(arg("--say")!, { language: "id-ID" });
  if (!/wav/.test(clip.mime)) { console.error(`TTS menghasilkan ${clip.mime}, bukan WAV. Berikan --wav sendiri.`); process.exit(2); }
  wav = clip.audio;
} else {
  console.error('Berikan --wav berkas.wav atau --say "kalimat sintetis".');
  process.exit(2);
}
const src = parseWav(wav);
const speech = resamplePcm16(src.samples, src.rate, provider.inputRate);
void makeLlm; void makeStt;

// 2) jalankan sesi nyata
const t0 = Date.now();
const mark = () => Date.now() - t0;
const log: { at: number; ev: string; detail?: string }[] = [];
let speechEndedAt = 0, firstAudioAt = 0, userFinalAt = 0, assistantFinalAt = 0, turnCompleteAt = 0, audioBytes = 0, usage = { input: 0, output: 0 };
let userText = "", assistantText = "", errors: string[] = [];

const ev: RealtimeEvents = {
  onAudio: (b) => { audioBytes += b.length; if (!firstAudioAt) { firstAudioAt = mark(); log.push({ at: firstAudioAt, ev: "audio_pertama" }); } },
  onSpeech: () => undefined, onSpeechText: () => undefined,
  onUserTranscript: (t, f) => { if (f) { userFinalAt ||= mark(); userText = t; log.push({ at: mark(), ev: "transkrip_pengguna_final", detail: t }); } },
  onAssistantTranscript: (t, f) => { if (f) { assistantFinalAt ||= mark(); assistantText = t; log.push({ at: mark(), ev: "transkrip_asisten_final", detail: t }); } },
  onTurnComplete: () => { turnCompleteAt ||= mark(); log.push({ at: mark(), ev: "giliran_selesai" }); },
  onInterrupted: () => log.push({ at: mark(), ev: "interrupted" }),
  onUsage: (i, o) => { usage = { input: usage.input + i, output: usage.output + o }; },
  onError: (e) => { errors.push(e.message); log.push({ at: mark(), ev: "error", detail: e.message }); },
  onClosed: () => log.push({ at: mark(), ev: "ditutup" }),
};

const instructions = "Kamu Sawala, teman ngobrol berbahasa Indonesia yang hangat. Jawab singkat dan lisan (uji asap).";
console.log(`Menyambung ke ${provider.name} (${provider.model})…`);
const session = await provider.open({ instructions, language: "id-ID", bargeIn: false }, ev).catch((e: Error) => { console.error("GAGAL tersambung:", e.message); process.exit(1); });
log.push({ at: mark(), ev: "tersambung" });

const frame = provider.inputRate / 50; // 20 ms
const pcm = pcmToBuffer(speech);
for (let o = 0; o < speech.length; o += frame) {
  session.sendAudio(pcm.subarray(o * 2, (o + frame) * 2));
  await new Promise((r) => setTimeout(r, 20)); // kecepatan realtime
}
speechEndedAt = mark();
log.push({ at: speechEndedAt, ev: "ucapan_selesai_dikirim" });
const silence = Buffer.alloc(frame * 2);
const deadline = Date.now() + 25_000;
while (!turnCompleteAt && Date.now() < deadline) { session.sendAudio(silence); await new Promise((r) => setTimeout(r, 20)); }
await new Promise((r) => setTimeout(r, 500));
session.close();

// 3) laporan
const checks = {
  transkripPengguna: Boolean(userText),
  audioBalasan: audioBytes > 0,
  transkripAsisten: Boolean(assistantText),
  giliranSelesai: Boolean(turnCompleteAt),
  tanpaError: errors.length === 0,
};
const report = {
  provider: provider.name, model: provider.model, checks,
  latensiMs: {
    ucapanSelesaiKeAudioPertama: firstAudioAt ? firstAudioAt - speechEndedAt : null,
    ucapanSelesaiKeTranskripPengguna: userFinalAt ? userFinalAt - speechEndedAt : null,
    ucapanSelesaiKeGiliranSelesai: turnCompleteAt ? turnCompleteAt - speechEndedAt : null,
  },
  audioBalasanDetik: Number((audioBytes / 2 / provider.outputRate).toFixed(2)),
  token: usage,
  catatan: [
    userFinalAt && firstAudioAt && userFinalAt > firstAudioAt
      ? `Transkrip pengguna datang ${userFinalAt - firstAudioAt} ms SETELAH audio balasan pertama: naikkan VOICE_SAFETY_HOLD_MS (sekarang ${cfg.VOICE_SAFETY_HOLD_MS}) agar gate keselamatan sempat memeriksa, atau terima jeda tambahan.`
      : "Transkrip pengguna tiba sebelum audio balasan: penahanan audio efektif.",
    firstAudioAt && firstAudioAt - speechEndedAt > 2500 ? "Latensi ke audio pertama > 2,5 dtk: terasa lambat untuk percakapan." : "Latensi ke audio pertama wajar.",
  ],
  transkripPengguna: userText, balasan: assistantText, timeline: log,
};
console.log(JSON.stringify(report, null, 2));
const ok = Object.values(checks).every(Boolean);
console.log(ok ? "\nLULUS: urutan event sesuai harapan adapter." : "\nGAGAL: ada langkah yang tidak muncul. Bandingkan timeline dengan dokumentasi vendor terkini dan perbaiki adapter di server/src/voice/providers/.");
process.exit(ok ? 0 : 1);
