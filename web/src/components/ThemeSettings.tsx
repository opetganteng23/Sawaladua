import type { Features, Preferences, Theme } from "../api";

export const THEMES: { id: Theme; label: string }[] = [
  { id: "terang", label: "Terang" }, { id: "gelap", label: "Gelap" }, { id: "senja", label: "Senja" },
  { id: "hutan", label: "Hutan" }, { id: "sakura", label: "Sakura" },
];

/** Tema, tema mengikuti mood (opt-in, bisa dimatikan), dan indikator mood. */
export function ThemeSettings({ prefs, features, onChange }: {
  prefs: Preferences; features: Features; onChange: (patch: { theme?: Theme; moodThemes?: boolean; showMood?: boolean }) => void;
}) {
  return (
    <fieldset className="fieldset">
      <legend>Tampilan</legend>
      <label className="field">Tema
        <select value={prefs.theme} onChange={(e) => onChange({ theme: e.target.value as Theme })}>
          {THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      {features.moodThemes && (
        <label className="check"><input type="checkbox" checked={prefs.moodThemes} onChange={(e) => onChange({ moodThemes: e.target.checked })} />
          <span>Warna balon mengikuti mood Sawala (halus, bisa dimatikan).</span></label>
      )}
      <label className="check"><input type="checkbox" checked={prefs.showMood} onChange={(e) => onChange({ showMood: e.target.checked })} />
        <span>Tampilkan indikator mood.</span></label>
    </fieldset>
  );
}
