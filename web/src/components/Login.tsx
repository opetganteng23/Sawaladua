import { useEffect, useRef, useState } from "react";
import { api, type SessionInfo, type User } from "../api";

declare global {
  interface Window {
    google?: { accounts: { id: { initialize(o: unknown): void; renderButton(el: HTMLElement, o: unknown): void } } };
  }
}

export function Login({ info, onLogin }: { info: SessionInfo; onLogin: (u: User) => void }) {
  const btn = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (!info.auth.google || !info.auth.clientId) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => {
      window.google?.accounts.id.initialize({
        client_id: info.auth.clientId,
        callback: async (resp: { credential: string }) => {
          try {
            const r = await api<{ user: User }>("POST", "/api/auth/google", { credential: resp.credential });
            onLogin(r.user);
          } catch (e) {
            setErr((e as Error).message);
          }
        },
      });
      if (btn.current) window.google?.accounts.id.renderButton(btn.current, { theme: "outline", size: "large", text: "continue_with", locale: "id" });
    };
    document.head.appendChild(s);
    return () => { s.remove(); };
  }, [info, onLogin]);

  const dev = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ user: User }>("POST", "/api/auth/dev", { email });
      onLogin(r.user);
    } catch (x) {
      setErr((x as Error).message);
    }
  };

  return (
    <main className="center">
      <div className="card stack">
        <h1>Sawala</h1>
        <p>
          Teman ngobrol berbasis AI untuk bercerita dan menyusun pikiran. Sawala adalah AI, bukan manusia, dan bukan
          pengganti psikolog, dokter, atau layanan darurat.
        </p>
        {info.auth.google ? <div ref={btn} /> : <p className="muted">Login Google belum dikonfigurasi di server ini.</p>}
        {info.auth.dev && (
          <form onSubmit={dev} className="stack" aria-label="Login pengembangan">
            <p className="muted">Mode pengembangan (hanya data uji, bukan untuk produksi).</p>
            <label className="field">
              Email uji
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="uji@contoh.com" />
            </label>
            <button className="btn primary" type="submit">Masuk (dev)</button>
          </form>
        )}
        <div role="alert" style={{ color: "var(--danger)" }}>{err}</div>
      </div>
    </main>
  );
}
