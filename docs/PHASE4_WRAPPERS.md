# Fase 4: evaluasi pembungkus aplikasi dan kesiapan rilis lebih luas

Status: **evaluasi dan rekomendasi** (MTS 2.4 meminta *evaluasi*, bukan langsung membangun). Tidak ada aplikasi native yang dibangun atau diuji di sini; semua klaim tentang perilaku WebView/App Store di bawah **harus diverifikasi di perangkat target** sebelum keputusan akhir.

## 1. Ringkasan rekomendasi

| Platform | Rekomendasi | Alasan |
|---|---|---|
| Android | **Langkah 1: PWA terpasang (sudah ada).** Langkah 2 bila perlu Play Store: Trusted Web Activity (TWA) | TWA menjalankan PWA di Chrome, bukan WebView. Login Google dan pengenalan suara tetap seperti di browser |
| iOS | **PWA "Tambahkan ke Layar Utama"** dulu. Pembungkus Capacitor hanya jika ada fitur native yang membenarkan | App Store umumnya menolak aplikasi yang hanya membungkus situs tanpa nilai native (periksa pedoman terbaru). Fitur suara/auth di WKWebView perlu plugin native |
| Desktop | **PWA terpasang (Chrome/Edge)**. Tauri hanya jika butuh integrasi OS (tray, shortcut global) | Tanpa biaya build/rilis/penandatanganan kode. Electron paling berat; Tauri lebih ringan tapi perlu toolchain Rust |

## 2. Temuan teknis yang menentukan pilihan

1. **Login Google tidak boleh di WebView tertanam.** Google memblokir OAuth di embedded WebView (`disallowed_useragent`). Pembungkus berbasis WebView (Capacitor/Tauri/Electron) perlu alur browser sistem + deep link atau plugin Google Sign-In native. Ini pekerjaan tambahan nyata. Sesi Sawala memakai cookie sesi httpOnly; jika memakai token via deep link, itu mengubah model keamanan dan perlu desain ulang (CSRF/penyimpanan token).
2. **Pengenalan suara (Web Speech API) tidak andal di WebView.** Fitur suara Fase 3 bergantung pada `SpeechRecognition` browser. Di WebView Android/iOS biasanya tidak tersedia atau terbatas; pembungkus butuh plugin STT/TTS native, dan itu mengubah klaim privasi di Kebijakan Privasi (audio bisa diproses layanan lain). Dengan TWA/PWA di Chrome, perilaku sama seperti web.
3. **Cookie lintas origin.** Pembungkus yang memuat bundle lokal (bukan URL server) membuat API menjadi lintas-origin: butuh `SameSite=None; Secure`, CORS dengan kredensial, dan penyesuaian CSRF. Opsi paling sederhana: pembungkus **memuat URL produksi** (`server.url`), sehingga tetap satu origin.
4. **Service worker** sudah hanya meng-cache cangkang statis dan tidak pernah `/api`; aman untuk PWA terpasang.
5. **Ikon**: manifest memakai satu ikon SVG. Untuk TWA/toko, siapkan PNG 192/512 + maskable dan screenshot.

## 3. Biaya, kapasitas, dan beban kerja (perkiraan; verifikasi harga terbaru)

| Item | Catatan |
|---|---|
| Akun toko | Apple Developer Program (tahunan) dan Google Play (sekali bayar): **cek harga resmi saat mendaftar** |
| Penandatanganan kode desktop | Sertifikat berbayar bila ingin menghindari peringatan OS |
| Peninjauan toko | Perlu pengisian formulir data safety/privasi, peringkat usia, dan pernyataan fitur AI. Kebijakan toko untuk aplikasi kesehatan mental/companion berubah-ubah: baca pedoman terbaru |
| Biaya model | Dari `GET /api/admin/usage` (token per hari) × harga provider (isi `COST_PER_1M_*`) ÷ jumlah pengguna aktif = biaya per MAU. **Ukur saat beta**, jangan ditebak |
| Kapasitas server | Lihat bagian 4 |

## 4. Kapasitas terukur (baseline, bukan jaminan)

`server/scripts/loadtest.mjs`, satu proses Node, MongoDB in-memory, **LLM mock**, mesin pengembangan lokal:

| Skenario | Request | Error | Throughput | Latensi p50 / p95 |
|---|---|---|---|---|
| 50 pengguna × 6 pesan | 300 | 0 | ~200 req/dtk | 192 / 241 ms |
| 200 pengguna × 3 pesan | 600 | 0 | ~258 req/dtk | 592 / 621 ms |

Arti: **overhead aplikasi + database kecil** pada beban ini. Tidak mencerminkan latensi model sebenarnya (biasanya satuan detik), jaringan Atlas, maupun Vector Search. Sebelum rilis luas: ulangi di staging dengan provider dan Atlas nyata, uji dengan jumlah pengguna serentak yang direncanakan, dan pasang batas anggaran (`DAILY_TOKEN_BUDGET_*`). Rate limiter sudah di MongoDB sehingga PM2 cluster (`PM2_INSTANCES`) aman.

## 5. Prasyarat sebelum rilis lebih luas (Gate 4)

- [ ] Tinjauan keamanan terbaru (dependensi, konfigurasi, pentest ringan)
- [ ] Tinjauan privasi/hukum final (UU PDP): kebijakan privasi, ketentuan, retensi, DPA dengan penyedia
- [ ] Uji kapasitas di staging dengan provider nyata
- [ ] Backup dan restore pernah diuji ([RUNBOOK](RUNBOOK.md) bagian 6)
- [ ] Rencana dukungan siap ([SUPPORT](SUPPORT.md)) dan respons insiden dilatih ([RUNBOOK](RUNBOOK.md))
- [ ] Verifikasi nomor/sumber bantuan krisis resmi di `CRISIS_RESOURCES_TEXT`
- [ ] Evaluasi AI dengan model nyata dan **tinjauan manusia** atas skenario keselamatan

## 6. Jika tetap ingin membangun pembungkus

Urutan kerja yang disarankan (belum dikerjakan):
1. TWA Android lewat Bubblewrap + Digital Asset Links (`/.well-known/assetlinks.json` disajikan dari `web/public`).
2. Uji alur login Google, suara, hapus akun, dan ekspor di perangkat nyata.
3. Hanya bila ada kebutuhan native: Capacitor dengan `server.url` produksi + plugin Google Sign-In native + plugin STT/TTS native; perbarui Kebijakan Privasi tentang pemrosesan audio.
4. Desktop: tetap PWA kecuali ada alasan kuat memakai Tauri.
