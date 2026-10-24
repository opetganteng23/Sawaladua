import { useCallback, useEffect, useState } from "react";
import { api, type Memory, type User } from "../api";
import { MemoryItem } from "./MemoryItem";
import { Overlay } from "./Overlay";

interface Detail extends Memory { sources: { messageId: string; excerpt: string; createdAt: string }[] }

export function MemoryPanel({ user, onUser, onClose }: { user: User; onUser: (u: User) => void; onClose: () => void }) {
  const [items, setItems] = useState<Memory[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [err, setErr] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [forgetQ, setForgetQ] = useState("");
  const [cands, setCands] = useState<{ id: string; content: string }[] | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Memory[]; enabled: boolean }>("GET", "/api/memories");
      setItems(r.items); setEnabled(r.enabled); setErr("");
    } catch (e) { setErr((e as Error).message); }
    setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); await load(); } catch (e) { setErr((e as Error).message); }
  };
  const toggle = async (on: boolean) => {
    try { onUser(await api<User>("PATCH", "/api/settings", { privacySettings: { longTermMemory: on } })); await load(); }
    catch (e) { setErr((e as Error).message); }
  };
  const findForget = async (e: React.FormEvent) => {
    e.preventDefault();
    try { setCands((await api<{ candidates: { id: string; content: string }[] }>("POST", "/api/memories/forget", { query: forgetQ })).candidates); }
    catch (x) { setErr((x as Error).message); }
  };

  const conflicts = items.filter((m) => m.status === "conflict");
  const byId = new Map(items.map((m) => [m.id, m]));
  const rest = items.filter((m) => m.status !== "conflict" && m.status !== "superseded");

  return (
    <Overlay title="Memori" onClose={onClose}>
      <div className="stack">
        <p className="muted">
          Ini hal-hal yang Sawala ingat agar obrolan nyambung. Bisa keliru, jadi kamu yang pegang kendali: ubah, tandai salah, atau hapus.
        </p>
        <p className="muted">Menghapus memori juga menghapus ringkasan sesi dari percakapan sumbernya agar informasinya tidak bertahan di sana. Riwayat chat tetap ada sampai kamu menghapus percakapannya.</p>
        <label className="check">
          <input type="checkbox" checked={user.privacySettings.longTermMemory} onChange={(e) => void toggle(e.target.checked)} />
          <span>Memori jangka panjang aktif {enabled ? "" : "(dinonaktifkan)"}. Mematikan ini menghentikan memori baru dan pemakaian memori; daftar di bawah tetap tersimpan sampai kamu hapus.</span>
        </label>
        {err && <div role="alert" style={{ color: "var(--danger)" }}>{err}</div>}

        {conflicts.map((c) => {
          const other = c.conflictWith ? byId.get(c.conflictWith) : undefined;
          return (
            <div key={c.id} className="mem conflict" role="group" aria-label="Informasi bertentangan">
              <strong>Mana yang benar?</strong>
              <p>Sawala menemukan dua informasi yang bertentangan dan tidak mau memilih sendiri.</p>
              {other && <button className="btn" onClick={() => act(() => api("PATCH", `/api/memories/${c.id}`, { action: "resolve", keep: "other" }))}>Lama: {other.content}</button>}
              <div style={{ height: 8 }} />
              <button className="btn" onClick={() => act(() => api("PATCH", `/api/memories/${c.id}`, { action: "resolve", keep: "this" }))}>Baru: {c.content}</button>
            </div>
          );
        })}

        <form onSubmit={findForget} className="row" role="search" aria-label="Minta Sawala melupakan">
          <label className="sr-only" htmlFor="fq">Lupakan tentang…</label>
          <input id="fq" type="text" value={forgetQ} onChange={(e) => { setForgetQ(e.target.value); setCands(null); }} placeholder="Lupakan tentang… (cari dulu)" />
          <button className="btn" disabled={forgetQ.trim().length < 2}>Cari</button>
        </form>
        {cands && (
          <div className="mem">
            {cands.length === 0 ? <p>Tidak ada memori yang cocok.</p> : (
              <>
                <p>Pilih yang mau dilupakan (tidak ada yang dihapus sebelum kamu konfirmasi):</p>
                {cands.map((c) => (
                  <div key={c.id} className="row" style={{ marginBottom: 6 }}>
                    <span style={{ flex: 1 }}>{c.content}</span>
                    <button className="btn danger" onClick={() => act(async () => { await api("POST", "/api/memories/forget", { ids: [c.id] }); setCands(cands.filter((x) => x.id !== c.id)); })}>Lupakan</button>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {loaded && rest.length === 0 && conflicts.length === 0 && <p>Belum ada memori tersimpan.</p>}
        {rest.map((m) => (
          <MemoryItem
            key={m.id} m={m}
            onSave={(content) => act(async () => { await api("PATCH", `/api/memories/${m.id}`, { content }); })}
            onFlag={() => act(() => api("PATCH", `/api/memories/${m.id}`, { action: "flag_wrong" }))}
            onUnflag={() => act(() => api("PATCH", `/api/memories/${m.id}`, { action: "unflag" }))}
            onSources={async () => { try { setDetail(await api<Detail>("GET", `/api/memories/${m.id}`)); } catch (e) { setErr((e as Error).message); } }}
            onDelete={() => act(() => api("DELETE", `/api/memories/${m.id}`))}
          />
        ))}
      </div>
      {detail && (
        <Overlay kind="modal" title="Sumber memori" onClose={() => setDetail(null)}>
          <h2>Sumber memori</h2>
          <p><em>{detail.content}</em></p>
          {detail.sources.length === 0 ? <p className="muted">Sumber sudah dihapus atau tidak tersedia.</p> : detail.sources.map((s) => <blockquote key={s.messageId} className="muted">&ldquo;{s.excerpt}&rdquo;</blockquote>)}
          <button className="btn" onClick={() => setDetail(null)}>Tutup</button>
        </Overlay>
      )}
    </Overlay>
  );
}
