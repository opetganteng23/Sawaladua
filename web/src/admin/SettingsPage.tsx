import { useEffect, useMemo, useState } from "react";
import { api, ApiFail, type FieldError } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Toast } from "../components/Toast";

type Site = {
  name: string; tagline: string; supportEmail: string; defaultTheme: string;
  ui: { emptyLines: string[]; disclaimer: string };
  legal: { privacy: string; terms: string };
  safety: { crisisResourcesText: string };
  persona: { extraInstructions: string };
  limits: Record<"dailyMessageLimit" | "maxMessageChars" | "maxOutputTokens" | "callMaxMinutes" | "chatRetentionDays" | "dailyTokenBudgetGlobal" | "dailyTokenBudgetPerUser", number | null>;
  costs: { inputPer1M: number | null; outputPer1M: number | null; currency: string | null };
  alerts: { webhookUrl: string; minIntervalMinutes: number | null; errorRateThreshold: number | null };
  voice: { safetyHoldMs: number | null };
  access: { registrationOpen: boolean; allowedEmailDomains: string[]; maintenance: { enabled: boolean; message: string } };
};
interface View {
  value: Site; defaults: Site; meta: { updatedAt: string | null; updatedBy: string | null };
  effective: Record<string, { value: unknown; envDefault: unknown; source: "db" | "env" }>;
  alertWebhookConfigured: boolean; crisisTextConfigured: boolean;
}

const THEMES = [["terang", "Terang"], ["gelap", "Gelap"], ["senja", "Senja"], ["hutan", "Hutan"], ["sakura", "Sakura"]];
const LIMITS: [keyof Site["limits"], string, string][] = [
  ["dailyMessageLimit", "Batas pesan per pengguna per 24 jam", "limits.dailyMessageLimit"],
  ["maxMessageChars", "Panjang maksimum satu pesan (karakter)", "limits.maxMessageChars"],
  ["maxOutputTokens", "Token keluaran maksimum per balasan", "limits.maxOutputTokens"],
  ["callMaxMinutes", "Durasi maksimum panggilan suara (menit)", "limits.callMaxMinutes"],
  ["chatRetentionDays", "Retensi riwayat chat (hari; 0 = sampai dihapus pengguna)", "limits.chatRetentionDays"],
  ["dailyTokenBudgetGlobal", "Anggaran token harian, seluruh layanan (0 = nonaktif)", "limits.dailyTokenBudgetGlobal"],
  ["dailyTokenBudgetPerUser", "Anggaran token harian per pengguna (0 = nonaktif)", "limits.dailyTokenBudgetPerUser"],
];

function Field({ errors, path, label, children, hint }: { errors: FieldError[]; path: string; label: string; children: React.ReactNode; hint?: string }) {
  const msg = errors.find((e) => e.path === path || e.path.startsWith(path + "."))?.message;
  return (
    <div className={`field ${msg ? "invalid" : ""}`}>
      <label>{label}{children}</label>
      {hint && <small className="muted">{hint}</small>}
      {msg && <small role="alert" className="err">{msg}</small>}
    </div>
  );
}
function Head({ id, title, section, onReset }: { id: string; title: string; section: string; onReset: (s: string) => void }) {
  return <div className="row"><h2 id={id} style={{ margin: 0 }}>{title}</h2><span className="spacer" /><button type="button" className="btn ghost" onClick={() => onReset(section)}>Kembalikan ke bawaan</button></div>;
}

