import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

interface Usage {
  ops?: Ops;
  days: number; currency: string; costNote: string;
  budget: { dailyGlobal: number | null; dailyPerUser: number | null };
  daily: { date: string; requests: number; ok: number; failed: number; errorRate: number; inputTokens: number; outputTokens: number; latencyP50Ms: number; latencyP95Ms: number; estimatedCost: number | null }[];
  models: { model: string; requests: number; inputTokens: number; outputTokens: number; estimatedCost: number | null }[];
}
interface Ops {
  counts: Record<string, number>; streamDisconnectRate: number; invalidOutputRate: number;
  retrieval: { samples: number; p50Ms: number; p95Ms: number }; vectorSearch: { samples: number; p50Ms: number; p95Ms: number }; dbPing: { samples: number; p50Ms: number; p95Ms: number };
  safety: { level1: number; level2: number; level3: number; voiceLatched: number };
  failures: { memoryExtraction: number; summary: number; deletionStep: number };
}
interface Flags { effective: Record<string, boolean>; killed: string[]; names: string[] }

const LABEL: Record<string, string> = {
  longTermMemory: "Memori jangka panjang", moodThemes: "Tema mengikuti mood", proactiveGreeting: "Sapaan opsional",
  voiceCalls: "Panggilan suara", dataExport: "Ekspor data",
};
const fmt = (n: number) => n.toLocaleString("id-ID");

/** Dasbor operator: metrik agregat (tanpa isi percakapan/identitas) dan kill switch fitur. */
export function AdminView() {
  const [days, setDays] = useState(7);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [flags, setFlags] = useState<Flags | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const [u, f] = await Promise.all([api<Usage>("GET", `/api/admin/usage?days=${days}`), api<Flags>("GET", "/api/admin/flags")]);
      setUsage(u); setFlags(f); setErr("");
    } catch (e) { setErr((e as Error).message); }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (name: string, enabled: boolean) => {
    if (!flags) return;
    const killed = enabled ? flags.killed.filter((k) => k !== name) : [...flags.killed, name];
    try { setFlags(await api<Flags>("PATCH", "/api/admin/flags", { killed })); }
    catch (e) { setErr((e as Error).message); }
  };

  const maxTok = Math.max(1, ...(usage?.daily.map((d) => d.inputTokens + d.outputTokens) ?? [1]));

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "16px" }}>
      <div className="row wrap">
        <h1 style={{ margin: 0 }}>Metrik operator</h1><span className="spacer" />
        <a className="btn" href="/">Kembali ke Sawala</a>
      </div>
      <p className="muted">Data agregat tanpa isi percakapan dan tanpa identitas pengguna.</p>
      {err && <div className="banner" role="alert">{err}</div>}

      <fieldset className="fieldset">
        <legend>Kill switch fitur</legend>
        <p className="muted">Mematikan fitur segera (tanpa restart; berlaku lintas instance dalam ~10 detik). Fitur yang mati di environment tidak bisa dinyalakan dari sini.</p>
        {flags?.names.map((n) => (
          <label className="check" key={n}>
            <input type="checkbox" checked={flags.effective[n] ?? false} disabled={!flags.effective[n] && !flags.killed.includes(n)} onChange={(e) => void toggle(n, e.target.checked)} />
            <span>{LABEL[n] ?? n} {flags.killed.includes(n) && <strong>(dimatikan operator)</strong>}</span>
          </label>
        ))}
      </fieldset>

      <label className="field">Rentang
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>1 hari</option><option value={7}>7 hari</option><option value={30}>30 hari</option>
        </select>
      </label>
      {usage && (
        <>
          <p className="muted">{usage.costNote} Anggaran harian: global {usage.budget.dailyGlobal ? fmt(usage.budget.dailyGlobal) : "nonaktif"}, per pengguna {usage.budget.dailyPerUser ? fmt(usage.budget.dailyPerUser) : "nonaktif"} token.</p>
          <div style={{ overflowX: "auto" }} tabIndex={0} role="region" aria-label="Tabel penggunaan harian (dapat digulir)">
            <table className="data" aria-label="Penggunaan harian">
              <caption className="sr-only">Penggunaan harian</caption>
              <thead><tr>{["Tanggal", "Request", "Gagal", "Error rate", "Token masuk", "Token keluar", "p50 ms", "p95 ms", `Biaya (${usage.currency})`, "Skala token"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
              <tbody>
                {usage.daily.length === 0 && <tr><td colSpan={10}>Belum ada data.</td></tr>}
                {usage.daily.map((d) => (
                  <tr key={d.date}>
                    <th scope="row">{d.date}</th><td>{fmt(d.requests)}</td><td>{fmt(d.failed)}</td><td>{(d.errorRate * 100).toFixed(1)}%</td>
                    <td>{fmt(d.inputTokens)}</td><td>{fmt(d.outputTokens)}</td><td>{fmt(d.latencyP50Ms)}</td><td>{fmt(d.latencyP95Ms)}</td>
                    <td>{d.estimatedCost === null ? "-" : d.estimatedCost}</td>
                    <td><span className="bar" style={{ width: `${Math.round(((d.inputTokens + d.outputTokens) / maxTok) * 100)}%` }} aria-hidden="true" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {usage.ops && (
            <>
              <h2>Operasional</h2>
              <table className="data" aria-label="Metrik operasional">
                <thead><tr>{["Metrik", "Nilai"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
                <tbody>
                  <tr><th scope="row">Stream terputus (rasio terhadap request)</th><td>{(usage.ops.streamDisconnectRate * 100).toFixed(1)}%</td></tr>
                  <tr><th scope="row">Keluaran model tidak valid (rasio)</th><td>{(usage.ops.invalidOutputRate * 100).toFixed(1)}%</td></tr>
                  <tr><th scope="row">Latensi retrieval memori p50 / p95</th><td>{usage.ops.retrieval.p50Ms} / {usage.ops.retrieval.p95Ms} ms ({usage.ops.retrieval.samples} sampel)</td></tr>
                  <tr><th scope="row">Latensi Vector Search p50 / p95</th><td>{usage.ops.vectorSearch.samples ? `${usage.ops.vectorSearch.p50Ms} / ${usage.ops.vectorSearch.p95Ms} ms` : "belum dipakai"}</td></tr>
                  <tr><th scope="row">Ping database p50 / p95</th><td>{usage.ops.dbPing.p50Ms} / {usage.ops.dbPing.p95Ms} ms</td></tr>
                  <tr><th scope="row">Pesan terdeteksi distres / risiko / bahaya segera</th><td>{usage.ops.safety.level1} / {usage.ops.safety.level2} / {usage.ops.safety.level3}</td></tr>
                  <tr><th scope="row">Panggilan suara dikunci karena risiko</th><td>{usage.ops.safety.voiceLatched}</td></tr>
                  <tr><th scope="row">Gagal: ekstraksi memori / ringkasan / langkah penghapusan</th><td>{usage.ops.failures.memoryExtraction} / {usage.ops.failures.summary} / {usage.ops.failures.deletionStep}</td></tr>
                </tbody>
              </table>
            </>
          )}
          <h2>Per model</h2>
          <table className="data" aria-label="Penggunaan per model">
            <thead><tr>{["Model", "Request", "Token masuk", "Token keluar", `Biaya (${usage.currency})`].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>{usage.models.map((m) => <tr key={m.model}><th scope="row">{m.model}</th><td>{fmt(m.requests)}</td><td>{fmt(m.inputTokens)}</td><td>{fmt(m.outputTokens)}</td><td>{m.estimatedCost === null ? "-" : m.estimatedCost}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </main>
  );
}
