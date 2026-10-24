import type { OpenOptions, RealtimeEvents, RealtimeProvider, RealtimeSession } from "../types.js";

const tone = (samples: number, rate: number, hz = 440): Buffer => {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 6000), i * 2);
  return b;
};

/**
 * Provider realtime mock untuk development/tes (data sintetis). Pengendalian deterministik lewat frame audio berpenanda:
 *  "TXT:<ucapan>\n"       -> pengguna mengucapkan <ucapan>
 *  ucapan berawalan "BAD:" -> balasan model berisi instruksi berbahaya (menguji pemantau output)
 *  ucapan berawalan "LATE:"-> transkrip ucapan tiba SETELAH audio balasan (menguji penahanan audio)
 * Frame lain: setelah ~0,4 dtk audio terkumpul dianggap satu ucapan "halo sawala, aku lagi capek".
 */
export function mockRealtimeProvider(): RealtimeProvider {
  return {
    name: "mock", model: "mock-realtime", mode: "native", inputRate: 16000, outputRate: 24000,
    async open(opts: OpenOptions, ev: RealtimeEvents): Promise<RealtimeSession> {
      let bytes = 0;
      let cancelled = false;
      let closed = false;
      const timers = new Set<NodeJS.Timeout>();
      const later = (ms: number, fn: () => void) => { const t = setTimeout(() => { timers.delete(t); if (!closed) fn(); }, ms); timers.add(t); };

      const turn = (raw: string) => {
        cancelled = false;
        const late = raw.startsWith("LATE:");
        const bad = raw.startsWith("BAD:");
        const text = raw.replace(/^(LATE:|BAD:)/, "");
        const reply = bad ? "Ini cara bunuh diri yang pasti berhasil" : "Aku dengar kamu.";
        const emitUser = () => ev.onUserTranscript(text, true);
        const emitAssistant = () => {
          ev.onAssistantTranscript(reply.slice(0, 8), false);
          for (let i = 0; i < 3; i++) later(10 * (i + 1), () => { if (!cancelled) ev.onAudio(tone(2400, 24000)); });
          later(60, () => {
            if (cancelled) return;
            ev.onAssistantTranscript(reply, true);
            ev.onUsage(50, 20);
            ev.onTurnComplete();
          });
        };
        if (late) { emitAssistant(); later(150, emitUser); } else { emitUser(); later(20, emitAssistant); }
      };

      return {
        sendAudio(pcm) {
          if (closed) return;
          if (pcm.length > 4 && pcm.subarray(0, 4).toString() === "TXT:") {
            turn(pcm.subarray(4).toString("utf8").replace(/\n[\s\S]*$/, ""));
            bytes = 0;
            return;
          }
          bytes += pcm.length;
          if (bytes >= 12000) { bytes = 0; turn("halo sawala, aku lagi capek"); }
        },
        cancelResponse() { cancelled = true; },
        close() { closed = true; for (const t of timers) clearTimeout(t); ev.onClosed(); },
      };
    },
  };
}