/** Pengaturan situs: semua yang dulu hard-code dapat diubah di sini; berlaku seketika tanpa restart. */
export function SettingsPage() {
  const [view, setView] = useState<View | null>(null);
  const [form, setForm] = useState<Site | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState("");
  const [saving, setSaving] = useState(false);
  const [reset, setReset] = useState<string | null>(null);

  const load = async () => {
    try { const v = await api<View>("GET", "/api/admin/settings"); setView(v); setForm(structuredClone(v.value)); setErr(""); }
    catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);

  const dirty = useMemo(() => Boolean(view && form && JSON.stringify(view.value) !== JSON.stringify(form)), [view, form]);
  if (err && !view) return <div role="alert" className="banner">{err}</div>;
  if (!view || !form) return <p>Memuat…</p>;

  const set = (fn: (s: Site) => void) => setForm((cur) => { const n = structuredClone(cur!); fn(n); return n; });
  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr(""); setErrors([]);
    try { const v = await api<View>("PUT", "/api/admin/settings", { value: form }); setView(v); setForm(structuredClone(v.value)); setToast("Pengaturan disimpan dan langsung berlaku."); }
    catch (x) { const f = x as ApiFail; setErr(f.message); setErrors(f.fields ?? []); }
    setSaving(false);
  };
  const doReset = async (section: string) => {
    setReset(null);
    try { const v = await api<View>("POST", "/api/admin/settings/reset", { section }); setView(v); setForm(structuredClone(v.value)); setErrors([]); setToast("Dikembalikan ke bawaan."); }
    catch (x) { setErr((x as Error).message); }
  };

  return (
    <section aria-labelledby="h-set">
      <h1 id="h-set">Pengaturan situs</h1>
      <p className="muted">Ubah teks, aturan akses, batas, dan biaya tanpa mengedit kode atau me-restart server. Terakhir diubah: {view.meta.updatedAt ? `${new Date(view.meta.updatedAt).toLocaleString("id-ID")} oleh ${view.meta.updatedBy}` : "belum pernah (memakai bawaan)"}.</p>
      {err && <div role="alert" className="banner">{err}{errors.length > 0 && <ul>{errors.map((e, i) => <li key={i}>{e.path}: {e.message}</li>)}</ul>}</div>}

      <form onSubmit={save} className="stack-lg" noValidate>
        <fieldset className="card" aria-labelledby="s-umum">
          <Head onReset={setReset} id="s-umum" title="Umum dan tampilan" section="name" />
          <div className="grid2">
            <Field errors={errors} path="name" label="Nama situs"><input type="text" value={form.name} maxLength={40} onChange={(e) => set((s) => { s.name = e.target.value; })} /></Field>
            <Field errors={errors} path="tagline" label="Slogan"><input type="text" value={form.tagline} maxLength={120} onChange={(e) => set((s) => { s.tagline = e.target.value; })} /></Field>
            <Field errors={errors} path="supportEmail" label="Email dukungan" hint="Ditampilkan ke pengguna sebagai kontak bantuan."><input type="email" value={form.supportEmail} onChange={(e) => set((s) => { s.supportEmail = e.target.value; })} /></Field>
            <Field errors={errors} path="defaultTheme" label="Tema bawaan pengguna baru"><select value={form.defaultTheme} onChange={(e) => set((s) => { s.defaultTheme = e.target.value; })}>{THEMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          </div>
          <h3>Teks antarmuka</h3>
          {[0, 1, 2].map((i) => (
            <Field errors={errors} key={i} path={`ui.emptyLines.${i}`} label={`Teks layar kosong ${i + 1}`}><input type="text" value={form.ui.emptyLines[i] ?? ""} maxLength={140} onChange={(e) => set((s) => { s.ui.emptyLines[i] = e.target.value; })} /></Field>
          ))}
          <Field errors={errors} path="ui.disclaimer" label="Pernyataan di bawah kolom pesan" hint="Wajib menyatakan bahwa ini AI. Maksimal 300 karakter."><textarea rows={2} maxLength={300} value={form.ui.disclaimer} onChange={(e) => set((s) => { s.ui.disclaimer = e.target.value; })} /></Field>
        </fieldset>

        <fieldset className="card" aria-labelledby="s-akses">
          <Head onReset={setReset} id="s-akses" title="Akses dan pemeliharaan" section="access" />
          <label className="check"><input type="checkbox" checked={form.access.registrationOpen} onChange={(e) => set((s) => { s.access.registrationOpen = e.target.checked; })} /><span>Pendaftaran terbuka. Jika ditutup, hanya pengguna lama dan email yang diundang yang bisa masuk.</span></label>
          <Field errors={errors} path="access.allowedEmailDomains" label="Batasi ke domain email (pisahkan koma; kosong = semua)" hint="Contoh: kampus.ac.id, perusahaan.co.id. Email yang diundang tetap boleh."><input type="text" value={form.access.allowedEmailDomains.join(", ")} onChange={(e) => set((s) => { s.access.allowedEmailDomains = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); })} /></Field>
          <label className="check"><input type="checkbox" checked={form.access.maintenance.enabled} onChange={(e) => set((s) => { s.access.maintenance.enabled = e.target.checked; })} /><span>Mode pemeliharaan: selain admin, pengguna melihat pesan di bawah dan tidak bisa memakai layanan.</span></label>
          <Field errors={errors} path="access.maintenance.message" label="Pesan pemeliharaan"><input type="text" value={form.access.maintenance.message} maxLength={300} onChange={(e) => set((s) => { s.access.maintenance.message = e.target.value; })} /></Field>
        </fieldset>

        <fieldset className="card" aria-labelledby="s-batas">
          <Head onReset={setReset} id="s-batas" title="Batas penggunaan" section="limits" />
          <p className="muted">Kosongkan kolom untuk memakai nilai bawaan dari konfigurasi server.</p>
          <div className="grid2">
            {LIMITS.map(([k, label, path]) => {
              const eff = view.effective[path];
              return (
                <Field errors={errors} key={k} path={path} label={label} hint={`Berlaku: ${String(eff?.value)} (${eff?.source === "db" ? "dari dasbor" : "bawaan server"}; bawaan server: ${String(eff?.envDefault)})`}>
                  <input type="number" min={0} inputMode="numeric" value={form.limits[k] ?? ""} placeholder={String(eff?.envDefault ?? "")} onChange={(e) => set((s) => { s.limits[k] = num(e.target.value); })} />
                </Field>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="card" aria-labelledby="s-biaya">
          <Head onReset={setReset} id="s-biaya" title="Biaya (untuk estimasi di Metrik)" section="costs" />
          <p className="muted">Isi dari harga resmi penyedia AI. Sistem tidak menebak harga.</p>
          <div className="grid2">
            <Field errors={errors} path="costs.inputPer1M" label="Harga per 1 juta token masuk"><input type="number" min={0} step="any" value={form.costs.inputPer1M ?? ""} onChange={(e) => set((s) => { s.costs.inputPer1M = num(e.target.value); })} /></Field>
            <Field errors={errors} path="costs.outputPer1M" label="Harga per 1 juta token keluar"><input type="number" min={0} step="any" value={form.costs.outputPer1M ?? ""} onChange={(e) => set((s) => { s.costs.outputPer1M = num(e.target.value); })} /></Field>
            <Field errors={errors} path="costs.currency" label="Mata uang"><input type="text" maxLength={8} value={form.costs.currency ?? ""} placeholder="USD" onChange={(e) => set((s) => { s.costs.currency = e.target.value.trim() || null; })} /></Field>
          </div>
        </fieldset>

        <fieldset className="card" aria-labelledby="s-aman">
          <Head onReset={setReset} id="s-aman" title="Keselamatan dan persona" section="safety" />
          <Field errors={errors} path="safety.crisisResourcesText" label="Teks bantuan krisis (diucapkan/ditampilkan pada bahaya segera)" hint={view.crisisTextConfigured ? "Wajib dari sumber resmi yang sudah diverifikasi. Kosong = memakai nilai server." : "BELUM ADA: tanpa teks ini Sawala hanya mengarahkan ke layanan darurat setempat tanpa nomor. Isi dari sumber resmi."}>
            <textarea rows={3} maxLength={2000} value={form.safety.crisisResourcesText} onChange={(e) => set((s) => { s.safety.crisisResourcesText = e.target.value; })} /></Field>
          <Field errors={errors} path="persona.extraInstructions" label="Catatan tambahan untuk persona (opsional)" hint="Ditambahkan ke instruksi AI, tetapi tidak bisa mengalahkan aturan keselamatan. Perubahan dicatat di log audit."><textarea rows={3} maxLength={1000} value={form.persona.extraInstructions} onChange={(e) => set((s) => { s.persona.extraInstructions = e.target.value; })} /></Field>
        </fieldset>

        <fieldset className="card" aria-labelledby="s-hukum">
          <Head onReset={setReset} id="s-hukum" title="Halaman hukum" section="legal" />
          <p className="muted">Kosong = memakai halaman bawaan (draf). Markup: <code># Judul</code>, <code>## Subjudul</code>, <code>- butir</code>, baris kosong = paragraf. HTML tidak diizinkan. Tinjau secara hukum sebelum dipublikasikan.</p>
          <Field errors={errors} path="legal.privacy" label="Kebijakan privasi (/privasi.html)"><textarea rows={8} value={form.legal.privacy} onChange={(e) => set((s) => { s.legal.privacy = e.target.value; })} /></Field>
          <Field errors={errors} path="legal.terms" label="Ketentuan penggunaan (/ketentuan.html)"><textarea rows={8} value={form.legal.terms} onChange={(e) => set((s) => { s.legal.terms = e.target.value; })} /></Field>
        </fieldset>

        <fieldset className="card" aria-labelledby="s-alert">
          <Head onReset={setReset} id="s-alert" title="Alert dan suara" section="alerts" />
          <div className="grid2">
            <Field errors={errors} path="alerts.webhookUrl" label="Webhook alert (https)" hint={view.alertWebhookConfigured ? "Aktif. Payload tanpa isi percakapan." : "Belum ada webhook aktif."}><input type="url" value={form.alerts.webhookUrl} placeholder="https://hooks.contoh/…" onChange={(e) => set((s) => { s.alerts.webhookUrl = e.target.value.trim(); })} /></Field>
            <Field errors={errors} path="alerts.minIntervalMinutes" label="Jeda minimal antar alert sejenis (menit)"><input type="number" min={0} value={form.alerts.minIntervalMinutes ?? ""} placeholder={String(view.effective["alerts.minIntervalMinutes"]?.envDefault ?? "")} onChange={(e) => set((s) => { s.alerts.minIntervalMinutes = num(e.target.value); })} /></Field>
            <Field errors={errors} path="alerts.errorRateThreshold" label="Ambang error rate (0 sampai 1)"><input type="number" min={0} max={1} step="0.01" value={form.alerts.errorRateThreshold ?? ""} placeholder={String(view.effective["alerts.errorRateThreshold"]?.envDefault ?? "")} onChange={(e) => set((s) => { s.alerts.errorRateThreshold = num(e.target.value); })} /></Field>
            <Field errors={errors} path="voice.safetyHoldMs" label="Penahanan audio suara native (ms)" hint="Ditahan sampai transkrip lolos pemeriksaan keselamatan. Lebih besar = lebih aman, lebih lambat."><input type="number" min={0} max={3000} value={form.voice.safetyHoldMs ?? ""} placeholder={String(view.effective["voice.safetyHoldMs"]?.envDefault ?? "")} onChange={(e) => set((s) => { s.voice.safetyHoldMs = num(e.target.value); })} /></Field>
          </div>
        </fieldset>

        <div className="savebar" role="region" aria-label="Simpan pengaturan">
          <span className="muted" role="status">{dirty ? "Ada perubahan yang belum disimpan." : "Tidak ada perubahan."}</span>
          <span className="spacer" />
          <button type="button" className="btn" disabled={!dirty || saving} onClick={() => { setForm(structuredClone(view.value)); setErrors([]); setErr(""); }}>Batalkan perubahan</button>
          <button type="submit" className="btn primary" disabled={!dirty || saving}>{saving ? "Menyimpan…" : "Simpan pengaturan"}</button>
        </div>
      </form>

      {reset && <ConfirmDialog title="Kembalikan ke bawaan?" confirmLabel="Kembalikan" onCancel={() => setReset(null)} onConfirm={() => void doReset(reset)} body="Bagian ini akan dikembalikan ke nilai bawaan. Bagian lain tidak berubah." />}
      {toast && <Toast text={toast} onDone={() => setToast("")} />}
    </section>
  );
}
