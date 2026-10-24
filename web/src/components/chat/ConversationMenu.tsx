import type { Conversation } from "../../api";

/** Satu entri riwayat beserta aksinya (buka, hapus). */
export function ConversationMenu({ conv, active, onOpen, onDelete }: { conv: Conversation; active: boolean; onOpen: () => void; onDelete: () => void }) {
  return (
    <li className="conv-item" aria-current={active}>
      <button className="open" onClick={onOpen} title={conv.title}>{conv.ephemeral ? "⏳ " : ""}{conv.title}</button>
      <button className="icon-btn" aria-label={`Hapus percakapan ${conv.title}`} onClick={onDelete}>🗑</button>
    </li>
  );
}
