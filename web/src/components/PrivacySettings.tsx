import type { Features, Privacy } from "../api";

/** Persetujuan dipisah per tujuan pemrosesan (MTS 11.4): memori, hal sensitif, dan riwayat adalah tiga pilihan terpisah. */
export function PrivacySettings({ privacy, features, onToggleMemory, onChange }: {
  privacy: Privacy; features: Features; onToggleMemory: (on: boolean) => void; onChange: (patch: Partial<Privacy>) => void;
}) {
  return (
    <fieldset className="fieldset">
      <legend>Privasi</legend>
      {features.longTermMemory && (
        <label className="check"><input type="checkbox" checked={privacy.longTermMemory} onChange={(e) => onToggleMemory(e.target.checked)} />
          <span>Memori jangka panjang. Mematikannya menghentikan pembuatan dan pemakaian memori; riwayat chat tidak ikut terhapus.</span></label>
      )}
      {features.longTermMemory && (
        <label className="check"><input type="checkbox" checked={privacy.allowSensitiveMemory} disabled={!privacy.longTermMemory} onChange={(e) => onChange({ allowSensitiveMemory: e.target.checked })} />
          <span>Izinkan menyimpan hal sensitif (mis. kesehatan, keyakinan) sebagai memori. Terpisah dari pengaturan lain, dan default mati.</span></label>
      )}
      <label className="check"><input type="checkbox" checked={privacy.saveHistory} onChange={(e) => onChange({ saveHistory: e.target.checked })} />
        <span>Simpan riwayat percakapan. Jika mati, percakapan baru bersifat sementara (hapus otomatis setelah 24 jam tidak aktif) dan tidak membuat memori.</span></label>
    </fieldset>
  );
}
