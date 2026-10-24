import type { Mood } from "../../api";

/** Indikator mood berupa teks (tidak hanya warna) agar bisa dibaca semua pengguna. */
export function MoodIndicator({ mood }: { mood: Mood }) {
  return <span className="mood" role="status" aria-label={`Mood Sawala: ${mood}`}>Mood: {mood}</span>;
}
