/** Utilitas audio PCM16 mono untuk uji asap dan alat bantu server. */

export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const n = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = pos - i0;
    out[i] = Math.round(input[i0]! * (1 - f) + input[i1]! * f);
  }
  return out;
}

export interface Pcm { samples: Int16Array; rate: number }

/** Baca WAV PCM 16-bit (mono atau stereo; stereo diambil kanal pertama). Menolak format lain dengan pesan jelas. */
export function parseWav(buf: Buffer): Pcm {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Bukan berkas WAV.");
  let off = 12, rate = 0, channels = 1, bits = 16, fmt = 1;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") { fmt = buf.readUInt16LE(body); channels = buf.readUInt16LE(body + 2); rate = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14); }
    if (id === "data") {
      if (fmt !== 1 || bits !== 16) throw new Error("WAV harus PCM 16-bit (format lain belum didukung).");
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const s = new Int16Array(frames);
      for (let i = 0; i < frames; i++) s[i] = buf.readInt16LE(body + i * 2 * channels);
      return { samples: s, rate };
    }
    off = body + size + (size % 2);
  }
  throw new Error("Chunk data WAV tidak ditemukan.");
}

export const pcmToBuffer = (s: Int16Array) => Buffer.from(s.buffer, s.byteOffset, s.byteLength);
