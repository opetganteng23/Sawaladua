# Siklus hidup data (MTS 11.5)

Setiap kategori data: tujuan, dasar/mekanisme persetujuan, retensi, siapa yang bisa mengakses, lokasi, dan cara menghapus. Dokumen teknis, **bukan nasihat hukum**; nilai bertanda [ ... ] diisi pemilik layanan.

| Data | Tujuan | Persetujuan | Retensi | Akses | Lokasi | Penghapusan |
|---|---|---|---|---|---|---|
| Akun (email, nama, ID Google) | Login, mengenali akun | Login Google + persetujuan ketentuan/privasi saat onboarding | Sampai akun dihapus | Pengguna; operator database (dibatasi) | MongoDB [region] | Hapus akun (workflow berstatus) |
| Konfirmasi usia 18+ (waktu) | Penegakan batas usia | Centang di onboarding | Sampai akun dihapus | Pengguna; operator | MongoDB | Hapus akun |
| Pesan chat | Riwayat, konteks balasan | Bagian dari layanan; **Simpan riwayat** dapat dimatikan | Sampai dihapus pengguna; atau `CHAT_RETENTION_DAYS` (default 0 = tanpa batas); riwayat sementara 24 jam bila Simpan riwayat mati | Pengguna; operator database (dibatasi) | MongoDB; **isi dikirim ke penyedia model AI** saat membuat balasan | Hapus percakapan; retensi otomatis; hapus akun |
| Memori jangka panjang | Kesinambungan obrolan | **Terpisah**: toggle memori; hal sensitif **terpisah lagi** (default mati) | Sampai dihapus pengguna; peluruhan prioritas (bukan penghapusan) untuk kejadian lama | Pengguna; operator database | MongoDB; teks dikirim ke penyedia embedding saat dibuat/dicari | Hapus memori (juga membersihkan ringkasan sesi sumbernya); matikan memori + hapus; hapus akun |
| Embedding memori/ringkasan | Pencarian relevansi | Mengikuti persetujuan memori | Sama dengan memori | Operator database | MongoDB (dan Atlas Vector Search bila dipakai) | Ikut terhapus bersama memori; `db:reembed` saat ganti model |
| Ringkasan sesi | Kesinambungan antar sesi | Mengikuti persetujuan memori | Sampai percakapan/akun dihapus; dihapus saat memori sumber dihapus | Pengguna (tidak ditampilkan langsung); operator | MongoDB | Hapus percakapan/memori sumber; hapus akun |
| Transkrip panggilan suara | Riwayat panggilan | **Centang tersendiri per panggilan** (default tidak) | Hanya bila disetujui; selain itu dihapus saat panggilan berakhir | Pengguna; operator | MongoDB | Hapus percakapan; hapus akun |
| **Audio panggilan** | Diproses secara realtime | Consent sebelum panggilan | **Tidak disimpan oleh Sawala** (hanya di memori proses) | Penyedia AI yang dipakai memprosesnya sesuai ketentuan mereka | Server Sawala (memori) -> [penyedia AI] | Tidak ada salinan di Sawala |
| Metadata panggilan | Operasional | Bagian dari layanan | Sampai akun dihapus | Operator | MongoDB | Hapus akun |
| Daftar sesi login (waktu, jenis browser, dipotong) | Keamanan akun | Bagian dari layanan | Sesi berakhir (maks. 14 hari) | Pengguna; operator | MongoDB | Cabut sesi; logout; hapus akun |
| Preferensi (tema, gaya, sapaan) | Personalisasi | Pengaturan pengguna | Sampai akun dihapus | Pengguna; operator | MongoDB | Hapus akun |
| Metrik penggunaan (`usage_events`): waktu, token, status | Keandalan, biaya | Kepentingan operasional | 90 hari | Operator | MongoDB | Kedaluwarsa otomatis; hapus akun |
| Kejadian operasional (`ops_events`): jenis kejadian dan durasi, **tanpa isi dan tanpa ID pengguna** | Pemantauan kualitas | Kepentingan operasional | 30 hari | Operator | MongoDB | Kedaluwarsa otomatis |
| Log aplikasi: ID request, status, durasi, kode error | Debugging | Kepentingan operasional | Rotasi 14 hari (PM2) | Operator | Disk server | Rotasi log |
| Job penghapusan (`deletion_jobs`): langkah dan status, tanpa isi | Bukti dan pemulihan penghapusan | Kewajiban operasional | 30 hari setelah selesai | Operator | MongoDB | Kedaluwarsa otomatis |
| Backup database | Pemulihan bencana | Kepentingan operasional | [mis. 7-30 hari; tentukan] | Operator terbatas | Atlas/[lokasi] | Mengikuti siklus retensi backup; **data terhapus bisa bertahan di backup sampai siklus berakhir** |

## Pihak ketiga yang menerima data
| Pihak | Data | Tujuan | Yang harus diverifikasi sebelum data nyata |
|---|---|---|---|
| Google (login) | Email, nama, ID akun | Autentikasi | Konfigurasi OAuth |
| Penyedia model AI [nama] | Pesan, konteks, (suara bila realtime) | Balasan, embedding, STT/TTS | Retensi, penggunaan untuk pelatihan, lokasi, opsi penghapusan |
| MongoDB Atlas / hosting [nama] | Semua data tersimpan | Penyimpanan | Region, enkripsi at-rest, akses, backup |
| Penerima webhook alert [opsional] | Hanya jenis kejadian, tanpa isi/identitas | Peringatan | Kebijakan penerima |

## Aturan akses operator
- Akses database produksi dibatasi pada orang yang perlu, dengan akun individual dan IP yang diizinkan.
- Dukungan pengguna **tidak membaca isi percakapan** (lihat [SUPPORT.md](SUPPORT.md)).
- Pengambilan sampel isi untuk debugging membutuhkan proses khusus, persetujuan, dan retensi singkat; tidak ada mekanisme otomatis untuk itu di aplikasi ini.
