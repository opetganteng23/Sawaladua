import WebSocket from "ws";
import type { Config } from "../../config.js";
import type { OpenOptions, RealtimeEvents, RealtimeProvider, RealtimeSession } from "../types.js";

/**
 * Adapter Gemini Live (speech-to-speech) lewat WebSocket. Masukan PCM16 16 kHz, keluaran PCM16 24 kHz.
 * CATATAN: protokol ditulis dari dokumentasi publik dan diuji terhadap server palsu, BUKAN terhadap API asli.
 * Verifikasi nama field dengan kunci Anda sebelum rilis.
 */
export function geminiLiveProvider(cfg: Config): RealtimeProvider {
  return {
    name: "gemini-live", model: cfg.GEMINI_REALTIME_MODEL, mode: "native", inputRate: 16000, outputRate: 24000,
    open(opts: OpenOptions, ev: RealtimeEvents): Promise<RealtimeSession> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${cfg.GEMINI_LIVE_URL}?key=${encodeURIComponent(cfg.GEMINI_API_KEY)}`);
        let ready = false;
        let closed = false;
        let userText = "";
        let modelText = "";
        let userFlushed = false;
        const send = (o: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

        // Gemini mengirim transkrip masukan bertahap tanpa penanda "final"; dianggap final saat model mulai menjawab atau giliran selesai.
        const flushUser = () => {
          if (!userFlushed && userText.trim()) { userFlushed = true; ev.onUserTranscript(userText.trim(), true); }
        };

        const session: RealtimeSession = {
          sendAudio(pcm) { send({ realtimeInput: { audio: { data: pcm.toString("base64"), mimeType: "audio/pcm;rate=16000" } } }); },
          // Live API tidak menyediakan pembatalan eksplisit; relay membuang keluaran model sampai giliran berikutnya.
          cancelResponse() { /* ditangani relay dengan menjatuhkan audio */ },
          close() { closed = true; try { ws.close(); } catch { /* sudah tertutup */ } },
        };

        ws.on("open", () => {
          send({
            setup: {
              model: cfg.GEMINI_REALTIME_MODEL.startsWith("models/") ? cfg.GEMINI_REALTIME_MODEL : `models/${cfg.GEMINI_REALTIME_MODEL}`,
              generationConfig: {
                responseModalities: ["AUDIO"],
                ...(cfg.GEMINI_REALTIME_VOICE ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.GEMINI_REALTIME_VOICE } } } } : {}),
              },
              systemInstruction: { parts: [{ text: opts.instructions }] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          });
        });

        ws.on("message", (raw) => {
          let m: {
            setupComplete?: unknown;
            serverContent?: {
              modelTurn?: { parts?: { inlineData?: { data?: string } }[] };
              inputTranscription?: { text?: string };
              outputTranscription?: { text?: string };
              turnComplete?: boolean;
              interrupted?: boolean;
            };
            usageMetadata?: { promptTokenCount?: number; responseTokenCount?: number; candidatesTokenCount?: number };
          };
          try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m.setupComplete !== undefined && !ready) { ready = true; resolve(session); return; }
          const sc = m.serverContent;
          if (sc?.inputTranscription?.text) {
            if (userFlushed) { userText = ""; userFlushed = false; } // giliran baru
            userText += sc.inputTranscription.text;
            ev.onUserTranscript(userText, false);
          }
          for (const p of sc?.modelTurn?.parts ?? []) {
            if (p.inlineData?.data) { flushUser(); ev.onAudio(Buffer.from(p.inlineData.data, "base64")); }
          }
          if (sc?.outputTranscription?.text) { modelText += sc.outputTranscription.text; ev.onAssistantTranscript(modelText, false); }
          if (sc?.interrupted) { if (opts.bargeIn) ev.onInterrupted(); modelText = ""; }
          if (sc?.turnComplete) {
            flushUser();
            ev.onAssistantTranscript(modelText, true);
            modelText = ""; userText = ""; userFlushed = false;
            ev.onTurnComplete();
          }
          if (m.usageMetadata) ev.onUsage(m.usageMetadata.promptTokenCount ?? 0, m.usageMetadata.responseTokenCount ?? m.usageMetadata.candidatesTokenCount ?? 0);
        });

        ws.on("error", (e) => { if (!ready) reject(e); else ev.onError(e); });
        ws.on("close", () => { if (!ready) reject(new Error("gemini_live_closed")); else if (!closed) ev.onClosed(); });
        opts.signal?.addEventListener("abort", () => session.close());
      });
    },
  };
}
