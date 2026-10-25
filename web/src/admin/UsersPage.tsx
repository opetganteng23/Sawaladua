import { useEffect, useState } from "react";
import { api, type ApiFail } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Overlay } from "../components/Overlay";
import { DataTable, type Column } from "./DataTable";
import { fmtDate, fmtNum, useDebounced, usePagedList } from "./usePagedList";

export interface UserRow {
  id: string; email: string; displayName: string; role: "owner" | "admin" | "user"; status: "active" | "suspended"; deletionStatus: string;
  createdAt: string; lastLoginAt: string | null; note: string; ageConfirmed: boolean;
  counts?: { conversations: number; messages: number; memories: number; tokens30d: number };
}
interface Detail extends UserRow { activeSessions: number; calls: number; lastDeletionJob: { status: string; requestedAt: string } | null }

const ROLE: Record<string, string> = { owner: "Pemilik", admin: "Admin", user: "Pengguna" };
export const Badge = ({ tone, children }: { tone: "ok" | "warn" | "info" | "muted"; children: React.ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;

export function UsersPage({ actorRole, selfId }: { actorRole: "owner" | "admin"; selfId: string }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "createdAt", dir: "desc" });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [open, setOpen] = useState<string | null>(null);
  const dq = useDebounced(q);
  const { data, loading, error, reload } = usePagedList<UserRow>("/api/admin/users", { q: dq, status, role, sort: sort.key, dir: sort.dir, page, limit });

  const cols: Column<UserRow>[] = [
    { key: "email", header: "Pengguna", sortable: true, render: (u) => <><strong>{u.email}</strong><br /><span className="muted">{u.displayName}</span></> },
    { key: "role", header: "Peran", render: (u) => <Badge tone={u.role === "user" ? "muted" : "info"}>{ROLE[u.role]}</Badge> },
    { key: "status", header: "Status", render: (u) => (u.deletionStatus === "deletion_pending" ? <Badge tone="warn">Dihapus…</Badge> : <Badge tone={u.status === "active" ? "ok" : "warn"}>{u.status === "active" ? "Aktif" : "Ditangguhkan"}</Badge>) },
    { key: "createdAt", header: "Dibuat", sortable: true, render: (u) => <span className="nowrap">{fmtDate(u.createdAt)}</span> },
    { key: "lastLoginAt", header: "Login terakhir", sortable: true, render: (u) => <span className="nowrap">{fmtDate(u.lastLoginAt)}</span> },
    { key: "activity", header: "Percakapan / pesan / memori", align: "right", render: (u) => <span className="nowrap">{fmtNum(u.counts?.conversations ?? 0)} / {fmtNum(u.counts?.messages ?? 0)} / {fmtNum(u.counts?.memories ?? 0)}</span> },
    { key: "tok", header: "Token 30 hari", align: "right", render: (u) => fmtNum(u.counts?.tokens30d ?? 0) },
  ];
  const toggleSort = (key: string) => { setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" })); setPage(1); };

  return (
    <section aria-labelledby="h-users">
      <h1 id="h-users">Pengguna</h1>
      <p className="muted">Kelola akun. Admin tidak bisa membaca isi percakapan, memori, atau ringkasan; yang tampil hanya metadata dan hitungan.</p>
      <div className="toolbar" role="search" aria-label="Filter pengguna">
        <label className="field">Cari<input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Email atau nama" /></label>
        <label className="field">Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">Semua</option><option value="active">Aktif</option><option value="suspended">Ditangguhkan</option></select></label>
        <label className="field">Peran
          <select value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}><option value="">Semua</option><option value="owner">Pemilik</option><option value="admin">Admin</option><option value="user">Pengguna</option></select></label>
        <label className="field">Per halaman
          <select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>{[10, 20, 50, 100].map((n) => <option key={n}>{n}</option>)}</select></label>
      </div>
      <DataTable
        caption="Daftar pengguna" columns={cols} rows={data.items} rowKey={(u) => u.id} total={data.total} page={data.page} pages={data.pages} limit={data.limit}
        loading={loading} error={error} sort={sort} onSort={toggleSort} onPage={setPage} empty="Tidak ada pengguna yang cocok."
        actions={(u) => <button className="btn" onClick={() => setOpen(u.id)} aria-label={`Kelola ${u.email}`}>Kelola</button>}
      />
      {open && <UserDrawer id={open} actorRole={actorRole} selfId={selfId} onClose={() => setOpen(null)} onChanged={reload} />}
    </section>
  );
}

