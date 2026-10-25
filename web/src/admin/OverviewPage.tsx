import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtNum } from "./usePagedList";
import type { Usage } from "./MetricsPage";

interface Counts { total: number }
interface Flags { effective: Record<string, boolean>; killed: string[] }

/** Ringkasan cepat: angka kunci dan jalan pintas ke bagian yang sering dipakai. */
export function OverviewPage({ nav }: { nav: (section: string) => void }) {
  const [users, setUsers] = useState<number | null>(null);
  const [suspended, setSuspended] = useState<number | null>(null);
  const [invites, setInvites] = useState<number | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [flags, setFlags] = useState<Flags | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const [u, s, i, m, f] = await Promise.all([
          api<Counts>("GET", "/api/admin/users?limit=1"), api<Counts>("GET", "/api/admin/users?limit=1&status=suspended"),
          api<Counts>("GET", "/api/admin/invites?limit=1"), api<Usage>("GET", "/api/admin/usage?days=1"), api<Flags>("GET", "/api/admin/flags"),
        ]);
        setUsers(u.total); setSuspended(s.total); setInvites(i.total); setUsage(m); setFlags(f);
      } catch (e) { setErr((e as Error).message); }
    })();
  }, []);

  const today = usage?.daily.at(-1);
  const killed = flags?.killed.length ?? 0;
  const cards: { label: string; value: string; go: string; hint?: string }[] = [
    { label: "Pengguna", value: users === null ? "…" : fmtNum(users), go: "users", hint: suspended ? `${suspended} ditangguhkan` : undefined },
    { label: "Undangan", value: invites === null ? "…" : fmtNum(invites), go: "invites" },
    { label: "Request hari ini", value: today ? fmtNum(today.requests) : "0", go: "metrics", hint: today ? `error ${(today.errorRate * 100).toFixed(1)}%` : undefined },
    { label: "Token hari ini", value: today ? fmtNum(today.inputTokens + today.outputTokens) : "0", go: "metrics" },
    { label: "Fitur dimatikan operator", value: String(killed), go: "features", hint: killed ? (flags?.killed.join(", ") ?? "") : "semua sesuai konfigurasi" },
  ];

  return (
    <section aria-labelledby="h-ov">
      <h1 id="h-ov">Ringkasan</h1>
      {err && <div role="alert" className="banner">{err}</div>}
      <ul className="cards" aria-label="Angka kunci">
        {cards.map((c) => (
          <li key={c.label} className="stat">
            <span className="stat-label">{c.label}</span>
            <span className="stat-value">{c.value}</span>
            {c.hint && <span className="muted">{c.hint}</span>}
            <button className="btn ghost" onClick={() => nav(c.go)} aria-label={`Buka ${c.label}`}>Buka</button>
          </li>
        ))}
      </ul>
      <h2>Jalan pintas</h2>
      <div className="row wrap">
        <button className="btn" onClick={() => nav("users")}>Kelola pengguna</button>
        <button className="btn" onClick={() => nav("settings")}>Pengaturan situs</button>
        <button className="btn" onClick={() => nav("providers")}>Ganti provider AI</button>
        <button className="btn" onClick={() => nav("audit")}>Log audit</button>
      </div>
    </section>
  );
}
