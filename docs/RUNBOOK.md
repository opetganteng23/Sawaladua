# Runbook operasional Sawala

Dokumen untuk operator. Aturan dasar: **jangan menyalin isi percakapan pengguna ke tiket, chat tim, atau log** saat menangani insiden. Gunakan `requestId` dan ID teknis saja.

## 0. Cek cepat

| Gejala | Perintah/lokasi |
|---|---|
| Aplikasi hidup? | `curl -s https://DOMAIN/healthz` -> `{"ok":true}` |
| Proses PM2 | `pm2 status`, `pm2 logs sawala --lines 100` |
| Metrik penggunaan | `GET /api/admin/usage?days=7` (login sebagai email di `ADMIN_EMAILS`) |
| Error per request | cari `requestId` (dikirim ke pengguna di pesan error) di `logs/sawala.*.log` |

Log hanya memuat field operasional. Jika kamu melihat isi curhat di log, itu **insiden privasi** (lihat 3).

## 1. Provider AI gangguan atau kuota habis

1. Pengguna melihat "Sawala sedang kesulitan merespons" (retryable) atau `QUOTA_EXHAUSTED` (tidak retryable). Pesan mereka sudah tersimpan.
2. Pengguna dengan sinyal risiko tetap mendapat respons tinjauan-manusia (tanpa LLM). Jangan menonaktifkan jalur ini.
3. Cek status/kuota di konsol provider. Naikkan kuota **atau** naikkan `DAILY_TOKEN_BUDGET_GLOBAL` hanya setelah memahami biayanya, lalu `pm2 reload sawala`.
4. Jangan menaikkan retry tanpa batas; retry model dibatasi (2) demi biaya.
5. Catat waktu mulai/selesai dan dampak di catatan insiden.

## 2. Lonjakan biaya atau penyalahgunaan API

1. Lihat `GET /api/admin/usage?days=1`: token per hari, error rate, latensi, per model.
2. Periksa lonjakan dari satu akun: query `usage_events` agregat per `userId` (hanya angka). Jika penyalahgunaan: turunkan `DAILY_TOKEN_BUDGET_PER_USER` atau `DAILY_MESSAGE_LIMIT`, reload.
3. Darurat: set `DAILY_TOKEN_BUDGET_GLOBAL=1` (praktis menghentikan pemanggilan LLM; pengguna berisiko tetap dijawab) lalu reload.
4. Rotasi `GEMINI_API_KEY` jika dicurigai bocor (lihat 4).

## 3. Dugaan kebocoran data pengguna / akses tidak sah

1. **Tahan dulu**: catat waktu, apa yang terlihat, siapa yang melihat. Jangan hapus bukti.
2. Batasi: cabut akses yang dicurigai, `db.sessions.deleteMany({})` untuk memaksa semua pengguna login ulang bila perlu, rotasi `SESSION_SECRET` dan kredensial database.
3. Tentukan cakupan: akun/jenis data apa, rentang waktu. Pakai log operasional dan audit Atlas.
4. Pemberitahuan: ikuti kewajiban hukum yang berlaku (UU PDP) dan kebijakan privasi. **Konsultasikan penasihat hukum untuk batas waktu dan isi pemberitahuan**; dokumen ini tidak menetapkannya.
5. Pasca-insiden: akar masalah, perbaikan, tes regresi, ubah runbook.

## 4. Kredensial bocor (API key, URI database, secret sesi)

| Rahasia | Tindakan |
|---|---|
| `GEMINI_API_KEY` | Buat kunci baru di konsol provider, isi `server/.env`, `pm2 reload sawala`, cabut kunci lama |
| `MONGODB_URI` | Buat user DB baru, ganti URI, cabut user lama, periksa Network Access (hanya IP server) |
| `SESSION_SECRET` | Ganti nilainya; reload. Sesi disimpan di database (hash token), jadi hapus koleksi `sessions` bila perlu paksa logout |
| `GOOGLE_CLIENT_ID` | Bukan rahasia; yang rahasia adalah akun Google Cloud. Tinjau Authorized origins |
| Commit berisi `.env` | Anggap bocor: rotasi semua, hapus dari riwayat git |

## 5. Penghapusan data gagal

1. `db.deletion_jobs.find({status:{$in:["failed","running","pending"]}})`.
2. Server mencoba ulang otomatis tiap 2 menit (`resumePendingDeletions`). Alur idempoten.
3. Jika tetap gagal: lihat `steps` mana yang `failed`, perbaiki penyebab (izin DB, jaringan), lalu `pm2 restart sawala`.
4. Selama belum `completed`, **jangan** menyatakan kepada pengguna bahwa datanya sudah terhapus.
5. Permintaan penghapusan juga mencakup data di backup/pihak ketiga sesuai kebijakan retensi; catat tanggal kedaluwarsa backup yang memuat data tsb.

## 6. Backup dan pemulihan MongoDB

- **Backup**: aktifkan backup berkelanjutan/snapshot Atlas. Tentukan retensi (mis. 7–30 hari) dan tulis di kebijakan privasi.
- **Uji restore (minimal tiap kuartal, dan sebelum rilis)**:
  1. Restore snapshot ke cluster **terpisah** (jangan menimpa produksi).
  2. Jalankan aplikasi staging menunjuk ke cluster itu, login, buka riwayat dan memori.
  3. Catat waktu pemulihan (RTO) dan titik data terakhir (RPO).
  4. Hapus cluster uji dan datanya.
- **Setelah restore ke produksi**: akun yang dihapus *setelah* titik backup akan hidup kembali. Jalankan ulang penghapusan berdasarkan daftar `deletion_jobs` yang sudah `completed` (userId-nya tersimpan) sebelum membuka layanan.
- Batasi akses ke backup dan enkripsi sesuai kebutuhan.

## 7. Keselamatan: laporan jawaban berbahaya

1. Minta `requestId` dan waktu dari pelapor; **jangan** minta/menyalin isi percakapan ke kanal umum.
2. Tambahkan skenario ke `server/eval/safety.cases.json` (versi sintetis, tanpa data asli) dan perbaiki pola/prompt.
3. Jalankan `npm test` dan `npm -w server run eval`; tinjau hasil dengan manusia sebelum rilis perbaikan.
4. Jika jawaban berbahaya muncul pada pengguna berisiko: perlakukan sebagai insiden prioritas tinggi, pertimbangkan menonaktifkan model untuk kategori itu (naikkan sensitivitas gate) sampai diperbaiki.

## 8. Rilis dan rollback

Lihat bagian "Update versi" di [DEPLOY.md](../DEPLOY.md). Rollback = `git checkout <tag>`, `npm ci`, `npm run build`, `npm run pm2:start`. Migrasi data tidak boleh destruktif otomatis.

## 9. Kill switch fitur saat insiden

Jika satu fitur bermasalah (mis. memori menyimpan hal yang salah, suara error, ekspor membebani server): buka `/admin` (akun di `ADMIN_EMAILS`) lalu matikan fiturnya. Efeknya seketika di instance yang melayani dan ~10 detik di instance lain, tanpa restart. API setara: `PATCH /api/admin/flags {"killed":["voiceCalls"]}`. Mematikan memori berarti tidak ada memori yang dibuat atau dipakai (riwayat chat tidak terhapus). Nyalakan kembali setelah akar masalah diperbaiki dan diuji.

## 10. Sesi dicurigai dibajak

Minta pengguna membuka Pengaturan > Sesi login > "Keluarkan semua perangkat lain". Untuk pencabutan massal oleh operator: `db.sessions.deleteMany({userId: ObjectId("...")})` (satu akun) atau seluruh koleksi (semua pengguna login ulang).
