import type { Conversation, Features, SearchHit, SimilarHit, User } from "../../api";
import { ConversationMenu } from "./ConversationMenu";

interface Props {
  open: boolean; user: User; features: Features; convs: Conversation[]; active: string | null; hasMore: boolean;
  q: string; hits: SearchHit[] | null; similar: SimilarHit[];
  onClose: () => void; onNew: () => void; onOpen: (id: string) => void; onDelete: (c: Conversation) => void; onMore: () => void;
  onQuery: (q: string) => void; onSearch: (e: React.FormEvent) => void;
  onCall: () => void; onMemory: () => void; onSettings: () => void; onLogout: () => void;
}

export function ConversationSidebar(p: Props) {
  return (
    <nav className={`sidebar ${p.open ? "open" : ""}`} aria-label="Riwayat percakapan">
      <div className="row">
        <strong style={{ fontSize: "1.2rem" }}>Sawala</strong><span className="spacer" />
        <button className="icon-btn menu-btn" aria-label="Tutup riwayat" onClick={p.onClose}>✕</button>
      </div>
      <button className="btn primary" onClick={p.onNew}>+ Percakapan baru</button>
      {p.features.voiceCalls && <button className="btn" onClick={p.onCall}>📞 Panggilan suara</button>}
      <form onSubmit={p.onSearch} role="search">
        <label className="sr-only" htmlFor="q">Cari percakapan</label>
        <input id="q" type="search" placeholder="Cari percakapan…" value={p.q} onChange={(e) => p.onQuery(e.target.value)} />
      </form>
      {p.hits ? (
        <div style={{ overflowY: "auto", flex: 1 }} aria-label="Hasil pencarian">
          {p.hits.length === 0 && p.similar.length === 0 && <p className="muted">Tidak ada hasil.</p>}
          {p.hits.map((h, i) => (
            <button key={i} className="hit" onClick={() => p.onOpen(h.conversationId)}><strong>{h.title}</strong><small>{h.snippet}</small></button>
          ))}
          {p.similar.length > 0 && <p className="muted" style={{ marginBottom: 0 }}>Mirip secara makna</p>}
          {p.similar.map((h) => (
            <button key={`s-${h.conversationId}`} className="hit" onClick={() => p.onOpen(h.conversationId)}><strong>{h.title}</strong><small>{h.snippet}</small></button>
          ))}
        </div>
      ) : (
        <ul>
          {p.convs.length === 0 && <li className="muted" style={{ padding: 8 }}>Belum ada percakapan.</li>}
          {p.convs.map((c) => <ConversationMenu key={c.id} conv={c} active={p.active === c.id} onOpen={() => p.onOpen(c.id)} onDelete={() => p.onDelete(c)} />)}
          {p.hasMore && <li><button className="btn ghost" onClick={p.onMore}>Muat percakapan lainnya</button></li>}
        </ul>
      )}
      <div className="row wrap">
        {p.features.longTermMemory && <button className="btn" onClick={p.onMemory}>Memori</button>}
        <button className="btn" onClick={p.onSettings}>Pengaturan</button>
        {p.user.isAdmin && <a className="btn" href="/admin">Metrik</a>}
        <button className="btn ghost" onClick={p.onLogout}>Keluar</button>
      </div>
    </nav>
  );
}
