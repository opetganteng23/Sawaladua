# Rencana dukungan pengguna Sawala (Fase 4)

Tujuan: pengguna tahu ke mana minta bantuan, dan tim bisa membantu **tanpa membaca isi curhat**.

## Prinsip
- Dukungan tidak membutuhkan akses ke isi percakapan. Pengguna bisa menyalin `requestId` dari pesan error.
- Jangan pernah meminta pengguna mengirim kata sandi/token. Login hanya lewat Google.
- Sawala bukan layanan krisis. Jika pengguna menulis ke dukungan dalam keadaan krisis, balas singkat dengan empati, arahkan ke layanan darurat setempat/orang tepercaya (nomor resmi yang sudah diverifikasi dari `CRISIS_RESOURCES_TEXT`), dan eskalasikan ke penanggung jawab.

## Kanal dan SLA (isi sebelum rilis)
| Kanal | Alamat | Target respons awal |
|---|---|---|
| Email dukungan | [EMAIL DUKUNGAN] | [mis. 2 hari kerja] |
| Permintaan data pribadi (akses, ekspor, hapus) | [EMAIL KONTAK PELINDUNGAN DATA] | [sesuai kewajiban hukum] |
| Laporan keselamatan/jawaban berbahaya | [EMAIL KONTAK] (prioritas tinggi) | [mis. 24 jam] |

## Masalah umum dan jawaban
| Masalah | Jawaban/aksi |
|---|---|
| "Tidak bisa login" | Pastikan cookie aktif dan memakai akun Google yang sama. Akun dengan `deletion_pending` tidak bisa login sampai penghapusan selesai. |
| "Sawala tidak membalas" | Kemungkinan gangguan provider/kuota. Pesan sudah tersimpan; coba lagi nanti (lihat RUNBOOK 1). |
| "Memori salah" | Panel Memori: Ubah / Salah-tidak relevan / Hapus. Konflik diselesaikan pengguna. |
| "Mau hapus semua" | Pengaturan > Hapus akun. Jelaskan batas backup/pihak ketiga (kebijakan privasi). |
| "Suara tidak jalan" | Butuh browser yang mendukung pengenalan suara (Chrome/Edge), izin mikrofon, dan HTTPS. Alternatif: chat teks. |
| "Data saya salah dipakai" | Eskalasi sebagai insiden privasi (RUNBOOK 3). |

## Eskalasi
1. Tingkat 1: dukungan umum (jawab dengan tabel di atas).
2. Tingkat 2: engineer on-call (insiden teknis, penghapusan gagal).
3. Tingkat 3: pemilik layanan + penasihat hukum (kebocoran data, permintaan otoritas).

## Metrik dukungan (tanpa isi percakapan)
Jumlah tiket per kategori, waktu respons, jumlah permintaan hapus/ekspor, jumlah laporan keselamatan.
