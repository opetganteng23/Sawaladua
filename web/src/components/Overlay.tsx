import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';

/** Dialog/drawer aksesibel: fokus masuk, Esc menutup, Tab terjebak di dalam, fokus kembali ke pemicu. */
export function Overlay({ title, onClose, children, kind = "drawer" }: { title: string; onClose: () => void; children: ReactNode; kind?: "drawer" | "modal" }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab" && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    // Dialog modal: sisa halaman dibuat inert (tidak bisa difokus/dibaca pembaca layar) selama dialog terbuka.
    const top = kind === "drawer" ? ref.current : ref.current?.parentElement;
    const host = top?.parentElement;
    const made: HTMLElement[] = [];
    host?.childNodes.forEach((node) => {
      if (!(node instanceof HTMLElement) || node === top) return;
      if (node.classList.contains("drawer-backdrop") || node.classList.contains("drawer") || node.classList.contains("modal")) return;
      if (!node.hasAttribute("inert")) { node.setAttribute("inert", ""); made.push(node); }
    });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      made.forEach((n) => n.removeAttribute("inert"));
      prev?.focus();
    };
  }, []);

  const inner = (
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={kind === "drawer" ? "drawer" : "card"}>
      {kind === "drawer" ? (
        <>
          <div className="header">
            <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{title}</h2>
            <span className="spacer" />
            <button className="icon-btn" aria-label="Tutup" onClick={onClose}>✕</button>
          </div>
          <div className="drawer-body">{children}</div>
        </>
      ) : children}
    </div>
  );
  return kind === "drawer" ? (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      {inner}
    </>
  ) : (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>{inner}</div>
  );
}

export function Confirm({ title, body, confirmLabel, danger, onConfirm, onCancel, children }: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; children?: ReactNode;
}) {
  return (
    <Overlay kind="modal" title={title} onClose={onCancel}>
      <h2>{title}</h2>
      <div className="stack">
        <div>{body}</div>
        {children}
        <div className="row">
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>Batal</button>
          <button className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </Overlay>
  );
}
