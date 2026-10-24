/** Pesan informasi non-error (mis. sapaan opsional). Bisa ditutup. */
export function StatusMessage({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="banner info" role="note">
      <span>{text}</span><span className="spacer" />
      <button className="btn ghost" onClick={onClose} aria-label="Tutup sapaan">Tutup</button>
    </div>
  );
}
