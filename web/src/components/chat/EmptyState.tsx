const DEFAULT_LINES = ["Lagi pengin cerita tentang apa?", "Kamu boleh mulai dari hal kecil.", "Kalau belum tahu mau mulai dari mana, nggak apa-apa."];

/** Teks layar kosong dapat diubah admin (Pengaturan situs > Teks antarmuka). */
export function EmptyState({ lines = DEFAULT_LINES }: { lines?: string[] }) {
  const l = lines.length >= 3 ? lines : DEFAULT_LINES;
  return (
    <div className="empty">
      <h2>{l[0]}</h2>
      <p>{l[1]}</p>
      <p>{l[2]}</p>
    </div>
  );
}
