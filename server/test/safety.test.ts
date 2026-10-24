import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessMessage, outputIsSafe } from "../src/safety/gate.js";

interface Case { text: string; min: number; max: number; tag: string }
interface Seq { turns: string[]; minLast?: number; maxLast?: number; tag: string }
const data = JSON.parse(readFileSync(new URL("../eval/safety.cases.json", import.meta.url), "utf8")) as { cases: Case[]; sequences: Seq[] };

// Skenario sintetis. Hasil harus ditinjau manusia sebelum rilis; ini hanya regresi otomatis.
describe("safety gate: dataset skenario", () => {
  for (const c of data.cases) {
    it(`[${c.tag}] "${c.text}" -> level ${c.min}-${c.max}`, () => {
      const a = assessMessage(c.text);
      expect(a.level).toBeGreaterThanOrEqual(c.min);
      expect(a.level).toBeLessThanOrEqual(c.max);
    });
  }

  for (const s of data.sequences) {
    it(`[${s.tag}] urutan ${s.turns.length} giliran`, () => {
      const history: string[] = [];
      let last = assessMessage(s.turns[0]!, history);
      history.push(s.turns[0]!);
      for (const t of s.turns.slice(1)) {
        last = assessMessage(t, history);
        history.push(t);
      }
      if (s.minLast !== undefined) expect(last.level).toBeGreaterThanOrEqual(s.minLast);
      if (s.maxLast !== undefined) expect(last.level).toBeLessThanOrEqual(s.maxLast);
    });
  }

  it("rekap: tidak ada kasus risiko yang lolos sebagai level 0 (false negative)", () => {
    const misses = data.cases.filter((c) => c.min >= 2 && assessMessage(c.text).level < 2).map((c) => c.text);
    expect(misses).toEqual([]);
  });

  it("pemeriksaan output", () => {
    expect(outputIsSafe(["Ini cara bunuh diri yang cepat"], 0)).toBe(false);
    expect(outputIsSafe(["ok"], 2)).toBe(false);
    expect(outputIsSafe(["Aku di sini bersamamu. Terima kasih sudah cerita, ya."], 2)).toBe(true);
  });
});
