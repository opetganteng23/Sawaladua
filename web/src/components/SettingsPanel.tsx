import { useCallback, useEffect, useState } from "react";
import { api, type Features, type Preferences, type Privacy, type User } from "../api";
import { ConfirmDialog as Confirm } from "./ConfirmDialog";
import { Overlay } from "./Overlay";
import { PrivacySettings } from "./PrivacySettings";
import { ThemeSettings } from "./ThemeSettings";
import { Toast } from "./Toast";

const HOURS = Array.from({ length: 24 }, (_, i) => i);

type PrefsPatch = { [K in keyof Preferences]?: Preferences[K] extends object ? Partial<Preferences[K]> : Preferences[K] };

interface SessionRow { id: string; current: boolean; createdAt: string; device: string }

function SessionsSection() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    try { setRows((await api<{ items: SessionRow[] }>("GET", "/api/sessions")).items); setErr(""); }
    catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { setErr((e as Error).message); } };
  return (
    <fieldset className="fieldset">
      <legend>Sesi login</legend>
      <p className="muted">Perangkat/browser yang sedang masuk ke akunmu. Cabut yang tidak kamu kenali.</p>
      {err && <div role="alert" style={{ color: "var(--danger)" }}>{err}</div>}
      <ul style={{ paddingLeft: 18 }}>
        {rows.map((s) => (
          <li key={s.id} style={{ marginBottom: 8 }}>
            <span>{s.device}</span> <span className="muted">({new Date(s.createdAt).toLocaleString("id-ID")})</span> {s.current && <strong>(sesi ini)</strong>}{" "}
            {!s.current && <button className="btn" onClick={() => act(() => api("DELETE", `/api/sessions/${s.id}`))} aria-label={`Cabut sesi ${s.device}`}>Cabut</button>}
          </li>
        ))}
      </ul>
      {rows.length > 1 && <button className="btn" onClick={() => act(() => api("POST", "/api/sessions/revoke-others", {}))}>Keluarkan semua perangkat lain</button>}
    </fieldset>
  );
}

