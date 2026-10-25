import { buildSystemPrompt } from "../chat/prompt.js";
import { contextSummaries } from "../chat/summary.js";
import type { AppCtx } from "../context.js";
import type { CallSessionDoc, ConversationDoc, UserDoc } from "../db.js";
import { checkBudget, QUOTA_MESSAGE } from "../lib/budget.js";
import { finishCall } from "../lib/calls.js";
import { log } from "../lib/logger.js";
import { recordOp } from "../lib/ops.js";
import { memoryEnabled } from "../memory/service.js";
import { assessMessage, outputIsSafe, reviewedImminentResponse, safetyInstruction } from "../safety/gate.js";
import type { ClientLink, RealtimeProvider, RealtimeSession } from "./types.js";
import {
  finalizeCallSummary, loadHistory, QuotaExhausted, saveAssistantMessage, saveUserMessage, scheduleExtraction, voiceTurn,
} from "./turn.js";

export interface RelayDeps {
  ctx: AppCtx;
  user: UserDoc;
  call: CallSessionDoc;
  conv: ConversationDoc;
  link: ClientLink;
  provider: RealtimeProvider;
  bargeIn: boolean;
}

const MAX_FRAME_BYTES = 32 * 1024;
const NO_AUDIO_TIMEOUT_MS = 30_000;
const LATCH_GRACE_MS = 2500;

/**
 * Relay satu panggilan suara realtime. Menjaga aturan yang sama dengan chat teks walau model berbicara langsung:
 *  - Instruksi sistem berisi persona + memori + ringkasan (disusun di server, bukan klien).
 *  - Audio balasan model ditahan sebentar sampai transkrip ucapan pengguna lolos safety gate.
 *  - Risiko (level >= 2) pada ucapan, atau output model yang berbahaya, "mengunci" sesi ke jalur tervalidasi:
 *    audio model dihentikan/dibuang, balasan dibuat lewat orchestrator + respons tinjauan-manusia, lalu diucapkan.
 *  - Penyimpanan, memori, anggaran, dan penghapusan mengikuti persetujuan transkrip.
 * Batas jujur: audio yang sudah terucap sebelum deteksi tidak bisa ditarik kembali.
 */
export class VoiceRelay {
  private session: RealtimeSession | null = null;
  private latched = false;
  private latchAt = 0;
  private muted = false;
  private ended = false;
  private held: Buffer[] = [];
  private holdTimer: NodeJS.Timeout | null = null;
  private turnGateDone = false;
  private userPartialLatched = false;
  private assistantText = "";
  private recentUser: string[] = [];
  private speakChain: Promise<void> = Promise.resolve();
  private inTokens = 0;
  private outTokens = 0;
  private lastFrameAt = Date.now();
  private windowStart = Date.now();
  private windowBytes = 0;
  private timers: NodeJS.Timeout[] = [];
  private startedAt = Date.now();
  private readonly ac = new AbortController();

  constructor(private d: RelayDeps) {}

  private get cfg() { return this.d.ctx.cfg; }
  private send(msg: Record<string, unknown>) { if (!this.ended) this.d.link.sendJson(msg); }

  async start() {
    const { ctx, user, provider } = this.d;
    const budget = await checkBudget(ctx, user._id);
    if (budget !== "ok") return this.fail("QUOTA_EXHAUSTED", QUOTA_MESSAGE);
    const instructions = await this.buildInstructions();
    try {
      this.session = await provider.open({
        instructions, language: "id-ID", bargeIn: this.d.bargeIn, signal: this.ac.signal,
        respond: (text, signal) => this.respond(text, signal),
      }, this.events());
    } catch {
      return this.fail("PROVIDER_UNAVAILABLE", "Sawala sedang kesulitan memulai suara. Coba lagi sebentar, atau gunakan chat teks.");
    }
    this.send({ type: "ready", mode: provider.mode, inputRate: provider.inputRate, outputRate: provider.outputRate, maxMinutes: this.cfg.CALL_MAX_MINUTES, bargeIn: this.d.bargeIn });
    this.send({ type: "state", state: "listening" });
    this.timers.push(
      setTimeout(() => void this.end("max_duration"), this.cfg.CALL_MAX_MINUTES * 60_000),
      setInterval(() => { if (Date.now() - this.lastFrameAt > NO_AUDIO_TIMEOUT_MS) void this.end("timeout"); }, 5000),
    );
  }

  private async buildInstructions(): Promise<string> {
    const { ctx, user, call } = this.d;
    let memories: string[] = [];
    let summaries: string[] = [];
    if (memoryEnabled(ctx, user)) {
      const rows = await ctx.d.c.memories.find({ userId: user._id, status: "active" }).sort({ userConfirmed: -1, importance: -1, updatedAt: -1 }).limit(30).toArray();
      memories = rows
        .filter((m) => user.privacySettings.allowSensitiveMemory || m.sensitivity !== "sensitive")
        .slice(0, 5).map((m) => m.content);
      summaries = await contextSummaries(ctx, user, call.conversationId).catch(() => []);
    }
    return buildSystemPrompt({
      style: user.preferences.style, mood: "hangat", memories, summaries, conflict: null,
      timeHint: null, safetyInstruction: safetyInstruction(0), channel: "call", output: "speech", operatorNotes: ctx.settings.site().persona.extraInstructions,
    });
  }

