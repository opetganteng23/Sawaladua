import { useEffect, useRef, useState } from "react";
import { api, ApiFail } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Overlay } from "../components/Overlay";
import { Toast } from "../components/Toast";
import { DataTable, type Column } from "./DataTable";
import { Badge } from "./UsersPage";
import { fmtDate } from "./usePagedList";

type Cap = "llm" | "embedding" | "stt" | "tts" | "realtime";
interface CapRow { capability: Cap; provider: string; model: string; voice?: string; dimensions?: number; source: "db" | "env"; envProvider: string }
type KeyInfo = { source: "db" | "env" | "none"; masked: string };
interface Reembed { status: "idle" | "running" | "completed" | "failed"; total: number; done: number; startedAt: string | null; finishedAt: string | null; startedBy: string | null }
interface View {
  capabilities: CapRow[]; keys: Record<"gemini" | "openai" | "anthropic", KeyInfo>; encryptionConfigured: boolean; mockAllowed: boolean;
  options: Record<Cap, string[]>; meta: { updatedAt: string | null; updatedBy: string | null }; embeddingTag: string;
  stale: { memories: number; summaries: number }; reembed: Reembed;
}
const CAP_LABEL: Record<Cap, string> = { llm: "Model bahasa (chat)", embedding: "Embedding (memori & pencarian makna)", stt: "Speech-to-text", tts: "Text-to-speech", realtime: "Suara realtime" };
const VENDOR_LABEL: Record<string, string> = { gemini: "Google Gemini", openai: "OpenAI", anthropic: "Anthropic", cascade: "Cascade (STT + LLM + TTS)", none: "Nonaktif", mock: "Mock (hanya uji)" };
const SOURCE: Record<string, string> = { db: "Dasbor", env: "Konfigurasi server", none: "Belum diisi" };

