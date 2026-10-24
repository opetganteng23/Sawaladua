# Cakupan MTS V2: bagian demi bagian

Legenda: **Selesai** = terbangun dan teruji otomatis. **Selesai (butuh uji nyata)** = kode/dokumen selesai, tetapi pembuktiannya butuh kunci/perangkat/pengguna Anda. **Anda** = bergantung pada keputusan/akun/tinjauan Anda ([KONFIGURASI_ANDA.md](KONFIGURASI_ANDA.md)). **Ditunda** = sengaja tidak dibangun.

| Bab | Isi | Status | Bukti / catatan |
|---|---|---|---|
| 1 | Ringkasan, prinsip, bukan-tujuan | Selesai | Transparan sebagai AI di onboarding/consent/disclaimer; tanpa streak/rasa bersalah/mode romantis; tes persona di harness evaluasi |
| 2.1 | Fase 1 MVP (PWA, login, chat streaming, riwayat, persona, 4 mood, memori, ringkasan, privasi, hapus, keselamatan, log aman, biaya, tes) | Selesai (butuh uji nyata) | Login Google dan model nyata belum teruji tanpa kunci |
| 2.2 | Fase 2 (tema mood opt-in, sapaan terbatas, retrieval, pencarian, personalisasi, aksesibilitas) | Selesai | Tuning retrieval berdasar evaluasi model nyata dan uji pengguna: **Anda** |
| 2.3 | Fase 3 (suara realtime, VAD, barge-in, UI, transkrip dengan persetujuan) | Selesai (butuh uji nyata) | Latensi/kualitas bahasa Indonesia di perangkat nyata: **Anda** |
| 2.4 | Fase 4 (evaluasi pembungkus, tinjauan, dukungan, insiden) | Selesai (evaluasi) / Ditunda (pembungkus) | [PHASE4_WRAPPERS.md](PHASE4_WRAPPERS.md), [SUPPORT.md](SUPPORT.md), [RUNBOOK.md](RUNBOOK.md) |
| 3 | Arsitektur dan stack | Selesai | Provider bisa diganti ([PROVIDERS.md](PROVIDERS.md)); deployment diputuskan: Biznet + PM2 |
| 4 | UX: onboarding, percakapan, memori, penghapusan | Selesai | E2E; penjelasan cakupan penghapusan di UI |
| 5 | Chat dan SSE | Selesai | Kontrak di [openapi.yaml](openapi.yaml); idempoten; tidak lengkap/gagal ditandai; batas ukuran/waktu/token |
| 6 | Persona, mood, strategi, prompt | Selesai | Prompt berversi; strategi dibatasi backend |
| 7 | Memory Engine | Selesai | Lifecycle lengkap: ekstraksi, validasi, dedup, merge, konflik, **supersede otomatis untuk kejadian**, peluruhan, retrieval berperingkat+MMR, hapus **termasuk ringkasan sumber**, ekspor |
| 8 | Model data | Selesai (butuh uji nyata) | Validator database + indeks; performa indeks dengan data nyata dan backup/restore: **Anda** |
| 9 | API | Selesai | Semua endpoint MTS + tambahan; dokumentasi diuji terhadap rute asli |
| 10 | UI/UX, komponen, tema, aksesibilitas | Selesai | Seluruh komponen bernama sesuai MTS 10.3 (`web/src/components/`); 5 tema; axe lulus; uji pembaca layar manual: [A11Y_TEST_PLAN.md](A11Y_TEST_PLAN.md) |
| 11.1 | Keamanan dasar | Selesai (butuh deploy) | Pemindai secret + Dependabot + audit di CI; HTTPS aktif setelah deploy |
| 11.2 | Enkripsi dan kunci | **Anda** | Rekomendasi tertulis di [THREAT_MODEL.md](THREAT_MODEL.md) |
| 11.3 | Data ke provider AI | **Anda** | Minimisasi konteks sudah; verifikasi ketentuan provider belum ([VERIFIKASI.md](VERIFIKASI.md)) |
| 11.4 | Persetujuan terpisah | Selesai | Memori, hal sensitif, riwayat, transkrip suara = pilihan terpisah |
| 11.5 | Siklus hidup data | Selesai | [DATA_LIFECYCLE.md](DATA_LIFECYCLE.md); retensi chat dapat diatur; nilai retensi/backup: **Anda** |
| 11.6 | Penghapusan akun | Selesai | Workflow berstatus, dapat diulang, tes termasuk kegagalan di tengah |
| 11.7 | Kepatuhan | **Anda** | Draf kebijakan privasi/ketentuan; tinjauan hukum |
| 12 | Safety architecture | Selesai (butuh tinjauan manusia) | Gate berlapis, dataset 57 skenario, laporan agregat (`npm run eval:safety`), pengaman suara; tinjauan manusia dan info krisis resmi: **Anda** |
| 13.1 | Logging aman | Selesai | Allowlist; tes |
| 13.2 | Metrik | Selesai | Latensi, error rate, **stream terputus**, token/biaya, **output tidak valid**, **latensi DB dan vector**, **kegagalan ekstraksi/penghapusan**, status penghapusan, agregat keselamatan: dasbor `/admin` |
| 13.3 | Penanganan kegagalan | Selesai | Tes: provider timeout/mati, klien putus, DB gagal, output tidak valid, hapus ulang |
| 13.4 | Pengendalian biaya | Selesai | Batas, anggaran, alert, fallback kuota; angka batas/harga: **Anda** |
| 14.1 | Jenis pengujian | Selesai (sebagian manual) | Unit, integrasi, E2E, keamanan, AI eval, safety, a11y otomatis, resilience; **a11y manual** dan **AI eval model nyata**: Anda |
| 14.2 | Acceptance criteria | Selesai | Semua 16 area punya tes |
| 14.3 | Evaluasi kualitas AI | Selesai (harness) | Ambang numerik setelah baseline model nyata: **Anda** |
| 15 | Deployment, CI/CD, backup, insiden | Selesai (dokumen/skrip) | Eksekusi deploy, uji restore, latihan insiden: **Anda** |
| 16 | Feature flags | Selesai | Env + kill switch runtime |
| 17 | Rencana implementasi | Selesai | |
| 18 | Release gates | Lihat [RELEASE_GATES.md](RELEASE_GATES.md) | Butir yang membutuhkan Anda tetap terbuka |
| 19 | Risiko dan mitigasi | Selesai | Setiap mitigasi punya kontrol dan tes |
| 20 | Keputusan terbuka | Sebagian **Anda** | Selesai: usia 18+, stack, login, memori terkendali, ekspor JSON, deployment. Anda: retensi chat/backup, tema visual final, nomor krisis |
| 21 | Definition of Done | Selesai | Per fitur: validasi server, loading/kosong/sukses/gagal, tes, tanpa secret, log aman, aksesibel, dokumentasi |
| 22 | Verifikasi sumber | **Anda** | Templat di [VERIFIKASI.md](VERIFIKASI.md) |
