const LINES = ["Lagi pengin cerita tentang apa?", "Kamu boleh mulai dari hal kecil.", "Kalau belum tahu mau mulai dari mana, nggak apa-apa."];

export function EmptyState() {
  return (
    <div className="empty">
      <h2>{LINES[0]}</h2>
      <p>{LINES[1]}</p>
      <p>{LINES[2]}</p>
    </div>
  );
}