export function ProvidersPage({ isOwner }: { isOwner: boolean }) {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState("");
  const [edit, setEdit] = useState<CapRow | null>(null);
  const [keyFor, setKeyFor] = useState<"gemini" | "openai" | "anthropic" | null>(null);
  const [delKey, setDelKey] = useState<"gemini" | "openai" | "anthropic" | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => { try { setV(await api<View>("GET", "/api/admin/providers")); setErr(""); } catch (e) { setErr((e as Error).message); } };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (v?.reembed.status !== "running") return;
    timer.current = setInterval(() => void load(), 1500);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [v?.reembed.status]);

  if (err && !v) return <div role="alert" className="banner">{err}</div>;
  if (!v) return <p>Memuat…</p>;

  const test = async (cap: Cap) => {
    setTests((t) => ({ ...t, [cap]: "Menguji…" }));
    try {
      const r = await api<{ ok: boolean; ms?: number; detail?: string; error?: string }>("POST", "/api/admin/providers/test", { capability: cap });
      setTests((t) => ({ ...t, [cap]: r.ok ? `Berhasil (${r.ms} ms): ${r.detail}` : `Gagal: ${r.error}` }));
    } catch (e) { setTests((t) => ({ ...t, [cap]: `Gagal: ${(e as Error).message}` })); }
  };

  const cols: Column<CapRow>[] = [
    { key: "capability", header: "Kemampuan", render: (c) => <strong>{CAP_LABEL[c.capability]}</strong> },
    { key: "provider", header: "Provider", render: (c) => VENDOR_LABEL[c.provider] ?? c.provider },
    { key: "model", header: "Model", render: (c) => (c.model ? <code>{c.model}</code> : "-") },
    { key: "extra", header: "Rincian", render: (c) => (c.capability === "embedding" ? `${c.dimensions} dimensi` : c.voice ? `suara: ${c.voice}` : "-") },
    { key: "source", header: "Sumber", render: (c) => <Badge tone={c.source === "db" ? "info" : "muted"}>{SOURCE[c.source]}</Badge> },
    { key: "test", header: "Hasil uji", render: (c) => <span className="muted" role="status">{tests[c.capability] ?? "-"}</span> },
  ];
  const keyRows = (Object.keys(v.keys) as ("gemini" | "openai" | "anthropic")[]).map((id) => ({ id, ...v.keys[id] }));
  const keyCols: Column<(typeof keyRows)[number]>[] = [
    { key: "id", header: "Vendor", render: (k) => <strong>{VENDOR_LABEL[k.id]}</strong> },
    { key: "masked", header: "Kunci API", render: (k) => (k.masked ? <code>{k.masked}</code> : "-") },
    { key: "source", header: "Sumber", render: (k) => <Badge tone={k.source === "none" ? "warn" : k.source === "db" ? "info" : "muted"}>{SOURCE[k.source]}</Badge> },
  ];
  const re = v.reembed;
  const staleTotal = v.stale.memories + v.stale.summaries;

  return (
    <section aria-labelledby="h-prov">
      <h1 id="h-prov">Provider AI</h1>
      <p className="muted">Ganti provider, model, dan kunci tanpa restart. {isOwner ? "" : "Kamu bisa melihat konfigurasi; hanya pemilik yang boleh mengubahnya."} Base URL provider hanya bisa diatur lewat konfigurasi server (demi keamanan). Terakhir diubah: {v.meta.updatedAt ? `${fmtDate(v.meta.updatedAt)} oleh ${v.meta.updatedBy}` : "belum pernah"}.</p>
      {err && <div role="alert" className="banner">{err}</div>}

      <h2>Kemampuan</h2>
      <DataTable caption="Provider per kemampuan" columns={cols} rows={v.capabilities} rowKey={(c) => c.capability} total={v.capabilities.length} page={1} pages={1} limit={50} onPage={() => undefined}
        actions={isOwner ? (c) => (
          <div className="row wrap">
            <button className="btn" onClick={() => setEdit(c)} aria-label={`Ubah ${CAP_LABEL[c.capability]}`}>Ubah</button>
            <button className="btn" onClick={() => void test(c.capability)} aria-label={`Uji koneksi ${CAP_LABEL[c.capability]}`}>Uji koneksi</button>
          </div>
        ) : undefined} />

      <h2>Kunci API</h2>
      {!v.encryptionConfigured && <div className="banner" role="note">Penyimpanan kunci lewat dasbor belum aktif: server belum punya <code>SETTINGS_ENCRYPTION_KEY</code> (buat dengan <code>openssl rand -base64 32</code>). Kunci tetap bisa diisi lewat konfigurasi server.</div>}
      <p className="muted">Kunci disimpan terenkripsi, tidak pernah ditampilkan utuh, dan tidak masuk log audit. Kunci dari dasbor menggantikan kunci konfigurasi server.</p>
      <DataTable caption="Kunci API per vendor" columns={keyCols} rows={keyRows} rowKey={(k) => k.id} total={keyRows.length} page={1} pages={1} limit={50} onPage={() => undefined}
        actions={isOwner ? (k) => (
          <div className="row wrap">
            <button className="btn" disabled={!v.encryptionConfigured} onClick={() => setKeyFor(k.id)} aria-label={`${k.source === "db" ? "Ganti" : "Isi"} kunci ${VENDOR_LABEL[k.id]}`}>{k.source === "db" ? "Ganti" : "Isi"}</button>
            {k.source === "db" && <button className="btn danger" onClick={() => setDelKey(k.id)} aria-label={`Hapus kunci ${VENDOR_LABEL[k.id]} dari dasbor`}>Hapus</button>}
          </div>
        ) : undefined} />

      <h2>Embedding</h2>
      <div className="card">
        <p>Embedding aktif: <code>{v.embeddingTag}</code>.</p>
        {staleTotal === 0 && re.status !== "running" && <p className="muted">Semua memori dan ringkasan memakai embedding yang aktif.</p>}
        {staleTotal > 0 && re.status !== "running" && <p role="alert"><strong>{v.stale.memories} memori dan {v.stale.summaries} ringkasan</strong> masih memakai embedding lain, jadi belum dipakai untuk pencarian. Hitung ulang agar kembali berfungsi.</p>}
        {re.status === "running" && <p role="status">Menghitung ulang… {re.done} dari {re.total}<progress value={re.done} max={Math.max(1, re.total)} style={{ marginLeft: 8 }} /></p>}
        {re.status === "failed" && <p role="alert">Penghitungan ulang terakhir gagal. Periksa provider embedding lalu coba lagi.</p>}
        {re.status === "completed" && re.finishedAt && <p className="muted">Terakhir selesai: {fmtDate(re.finishedAt)} ({re.done} item).</p>}
        {isOwner && <button className="btn primary" disabled={re.status === "running" || staleTotal === 0} onClick={() => void api("POST", "/api/admin/reembed", {}).then(() => { setToast("Penghitungan ulang dimulai."); return load(); }).catch((e) => setErr((e as Error).message))}>Hitung ulang embedding</button>}
      </div>

      {edit && <EditProvider row={edit} view={v} onClose={() => setEdit(null)} onSaved={(nv) => { setV(nv); setEdit(null); setToast("Provider disimpan dan langsung dipakai."); }} />}
      {keyFor && <KeyDialog vendor={keyFor} onClose={() => setKeyFor(null)} onSaved={(nv) => { setV(nv); setKeyFor(null); setToast("Kunci disimpan (terenkripsi)."); }} />}
      {delKey && <ConfirmDialog title="Hapus kunci dari dasbor?" confirmLabel="Hapus" danger onCancel={() => setDelKey(null)}
        body={`Kunci ${VENDOR_LABEL[delKey]} di dasbor dihapus. Server kembali memakai kunci dari konfigurasi server (jika ada).`}
        onConfirm={() => { const k = delKey; setDelKey(null); void api<View>("PUT", "/api/admin/providers", { keys: { [k]: null } }).then((nv) => { setV(nv); setToast("Kunci dihapus."); }).catch((e) => setErr((e as Error).message)); }} />}
      {toast && <Toast text={toast} onDone={() => setToast("")} />}
    </section>
  );
}

