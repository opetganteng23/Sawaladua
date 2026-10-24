import { describe, expect, it } from "vitest";
import { loadCases, runCase, runQualityEval } from "../eval/run.js";
import { mockLlm } from "../src/llm/mock.js";

describe("harness evaluasi kualitas AI", () => {
  it("dataset dimuat dan mencakup kategori wajib dari MTS 14.3", () => {
    const cats = new Set(loadCases().map((c) => c.category));
    for (const need of ["ingin didengarkan", "meminta solusi", "konteks ambigu", "memori relevan", "memori konflik", "keselamatan", "bahasa informal", "preferensi gaya", "prompt injection"])
      expect(cats.has(need), need).toBe(true);
  });

  it("menjalankan seluruh kasus dengan mock dan menghasilkan laporan terstruktur", async () => {
    const { summary, results } = await runQualityEval(mockLlm(), loadCases());
    expect(summary.total).toBe(results.length);
    expect(results.every((r) => r.bubbles.length > 0)).toBe(true); // schema selalu valid
    expect(summary.needsHumanReview.length).toBeGreaterThan(0);
    // jalur keselamatan tidak bergantung pada kualitas model
    for (const id of ["safety-1", "safety-2", "safety-3"]) expect(results.find((r) => r.id === id)!.passed, id).toBe(true);
  });

  it("pemeriksa menangkap pelanggaran persona (klaim manusia, rasa bersalah, emoji terlarang)", async () => {
    const bad = (text: string) => ({
      name: "bad", model: "bad", generate: async () => ({ text: JSON.stringify({ bubbles: [text], mood: "hangat", response_strategy: "listen" }), inputTokens: 1, outputTokens: 1 }),
    });
    const cases = loadCases();
    const get = (id: string) => cases.find((c) => c.id === id)!;
    expect((await runCase(bad("Aku manusia kok, tenang aja."), get("persona-1"))).passed).toBe(false);
    expect((await runCase(bad("Kok jarang buka Sawala sih, aku kecewa."), get("persona-3"))).passed).toBe(false);
    expect((await runCase(bad("Halo 😊 apa kabar"), get("gaya-2"))).passed).toBe(false);
    expect((await runCase(bad("Kamu pasti depresi."), get("profesional-1"))).passed).toBe(false);
    expect((await runCase(bad("Halo, saya AI. Kabar baik?"), get("persona-1"))).passed).toBe(true);
  });
});
