import { useState } from "react";
import type { Memory } from "../api";

/** Satu memori beserta aksi pengguna: ubah, tandai salah/tidak relevan, lihat sumber, hapus. */
export function MemoryItem({ m, onSave, onFlag, onUnflag, onSources, onDelete }: {
  m: Memory; onSave: (content: string) => Promise<void>; onFlag: () => void; onUnflag: () => void; onSources: () => void; onDelete: () => void;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <article className="mem" aria-label={m.content}>
      {edit !== null ? (
        <form onSubmit={(e) => { e.preventDefault(); void onSave(edit).then(() => setEdit(null)); }} className="stack">
          <label className="sr-only" htmlFor={`e-${m.id}`}>Ubah memori</label>
          <textarea id={`e-${m.id}`} rows={3} maxLength={300} value={edit} onChange={(e) => setEdit(e.target.value)} />
          <div className="row"><button className="btn primary" type="submit">Simpan</button><button type="button" className="btn" onClick={() => setEdit(null)}>Batal</button></div>
        </form>
      ) : (
        <>
          <p style={{ margin: "0 0 8px", textDecoration: m.status === "flagged_wrong" ? "line-through" : "none" }}>{m.content}</p>
          <div className="row wrap">
            <span className="tag">{m.type === "episodic" ? "kejadian" : "fakta"}</span>
            {m.userConfirmed && <span className="tag">dikonfirmasi</span>}
            {m.status === "flagged_wrong" && <span className="tag">ditandai salah (tidak dipakai)</span>}
            {m.sensitivity === "sensitive" && <span className="tag">sensitif</span>}
          </div>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => setEdit(m.content)}>Ubah</button>
            {m.status === "flagged_wrong"
              ? <button className="btn" onClick={onUnflag}>Batalkan tanda</button>
              : <button className="btn" onClick={onFlag}>Salah / tidak relevan</button>}
            <button className="btn ghost" onClick={onSources}>Sumber</button>
            <button className="btn danger" onClick={onDelete} aria-label={`Hapus memori: ${m.content}`}>Hapus</button>
          </div>
        </>
      )}
    </article>
  );
}
