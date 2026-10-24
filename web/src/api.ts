export type Mood = "hangat" | "ceria" | "playful" | "reflektif";
export type Theme = "terang" | "gelap" | "senja" | "hutan" | "sakura";

export interface Preferences {
  theme: Theme;
  moodThemes: boolean;
  showMood: boolean;
  style: { length: "ringkas" | "sedang" | "panjang"; formality: "santai" | "netral" | "sopan"; emoji: "tanpa" | "sedikit" | "sedang"; humor: boolean; addressAs: string };
  greeting: { enabled: boolean; quietStartHour: number; quietEndHour: number; utcOffsetMinutes: number };
}
export interface Privacy { longTermMemory: boolean; allowSensitiveMemory: boolean; saveHistory: boolean }
export interface User { id: string; email: string; displayName: string; isAdmin?: boolean; preferences: Preferences; privacySettings: Privacy; onboardingDone: boolean; ageConfirmed: boolean }
export interface Features { longTermMemory: boolean; moodThemes: boolean; proactiveGreeting: boolean; voiceCalls: boolean; dataExport: boolean; realtimeVoice?: boolean; realtimeMode?: "native" | "cascade" | null; realtimeProvider?: string }
export interface SessionInfo { user: User | null; features: Features; auth: { google: boolean; clientId: string | null; dev: boolean } }
export interface Conversation { id: string; title: string; updatedAt: string; ephemeral: boolean }
export interface Msg { id: string; role: "user" | "assistant"; text: string; bubbles: string[]; status: string; mood: Mood | null; createdAt: string }
export interface Memory {
  id: string; type: string; content: string; status: "active" | "conflict" | "flagged_wrong" | "superseded";
  sensitivity: string; userConfirmed: boolean; conflictWith: string | null; updatedAt: string; sourceCount: number;
}
export interface SimilarHit { conversationId: string; title: string; snippet: string; score: number }
export interface SearchHit { conversationId: string; title: string; messageId: string | null; snippet: string; createdAt: string }

export class ApiFail extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) { super(message); }
}

const H = { "Content-Type": "application/json", "X-Requested-With": "sawala" };

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method, headers: H, credentials: "include", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiFail(0, "NETWORK", "Tidak bisa terhubung ke Sawala. Periksa koneksimu lalu coba lagi.", true);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (data as { error?: { code: string; message: string; retryable: boolean } } | null)?.error;
    throw new ApiFail(res.status, e?.code ?? "ERROR", e?.message ?? "Terjadi kesalahan.", e?.retryable ?? false);
  }
  return data as T;
}

export interface StreamHandlers {
  onStarted(d: { conversationId: string }): void;
  onBubbleStart(i: number): void;
  onBubbleEnd?(i: number): void;
  onDelta(i: number, text: string): void;
  onMood(m: Mood): void;
  onError(msg: string, retryable: boolean): void;
  onDone(): void;
}

/** Klien SSE di atas fetch (POST + cookie). Parsing sesuai kontrak event di server. */
export async function streamChat(body: { conversationId?: string; clientMessageId: string; text: string; callId?: string }, h: StreamHandlers, signal: AbortSignal) {
  let res: Response;
  try {
    res = await fetch("/api/chat", { method: "POST", headers: H, credentials: "include", body: JSON.stringify(body), signal });
  } catch {
    if (signal.aborted) return;
    return h.onError("Tidak bisa terhubung ke Sawala. Pesanmu belum terkirim, coba lagi ya.", true);
  }
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => null) as { error?: { message: string; retryable: boolean } } | null;
    return h.onError(d?.error?.message ?? "Terjadi kesalahan.", d?.error?.retryable ?? false);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const blk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /event: (.*)/.exec(blk)?.[1];
        const raw = /data: (.*)/.exec(blk)?.[1];
        if (!ev || !raw) continue;
        const d = JSON.parse(raw);
        if (ev === "message_started") h.onStarted(d);
        else if (ev === "bubble_started") h.onBubbleStart(d.bubbleIndex);
        else if (ev === "bubble_delta") h.onDelta(d.bubbleIndex, d.text);
        else if (ev === "bubble_completed") h.onBubbleEnd?.(d.bubbleIndex);
        else if (ev === "mood_updated") h.onMood(d.mood);
        else if (ev === "error") { finished = true; h.onError(d.userMessage, d.retryable); }
        else if (ev === "message_completed") { finished = true; h.onDone(); }
      }
    }
  } catch {
    if (signal.aborted) return;
  }
  if (!finished && !signal.aborted) h.onError("Koneksi terputus sebelum balasan selesai. Kamu bisa kirim ulang.", true);
}