function UserDrawer({ id, actorRole, selfId, onClose, onChanged }: { id: string; actorRole: "owner" | "admin"; selfId: string; onClose: () => void; onChanged: () => void }) {
  const [u, setU] = useState<Detail | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");

  const load = async () => {
    try { const d = await api<Detail>("GET", `/api/admin/users/${id}`); setU(d); setName(d.displayName); setNote(d.note); }
    catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErr(""); setMsg("");
    try { await fn(); setMsg(ok); await load(); onChanged(); } catch (e) { setErr((e as ApiFail).message); }
    setBusy(false);
  };
  const patch = (body: object, ok: string) => act(() => api("PATCH", `/api/admin/users/${id}`, body), ok);

  const self = id === selfId;
  const targetIsOwner = u?.role === "owner";
  const needsOwner = u?.role === "admin" && actorRole !== "owner";
  const locked = self || targetIsOwner || needsOwner;

  return (
    <Overlay title={u ? `Kelola ${u.email}` : "Kelola pengguna"} onClose={onClose}>
      {err && <div role="alert" className="banner">{err}</div>}
      {msg && <div role="status" className="muted">{msg}</div>}
      {!u && !err && <p>Memuat…</p>}
      {u && (
        <div className="stack">
          <dl className="kv">
            <dt>Email</dt><dd>{u.email}</dd>
            <dt>Peran</dt><dd><Badge tone={u.role === "user" ? "muted" : "info"}>{ROLE[u.role]}</Badge></dd>
            <dt>Status</dt><dd><Badge tone={u.status === "active" ? "ok" : "warn"}>{u.status === "active" ? "Aktif" : "Ditangguhkan"}</Badge></dd>
            <dt>Dibuat</dt><dd>{fmtDate(u.createdAt)}</dd>
            <dt>Login terakhir</dt><dd>{fmtDate(u.lastLoginAt)}</dd>
            <dt>Sesi aktif</dt><dd>{u.activeSessions}</dd>
            <dt>Panggilan suara</dt><dd>{u.calls}</dd>
            <dt>Percakapan / pesan / memori</dt><dd>{u.counts?.conversations} / {u.counts?.messages} / {u.counts?.memories}</dd>
            <dt>Token 30 hari</dt><dd>{fmtNum(u.counts?.tokens30d ?? 0)}</dd>
            <dt>Usia 18+ dikonfirmasi</dt><dd>{u.ageConfirmed ? "Ya" : "Belum"}</dd>
          </dl>
          {locked && <p className="muted">{self ? "Ini akunmu sendiri: status dan peran tidak bisa diubah di sini." : targetIsOwner ? "Pemilik layanan (ADMIN_EMAILS) hanya bisa diubah lewat konfigurasi server." : "Hanya pemilik yang boleh mengubah admin."}</p>}

          <form className="stack" onSubmit={(e) => { e.preventDefault(); void patch({ displayName: name, note }, "Tersimpan."); }}>
            <label className="field">Nama tampilan<input type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={targetIsOwner || needsOwner} /></label>
            <label className="field">Catatan internal (jangan isi data pribadi sensitif)<textarea rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <div><button className="btn primary" disabled={busy || targetIsOwner || needsOwner}>Simpan</button></div>
          </form>

          <div className="row wrap">
            {u.status === "active"
              ? <button className="btn danger" disabled={busy || locked} onClick={() => void patch({ status: "suspended" }, "Akun ditangguhkan dan semua sesi dicabut.")}>Tangguhkan</button>
              : <button className="btn" disabled={busy || locked} onClick={() => void patch({ status: "active" }, "Akun dipulihkan.")}>Pulihkan</button>}
            <button className="btn" disabled={busy || targetIsOwner} onClick={() => void act(() => api("POST", `/api/admin/users/${id}/revoke-sessions`, {}), "Semua sesi dicabut.")}>Cabut semua sesi</button>
            {actorRole === "owner" && !locked && (
              <label className="field inline">Peran
                <select value={u.role} onChange={(e) => void patch({ role: e.target.value }, "Peran diubah.")} disabled={busy}><option value="user">Pengguna</option><option value="admin">Admin</option></select></label>
            )}
            <span className="spacer" />
            <button className="btn danger" disabled={busy || self || targetIsOwner || needsOwner} onClick={() => { setConfirmEmail(""); setDel(true); }}>Hapus pengguna…</button>
          </div>
        </div>
      )}
      {del && u && (
        <ConfirmDialog title="Hapus pengguna?" danger confirmLabel={busy ? "Menghapus…" : "Hapus permanen"} onCancel={() => setDel(false)}
          onConfirm={() => { if (confirmEmail.trim().toLowerCase() === u.email) { setDel(false); void act(() => api("DELETE", `/api/admin/users/${id}`, { confirmEmail }), "Penghapusan dimulai (berjalan di latar belakang)."); } }}
          body={<>Seluruh percakapan, memori, ringkasan, dan data akun <strong>{u.email}</strong> akan dihapus dan tidak bisa dikembalikan. Salinan di backup mengikuti retensi. Ketik email pengguna untuk melanjutkan.</>}>
          <label className="field">Email pengguna<input type="text" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} autoComplete="off" /></label>
        </ConfirmDialog>
      )}
    </Overlay>
  );
}
