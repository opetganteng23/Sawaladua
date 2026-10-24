import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat } from "../api";
import { Overlay } from "./Overlay";

// Web Speech API belum ada di lib.dom TypeScript; tipe minimal yang kita pakai.
interface SpeechRec {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecCtor = new () => SpeechRec;
const getSR = (): SpeechRecCtor | null => {
  const w = window as unknown as { SpeechRecognition?: SpeechRecCtor; webkitSpeechRecognition?: SpeechRecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

type Phase = "consent" | "starting" | "listening" | "thinking" | "speaking" | "muted" | "ended";
const LABEL: Record<Phase, string> = {
  consent: "Siap memulai", starting: "Menyambungkan…", listening: "Mendengarkan", thinking: "Sawala sedang berpikir",
  speaking: "Sawala berbicara", muted: "Mikrofon dimatikan", ended: "Panggilan berakhir",
};

export function CallView({ onClose, onEnded }: { onClose: () => void; onEnded: (kept: boolean) => void }) {
  const SR = getSR();
  const [phase, setPhase] = useState<Phase>("consent");
  const [consent, setConsent] = useState(false);
  const [bargeIn, setBargeIn] = useState(false);
  const [error, setError] = useState("");
  const [youSaid, setYouSaid] = useState("");
  const [sawalaSaid, setSawalaSaid] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [maxMin, setMaxMin] = useState(30);

  const callId = useRef<string | null>(null);
  const rec = useRef<SpeechRec | null>(null);
  const phaseRef = useRef<Phase>("consent");
  const wantListen = useRef(false);
  const busy = useRef(false);
  const bargeRef = useRef(false);
  const latencies = useRef<number[]>([]);
  const turns = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const restarts = useRef(0);
  const ending = useRef(false);

  const setP = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  bargeRef.current = bargeIn;

  const stopRec = () => { try { rec.current?.abort(); } catch { /* sudah berhenti */ } };
  const startRec = useCallback(() => {
    if (!wantListen.current || !rec.current) return;
    try { rec.current.start(); } catch { /* sudah berjalan */ }
  }, []);

  // Antrean ucapan: setiap bubble diucapkan begitu selesai diterima. Aman karena seluruh balasan sudah divalidasi
  // (schema + keselamatan) di server sebelum satu pun bubble dialirkan.
  const speakQueue = useRef<Promise<void>>(Promise.resolve());
  const speakGen = useRef(0);
  const speakOne = (text: string, gen: number) => new Promise<void>((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth || gen !== speakGen.current || ending.current) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "id-ID";
    const id = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith("id"));
    if (id) u.voice = id;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
  });
  const enqueueSpeak = (text: string) => {
    if (!text.trim() || ending.current) return;
    const gen = speakGen.current;
    setP("speaking");
    // Tanpa barge-in, mikrofon dimatikan saat Sawala bicara agar suara speaker tidak terdengar sebagai ucapan pengguna.
    if (!bargeRef.current) stopRec();
    speakQueue.current = speakQueue.current.then(() => speakOne(text, gen));
  };
  const cancelSpeech = () => { speakGen.current++; window.speechSynthesis?.cancel(); };

  const sendTurn = useCallback(async (text: string) => {
    if (busy.current || !callId.current) return;
    busy.current = true;
    setYouSaid(text); setSawalaSaid(""); setError("");
    setP("thinking");
    const t0 = performance.now();
    const bubbles: string[] = [];
    let failed = false;
    const ac = new AbortController();
    abort.current = ac;
    let first = true;
    await streamChat({ clientMessageId: crypto.randomUUID(), text, callId: callId.current }, {
      onStarted: () => undefined,
      onBubbleStart: (i) => { bubbles[i] = ""; },
      onBubbleEnd: (i) => enqueueSpeak(bubbles[i] ?? ""),
      onDelta: (i, t) => {
        if (first) { first = false; latencies.current.push(performance.now() - t0); }
        bubbles[i] = (bubbles[i] ?? "") + t;
        setSawalaSaid(bubbles.join(" "));
      },
      onMood: () => undefined,
      onError: (msg) => { failed = true; setError(msg); },
      onDone: () => undefined,
    }, ac.signal);
    busy.current = false;
    if (ac.signal.aborted || ending.current) return;
    turns.current++;
    if (!failed) await speakQueue.current;
    if (ending.current) return;
    if (phaseRef.current !== "muted") { setP("listening"); startRec(); }
  }, [startRec]);

  const beginRecognition = useCallback(() => {
    if (!SR) return;
    const r = new SR();
    r.lang = "id-ID"; r.continuous = true; r.interimResults = true;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        const text = res[0].transcript.trim();
        if (!text) continue;
        // Barge-in: pengguna mulai bicara saat Sawala berbicara.
        if (phaseRef.current === "speaking" && bargeRef.current) { cancelSpeech(); setP("listening"); }
        if (res.isFinal && text.length > 1 && !busy.current && phaseRef.current !== "muted") void sendTurn(text);
        else if (!res.isFinal) setYouSaid(text + " …");
      }
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        wantListen.current = false;
        setError("Izin mikrofon ditolak. Izinkan mikrofon di pengaturan browser lalu mulai panggilan lagi.");
      } else if (e.error === "network") {
        setError("Pengenalan suara terputus karena jaringan. Mencoba menyambung lagi…");
      } else if (e.error === "audio-capture") {
        wantListen.current = false;
        setError("Mikrofon tidak terdeteksi.");
      }
    };
    r.onend = () => {
      // Browser menghentikan sesi pengenalan secara berkala; sambungkan lagi selama masih dalam panggilan (dibatasi).
      if (!wantListen.current || ending.current) return;
      if (phaseRef.current === "speaking" && !bargeRef.current) return;
      if (restarts.current++ > 200) { setError("Pengenalan suara berhenti. Akhiri lalu mulai panggilan lagi."); return; }
      setTimeout(startRec, 250);
    };
    rec.current = r;
  }, [SR, sendTurn, startRec]);

  const start = async () => {
    setError(""); setP("starting");
    try {
      const r = await api<{ id: string; maxMinutes: number }>("POST", "/api/calls", { transcriptConsent: consent });
      callId.current = r.id; setMaxMin(r.maxMinutes);
      // Meminta izin mikrofon secara eksplisit agar kegagalan terlihat jelas sebelum pengenalan dimulai.
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      beginRecognition();
      wantListen.current = true;
      setP("listening");
      startRec();
    } catch (e) {
      const msg = (e as Error).name === "NotAllowedError" ? "Izin mikrofon ditolak. Izinkan mikrofon di browser lalu coba lagi." : (e as Error).message;
      setError(msg);
      if (callId.current) { void api("POST", `/api/calls/${callId.current}/end`, {}).catch(() => undefined); callId.current = null; }
      setP("consent");
    }
  };

  const end = useCallback(async () => {
    if (ending.current) return;
    ending.current = true;
    wantListen.current = false;
    abort.current?.abort();
    cancelSpeech();
    stopRec();
    setP("ended");
    let kept = false;
    if (callId.current) {
      const avg = latencies.current.length ? Math.round(latencies.current.reduce((a, b) => a + b, 0) / latencies.current.length) : undefined;
      try {
        const r = await api<{ transcriptKept: boolean }>("POST", `/api/calls/${callId.current}/end`, { avgLatencyMs: avg, clientTurns: turns.current });
        kept = r.transcriptKept;
      } catch { /* server akan mengakhiri sendiri lewat timeout */ }
    }
    onEnded(kept);
  }, [onEnded]);

  const toggleMute = () => {
    if (phaseRef.current === "muted") { wantListen.current = true; setP("listening"); startRec(); }
    else if (phaseRef.current === "listening") { wantListen.current = false; stopRec(); setP("muted"); }
  };

  // timer & pembersihan
  useEffect(() => {
    if (phase === "consent" || phase === "ended") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => { if (seconds >= maxMin * 60) void end(); }, [seconds, maxMin, end]);
  useEffect(() => () => {
    if (!ending.current) {
      ending.current = true; wantListen.current = false;
      speakGen.current++; window.speechSynthesis?.cancel(); stopRec(); abort.current?.abort();
      if (callId.current) void api("POST", `/api/calls/${callId.current}/end`, {}).catch(() => undefined);
    }
  }, []);

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const active = phase !== "consent" && phase !== "ended";
  const micOn = phase === "listening" || phase === "thinking" || phase === "speaking" ? bargeIn || phase !== "speaking" : false;

  return (
    <Overlay title="Panggilan suara" onClose={() => (active ? void end().then(onClose) : onClose())}>
      {!SR && (
        <div className="stack" role="alert">
          <p>Browser ini belum mendukung pengenalan suara. Coba Chrome atau Edge terbaru di Android/desktop, atau gunakan chat teks.</p>
        </div>
      )}
      {SR && phase === "consent" && (
        <div className="stack">
          <p><strong>Sebelum menelepon Sawala</strong></p>
          <ul>
            <li>Sawala adalah AI. Ia bisa salah, dan bukan layanan darurat atau tenaga kesehatan.</li>
            <li>Mikrofon aktif selama panggilan dan selalu ada penanda &quot;Mikrofon aktif&quot; di layar.</li>
            <li>Pengenalan suara dilakukan oleh <strong>browser kamu</strong>. Tergantung browser (mis. Chrome), audio bisa dikirim ke layanan pengenalan suara milik pembuat browser. Server Sawala <strong>tidak pernah menerima atau menyimpan audio</strong>; yang dikirim hanya teks hasil transkripsi.</li>
            <li>Suara Sawala dibuat oleh browser/perangkatmu.</li>
            <li>Durasi maksimum {maxMin} menit per panggilan.</li>
          </ul>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>Simpan transkrip panggilan ini di riwayat (dan izinkan Sawala membuat memori darinya jika memori aktif). <em>Jika tidak dicentang</em>, teks hanya dipakai sementara selama panggilan dan dihapus saat panggilan berakhir.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={bargeIn} onChange={(e) => setBargeIn(e.target.checked)} />
            <span>Boleh memotong Sawala saat ia berbicara. Aktifkan hanya jika memakai headphone; dengan speaker, suara Sawala bisa terdengar sebagai ucapanmu.</span>
          </label>
          {error && <div role="alert" style={{ color: "var(--danger)" }}>{error}</div>}
          <div className="row"><span className="spacer" /><button className="btn" onClick={onClose}>Batal</button><button className="btn primary" onClick={start}>Mulai panggilan</button></div>
        </div>
      )}
      {SR && phase !== "consent" && (
        <div className="call stack">
          <div className="row">
            <span className={`mic-indicator ${micOn ? "on" : "off"}`} role="status">
              <span aria-hidden="true">{micOn ? "●" : "○"}</span> {micOn ? "Mikrofon aktif" : phase === "ended" ? "Mikrofon mati" : "Mikrofon tidak merekam"}
            </span>
            <span className="spacer" />
            <span aria-label={`Durasi ${mm} menit ${ss} detik`}>{mm}:{ss}</span>
          </div>
          <p className="call-status" role="status" aria-live="polite">{LABEL[phase]}</p>
          <div className="captions" aria-live="polite" aria-label="Teks percakapan">
            {youSaid && <p><strong>Kamu:</strong> {youSaid}</p>}
            {sawalaSaid && <p><strong>Sawala:</strong> {sawalaSaid}</p>}
          </div>
          {error && <div className="banner" role="alert"><span>{error}</span></div>}
          {phase !== "ended" && (
            <div className="row wrap">
              <button className="btn" onClick={toggleMute} disabled={phase === "thinking" || phase === "starting"} aria-pressed={phase === "muted"}>
                {phase === "muted" ? "Nyalakan mikrofon" : "Matikan mikrofon"}
              </button>
              <span className="spacer" />
              <button className="btn danger" onClick={() => void end()}>Akhiri panggilan</button>
            </div>
          )}
          {phase === "ended" && <button className="btn primary" onClick={onClose}>Tutup</button>}
        </div>
      )}
    </Overlay>
  );
}
