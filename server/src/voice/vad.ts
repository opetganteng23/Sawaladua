/**
 * VAD berbasis energi (RMS) untuk mode cascade. Sederhana dan tanpa dependensi; cukup untuk memotong ucapan per giliran.
 * Ambang adaptif terhadap noise latar (lantai noise bergerak).
 */
export interface VadOptions {
  sampleRate: number;
  minSpeechMs?: number;
  silenceMs?: number;
  maxUtteranceMs?: number;
  prerollMs?: number;
  minThreshold?: number;
}

export interface Utterance { pcm: Buffer; durationMs: number }

export const rms16 = (pcm: Buffer): number => {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; sum += v * v; }
  return Math.sqrt(sum / n);
};

export class Vad {
  private readonly o: Required<VadOptions>;
  private floor = 0.004;
  private speaking = false;
  private speechMs = 0;
  private silenceAcc = 0;
  private hot = 0;
  private chunks: Buffer[] = [];
  private pre: { buf: Buffer; ms: number }[] = [];
  private preMs = 0;
  private totalMs = 0;
  onSpeechStart: (() => void) | null = null;

  constructor(opts: VadOptions) {
    this.o = { minSpeechMs: 300, silenceMs: 800, maxUtteranceMs: 30_000, prerollMs: 300, minThreshold: 0.015, ...opts };
  }

  get inSpeech() { return this.speaking; }

  /** Masukkan satu frame PCM16. Mengembalikan ucapan utuh bila giliran bicara baru saja selesai. */
  push(frame: Buffer): Utterance | null {
    const ms = (frame.length / 2 / this.o.sampleRate) * 1000;
    const level = rms16(frame);
    const threshold = Math.max(this.o.minThreshold, this.floor * 3.5);
    const voiced = level > threshold;
    if (!voiced && !this.speaking) this.floor = this.floor * 0.95 + level * 0.05; // adaptasi hanya saat hening

    if (!this.speaking) {
      this.pre.push({ buf: frame, ms }); this.preMs += ms;
      while (this.preMs > this.o.prerollMs && this.pre.length > 1) this.preMs -= this.pre.shift()!.ms;
      this.hot = voiced ? this.hot + 1 : 0;
      if (this.hot >= 2) {
        this.speaking = true; this.speechMs = 0; this.silenceAcc = 0; this.totalMs = this.preMs;
        this.chunks = this.pre.map((p) => p.buf); this.pre = []; this.preMs = 0; this.hot = 0;
        this.onSpeechStart?.();
      }
      return null;
    }

    this.chunks.push(frame); this.totalMs += ms;
    if (voiced) { this.speechMs += ms; this.silenceAcc = 0; } else this.silenceAcc += ms;
    if (this.silenceAcc >= this.o.silenceMs || this.totalMs >= this.o.maxUtteranceMs) return this.finish();
    return null;
  }

  private finish(): Utterance | null {
    const enough = this.speechMs >= this.o.minSpeechMs;
    const pcm = Buffer.concat(this.chunks);
    const durationMs = this.totalMs;
    this.reset();
    return enough ? { pcm, durationMs } : null;
  }

  reset() {
    this.speaking = false; this.speechMs = 0; this.silenceAcc = 0; this.hot = 0; this.chunks = []; this.pre = []; this.preMs = 0; this.totalMs = 0;
  }
}
