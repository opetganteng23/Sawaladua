// Uji beban sederhana untuk server Sawala (data sintetis, dev login).
// Pakai: node scripts/loadtest.mjs [baseUrl] [users] [messagesPerUser]
// Mengukur overhead aplikasi + database. Dengan LLM mock hasilnya BUKAN latensi model nyata.
const base = process.argv[2] ?? "http://localhost:8790";
const users = Number(process.argv[3] ?? 50);
const perUser = Number(process.argv[4] ?? 5);
const H = { "Content-Type": "application/json", "X-Requested-With": "sawala", Origin: base };

async function session(i) {
  const r = await fetch(`${base}/api/auth/dev`, { method: "POST", headers: H, body: JSON.stringify({ email: `load${i}-${Date.now()}@contoh.com` }) });
  if (!r.ok) throw new Error("login " + r.status);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const h = { ...H, cookie };
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: h, body: JSON.stringify({ ageConfirmed: true }) });
  return h;
}

const lat = [];
let errors = 0;
async function worker(i) {
  const h = await session(i);
  let conv;
  for (let m = 0; m < perUser; m++) {
    const t0 = performance.now();
    try {
      const r = await fetch(`${base}/api/chat`, {
        method: "POST", headers: h,
        body: JSON.stringify({ conversationId: conv, clientMessageId: `load-${i}-${m}-${Date.now()}`, text: m % 2 ? "aku capek banget hari ini" : "kasih saran dong biar tidurku nyenyak" }),
      });
      const body = await r.text();
      if (!r.ok || !body.includes("message_completed")) { errors++; continue; }
      conv ??= /"conversationId":"([a-f0-9]+)"/.exec(body)?.[1];
      lat.push(performance.now() - t0);
    } catch { errors++; }
  }
}

const t0 = performance.now();
await Promise.all(Array.from({ length: users }, (_, i) => worker(i)));
const secs = (performance.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const p = (q) => Math.round(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? 0);
console.log(JSON.stringify({
  users, messagesPerUser: perUser, totalRequests: users * perUser, ok: lat.length, errors,
  seconds: Number(secs.toFixed(1)), requestsPerSecond: Number((lat.length / secs).toFixed(1)),
  latencyMs: { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: Math.round(lat.at(-1) ?? 0) },
}, null, 2));
