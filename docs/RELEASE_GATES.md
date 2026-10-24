# Status gerbang rilis (MTS bab 18)

Diperbarui berdasarkan keadaan repo saat ini. **Centang hanya jika buktinya ada.** Item "butuh pemilik layanan" tidak bisa diselesaikan oleh kode.

## Gate 1: beta terbatas

| Syarat | Status | Bukti / yang masih perlu |
|---|---|---|
| Login & logout berfungsi | Sebagian | Login dev + sesi teruji. **Login Google belum diuji** (butuh Client ID) |
| Isolasi data diuji | Selesai | `server/test/api.test.ts` ("auth & isolasi"), panggilan juga diisolasi |
| Chat streaming & error handling | Selesai | Tes API + E2E |
| Memori dapat dikendalikan pengguna | Selesai | Tes + E2E (lihat/ubah/hapus/konflik/forget/nonaktif) |
| Hapus percakapan & akun teruji | Selesai | Tes workflow + E2E hapus akun |
| Log tidak membocorkan isi curhat | Selesai | Tes logger allowlist; Nginx `access_log off` di DEPLOY |
| Skenario keselamatan dievaluasi | **Sebagian** | 57 skenario sintetis lulus otomatis (laporan agregat `npm run eval:safety`). **Tinjauan manusia belum dilakukan** |
| Provider & konfigurasi data ditinjau | **Belum** | Butuh pemilik layanan (ketentuan data provider) |
| Kebijakan privasi & batasan produk | **Draf** | `web/public/privasi.html`, `ketentuan.html`; butuh isi [..] dan tinjauan hukum |
| Backup/restore & insiden dasar | Dokumen siap, **uji restore belum** | [RUNBOOK](RUNBOOK.md); uji restore butuh Atlas |
| Deploy terkontrol | Selesai (skrip + workflow), **belum dijalankan di server nyata** | [DEPLOY.md](../DEPLOY.md) bagian 12; rollback otomatis |
| Alert operasional | Selesai (webhook), **belum disambungkan** | Butuh URL webhook Anda |
| Tidak ada bug kritis terbuka | Tidak ada yang diketahui | Tes otomatis lulus; belum ada pengguna nyata |

## Gate 2: pendalaman pengalaman (Fase 2)
Fitur selesai (tema mood opt-in, sapaan terbatas, ranking memori, pencarian, gaya komunikasi, aksesibilitas). **Syarat evaluasi beta dengan pengguna nyata belum terpenuhi.** Regresi keselamatan otomatis lulus.

## Gate 3: suara (Fase 3)
| Syarat | Status |
|---|---|
| Izin mikrofon & indikator rekaman jelas | Selesai (layar consent, penanda "Mikrofon aktif" non-warna, E2E) |
| Pengguna tahu apakah audio/transkrip disimpan | Selesai (audio tidak disimpan Sawala; transkrip hanya dengan persetujuan; teks sementara dihapus saat panggilan berakhir). **Audio diteruskan ke penyedia AI** pada mode realtime: diungkapkan di consent dan draf kebijakan privasi |
| Latensi & kualitas bahasa Indonesia diuji | **Belum**: butuh kunci provider dan perangkat nyata |
| Barge-in, timeout, gangguan koneksi | Selesai fungsional (barge-in opsional, batas durasi, timeout tanpa audio, error jelas). Uji perangkat nyata belum |
| Keselamatan saat model berbicara langsung | Pengaman berlapis dan teruji dengan provider mock (penahanan audio, pengunci sesi, pemantau output). **Belum teruji dengan model native asli**; batas jujur ada di [PROVIDERS.md](PROVIDERS.md). Mode cascade tidak punya batas ini |
| Adapter vendor | Teruji terhadap server palsu; **belum terhadap API asli** |
| Kebijakan privasi & retensi suara ditinjau | Draf; butuh tinjauan hukum dan isi nama penyedia |

Flag `FEATURE_VOICE_CALLS` **menyala secara default** di kode dan `.env.example` (disetujui pemilik layanan). Poin "Belum" di atas tetap harus diselesaikan di staging sebelum dibuka ke pengguna; kill switch di `/admin` bisa mematikannya seketika.

## Gate 4: rilis lebih luas (Fase 4)
Lihat [PHASE4_WRAPPERS.md](PHASE4_WRAPPERS.md) bagian 5. Evaluasi pembungkus selesai (rekomendasi: PWA/TWA); **pembungkus native tidak dibangun**. Semua syarat Gate 4 masih terbuka.