export function SettingsPanel({ user, features, onUser, onClose, onDeleted }: {
  user: User; features: Features; onUser: (u: User) => void; onClose: () => void; onDeleted: (token: string) => void;
}) {
  const p = user.preferences;
  const pv = user.privacySettings;
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [memOff, setMemOff] = useState(false);
  const [alsoDelete, setAlsoDelete] = useState(false);
  const [delAcc, setDelAcc] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  const patch = async (body: object) => {
    try { onUser(await api<User>("PATCH", "/api/settings", body)); setErr(""); }
    catch (e) { setErr((e as Error).message); }
  };
  const pref = (x: PrefsPatch) => patch({ preferences: x });
  const priv = (x: Partial<Privacy>) => patch({ privacySettings: x });

  const exportData = async () => {
    setBusy(true);
    try {
      const data = await api("POST", "/api/data/export", {});
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url; a.download = "sawala-data.json"; a.click();
      URL.revokeObjectURL(url);
      setNote("Data diekspor.");
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const deleteAccount = async () => {
    setBusy(true);
    try {
      const r = await api<{ statusToken: string }>("DELETE", "/api/me", { confirm: "HAPUS" });
      onDeleted(r.statusToken);
    } catch (e) { setErr((e as Error).message); setBusy(false); setDelAcc(false); }
  };

  return (
    <Overlay title="Pengaturan" onClose={onClose}>
      {err && <div role="alert" style={{ color: "var(--danger)", marginBottom: 8 }}>{err}</div>}
      {note && <Toast text={note} onDone={() => setNote("")} />}

      <ThemeSettings prefs={p} features={features} onChange={(x) => pref(x)} />

      <fieldset className="fieldset">
        <legend>Gaya komunikasi</legend>
        <label className="field">Dipanggil
          <input type="text" maxLength={40} defaultValue={p.style.addressAs} placeholder="Opsional, mis. Kak Ayu"
            onBlur={(e) => { if (e.target.value !== p.style.addressAs) void pref({ style: { addressAs: e.target.value } }); }} />
        </label>
        <label className="field">Panjang balasan
          <select value={p.style.length} onChange={(e) => pref({ style: { length: e.target.value as Preferences["style"]["length"] } })}>
            <option value="ringkas">Ringkas</option><option value="sedang">Sedang</option><option value="panjang">Panjang</option>
          </select></label>
        <label className="field">Kesopanan
          <select value={p.style.formality} onChange={(e) => pref({ style: { formality: e.target.value as Preferences["style"]["formality"] } })}>
            <option value="santai">Santai (aku/kamu)</option><option value="netral">Netral</option><option value="sopan">Sopan (saya/Anda)</option>
          </select></label>
        <label className="field">Emoji
          <select value={p.style.emoji} onChange={(e) => pref({ style: { emoji: e.target.value as Preferences["style"]["emoji"] } })}>
            <option value="tanpa">Tanpa emoji</option><option value="sedikit">Sedikit</option><option value="sedang">Cukup sering</option>
          </select></label>
        <label className="check"><input type="checkbox" checked={p.style.humor} onChange={(e) => pref({ style: { humor: e.target.checked } })} />
          <span>Boleh bercanda ringan.</span></label>
      </fieldset>

      {features.proactiveGreeting && (
        <fieldset className="fieldset">
          <legend>Sapaan</legend>
          <label className="check"><input type="checkbox" checked={p.greeting.enabled}
            onChange={(e) => pref({ greeting: { enabled: e.target.checked, utcOffsetMinutes: -new Date().getTimezoneOffset() } })} />
            <span>Tampilkan sapaan singkat saat aku membuka Sawala (maksimal sekali sehari, tanpa notifikasi, tanpa tekanan).</span></label>
          {p.greeting.enabled && (
            <div className="row wrap">
              <label className="field">Jam tenang dari
                <select value={p.greeting.quietStartHour} onChange={(e) => pref({ greeting: { quietStartHour: Number(e.target.value) } })}>
                  {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</select></label>
              <label className="field">sampai
                <select value={p.greeting.quietEndHour} onChange={(e) => pref({ greeting: { quietEndHour: Number(e.target.value) } })}>
                  {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</select></label>
            </div>
          )}
        </fieldset>
      )}

      <PrivacySettings privacy={pv} features={features} onToggleMemory={(on) => (on ? priv({ longTermMemory: true }) : setMemOff(true))} onChange={priv} />

      <SessionsSection />

      <fieldset className="fieldset">
        <legend>Data</legend>
        {features.dataExport && <button className="btn" disabled={busy} onClick={exportData}>Ekspor data saya (JSON)</button>}
        <p className="muted">Menghapus akun menghapus percakapan, pesan, memori, dan ringkasan dari database utama. Salinan di backup dan pihak ketiga mengikuti jadwal retensi di kebijakan privasi.</p>
        <button className="btn danger" onClick={() => { setConfirmText(""); setDelAcc(true); }}>Hapus akun &amp; semua data</button>
      </fieldset>

      {memOff && (
        <Confirm title="Matikan memori jangka panjang?" confirmLabel="Matikan" onCancel={() => { setMemOff(false); setAlsoDelete(false); }}
          onConfirm={async () => { await patch({ privacySettings: { longTermMemory: false }, deleteExistingMemories: alsoDelete }); setMemOff(false); setAlsoDelete(false); }}
          body="Sawala berhenti membuat dan memakai memori. Riwayat chat tetap ada.">
          <label className="check"><input type="checkbox" checked={alsoDelete} onChange={(e) => setAlsoDelete(e.target.checked)} />
            <span>Hapus juga semua memori dan ringkasan yang sudah tersimpan (tidak bisa dikembalikan).</span></label>
        </Confirm>
      )}
      {delAcc && (
        <Confirm title="Hapus akun?" danger confirmLabel={busy ? "Menghapus…" : "Hapus permanen"} onCancel={() => setDelAcc(false)}
          onConfirm={() => { if (confirmText === "HAPUS" && !busy) void deleteAccount(); }}
          body="Semua percakapan, memori, dan data akunmu akan dihapus dan tidak bisa dikembalikan. Ketik HAPUS untuk melanjutkan.">
          <label className="field">Ketik HAPUS<input type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" /></label>
        </Confirm>
      )}
    </Overlay>
  );
}
