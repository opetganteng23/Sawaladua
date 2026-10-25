import { useState } from "react";
import { api } from "../api";
import { DataTable, type Column } from "./DataTable";
import { Badge } from "./UsersPage";
import { fmtDate, useDebounced, usePagedList } from "./usePagedList";

interface Invite { id: string; email: string; role: "user" | "admin"; createdBy: string; createdAt: string; usedAt: string | null }

export function InvitesPage({ actorRole }: { actorRole: "owner" | "admin" }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const dq = useDebounced(q);
  const { data, loading, error, reload } = usePagedList<Invite>("/api/admin/invites", { q: dq, page, limit: 20, dir });

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(""); setOk("");
    try { await api("POST", "/api/admin/invites", { email, role }); setOk(`Undangan untuk ${email} dibuat.`); setEmail(""); setRole("user"); setPage(1); await reload(); }
    catch (x) { setErr((x as Error).message); }
  };
  const remove = async (i: Invite) => {
    setErr(""); setOk("");
    try { await api("DELETE", `/api/admin/invites/${i.id}`); setOk(`Undangan ${i.email} dicabut.`); await reload(); } catch (x) { setErr((x as Error).message); }
  };

  const cols: Column<Invite>[] = [
    { key: "email", header: "Email", render: (i) => <strong>{i.email}</strong> },
    { key: "role", header: "Peran", render: (i) => <Badge tone={i.role === "admin" ? "info" : "muted"}>{i.role === "admin" ? "Admin" : "Pengguna"}</Badge> },
    { key: "createdBy", header: "Diundang oleh" },
    { key: "createdAt", header: "Dibuat", sortable: true, render: (i) => fmtDate(i.createdAt) },
    { key: "usedAt", header: "Status", render: (i) => (i.usedAt ? <Badge tone="ok">Sudah dipakai {fmtDate(i.usedAt)}</Badge> : <Badge tone="warn">Menunggu</Badge>) },
  ];

  return (
    <section aria-labelledby="h-inv">
      <h1 id="h-inv">Undangan</h1>
      <p className="muted">Undangan memberi akses ke email tertentu, termasuk saat pendaftaran ditutup. Peran admin hanya bisa diberikan oleh pemilik.</p>
      <form className="card-form" onSubmit={add} aria-label="Buat undangan">
        <label className="field">Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nama@contoh.com" /></label>
        <label className="field">Peran
          <select value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}><option value="user">Pengguna</option>{actorRole === "owner" && <option value="admin">Admin</option>}</select></label>
        <button className="btn primary" type="submit">Buat undangan</button>
      </form>
      {err && <div role="alert" className="banner">{err}</div>}
      {ok && <div role="status" className="muted">{ok}</div>}
      <div className="toolbar"><label className="field">Cari<input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Email" /></label></div>
      <DataTable
        caption="Daftar undangan" columns={cols} rows={data.items} rowKey={(i) => i.id} total={data.total} page={data.page} pages={data.pages} limit={data.limit}
        loading={loading} error={error} sort={{ key: "createdAt", dir }} onSort={() => { setDir((d) => (d === "asc" ? "desc" : "asc")); setPage(1); }} onPage={setPage} empty="Belum ada undangan."
        actions={(i) => <button className="btn danger" onClick={() => void remove(i)} aria-label={`Cabut undangan ${i.email}`} disabled={i.role === "admin" && actorRole !== "owner"}>Cabut</button>}
      />
    </section>
  );
}
