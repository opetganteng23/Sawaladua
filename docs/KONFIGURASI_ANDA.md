# Daftar yang tinggal dari Anda

Semua kode, uji, dan dokumen yang bisa dikerjakan tanpa data Anda sudah selesai. Yang tersisa hanya hal di bawah. Kerjakan berurutan; centang saat selesai.

## 1. Akun dan kunci (membuka semua uji "nyata")
- [ ] **Google OAuth**: buat OAuth client ID (Web), isi `GOOGLE_CLIENT_ID`, tambahkan domain ke Authorized JavaScript origins.
- [ ] **Penyedia AI** (pilih per kemampuan, lihat [PROVIDERS.md](PROVIDERS.md)): `LLM_PROVIDER` + kunci + nama model; `EMBEDDING_PROVIDER` + model + `EMBEDDING_DIMENSIONS`; opsional `STT_PROVIDER`/`TTS_PROVIDER`/`REALTIME_PROVIDER` + modelnya.
- [ ] **MongoDB Atlas**: `MONGODB_URI` (IP server saja di allowlist), lalu `npm run db:vector-index` bila memakai Vector Search (`VECTOR_SEARCH_INDEX`).
- [ ] `SESSION_SECRET` acak (`openssl rand -base64 48`), `ALLOWED_ORIGINS` = origin publik persis.
- [ ] `ADMIN_EMAILS` (akses `/admin`), `ALERT_WEBHOOK_URL` (https), `DAILY_TOKEN_BUDGET_*`, `COST_PER_1M_*` dari harga resmi.

## 2. Verifikasi sumber (catat di [VERIFIKASI.md](VERIFIKASI.md))
- [ ] Ketentuan data penyedia AI untuk **paket yang dipakai** (retensi, pelatihan, lokasi, penghapusan). **Sampai ini selesai: data sintetis saja.**
- [ ] Info bantuan krisis resmi, isi `CRISIS_RESOURCES_TEXT`.
- [ ] Kecocokan protokol adapter realtime (OpenAI Realtime/Gemini Live) dengan versi API terkini.

## 3. Keputusan Anda
- [ ] **Retensi chat** (`CHAT_RETENTION_DAYS`; 0 = sampai dihapus pengguna) dan **retensi backup** (isi di [DATA_LIFECYCLE.md](DATA_LIFECYCLE.md) dan kebijakan privasi).
- [ ] Setujui/ubah keputusan enkripsi di [THREAT_MODEL.md](THREAT_MODEL.md).
- [ ] Siapa yang punya akses produksi; kontak dukungan ([SUPPORT.md](SUPPORT.md)).
- [ ] Tema/identitas visual final (saat ini 5 tema bawaan).

## 4. Hukum
- [ ] Isi `[ ... ]` di [privasi.html](../web/public/privasi.html) dan [ketentuan.html](../web/public/ketentuan.html) (nama badan, alamat, kontak, penyedia AI, retensi), lalu **tinjauan hukum** (UU PDP).

## 5. Deploy dan uji di lingkungan nyata (ikuti [DEPLOY.md](../DEPLOY.md))
- [ ] VM Biznet Gio, domain, TLS, Nginx (termasuk blok WebSocket), PM2, `pm2 startup`.
- [ ] Secret GitHub Environment untuk workflow deploy (`SSH_*`, `APP_URL`) dan persetujuan wajib di `production`.
- [ ] **Staging dulu** dengan data sintetis: login Google, chat, memori, hapus akun, ekspor.
- [ ] **Suara realtime: ikuti [VOICE_GOLIVE.md](VOICE_GOLIVE.md)** (uji asap adapter dengan kunci asli, uji perangkat, latihan keselamatan, beta bertahap).
- [ ] `npm -w server run eval` dengan model nyata, **tinjau hasilnya dengan manusia**; tinjau juga laporan keselamatan (`npm run eval:safety`).
- [ ] Backup Atlas aktif, **uji restore** ([RUNBOOK.md](RUNBOOK.md) bagian 6), latih satu simulasi insiden.
- [ ] Uji aksesibilitas manual ([A11Y_TEST_PLAN.md](A11Y_TEST_PLAN.md)).
- [ ] Beta terbatas dengan pengguna yang paham ini AI; evaluasi sebelum membuka lebih luas.

Setelah semua tercentang, status gerbang rilis di [RELEASE_GATES.md](RELEASE_GATES.md) bisa diperbarui.
