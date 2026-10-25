import { useState } from "react";
import { DataTable, type Column } from "./DataTable";
import { fmtDate, useDebounced, usePagedList } from "./usePagedList";

interface Entry { id: string; at: string; actor: string; action: string; target: string; detail: Record<string, unknown>; ip: string }

const ACTIONS = ["", "user.", "invite.", "settings.", "providers.", "flags.", "embedding."];
const LABEL: Record<string, string> = { "": "Semua tindakan", "user.": "Pengguna", "invite.": "Undangan", "settings.": "Pengaturan situs", "providers.": "Provider AI", "flags.": "Kill switch fitur", "embedding.": "Embedding" };

const summary = (d: Record<string, unknown>) =>
  Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? (v.length ? v.join(", ") : "-") : typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ");

export function AuditPage() {
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const dq = useDebounced(q);
  const { data, loading, error } = usePagedList<Entry>("/api/admin/audit", { q: dq, action, page, limit: 25, dir });

  const cols: Column<Entry>[] = [
    { key: "at", header: "Waktu", sortable: true, render: (e) => fmtDate(e.at) },
    { key: "actor", header: "Admin" },
    { key: "action", header: "Tindakan", render: (e) => <code>{e.action}</code> },
    { key: "target", header: "Sasaran" },
    { key: "detail", header: "Rincian", render: (e) => <span className="muted">{summary(e.detail) || "-"}</span> },
    { key: "ip", header: "IP" },
  ];
  return (
    <section aria-labelledby="h-audit">
      <h1 id="h-audit">Log audit</h1>
      <p className="muted">Setiap tindakan admin dicatat (siapa, kapan, apa). Rahasia seperti kunci API dan isi percakapan tidak pernah dicatat. Disimpan 365 hari.</p>
      <div className="toolbar" role="search" aria-label="Filter log audit">
        <label className="field">Cari admin / sasaran<input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></label>
        <label className="field">Jenis<select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>{ACTIONS.map((a) => <option key={a} value={a}>{LABEL[a]}</option>)}</select></label>
      </div>
      <DataTable caption="Log audit tindakan admin" columns={cols} rows={data.items} rowKey={(e) => e.id} total={data.total} page={data.page} pages={data.pages} limit={data.limit}
        loading={loading} error={error} sort={{ key: "at", dir }} onSort={() => { setDir((d) => (d === "asc" ? "desc" : "asc")); setPage(1); }} onPage={setPage} empty="Belum ada tindakan tercatat." />
    </section>
  );
}
