import { resamplePcm16 } from "./audio";

export type CallState = "connecting" | "listening" | "thinking" | "speaking" | "safety" | "muted" | "ended";

export interface RealtimeHandlers {
  onReady(info: { mode: "native" | "cascade"; maxMinutes: number }): void;
  onState(s: CallState): void;
  onTranscript(role: "user" | "assistant", text: string, final: boolean): void;
  onError(code: string, message: string): void;
  onEnded(info: { reason: string; transcriptKept: boolean }): void;
}

/** Konversi PCM16 little-endian menjadi Float32 [-1, 1]. */
export function pcm16ToFloat32(buf: ArrayBuffer): Float32Array {
  const i16 = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i]! / 32768;
  return out;
}

/** Pemutar audio balasan: antrean PCM native, klip terenkode (TTS server), dan fallback suara browser. */
export class Player {
  private ctx: AudioContext | null = null;
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private gen = 0;
  onIdle: (() => void) | null = null;

  private ensure() { return (this.ctx ??= new AudioContext()); }
  /** Panggil SINKRON dari handler klik: browser (terutama Safari/iOS) baru mengizinkan audio jika konteks dibuat/di-resume dalam gestur pengguna. */
  unlock() { void this.ensure().resume().catch(() => undefined); }
  get playing() { return this.sources.size > 0 || Boolean(window.speechSynthesis?.speaking); }

  private schedule(buf: AudioBuffer) {
    const ctx = this.ensure();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const start = Math.max(ctx.currentTime + 0.02, this.next);
    src.start(start);
    this.next = start + buf.duration;
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); if (!this.sources.size) this.onIdle?.(); };
  }

  playPcm(buf: ArrayBuffer, rate: number) {
    const f = pcm16ToFloat32(buf);
    if (!f.length) return;
    const ab = this.ensure().createBuffer(1, f.length, rate);
    ab.getChannelData(0).set(f);
    this.schedule(ab);
  }

  async playClip(base64: string) {
    const gen = this.gen;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    try {
      const ab = await this.ensure().decodeAudioData(bytes.buffer.slice(0));
      if (gen === this.gen) this.schedule(ab);
    } catch { /* klip tidak bisa didekode: lewati */ }
  }

  speakText(text: string) {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "id-ID";
    const v = synth.getVoices().find((x) => x.lang.toLowerCase().startsWith("id"));
    if (v) u.voice = v;
    u.onend = () => { if (!this.playing) this.onIdle?.(); };
    synth.speak(u);
  }

  stop() {
    this.gen++;
    for (const s of this.sources) { try { s.stop(); } catch { /* sudah berhenti */ } }
    this.sources.clear();
    this.next = 0;
    window.speechSynthesis?.cancel();
  }

  async close() { this.stop(); await this.ctx?.close().catch(() => undefined); this.ctx = null; }
}

/**
 * Klien suara realtime: mikrofon -> PCM16 20 ms -> WebSocket ke server Sawala; balasan (PCM/klip/teks) dimainkan.
 * Audio tidak disimpan di browser. Echo cancellation/noise suppression diminta dari browser.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private mic: MediaStream | null = null;
  private inCtx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private player = new Player();
  private outRate = 24000;
  private muted = false;
  private ended = false;
  private wake: { release(): Promise<void> } | null = null;
  state: CallState = "connecting";

  constructor(private h: RealtimeHandlers) {}

  private set(s: CallState) { this.state = s; this.h.onState(s); }

  async start(callId: string, bargeIn: boolean) {
    this.player.unlock(); // harus sebelum await pertama agar masih dalam gestur klik
    // Mikrofon dulu agar penolakan izin terlihat jelas sebelum membuka koneksi.
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    // Cegah layar mati selama panggilan (HP); gagal tidak masalah.
    try { this.wake = (await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen")) ?? null; } catch { this.wake = null; }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/calls/${callId}/realtime${bargeIn ? "?bargeIn=1" : ""}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.player.onIdle = () => { if (this.state === "speaking") this.set(this.muted ? "muted" : "listening"); };

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Tidak bisa membuka koneksi suara. Periksa jaringanmu atau pakai chat teks."));
    });

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        if (this.state !== "speaking") this.set("speaking");
        this.player.playPcm(e.data, this.outRate);
        return;
      }
      let m: Record<string, unknown> & { type: string };
      try { m = JSON.parse(e.data as string); } catch { return; }
      switch (m.type) {
        case "ready":
          this.outRate = Number(m.outputRate) || 24000;
          void this.startMic(Number(m.inputRate) || 16000);
          this.h.onReady({ mode: m.mode as "native" | "cascade", maxMinutes: Number(m.maxMinutes) || 30 });
          break;
        case "state": {
          const s = String(m.state);
          if (s === "listening" && this.player.playing) break; // tunggu audio selesai diputar
          if (s === "safety") this.set("safety");
          else if (s === "listening" || s === "thinking" || s === "speaking") this.set(this.muted && s === "listening" ? "muted" : s);
          break;
        }
        case "transcript": this.h.onTranscript(m.role as "user" | "assistant", String(m.text), Boolean(m.final)); break;
        case "interrupted": this.player.stop(); this.set(this.muted ? "muted" : "listening"); break;
        case "speak_audio": void this.player.playClip(String(m.data)); this.set("speaking"); break;
        case "speak_text": this.player.speakText(String(m.text)); this.set("speaking"); break;
        case "error": this.h.onError(String(m.code), String(m.message)); break;
        case "ended": this.finish(String(m.reason), Boolean(m.transcriptKept)); break;
      }
    };
    ws.onclose = () => { if (!this.ended) this.finish("closed", false); };
  }

  private async startMic(rate: number) {
    if (!this.mic || this.node) return;
    const ctx = new AudioContext({ sampleRate: rate });
    this.inCtx = ctx;
    await ctx.resume().catch(() => undefined);
    // Sebagian browser mengabaikan sampleRate yang diminta; kirim ke server selalu pada laju yang diumumkan server.
    const actual = ctx.sampleRate;
    await ctx.audioWorklet.addModule("/pcm-capture.js");
    const src = ctx.createMediaStreamSource(this.mic);
    this.node = new AudioWorkletNode(ctx, "pcm-capture", { processorOptions: { frameSize: Math.round(actual / 50) } });
    this.node.port.onmessage = (ev) => {
      if (this.muted || this.ws?.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 256_000) return;
      const data = ev.data as ArrayBuffer;
      this.ws.send(actual === rate ? data : resamplePcm16(new Int16Array(data), actual, rate).buffer as ArrayBuffer);
    };
    src.connect(this.node); // tidak disambungkan ke destination: mikrofon tidak diputar balik
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.ws?.send(JSON.stringify({ type: "mute", muted: m }));
    this.set(m ? "muted" : "listening");
  }
  interrupt() { this.player.stop(); this.ws?.send(JSON.stringify({ type: "interrupt" })); }
  end() { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "end" })); else this.finish("closed", false); }

  private finish(reason: string, kept: boolean) {
    if (this.ended) return;
    this.ended = true;
    this.mic?.getTracks().forEach((t) => t.stop()); // lepas mikrofon (indikator browser padam)
    void this.wake?.release().catch(() => undefined);
    this.node?.disconnect();
    void this.inCtx?.close().catch(() => undefined);
    void this.player.close();
    try { this.ws?.close(); } catch { /* sudah tertutup */ }
    this.set("ended");
    this.h.onEnded({ reason, transcriptKept: kept });
  }
}
