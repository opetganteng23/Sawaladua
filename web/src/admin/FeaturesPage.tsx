import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

interface Flags { effective: Record<string, boolean>; killed: string[]; names: string[] }
const LABEL: Record<string, string> = {
  longTermMemory: "Memori jangka panjang", moodThemes: "Tema mengikuti mood", proactiveGreeting: "Sapaan opsional",
  voiceCalls: "Panggilan suara", dataExport: "Ekspor data",
};
const HINT: Record<string, string> = {
  longTermMemory: "Mematikan: tidak ada memori yang dibuat atau dipakai (riwayat chat tidak terhapus).",
  voiceCalls: "Mematikan: tombol panggilan hilang dan koneksi suara ditolak.",
  dataExport: "Mematikan: pengguna tidak bisa mengekspor data.",
  moodThemes: "Mematikan: warna balon tidak lagi mengikuti mood.",
  proactiveGreeting: "Mematikan: sapaan tidak ditampilkan.",
};

/** Kill switch fitur: berlaku dalam ±10 detik di semua instance, tanpa restart. Hanya bisa MEMATIKAN fitur yang menyala di server. */
export function FeaturesPage() {
  const [flags, setFlags] = useState<Flags | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => { try { setFlags(await api<Flags>("GET", "/api/admin/flags")); setErr(""); } catch (e) { setErr((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (name: string, enabled: boolean) => {
    if (!flags) return;
    setBusy(name);
    const killed = enabled ? flags.killed.filter((k) => k !== name) : [...flags.killed, name];
    try { setFlags(await api<Flags>("PATCH", "/api/admin/flags", { killed })); setErr(""); } catch (e) { setErr((e as Error).message); }
    setBusy("");
  };

  return (
    <section aria-labelledby="h-feat">
      <h1 id="h-feat">Fitur (kill switch)</h1>
      <p className="muted">Matikan fitur seketika bila ada masalah. Fitur yang mati di konfigurasi server tidak bisa dinyalakan dari sini. Setiap perubahan tercatat di log audit.</p>
      {err && <div role="alert" className="banner">{err}</div>}
      {!flags ? <p>Memuat…</p> : (
        <div className="dt-scroll" tabIndex={0} role="region" aria-label="Daftar fitur (dapat digulir)">
          <table>
            <caption className="sr-only">Status fitur</caption>
            <thead><tr><th scope="col">Fitur</th><th scope="col">Status</th><th scope="col">Keterangan</th><th scope="col">Aksi</th></tr></thead>
            <tbody>
              {flags.names.map((n) => {
                const on = flags.effective[n] ?? false;
                const killed = flags.killed.includes(n);
                const envOff = !on && !killed;
                return (
                  <tr key={n}>
                    <th scope="row" className="dt-first">{LABEL[n] ?? n}</th>
                    <td><span className={`badge ${on ? "ok" : "warn"}`}>{on ? "Menyala" : killed ? "Dimatikan operator" : "Mati di server"}</span></td>
                    <td className="muted">{HINT[n] ?? ""}</td>
                    <td>
                      <button className={`btn ${on ? "danger" : ""}`} disabled={envOff || busy === n} onClick={() => void toggle(n, !on)} aria-label={`${on ? "Matikan" : "Nyalakan"} ${LABEL[n] ?? n}`}>{on ? "Matikan" : "Nyalakan"}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
