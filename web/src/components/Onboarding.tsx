import { useState } from "react";
import { api, type Features, type User } from "../api";

export function Onboarding({ user, features, onDone }: { user: User; features: Features; onDone: (u: User) => void }) {
  const [memory, setMemory] = useState(user.privacySettings.longTermMemory && features.longTermMemory);
  const [history, setHistory] = useState(user.privacySettings.saveHistory);
  const [age, setAge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const finish = async (save: boolean) => {
    setBusy(true);
    try {
      const body = save
        ? { onboardingDone: true, ageConfirmed: true, privacySettings: { longTermMemory: memory, saveHistory: history } }
        : { onboardingDone: true, ageConfirmed: true };
      onDone(await api<User>("PATCH", "/api/settings", body));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="center">
      <div className="card stack">
        <h1>Sebelum mulai</h1>
        <p>
          <strong>Sawala adalah AI.</strong> Ia bisa salah, tidak mendiagnosis, dan bukan pengganti bantuan profesional atau
          orang-orang terdekatmu. Jika kamu dalam bahaya, hubungi layanan darurat setempat.
        </p>
        <fieldset className="fieldset">
          <legend>Privasi</legend>
          {features.longTermMemory && (
            <label className="check">
              <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} />
              <span>
                Izinkan memori jangka panjang. Sawala mengingat hal-hal yang relevan agar obrolan nyambung. Kamu bisa melihat,
                mengubah, dan menghapusnya kapan saja. Detail sensitif tidak disimpan kecuali kamu mengizinkannya.
              </span>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
            <span>Simpan riwayat percakapan. Jika dimatikan, percakapan hanya sementara dan dihapus otomatis setelah 24 jam tidak aktif.</span>
          </label>
          <p className="muted">
            Kamu bisa menghapus percakapan, memori, atau seluruh akun dari Pengaturan. Mematikan memori tidak otomatis menghapus riwayat chat.
          </p>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} />
          <span>Saya berusia 18 tahun atau lebih, dan saya setuju dengan <a href="/ketentuan.html" target="_blank" rel="noopener">Ketentuan Penggunaan</a> serta <a href="/privasi.html" target="_blank" rel="noopener">Kebijakan Privasi</a>.</span>
        </label>
        <div role="alert" style={{ color: "var(--danger)" }}>{err}</div>
        <div className="row">
          <button className="btn" disabled={busy || !age} onClick={() => finish(false)}>Lewati pengaturan</button>
          <span className="spacer" />
          <button className="btn primary" disabled={busy || !age} onClick={() => finish(true)}>Mulai ngobrol</button>
        </div>
      </div>
    </main>
  );
}