  private respond(text: string, signal: AbortSignal): Promise<string[]> {
    return voiceTurn(this.d.ctx, this.d.user, this.d.call, this.d.conv, text, signal).then((r) => r.bubbles);
  }

  private events() {
    const native = this.d.provider.mode === "native";
    return {
      onAudio: (pcm: Buffer) => this.onModelAudio(pcm),
      onSpeech: (audio: Buffer, mime: string) => {
        if (this.ended) return;
        this.send({ type: "speak_audio", mime, data: audio.toString("base64") });
        this.send({ type: "state", state: "speaking" });
      },
      onSpeechText: (text: string) => { this.send({ type: "speak_text", text }); this.send({ type: "state", state: "speaking" }); },
      onUserTranscript: (text: string, final: boolean) => (native ? void this.onNativeUser(text, final) : this.send({ type: "transcript", role: "user", text, final })),
      onAssistantTranscript: (text: string, final: boolean) => (native ? void this.onNativeAssistant(text, final) : this.send({ type: "transcript", role: "assistant", text, final })),
      onTurnComplete: () => { this.turnGateDone = false; this.userPartialLatched = false; this.send({ type: "state", state: "listening" }); },
      onInterrupted: () => { this.clearHeld(); this.send({ type: "interrupted" }); },
      onUsage: (i: number, o: number) => { this.inTokens += i; this.outTokens += o; },
      onError: (e: Error) => {
        if (e instanceof QuotaExhausted) return void this.failAndEnd("QUOTA_EXHAUSTED", QUOTA_MESSAGE);
        log("error", { event: "voice_provider_error", code: e.name });
        void this.failAndEnd("PROVIDER_UNAVAILABLE", "Koneksi suara terputus. Kamu bisa memulai panggilan lagi atau memakai chat teks.");
      },
      onClosed: () => { if (!this.ended) void this.end("error"); },
    };
  }

  // ---- audio masuk dari pengguna ----
  onClientAudio(frame: Buffer) {
    if (this.ended || !this.session) return;
    if (frame.length > MAX_FRAME_BYTES) return this.fail("FRAME_TOO_LARGE", "Data audio tidak valid.");
    this.lastFrameAt = Date.now();
    const now = Date.now();
    if (now - this.windowStart > 1000) { this.windowStart = now; this.windowBytes = 0; }
    this.windowBytes += frame.length;
    if (this.windowBytes > this.d.provider.inputRate * 2 * 3) return; // lebih dari 3x realtime: abaikan (penyalahgunaan/bug klien)
    if (this.muted) return;
    this.session.sendAudio(frame);
  }

  onClientJson(msg: { type?: string; muted?: boolean }) {
    if (msg.type === "mute") this.muted = Boolean(msg.muted);
    else if (msg.type === "end") void this.end("user");
    else if (msg.type === "interrupt") { this.session?.cancelResponse(); this.clearHeld(); this.send({ type: "interrupted" }); }
  }

