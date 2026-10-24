/**
 * Kontrak suara realtime. `RealtimeProvider` (model speech-to-speech native atau cascade STT+LLM+TTS) dan `ClientLink`
 * (transport ke pengguna: WebSocket sekarang, bisa LiveKit nanti) dipisahkan dari logika keselamatan di relay.ts,
 * sehingga mengganti vendor atau transport tidak menyentuh aturan keselamatan/privasi.
 */

export interface RealtimeEvents {
  /** Audio balasan model native: PCM16 mono pada `outputRate`. */
  onAudio(pcm: Buffer): void;
  /** Klip audio terenkode utuh (hasil TTS cascade): mime audio/wav, audio/mpeg, dst. */
  onSpeech(audio: Buffer, mime: string): void;
  /** Cascade tanpa TTS server: teks yang harus diucapkan oleh browser. */
  onSpeechText(text: string): void;
  onUserTranscript(text: string, final: boolean): void;
  onAssistantTranscript(text: string, final: boolean): void;
  onTurnComplete(): void;
  /** Pengguna memotong (barge-in) saat model berbicara. */
  onInterrupted(): void;
  onUsage(inputTokens: number, outputTokens: number): void;
  onError(err: Error): void;
  onClosed(): void;
}

export interface RealtimeSession {
  /** PCM16 mono pada `inputRate`. Tidak pernah disimpan atau dicatat. */
  sendAudio(pcm: Buffer): void;
  /** Hentikan respons yang sedang dibuat (dan audio yang belum terkirim). */
  cancelResponse(): void;
  close(): void;
}

export interface OpenOptions {
  /** Instruksi sistem lengkap (persona + konteks + keselamatan), versi ucapan. */
  instructions: string;
  language: string;
  /** Hanya dipakai cascade: hasilkan balasan tervalidasi untuk satu ucapan pengguna. */
  respond?: (userText: string, signal: AbortSignal) => Promise<string[]>;
  bargeIn: boolean;
  signal?: AbortSignal;
}

export interface RealtimeProvider {
  name: string;
  model: string;
  mode: "native" | "cascade";
  inputRate: number;
  outputRate: number;
  open(opts: OpenOptions, ev: RealtimeEvents): Promise<RealtimeSession>;
}

/** Transport ke pengguna. */
export interface ClientLink {
  sendJson(msg: Record<string, unknown>): void;
  sendAudio(pcm: Buffer): void;
  close(code?: number, reason?: string): void;
}
