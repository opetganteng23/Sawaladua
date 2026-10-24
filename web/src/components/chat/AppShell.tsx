import type { ReactNode } from "react";

/** Kerangka aplikasi: sidebar riwayat + area percakapan (+ panel yang ditumpuk di atasnya). */
export function AppShell({ children }: { children: ReactNode }) {
  return <div className="shell">{children}</div>;
}
