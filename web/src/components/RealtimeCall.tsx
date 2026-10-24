import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Features } from "../api";
import { RealtimeClient, type CallState } from "../voice/realtime";
import { Overlay } from "./Overlay";

const LABEL: Record<CallState, string> = {
  connecting: "Menyambungkan…", listening: "Mendengarkan", thinking: "Sawala sedang berpikir", speaking: "Sawala berbicara",
  safety: "Sawala memastikan kamu baik-baik saja", muted: "Mikrofon dimatikan", ended: "Panggilan berakhir",
};
const VENDOR: Record<string, string> = { gemini: "Google (Gemini)", openai: "OpenAI", cascade: "penyedia AI yang dikonfigurasi (pengenalan suara, model bahasa, dan suara)", mock: "penyedia uji" };

/** Panggilan suara realtime dua arah lewat server Sawala. Mikrofon aktif selalu ditandai dengan teks, bukan hanya warna. */
export function RealtimeCall({ features, onClose, onEnded }: { features: Features; onClose: () => void; onEnded: (kept: boolean) => void }) {
  const [phase, setPhase] = useState<"consent" | "live" | "ended">("consent");
  const [state, setState] = useState<CallState>("connecting");
  const [consent, setConsent] = useState(false);
  const [bargeIn, setBargeIn] = useState(false);
  const [error, setError] = useState("");
  const [youSaid, setYouSaid] = useState("");
  const [sawalaSaid, setSawalaSaid] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [maxMin, setMaxMin] = useState(30);
  const [kept, setKept] = useState(false);
  const client = useRef<RealtimeClient | null>(null);
  const callId = useRef<string | null>(null);
  const done = useRef(false);

  const vendor = VENDOR[features.realtimeProvider ?? ""] ?? "penyedia AI yang dikonfigurasi";

  const handleEnded = useCallback((info: { reason: string; transcriptKept: boolean }) => {
    done.current = true;
    setKept(info.transcriptKept);
    setPhase("ended");
    onEnded(info.transcriptKept);
  }, [onEnded]);

  const start = async () => {
    setError("");
    try {
      const r = await api<{ id: string }>("POST", "/api/calls", { transcriptConsent: consent });
      callId.current = r.id;
      const c = new RealtimeClient({
        onReady: (i) => { setMaxMin(i.maxMinutes); setPhase("live"); },
        onState: setState,
        onTranscript: (role, text, fin) => {
          if (role === "user") { setYouSaid(text); if (fin) setSawalaSaid(""); } else setSawalaSaid(text);
        },
        onError: (code, message) => setError(code === "QUOTA_EXHAUSTED" ? `${message}` : message),
        onEnded: handleEnded,
      });
      client.current = c;
      await c.start(r.id, bargeIn);
    } catch (e) {
      const msg = (e as Error).name === "NotAllowedError" ? "Izin mikrofon ditolak. Izinkan mikrofon di browser lalu coba lagi." : (e as Error).message;
      setError(msg);
      if (callId.current) void api("POST", `/api/calls/${callId.current}/end`, {}).catch(() => undefined);
      callId.current = null;
      client.current = null;
      setPhase("consent");
    }
  };

  const end = useCallback(() => { client.current?.end(); }, []);

  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => () => { // tutup dialog/pindah halaman: lepas mikrofon dan akhiri panggilan
    if (!done.current) client.current?.end();
  }, []);

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const micOn = phase === "live" && state !== "muted" && state !== "ended";

  return (
    <Overlay title="Panggilan suara" onClose={() => { if (phase === "live") { end(); } onClose(); }}>
      {phase === "consent" && (
        <div className="stack">
          <p><strong>Sebelum menelepon Sawala</strong></p>
          <ul>
            <li>Sawala adalah AI. Ia bisa salah, dan bukan layanan darurat atau tenaga kesehatan.</li>
            <li>Mikrofon aktif selama panggilan dan selalu ada penanda &quot;Mikrofon aktif&quot; di layar.</li>
            <li>Suaramu dikirim ke <strong>server Sawala</strong> lalu diteruskan ke <strong>{vendor}</strong> untuk diproses secara realtime. Sawala <strong>tidak menyimpan audio</strong> (hanya diproses di memori), tetapi penyedia AI memprosesnya sesuai ketentuan mereka.</li>
            <li>Karena Sawala berbicara langsung, pemeriksaan keselamatan dilakukan sambil berjalan. Bila ada tanda bahaya, Sawala menghentikan jawabannya dan mengambil jalur yang lebih hati-hati.</li>
            <li>Durasi maksimum {maxMin} menit per panggilan.</li>
          </ul>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>Simpan transkrip panggilan ini di riwayat (dan izinkan membuat memori darinya jika memori aktif). <em>Jika tidak dicentang</em>, teks hanya dipakai sementara dan dihapus saat panggilan berakhir.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={bargeIn} onChange={(e) => setBargeIn(e.target.checked)} />
            <span>Boleh memotong Sawala saat ia berbicara. Paling baik dengan headphone; dengan speaker, suara Sawala bisa tertangkap mikrofon.</span>
          </label>
          {error && <div role="alert" style={{ color: "var(--danger)" }}>{error}</div>}
          <div className="row"><span className="spacer" /><button className="btn" onClick={onClose}>Batal</button><button className="btn primary" onClick={start}>Mulai panggilan</button></div>
        </div>
      )}

      {phase === "live" && (
        <div className="call stack">
          <div className="row">
            <span className={`mic-indicator ${micOn ? "on" : "off"}`} role="status">
              <span aria-hidden="true">{micOn ? "●" : "○"}</span> {micOn ? "Mikrofon aktif" : "Mikrofon tidak merekam"}
            </span>
            <span className="spacer" />
            <span aria-label={`Durasi ${mm} menit ${ss} detik`}>{mm}:{ss}</span>
          </div>
          <p className="call-status" role="status" aria-live="polite">{LABEL[state]}</p>
          <div className="captions" aria-live="polite" aria-label="Teks percakapan">
            {youSaid && <p><strong>Kamu:</strong> {youSaid}</p>}
            {sawalaSaid && <p><strong>Sawala:</strong> {sawalaSaid}</p>}
          </div>
          {error && <div className="banner" role="alert"><span>{error}</span></div>}
          <div className="row wrap">
            <button className="btn" onClick={() => client.current?.setMuted(state !== "muted")} aria-pressed={state === "muted"}>
              {state === "muted" ? "Nyalakan mikrofon" : "Matikan mikrofon"}
            </button>
            {state === "speaking" && <button className="btn" onClick={() => client.current?.interrupt()}>Potong Sawala</button>}
            <span className="spacer" />
            <button className="btn danger" onClick={end}>Akhiri panggilan</button>
          </div>
        </div>
      )}

      {phase === "ended" && (
        <div className="stack">
          <p role="status">Panggilan berakhir. {kept ? "Transkrip tersimpan di riwayat." : "Teks sementara sudah dihapus."}</p>
          {error && <div className="banner" role="alert"><span>{error}</span></div>}
          <button className="btn primary" onClick={onClose}>Tutup</button>
        </div>
      )}
    </Overlay>
  );
}
