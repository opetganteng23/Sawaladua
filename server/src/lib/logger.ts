// Logger aman: hanya field operasional yang diizinkan. Isi curhat tidak pernah dicatat.
const ALLOWED = new Set([
  "requestId", "event", "status", "code", "durationMs", "provider", "model",
  "inputTokens", "outputTokens", "promptVersion", "route", "method", "retrieved", "step", "jobStatus",
]);

export function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  const safe: Record<string, unknown> = { level, ts: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
      safe[k] = typeof v === "string" ? v.slice(0, 120) : v;
    }
  }
  if (process.env.NODE_ENV === "test") return;
  console.log(JSON.stringify(safe));
}
