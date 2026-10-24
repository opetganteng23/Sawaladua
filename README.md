# Sawala

AI companion berbahasa Indonesia. Implementasi Fase 1 sampai 4 dari [SAWALA_MTS_V2.md](SAWALA_MTS_V2.md):

| Fase | Isi | Status |
|---|---|---|
| 1 | MVP chat teks, memori terkendali, keselamatan, privasi | Selesai |
| 2 | Tema mengikuti mood, sapaan opsional, ranking memori, pencarian, gaya komunikasi, aksesibilitas | Selesai |
| 3 | Panggilan suara **realtime dua arah** (Gemini Live / OpenAI Realtime / cascade STT+LLM+TTS, VAD, barge-in, consent, penanda mikrofon, pengaman keselamatan di server) | Fitur selesai dan teruji dengan provider mock; flag menyala di contoh env; uji di staging sebelum dibuka ke pengguna, lihat [status Gate 3](docs/RELEASE_GATES.md) |
| 4 | Evaluasi pembungkus (PWA/TWA/Capacitor/Tauri), dukungan, respons insiden, kapasitas | Evaluasi dan dokumen selesai; **pembungkus native sengaja tidak dibangun** ([alasan](docs/PHASE4_WRAPPERS.md)) |

Kode selesai **tidak** berarti siap rilis publik: syarat hukum, privasi provider, dan uji perangkat nyata masih di tangan pemilik layanan. Lihat [docs/RELEASE_GATES.md](docs/RELEASE_GATES.md).

## Menjalankan (development)

```bash
npm install
# Opsi A, tanpa instalasi database (MongoDB in-memory; data hilang saat berhenti, hanya data uji):
npm -w server run dev:memdb      # API di :8787, LLM & embedding = mock, suara aktif
npm run dev:web                  # PWA di :5173 (proxy /api ke :8787)

# Opsi B, MongoDB yang sudah terpasang di mesin atau Atlas (isi MONGODB_URI):
cp .env.example server/.env      # lalu isi SESSION_SECRET (>=32 karakter)
npm run dev:server
```

Buka http://localhost:5173, masuk lewat form "Masuk (dev)", centang konfirmasi 18+.

## Tes

| Perintah | Isi |
|---|---|
| `npm run scan:secrets` / `npm run eval:safety` | Pemindai secret; laporan agregat keselamatan (wajib ditinjau manusia) |
| `npm test` | Server (MongoDB in-memory): API, isolasi data, keselamatan (dataset skenario), memori, hapus akun, panggilan suara, anggaran/kuota, rate limiter, migrasi, kill switch, alert, sesi, kesesuaian OpenAPI, harness evaluasi. Web (jsdom): Overlay/focus trap, onboarding, parser SSE, CallView, dasbor admin |
| `npm run test:e2e` | Playwright desktop + mobile: alur UI, hapus akun, gerbang usia, panggilan suara, **audit aksesibilitas axe di 5 tema**. Sekali: `npx playwright install chromium` |
| `npm -w server run eval` | Evaluasi kualitas AI (`server/eval/quality.cases.json`) terhadap provider yang dikonfigurasi. Hasil otomatis hanya penyaring kasar; **butuh tinjauan manusia** |
| `node server/scripts/loadtest.mjs <url> <users> <msgs>` | Uji beban sederhana (baseline di [docs/PHASE4_WRAPPERS.md](docs/PHASE4_WRAPPERS.md)) |

## Status dan yang tersisa

- **Cakupan MTS bab demi bab:** [docs/MTS_COVERAGE.md](docs/MTS_COVERAGE.md)
- **Yang tinggal dari Anda (akun, kunci, keputusan, uji nyata):** [docs/KONFIGURASI_ANDA.md](docs/KONFIGURASI_ANDA.md)
- **Membawa suara realtime ke pengguna nyata:** [docs/VOICE_GOLIVE.md](docs/VOICE_GOLIVE.md) (`npm run voice:smoke` untuk uji adapter dengan API asli)
- Dokumen pendukung: [DATA_LIFECYCLE](docs/DATA_LIFECYCLE.md), [THREAT_MODEL](docs/THREAT_MODEL.md), [A11Y_TEST_PLAN](docs/A11Y_TEST_PLAN.md), [VERIFIKASI](docs/VERIFIKASI.md)

## Provider AI bisa diganti-ganti

LLM, embedding, STT, TTS, dan suara realtime dipilih terpisah lewat env (Gemini, OpenAI, Anthropic untuk LLM; Gemini/OpenAI untuk embedding, STT, TTS, realtime). Panduan, contoh kombinasi, dan langkah penggantian: [docs/PROVIDERS.md](docs/PROVIDERS.md). Adapter vendor belum diuji terhadap API asli (butuh kunci Anda).

