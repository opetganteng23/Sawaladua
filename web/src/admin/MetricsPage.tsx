import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { fmtNum } from "./usePagedList";

export interface Usage {
  days: number; currency: string; costNote: string;
  budget: { dailyGlobal: number | null; dailyPerUser: number | null };
  daily: { date: string; requests: number; ok: number; failed: number; errorRate: number; inputTokens: number; outputTokens: number; latencyP50Ms: number; latencyP95Ms: number; estimatedCost: number | null }[];
  models: { model: string; requests: number; inputTokens: number; outputTokens: number; estimatedCost: number | null }[];
  ops?: {
    counts: Record<string, number>; streamDisconnectRate: number; invalidOutputRate: number;
    retrieval: { samples: number; p50Ms: number; p95Ms: number }; vectorSearch: { samples: number; p50Ms: number; p95Ms: number }; dbPing: { samples: number; p50Ms: number; p95Ms: number };
    safety: { level1: number; level2: number; level3: number; voiceLatched: number };
    failures: { memoryExtraction: number; summary: number; deletionStep: number };
  };
}

/** Metrik agregat: penggunaan, biaya (jika harga diisi), latensi, dan metrik operasional. Tanpa isi percakapan atau identitas. */
export function MetricsPage() {
  const [days, setDays] = useState(7);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => { try { setUsage(await api<Usage>("GET", `/api/admin/usage?days=${days}`)); setErr(""); } catch (e) { setErr((e as Error).message); } }, [days]);
  useEffect(() => { void load(); }, [load]);
  const maxTok = Math.max(1, ...(usage?.daily.map((d) => d.inputTokens + d.outputTokens) ?? [1]));

  return (
    <section aria-labelledby="h-met">
      <h1 id="h-met">Metrik</h1>
      <p className="muted">Data agregat tanpa isi percakapan dan tanpa identitas pengguna.</p>
      <div className="toolbar"><label className="field">Rentang<select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={1}>1 hari</option><option value={7}>7 hari</option><option value={30}>30 hari</option></select></label></div>
      {err && <div role="alert" className="banner">{err}</div>}
      {!usage ? <p>Memuat…</p> : (
        <>
          <p className="muted">{usage.costNote} Anggaran harian: global {usage.budget.dailyGlobal ? fmtNum(usage.budget.dailyGlobal) : "nonaktif"}, per pengguna {usage.budget.dailyPerUser ? fmtNum(usage.budget.dailyPerUser) : "nonaktif"} token.</p>
          <h2>Penggunaan harian</h2>
          <div className="dt-scroll" tabIndex={0} role="region" aria-label="Tabel penggunaan harian (dapat digulir)">
            <table aria-label="Penggunaan harian">
              <caption className="sr-only">Penggunaan harian</caption>
              <thead><tr>{["Tanggal", "Request", "Gagal", "Error rate", "Token masuk", "Token keluar", "p50 ms", "p95 ms", `Biaya (${usage.currency})`, "Skala token"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
              <tbody>
                {usage.daily.length === 0 && <tr><td colSpan={10} className="dt-msg">Belum ada data.</td></tr>}
                {usage.daily.map((d) => (
                  <tr key={d.date}>
                    <th scope="row" className="dt-first">{d.date}</th><td className="num">{fmtNum(d.requests)}</td><td className="num">{fmtNum(d.failed)}</td><td className="num">{(d.errorRate * 100).toFixed(1)}%</td>
                    <td className="num">{fmtNum(d.inputTokens)}</td><td className="num">{fmtNum(d.outputTokens)}</td><td className="num">{fmtNum(d.latencyP50Ms)}</td><td className="num">{fmtNum(d.latencyP95Ms)}</td>
                    <td className="num">{d.estimatedCost === null ? "-" : d.estimatedCost}</td>
                    <td><span className="bar" style={{ width: `${Math.round(((d.inputTokens + d.outputTokens) / maxTok) * 100)}%` }} aria-hidden="true" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {usage.ops && (
            <>
              <h2>Operasional</h2>
              <div className="dt-scroll" tabIndex={0} role="region" aria-label="Metrik operasional (dapat digulir)">
                <table aria-label="Metrik operasional">
                  <caption className="sr-only">Metrik operasional</caption>
                  <thead><tr><th scope="col">Metrik</th><th scope="col">Nilai</th></tr></thead>
                  <tbody>
                    <tr><th scope="row" className="dt-first">Stream terputus (rasio terhadap request)</th><td>{(usage.ops.streamDisconnectRate * 100).toFixed(1)}%</td></tr>
                    <tr><th scope="row" className="dt-first">Keluaran model tidak valid (rasio)</th><td>{(usage.ops.invalidOutputRate * 100).toFixed(1)}%</td></tr>
                    <tr><th scope="row" className="dt-first">Latensi retrieval memori p50 / p95</th><td>{usage.ops.retrieval.p50Ms} / {usage.ops.retrieval.p95Ms} ms ({usage.ops.retrieval.samples} sampel)</td></tr>
                    <tr><th scope="row" className="dt-first">Latensi Vector Search p50 / p95</th><td>{usage.ops.vectorSearch.samples ? `${usage.ops.vectorSearch.p50Ms} / ${usage.ops.vectorSearch.p95Ms} ms` : "belum dipakai"}</td></tr>
                    <tr><th scope="row" className="dt-first">Ping database p50 / p95</th><td>{usage.ops.dbPing.p50Ms} / {usage.ops.dbPing.p95Ms} ms</td></tr>
                    <tr><th scope="row" className="dt-first">Pesan terdeteksi distres / risiko / bahaya segera</th><td>{usage.ops.safety.level1} / {usage.ops.safety.level2} / {usage.ops.safety.level3}</td></tr>
                    <tr><th scope="row" className="dt-first">Panggilan suara dikunci karena risiko</th><td>{usage.ops.safety.voiceLatched}</td></tr>
                    <tr><th scope="row" className="dt-first">Gagal: ekstraksi memori / ringkasan / langkah penghapusan</th><td>{usage.ops.failures.memoryExtraction} / {usage.ops.failures.summary} / {usage.ops.failures.deletionStep}</td></tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
          <h2>Per model</h2>
          <div className="dt-scroll" tabIndex={0} role="region" aria-label="Penggunaan per model (dapat digulir)">
            <table aria-label="Penggunaan per model">
              <caption className="sr-only">Penggunaan per model</caption>
              <thead><tr>{["Model", "Request", "Token masuk", "Token keluar", `Biaya (${usage.currency})`].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
              <tbody>
                {usage.models.length === 0 && <tr><td colSpan={5} className="dt-msg">Belum ada data.</td></tr>}
                {usage.models.map((m) => <tr key={m.model}><th scope="row" className="dt-first">{m.model}</th><td className="num">{fmtNum(m.requests)}</td><td className="num">{fmtNum(m.inputTokens)}</td><td className="num">{fmtNum(m.outputTokens)}</td><td className="num">{m.estimatedCost === null ? "-" : m.estimatedCost}</td></tr>)}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
