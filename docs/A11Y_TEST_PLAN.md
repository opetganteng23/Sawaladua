# Rencana uji aksesibilitas manual (MTS 10.5, 14.1)

Pengujian otomatis (axe, 5 tema, desktop + mobile) dan uji keyboard/focus-trap sudah berjalan di CI. Uji berikut **tidak bisa diotomatisasi** dan harus dilakukan manusia sebelum beta. Catat hasil di tabel akhir.

## Perangkat
- Windows: NVDA + Chrome/Firefox
- Android: TalkBack + Chrome
- iOS: VoiceOver + Safari (jika didukung target pengguna)
- Keyboard saja (tanpa mouse/touch), zoom 200%, mode kontras tinggi OS, "reduce motion" aktif

## Skenario (ulangi di tema terang dan gelap, minimal)
| # | Skenario | Yang diharapkan |
|---|---|---|
| 1 | Login dev/Google sampai onboarding | Semua kontrol punya label; urutan fokus masuk akal; checkbox 18+ dibaca jelas |
| 2 | Kirim pesan, tunggu balasan | Pembaca layar mengumumkan "Sawala sedang menulis balasan", lalu balasan **sekali** (bukan tiap potongan) |
| 3 | Balasan error / koneksi putus | Banner diumumkan (role=alert), tombol "Coba lagi" bisa dijangkau keyboard |
| 4 | Buka/tutup Memori dan Pengaturan | Fokus pindah ke dialog, Tab terjebak di dalam, Esc menutup, fokus kembali ke tombol pemicu; latar tidak terbaca |
| 5 | Ubah/hapus memori; selesaikan konflik | Tombol punya nama yang menyebut isi memori; hasil aksi diumumkan |
| 6 | Hapus percakapan dan hapus akun | Dialog konfirmasi jelas; ketik HAPUS bisa dilakukan keyboard; status penghapusan diumumkan |
| 7 | Panggilan suara | Penanda "Mikrofon aktif/tidak merekam" dibaca; status (mendengarkan/berpikir/berbicara) diumumkan sopan; tombol bisukan/akhiri/potong bisa dijangkau |
| 8 | Zoom 200% dan layar 320 px | Tidak ada konten terpotong atau scroll horizontal pada halaman |
| 9 | Kontras tinggi / reduce motion | Animasi mengetik dan transisi tema berhenti; teks tetap terbaca |
| 10 | Dasbor `/admin` | Tabel punya header; area geser tabel bisa difokus dan digulir dengan keyboard |

## Catatan hasil
| Tanggal | Penguji | Perangkat | # | Hasil | Temuan / tindak lanjut |
|---|---|---|---|---|---|
| | | | | | |
