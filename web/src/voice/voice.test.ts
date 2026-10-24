import { describe, expect, it } from "vitest";
import { pcm16ToFloat32 } from "./realtime";

describe("pcm16ToFloat32", () => {
  it("mengonversi PCM16 little-endian ke rentang [-1, 1]", () => {
    const i16 = new Int16Array([0, 16384, -16384, 32767, -32768]);
    const f = pcm16ToFloat32(i16.buffer);
    expect(Array.from(f).map((x) => Number(x.toFixed(3)))).toEqual([0, 0.5, -0.5, 1, -1]);
  });
  it("mengabaikan byte ganjil di ujung", () => {
    expect(pcm16ToFloat32(new Uint8Array([0, 64, 99]).buffer)).toHaveLength(1);
  });
});

import { resamplePcm16 } from "./audio";

describe("resamplePcm16", () => {
  it("tidak mengubah apa pun jika laju sama", () => {
    const a = new Int16Array([1, 2, 3]);
    expect(resamplePcm16(a, 16000, 16000)).toBe(a);
  });
  it("downsample 48k -> 16k menghasilkan sepertiga sampel dan mempertahankan bentuk gelombang", () => {
    const n = 4800;
    const sine = new Int16Array(n);
    for (let i = 0; i < n; i++) sine[i] = Math.round(Math.sin((2 * Math.PI * 200 * i) / 48000) * 10000);
    const out = resamplePcm16(sine, 48000, 16000);
    expect(out.length).toBe(1600);
    const ref = Math.round(Math.sin((2 * Math.PI * 200 * 300) / 16000) * 10000);
    expect(Math.abs(out[300]! - ref)).toBeLessThan(150);
  });
  it("upsample 16k -> 24k", () => {
    expect(resamplePcm16(new Int16Array([0, 3000, 6000, 9000]), 16000, 24000).length).toBe(6);
  });
  it("masukan kosong aman", () => {
    expect(resamplePcm16(new Int16Array(0), 48000, 16000).length).toBe(0);
  });
});
