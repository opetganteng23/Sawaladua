export function ErrorBanner({ text, retryable, onRetry, onClose }: { text: string; retryable: boolean; onRetry: () => void; onClose: () => void }) {
  return (
    <div className="banner" role="alert">
      <span>{text}</span><span className="spacer" />
      {retryable && <button className="btn" onClick={onRetry}>Coba lagi</button>}
      <button className="btn ghost" onClick={onClose} aria-label="Tutup pesan error">✕</button>
    </div>
  );
}
