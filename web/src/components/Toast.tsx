import { useEffect } from "react";

/** Notifikasi singkat yang hilang sendiri; diumumkan sopan ke pembaca layar (role=status). */
export function Toast({ text, onDone, ms = 4000 }: { text: string; onDone: () => void; ms?: number }) {
  useEffect(() => {
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, [text, ms, onDone]);
  return <div className="toast" role="status">{text}</div>;
}