function EditProvider({ row, view, onClose, onSaved }: { row: CapRow; view: View; onClose: () => void; onSaved: (v: View) => void }) {
  const [provider, setProvider] = useState(row.provider);
  const [model, setModel] = useState(row.model);
  const [voice, setVoice] = useState(row.voice ?? "");
  const [dims, setDims] = useState(row.dimensions ?? 256);
  const [err, setErr] = useState("");
  const [fields, setFields] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const options = [...view.options[row.capability], ...(view.mockAllowed ? ["mock"] : [])];
  const needsModel = provider !== "none" && provider !== "mock" && !(row.capability === "realtime" && provider === "cascade");

  const body = (confirmEmbedding: boolean) => {
    const base: Record<string, unknown> = { provider, model: needsModel ? model : "ok" };
    if (row.capability === "embedding") base.dimensions = Number(dims);
    if (row.capability === "tts" || row.capability === "realtime") base.voice = voice;
    return { providers: { [row.capability]: base }, ...(confirmEmbedding ? { confirmEmbeddingChange: true } : {}) };
  };
  const save = async (confirmEmbedding = false) => {
    setBusy(true); setErr(""); setFields([]);
    try { onSaved(await api<View>("PUT", "/api/admin/providers", body(confirmEmbedding))); }
    catch (e) {
      const f = e as ApiFail;
      if (f.code === "EMBEDDING_CHANGE_NEEDS_CONFIRM") setConfirm(true);
      else { setErr(f.message); setFields(f.fields.map((x) => x.message)); }
    }
    setBusy(false);
  };
  const resetEnv = async () => {
    setBusy(true);
    try { onSaved(await api<View>("PUT", "/api/admin/providers", { providers: { [row.capability]: null }, confirmEmbeddingChange: true })); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <Overlay title={`Ubah ${CAP_LABEL[row.capability]}`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {err && <div role="alert" className="banner">{err}{fields.length > 0 && <ul>{fields.map((f, i) => <li key={i}>{f}</li>)}</ul>}</div>}
        <label className="field">Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>{options.map((o) => <option key={o} value={o}>{VENDOR_LABEL[o] ?? o}</option>)}</select></label>
        {needsModel && <label className="field">Nama model<input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Salin dari dokumentasi vendor" required pattern="[A-Za-z0-9._:/\-]{1,100}" /><small className="muted">Huruf, angka, titik, titik dua, garis, dan slash. Nama model tidak ditanam di kode karena sering berubah.</small></label>}
        {row.capability === "embedding" && <label className="field">Dimensi<input type="number" min={8} max={3072} value={dims} onChange={(e) => setDims(Number(e.target.value))} /><small className="muted">Harus sama dengan dimensi Atlas Vector Search index jika dipakai.</small></label>}
        {(row.capability === "tts" || row.capability === "realtime") && provider !== "none" && provider !== "mock" && provider !== "cascade" && <label className="field">Suara (opsional)<input type="text" value={voice} onChange={(e) => setVoice(e.target.value)} /></label>}
        <div className="row wrap">
          <button type="button" className="btn ghost" disabled={busy || row.source === "env"} onClick={() => void resetEnv()}>Kembalikan ke konfigurasi server ({VENDOR_LABEL[row.envProvider] ?? row.envProvider})</button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Batal</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Menyimpan…" : "Simpan"}</button>
        </div>
      </form>
      {confirm && <ConfirmDialog title="Ganti model embedding?" confirmLabel="Ganti embedding" danger onCancel={() => setConfirm(false)}
        body="Memori dan ringkasan yang sudah ada dibuat dengan embedding lain, jadi tidak dipakai sampai dihitung ulang. Setelah ini, jalankan 'Hitung ulang embedding' dan (jika memakai Atlas Vector Search) buat ulang index dengan dimensi baru."
        onConfirm={() => { setConfirm(false); void save(true); }} />}
    </Overlay>
  );
}

function KeyDialog({ vendor, onClose, onSaved }: { vendor: "gemini" | "openai" | "anthropic"; onClose: () => void; onSaved: (v: View) => void }) {
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { onSaved(await api<View>("PUT", "/api/admin/providers", { keys: { [vendor]: secret } })); setSecret(""); }
    catch (x) { setErr((x as Error).message); }
    setBusy(false);
  };
  return (
    <Overlay title={`Kunci ${VENDOR_LABEL[vendor]}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {err && <div role="alert" className="banner">{err}</div>}
        <label className="field">Kunci API baru<input type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} minLength={8} required /></label>
        <p className="muted">Kunci dienkripsi sebelum disimpan dan tidak akan ditampilkan lagi (hanya 4 karakter terakhir). Jangan membagikan kunci lewat chat atau email.</p>
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Batal</button><button className="btn primary" disabled={busy}>{busy ? "Menyimpan…" : "Simpan kunci"}</button></div>
      </form>
    </Overlay>
  );
}
