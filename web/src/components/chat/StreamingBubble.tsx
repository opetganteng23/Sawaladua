/** Bubble yang sedang diisi oleh stream. Wadahnya disembunyikan dari pembaca layar agar tidak mengumumkan tiap potongan; hasil final diumumkan lewat daftar pesan. */
export function StreamingBubble({ text }: { text: string }) {
  return <div className="bubble sawala">{text}</div>;
}
