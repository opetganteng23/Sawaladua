/**
 * Resample PCM16 mono dengan interpolasi linear. Dipakai saat browser mengabaikan laju sampel yang diminta untuk AudioContext
 * (umum di Safari/iOS): audio yang dikirim ke server HARUS sesuai laju yang diumumkan server, kalau tidak hasilnya noise.
 */
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