  // ---- audio keluar dari model native ----
  private onModelAudio(pcm: Buffer) {
    if (this.ended || this.latched) return; // terkunci: audio model dibuang
    const holdMs = this.cfg.VOICE_SAFETY_HOLD_MS;
    if (this.turnGateDone || holdMs === 0) return this.forward(pcm);
    this.held.push(pcm);
    // Batas penahanan: setelah jeda, audio dilepas walau transkrip belum tiba; transkrip yang datang kemudian tetap bisa memutus.
    this.holdTimer ??= setTimeout(() => { this.holdTimer = null; this.turnGateDone = true; this.flushHeld(); }, holdMs);
  }
  private forward(pcm: Buffer) { this.d.link.sendAudio(pcm); this.send({ type: "state", state: "speaking" }); }
  private flushHeld() { const h = this.held; this.held = []; for (const b of h) this.forward(b); }
  private clearHeld() { this.held = []; if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; } }

  // ---- transkrip (mode native) ----
  private async onNativeUser(text: string, final: boolean) {
    if (this.ended) return;
    this.send({ type: "transcript", role: "user", text, final });
    const level = assessMessage(text, this.recentUser).level;
    if (level >= 2) {
      if (this.latched && Date.now() - this.latchAt < LATCH_GRACE_MS && !final) return;
      if (this.latched && final && this.userPartialLatched && Date.now() - this.latchAt < LATCH_GRACE_MS) { this.userPartialLatched = false; return; }
      this.userPartialLatched = !final;
      return this.lock(text);
    }
    if (!final) return;
    if (this.latched) { this.recentUser.push(text); return this.safeSpeak(text); } // sesi terkunci: semua giliran lewat jalur tervalidasi
    const id = await saveUserMessage(this.d.ctx, this.d.user, this.d.call, text, level);
    this.recentUser.push(text);
    this.recentUser = this.recentUser.slice(-5);
    this.turnGateDone = true;
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    this.flushHeld();
    const hist = await loadHistory(this.d.ctx, this.d.user, this.d.conv._id, 6);
    scheduleExtraction(this.d.ctx, this.d.user, this.d.call, hist.map((m) => ({ role: m.role, text: m.text })), id);
    const budget = await checkBudget(this.d.ctx, this.d.user._id);
    if (budget !== "ok") void this.failAndEnd("QUOTA_EXHAUSTED", QUOTA_MESSAGE);
  }

  private async onNativeAssistant(text: string, final: boolean) {
    if (this.ended || this.latched) return;
    this.assistantText = text;
    if (!outputIsSafe([text], 0)) return this.lock(this.recentUser.at(-1) ?? "", true);
    this.send({ type: "transcript", role: "assistant", text, final });
    if (final && text.trim()) {
      await saveAssistantMessage(this.d.ctx, this.d.user, this.d.call, [text.trim()], "hangat", "listen", 0);
      this.assistantText = "";
    }
  }

  /** Kunci sesi ke jalur tervalidasi. `outputUnsafe`: model sendiri yang mengucapkan hal berbahaya. */
  private async lock(userText: string, outputUnsafe = false) {
    if (this.ended) return;
    const first = !this.latched;
    this.latched = true;
    this.latchAt = Date.now();
    this.session?.cancelResponse();
    this.clearHeld();
    this.send({ type: "interrupted" });
    this.send({ type: "state", state: "safety" });
    if (first) {
      log("warn", { event: "voice_session_latched", code: outputUnsafe ? "unsafe_output" : "risk_input" });
      recordOp(this.d.ctx, "call_latched");
    }
    if (outputUnsafe) {
      const bubbles = reviewedImminentResponse(this.cfg.CRISIS_RESOURCES_TEXT);
      await saveAssistantMessage(this.d.ctx, this.d.user, this.d.call, bubbles, "hangat", "safety_support", 2);
      return this.speak(bubbles);
    }
    this.recentUser.push(userText);
    return this.safeSpeak(userText);
  }

  /** Balasan lewat jalur tervalidasi lalu diucapkan (TTS server bila ada, selain itu oleh browser). */
  private safeSpeak(text: string): Promise<void> {
    this.speakChain = this.speakChain.then(async () => {
      if (this.ended) return;
      this.send({ type: "state", state: "thinking" });
      try {
        const bubbles = await this.respond(text, this.ac.signal);
        if (this.ended) return;
        this.send({ type: "transcript", role: "assistant", text: bubbles.join(" "), final: true });
        await this.speak(bubbles);
      } catch (e) {
        if (e instanceof QuotaExhausted) return this.failAndEnd("QUOTA_EXHAUSTED", QUOTA_MESSAGE);
        log("error", { event: "voice_safe_turn_failed" });
        this.send({ type: "error", code: "TURN_FAILED", message: "Maaf, ada gangguan. Coba ucapkan lagi.", retryable: true });
      }
    });
    return this.speakChain;
  }

  private async speak(bubbles: string[]) {
    const { ctx } = this.d;
    for (const b of bubbles) {
      if (this.ended) return;
      if (ctx.tts) {
        try {
          const a = await ctx.tts.synthesize(b, { language: "id-ID", signal: this.ac.signal });
          this.inTokens += a.inputTokens; this.outTokens += a.outputTokens;
          this.send({ type: "speak_audio", mime: a.mime, data: a.audio.toString("base64") });
          continue;
        } catch { /* TTS gagal: pakai suara browser */ }
      }
      this.send({ type: "speak_text", text: b });
    }
    this.send({ type: "state", state: "listening" });
  }

  // ---- siklus hidup ----
  private fail(code: string, message: string) {
    this.send({ type: "error", code, message, retryable: code !== "QUOTA_EXHAUSTED" });
    void this.end("error");
  }
  private async failAndEnd(code: string, message: string) {
    this.send({ type: "error", code, message, retryable: code !== "QUOTA_EXHAUSTED" });
    await this.end("error");
  }

  async end(reason: NonNullable<CallSessionDoc["endReason"]>) {
    if (this.ended) return;
    this.ended = true;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.clearHeld();
    this.ac.abort();
    try { this.session?.close(); } catch { /* sudah tertutup */ }
    const { ctx, user, call } = this.d;
    try {
      if (this.inTokens || this.outTokens) {
        await ctx.d.c.usage_events.insertOne({
          userId: user._id, requestId: `call-${call._id}`, provider: this.d.provider.name, model: this.d.provider.model,
          inputTokens: this.inTokens, outputTokens: this.outTokens, latencyMs: Date.now() - this.startedAt, status: reason === "error" ? "error" : "ok", createdAt: new Date(),
        } as never);
      }
      await finalizeCallSummary(ctx, user, call);
      const r = await finishCall(ctx, call, reason, { clientTurns: call.turns });
      this.d.link.sendJson({ type: "ended", reason, transcriptKept: r.transcriptKept });
    } catch {
      log("error", { event: "voice_end_failed" });
    } finally {
      this.d.link.close(1000, "ended");
    }
  }
}
