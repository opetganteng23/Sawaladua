import { useState } from "react";

export function ChatComposer({ busy, onSend, disclaimer }: { busy: boolean; onSend: (text: string) => void; disclaimer?: string }) {
  const [text, setText] = useState("");
  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    onSend(t);
  };
  return (
    <div className="composer">
      <form onSubmit={submit}>
        <label className="sr-only" htmlFor="msg">Tulis pesan</label>
        <textarea
          id="msg" rows={1} value={text} placeholder="Tulis pesan…" maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
        />
        <button className="btn primary" type="submit" disabled={busy || !text.trim()} aria-label="Kirim pesan">Kirim</button>
      </form>
      <p className="disclaimer">{disclaimer ?? "Sawala adalah AI, bisa salah, dan bukan pengganti bantuan profesional. Dalam keadaan darurat, hubungi layanan darurat setempat."}</p>
    </div>
  );
}
