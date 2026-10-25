import type { AppCtx } from "../context.js";

/** Bagian pengaturan situs yang aman dibuka untuk publik (menampilkan nama, teks UI, status pendaftaran/pemeliharaan). Tanpa rahasia. */
export function publicSite(ctx: AppCtx) {
  const s = ctx.settings.site();
  return {
    name: s.name, tagline: s.tagline, supportEmail: s.supportEmail, defaultTheme: s.defaultTheme, ui: s.ui,
    registrationOpen: s.access.registrationOpen, maintenance: s.access.maintenance,
    legal: { privacy: Boolean(s.legal.privacy), terms: Boolean(s.legal.terms) },
  };
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Render teks hukum buatan admin menjadi halaman HTML aman. Semua teks di-escape (tidak ada HTML dari admin);
 * markup sederhana: "# judul", "## subjudul", "- butir", baris kosong = paragraf.
 */
export function legalHtml(siteName: string, title: string, text: string): string {
  const out: string[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flushList = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`); list = []; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${esc(para.join(" "))}</p>`); para = []; } };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flushList(); flushPara(); }
    else if (line.startsWith("## ")) { flushList(); flushPara(); out.push(`<h2>${esc(line.slice(3))}</h2>`); }
    else if (line.startsWith("# ")) { flushList(); flushPara(); out.push(`<h1>${esc(line.slice(2))}</h1>`); }
    else if (line.startsWith("- ")) { flushPara(); list.push(line.slice(2)); }
    else { flushList(); para.push(line); }
  }
  flushList(); flushPara();
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} - ${esc(siteName)}</title>
<style>:root{color-scheme:light dark;--bg:#f6f1ea;--fg:#2b2420}@media(prefers-color-scheme:dark){:root{--bg:#16181d;--fg:#eceff4}}body{background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif;margin:0;padding:24px 16px}main{max-width:760px;margin:0 auto}a{color:inherit}</style></head>
<body><main><p><a href="/">&larr; Kembali ke ${esc(siteName)}</a></p>${out.some((o) => o.startsWith("<h1>")) ? "" : `<h1>${esc(title)}</h1>`}${out.join("\n")}</main></body></html>`;
}
