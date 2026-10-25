import { useCallback, useEffect, useState } from "react";
import { api, type Mood, type SessionInfo, type User } from "./api";
import { AdminApp } from "./admin/AdminApp";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { Onboarding } from "./components/Onboarding";

interface DeletionView { status: string; steps: { name: string; status: string }[]; notice: string }

export function App() {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [mood, setMood] = useState<Mood>("hangat");
  const [error, setError] = useState("");
  const [deletion, setDeletion] = useState<{ token: string; view: DeletionView | null } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<SessionInfo>("GET", "/api/auth/session");
      setInfo(s); setUser(s.user); setError("");
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (info?.site?.name) document.title = info.site.name; }, [info?.site?.name]);

  // Tema & mood diterapkan lewat atribut data (token CSS), bukan warna hard-coded di komponen.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = user?.preferences.theme ?? "terang";
    const on = Boolean(user?.preferences.moodThemes && info?.features.moodThemes);
    root.dataset.moodtheme = on ? "on" : "off";
    root.dataset.mood = mood;
  }, [user, info, mood]);

  // Pantau status penghapusan akun sampai selesai.
  useEffect(() => {
    if (!deletion || deletion.view?.status === "completed") return;
    const t = setInterval(async () => {
      try {
        const v = await api<DeletionView>("GET", `/api/deletion-status?token=${encodeURIComponent(deletion.token)}`);
        setDeletion({ token: deletion.token, view: v });
      } catch { /* coba lagi pada interval berikutnya */ }
    }, 2000);
    return () => clearInterval(t);
  }, [deletion]);

  if (deletion) {
    const v = deletion.view;
    return (
      <main className="center"><div className="card stack">
        <h1>Penghapusan akun</h1>
        <p role="status">{v?.status === "completed" ? "Penghapusan data aktif selesai." : "Penghapusan sedang diproses. Mohon tunggu…"}</p>
        {v && <ul>{v.steps.map((s) => <li key={s.name}>{s.name}: {s.status === "done" ? "selesai" : s.status === "failed" ? "gagal, akan dicoba lagi" : "menunggu"}</li>)}</ul>}
        <p className="muted">{v?.notice ?? "Salinan di backup dan sistem pihak ketiga mengikuti jadwal retensi di kebijakan privasi."}</p>
        {v?.status === "completed" && <button className="btn primary" onClick={() => { setDeletion(null); setUser(null); void refresh(); }}>Kembali</button>}
      </div></main>
    );
  }

  if (error && !info) return <main className="center"><div className="card stack" role="alert"><h1>Sawala</h1><p>{error}</p><button className="btn primary" onClick={refresh}>Coba lagi</button></div></main>;
  if (!info) return <main className="center"><p role="status">Memuat…</p></main>;
  if (!user) return <Login info={info} onLogin={(u) => setUser(u)} />;
  if (info.site?.maintenance.enabled && !user.isAdmin) {
    return (
      <main className="center"><div className="card stack" role="status">
        <h1>{info.site.name}</h1>
        <p>{info.site.maintenance.message}</p>
        {info.site.supportEmail && <p className="muted">Bantuan: <a href={`mailto:${info.site.supportEmail}`}>{info.site.supportEmail}</a></p>}
        <button className="btn" onClick={() => void refresh()}>Coba lagi</button>
      </div></main>
    );
  }
  if (!user.onboardingDone || !user.ageConfirmed) return <Onboarding user={user} features={info.features} onDone={setUser} />;

  if (user.isAdmin && /^\/admin(\/|$)/.test(window.location.pathname)) return <AdminApp user={user} siteName={info.site?.name ?? "Sawala"} />;

  return (
    <Chat
      user={user} features={info.features} site={info.site} onUser={setUser} onMood={setMood}
      onLogout={async () => { await api("POST", "/api/auth/logout").catch(() => undefined); setUser(null); setMood("hangat"); }}
      onDeleted={(token) => { setUser(null); setDeletion({ token, view: null }); }}
    />
  );
}
