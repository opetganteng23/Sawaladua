import type { AppCtx } from "../../context.js";
import { pcm16ToWav } from "../../llm/types.js";
import { Vad } from "../vad.js";
import type { OpenOptions, RealtimeEvents, RealtimeProvider, RealtimeSession } from "../types.js";

/**
 * Mode cascade: VAD di server -> STT -> balasan tervalidasi (orchestrator: safety gate, memori, vendor LLM apa pun) -> TTS.
 * Dipakai bila model speech-to-speech native tidak tersedia/tidak diinginkan (mis. LLM Anthropic + STT/TTS OpenAI).
 * Semua jaminan keselamatan chat teks berlaku penuh karena balasan diucapkan SETELAH divalidasi.
 */
export function cascadeProvider(ctx: AppCtx): RealtimeProvider {
  const stt = ctx.stt!;
  return {
    name: `cascade(${stt.name}+${ctx.llm.name}${ctx.tts ? "+" + ctx.tts.name : "+browser-tts"})`,
    model: `${stt.model}|${ctx.llm.model}|${ctx.tts?.model ?? "browser"}`,
    mode: "cascade",
    inputRate: 16000,
    outputRate: 24000,
    async open(opts: OpenOptions, ev: RealtimeEvents): Promise<RealtimeSession> {
      const vad = new Vad({ sampleRate: 16000 });
      let busy = false;
      let current: AbortController | null = null;
      let closed = false;

      const handle = async (pcm: Buffer) => {
        busy = true;
        const ac = new AbortController();
        current = ac;
        try {
          const wav = pcm16ToWav(pcm, 16000);
          const t = await stt.transcribe(wav, "audio/wav", { language: opts.language, signal: ac.signal });
          ev.onUsage(t.inputTokens, t.outputTokens);
          if (ac.signal.aborted || closed || !t.text.trim()) return;
          ev.onUserTranscript(t.text, true);
          const bubbles = await opts.respond!(t.text, ac.signal);
          if (ac.signal.aborted || closed) return;
          ev.onAssistantTranscript(bubbles.join(" "), true);
          for (const b of bubbles) {
            if (ac.signal.aborted || closed) return;
            if (ctx.tts) {
              const a = await ctx.tts.synthesize(b, { language: opts.language, signal: ac.signal });
              ev.onUsage(a.inputTokens, a.outputTokens);
              if (ac.signal.aborted || closed) return;
              ev.onSpeech(a.audio, a.mime);
            } else ev.onSpeechText(b);
          }
          ev.onTurnComplete();
        } catch (e) {
          if (!ac.signal.aborted && !closed) ev.onError(e as Error);
        } finally {
          busy = false;
          if (current === ac) current = null;
        }
      };

      vad.onSpeechStart = () => {
        // Pengguna mulai bicara saat Sawala sedang memproses/berbicara: potong hanya jika barge-in diizinkan.
        if (busy && opts.bargeIn) { current?.abort(); ev.onInterrupted(); }
      };

      return {
        sendAudio(pcm) {
          if (closed) return;
          const u = vad.push(pcm);
          if (u && !busy) void handle(u.pcm);
        },
        cancelResponse() { current?.abort(); },
        close() { closed = true; current?.abort(); vad.reset(); ev.onClosed(); },
      };
    },
  };
}
