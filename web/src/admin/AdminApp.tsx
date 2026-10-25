import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { User } from "../api";
import { AuditPage } from "./AuditPage";
import { FeaturesPage } from "./FeaturesPage";
import { InvitesPage } from "./InvitesPage";
import { MetricsPage } from "./MetricsPage";
import { OverviewPage } from "./OverviewPage";
import { ProvidersPage } from "./ProvidersPage";
import { SettingsPage } from "./SettingsPage";
import { UsersPage } from "./UsersPage";
import "./admin.css";

type Section = "overview" | "users" | "invites" | "providers" | "settings" | "features" | "metrics" | "audit";
const SECTIONS: { id: Section; label: string; owner?: boolean }[] = [
  { id: "overview", label: "Ringkasan" }, { id: "users", label: "Pengguna" }, { id: "invites", label: "Undangan" },
  { id: "providers", label: "Provider AI" }, { id: "settings", label: "Pengaturan situs" }, { id: "features", label: "Fitur (kill switch)" },
  { id: "metrics", label: "Metrik" }, { id: "audit", label: "Log audit" },
];
const parse = (path: string): Section => {
  const seg = path.replace(/^\/admin\/?/, "").split("/")[0] ?? "";
  return (SECTIONS.find((s) => s.id === seg)?.id ?? "overview") as Section;
};

/** Dasbor admin: navigasi samping (tab di layar kecil), satu bagian per URL (/admin/users, /admin/settings, dst). */
export function AdminApp({ user, siteName }: { user: User; siteName: string }) {
  const [section, setSection] = useState<Section>(() => parse(window.location.pathname));
  const role = user.adminRole === "owner" ? "owner" : "admin";

  useEffect(() => {
    const onPop = () => setSection(parse(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => { document.title = `Dasbor admin - ${siteName}`; }, [siteName]);

  const go = useCallback((s: string) => {
    const id = parse(`/admin/${s}`);
    window.history.pushState(null, "", id === "overview" ? "/admin" : `/admin/${id}`);
    setSection(id);
    window.scrollTo?.({ top: 0 });
  }, []);

  const page: Record<Section, ReactNode> = {
    overview: <OverviewPage nav={go} />,
    users: <UsersPage actorRole={role} selfId={user.id} />,
    invites: <InvitesPage actorRole={role} />,
    providers: <ProvidersPage isOwner={role === "owner"} />,
    settings: <SettingsPage />,
    features: <FeaturesPage />,
    metrics: <MetricsPage />,
    audit: <AuditPage />,
  };

  return (
    <div className="admin">
      <a className="skip" href="#admin-main">Lewati ke konten</a>
      <header className="admin-top">
        <strong>{siteName}</strong><span className="muted"> / Dasbor admin</span>
        <span className="spacer" />
        <span className="badge info" title={user.email}>{role === "owner" ? "Pemilik" : "Admin"}</span>
        <a className="btn" href="/">Kembali ke aplikasi</a>
      </header>
      <div className="admin-body">
        <nav className="admin-nav" aria-label="Bagian dasbor">
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={s.id === "overview" ? "/admin" : `/admin/${s.id}`} aria-current={section === s.id ? "page" : undefined}
                  onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); go(s.id); }}>{s.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <main id="admin-main" tabIndex={-1}>{page[section]}</main>
      </div>
    </div>
  );
}