## Operasional yang sudah ada

| Fitur | Dokumen |
|---|---|
| Deploy otomatis + rollback, migrasi DB, indeks Atlas Vector Search | [DEPLOY.md](DEPLOY.md) bagian 12 |
| Dasbor operator `/admin` (metrik, biaya, kill switch fitur) | DEPLOY.md bagian 12, [RUNBOOK](docs/RUNBOOK.md) |
| Alert webhook (anggaran, kuota, error rate, penghapusan gagal) | DEPLOY.md bagian 12 |
| Kontrak API (diuji terhadap rute asli) | [docs/openapi.yaml](docs/openapi.yaml) |
| Daftar dan pencabutan sesi login | Pengaturan > Sesi login |

## Yang harus Anda isi sendiri (tidak saya karang)

| Item | Di mana | Catatan |
|---|---|---|
| `GOOGLE_CLIENT_ID` | server/.env | Wajib di staging/production. Login Google **belum teruji** tanpa ini |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_EMBEDDING_MODEL` | server/.env | Dengan `LLM_PROVIDER=gemini` / `EMBEDDING_PROVIDER=gemini`. Adapter belum diuji dengan model nyata |
| `CRISIS_RESOURCES_TEXT` | server/.env | Info bantuan krisis dari **sumber resmi yang sudah diverifikasi**. Kosong = respons hanya mengarah ke layanan darurat setempat tanpa nomor |
| `VECTOR_SEARCH_INDEX` | server/.env | Nama Atlas Vector Search index pada `memories.embedding` (filter: `userId`, `status`). Kosong = fallback cosine, tetap difilter `userId` |
| `COST_PER_1M_*`, `DAILY_TOKEN_BUDGET_*`, `ADMIN_EMAILS`, `ALERT_WEBHOOK_URL` | server/.env | Harga, batas, dan tujuan alert tidak ditanam di kode |
| Isian `[ ... ]` di kebijakan privasi/ketentuan | web/public/*.html | Draf; butuh tinjauan hukum |
| Deployment, retensi chat, retensi backup | - | Keputusan terbuka (MTS bab 20) |

## Guardrail yang ditegakkan

- Produksi/staging menolak `AUTH_DEV_LOGIN=true`, `LLM_PROVIDER=mock`, dan `GOOGLE_CLIENT_ID` kosong.
- `userId` dari sesi server; field tak dikenal ditolak; semua query privat difilter `userId`; panggilan juga terisolasi.
- Cookie sesi httpOnly + SameSite=Lax, cek Origin dan header `X-Requested-With` (CSRF), CSP, rate limiter di MongoDB (aman multi-instance).
- Konfirmasi usia 18+ ditegakkan **server** (chat dan panggilan ditolak tanpa itu).
- Log hanya memuat field operasional (allowlist); isi curhat tidak dicatat.
- Bahaya segera dijawab teks tinjauan-manusia tanpa memanggil LLM, juga saat kuota/anggaran habis. Krisis tidak disimpan sebagai memori.
- Audio tidak pernah dikirim ke server; transkrip panggilan hanya disimpan dengan persetujuan, selain itu dihapus saat panggilan berakhir.
- Tetap gunakan **data sintetis** sampai ketentuan data provider AI diverifikasi (MTS 11.3).

## Batasan yang perlu diketahui

- Balasan dialirkan **setelah** divalidasi (schema + pemeriksaan keselamatan), bukan token mentah dari LLM; disengaja agar output berbahaya tidak sempat tampil.
- Pola safety gate adalah lapisan pertama dan butuh tinjauan manusia serta perluasan dataset lewat evaluasi.
- Pengenalan suara memakai Web Speech API: butuh Chrome/Edge, HTTPS, dan sebagian browser mengirim audio ke vendor browser (diungkapkan di layar consent dan kebijakan privasi). Belum diuji di perangkat dan kualitas bahasa Indonesia nyata.
- Ekspor dan penghapusan berjalan sinkron di server tunggal; data di backup/pihak ketiga mengikuti retensi masing-masing.

## Produksi

`npm run build` lalu `npm run pm2:start`: satu proses Node melayani API dan PWA (`web/dist`) di satu port. Panduan Biznet Gio + PM2 + Nginx + TLS, staging, anggaran, dan metrik: [DEPLOY.md](DEPLOY.md). Operasional dan insiden: [docs/RUNBOOK.md](docs/RUNBOOK.md), dukungan pengguna: [docs/SUPPORT.md](docs/SUPPORT.md). Tema: terang, gelap, senja, hutan, sakura.
