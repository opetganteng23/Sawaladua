import WebSocket from "ws";
import type { Config } from "../../config.js";
import type { OpenOptions, RealtimeEvents, RealtimeProvider, RealtimeSession } from "../types.js";

/**
 * Adapter OpenAI Realtime (speech-to-speech) lewat WebSocket. Audio 24 kHz PCM16 dua arah.
 * CATATAN: protokol ini ditulis dari dokumentasi publik dan diuji terhadap server palsu, BUKAN terhadap API asli.
 * Nama event bisa berbeda antar versi API; handler di bawah menerima nama beta dan GA. Verifikasi dengan kunci Anda sebelum rilis.
 */
export function openaiRealtimeProvider(cfg: Config): RealtimeProvider {
  return {
    name: "openai-realtime", model: cfg.OPENAI_REALTIME_MODEL, mode: "native", inputRate: 24000, outputRate: 24000,
    open(opts: OpenOptions, ev: RealtimeEvents): Promise<RealtimeSession> {
      return new Promise((resolve, reject) => {
        const url = `${cfg.OPENAI_REALTIME_URL}?model=${encodeURIComponent(cfg.OPENAI_REALTIME_MODEL)}`;
        const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } });
        let opened = false;
        let closed = false;
        const send = (o: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
        let assistantText = "";

        const session: RealtimeSession = {
          sendAudio(pcm) { send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }); },
          cancelResponse() { send({ type: "response.cancel" }); send({ type: "input_audio_buffer.clear" }); },
          close() { closed = true; try { ws.close(); } catch { /* sudah tertutup */ } },
        };

        ws.on("open", () => {
          send({
            type: "session.update",
            session: {
              instructions: opts.instructions,
              voice: cfg.OPENAI_REALTIME_VOICE || "alloy",
              modalities: ["audio", "text"],
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: { model: cfg.OPENAI_REALTIME_TRANSCRIBE_MODEL || "whisper-1", language: opts.language.slice(0, 2) },
              turn_detection: { type: "server_vad" },
            },
          });
          opened = true;
          resolve(session);
        });

        ws.on("message", (raw) => {
          let m: { type?: string; delta?: string; transcript?: string; error?: { message?: string }; response?: { usage?: { input_tokens?: number; output_tokens?: number } } };
          try { m = JSON.parse(raw.toString()); } catch { return; }
          switch (m.type) {
            case "response.audio.delta":
            case "response.output_audio.delta":
              if (m.delta) ev.onAudio(Buffer.from(m.delta, "base64"));
              break;
            case "response.audio_transcript.delta":
            case "response.output_audio_transcript.delta":
              assistantText += m.delta ?? "";
              ev.onAssistantTranscript(assistantText, false);
              break;
            case "response.audio_transcript.done":
            case "response.output_audio_transcript.done":
              ev.onAssistantTranscript(m.transcript ?? assistantText, true);
              assistantText = "";
              break;
            case "conversation.item.input_audio_transcription.completed":
              if (m.transcript?.trim()) ev.onUserTranscript(m.transcript.trim(), true);
              break;
            case "input_audio_buffer.speech_started":
              if (opts.bargeIn) ev.onInterrupted();
              break;
            case "response.done":
              if (m.response?.usage) ev.onUsage(m.response.usage.input_tokens ?? 0, m.response.usage.output_tokens ?? 0);
              ev.onTurnComplete();
              break;
            case "error":
              ev.onError(new Error("openai_realtime_error"));
              break;
          }
        });

        ws.on("error", (e) => { if (!opened) reject(e); else ev.onError(e); });
        ws.on("close", () => { if (!opened) reject(new Error("openai_realtime_closed")); else if (!closed) ev.onClosed(); });
        opts.signal?.addEventListener("abort", () => session.close());
      });
    },
  };
}
