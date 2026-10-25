# Dasbor admin

Alamat: `/admin` (tombol **Metrik** di sidebar aplikasi untuk admin). Setiap bagian punya URL sendiri (`/admin/users`, `/admin/settings`, dst) dan semua berlaku **seketika tanpa restart** (instance lain menyusul dalam ±10 detik).

## Peran
| Peran | Dari mana | Boleh |
|---|---|---|
| **Pemilik** | email di `ADMIN_EMAILS` (konfigurasi server) | Semua: pengguna, undangan, pengaturan situs, **provider/kunci API**, hitung ulang embedding, kill switch, metrik, audit; mengangkat/menurunkan admin; mengubah admin lain |
| **Admin** | pengguna dengan peran admin (diangkat pemilik) | Pengguna biasa (tangguhkan, pulihkan, hapus, cabut sesi, ubah nama/catatan), undangan pengguna, pengaturan situs, kill switch, metrik, audit; **melihat** (tanpa mengubah) provider |
| Pengguna | semua lainnya | Tidak melihat dasbor (halaman admin menjawab 404, bukan 403) |

Aturan perlindungan: pemilik hanya bisa diubah lewat konfigurasi server; tidak ada yang bisa menangguhkan/menghapus/mengubah peran **akunnya sendiri** dari dasbor; admin tidak bisa mengubah admin lain; peran admin hanya bisa diberikan pemilik.

## Bagian dasbor
| Bagian | Isi (CRUD) |
|---|---|
| **Ringkasan** | Angka kunci dan jalan pintas |
| **Pengguna** | **R**: tabel berpaginasi (cari, filter status/peran, urut, per halaman) + detail. **U**: tangguhkan/pulihkan, peran, nama, catatan internal, cabut semua sesi. **D**: hapus pengguna (workflow penghapusan akun yang sama; wajib ketik email). **C**: lewat Undangan (login memakai Google, jadi akun dibuat saat pertama masuk) |
| **Undangan** | **C**: undang email (peran pengguna/admin). **R**: tabel dengan status "menunggu/sudah dipakai". **D**: cabut. Berguna saat pendaftaran ditutup |
| **Provider AI** | **R**: provider/model per kemampuan (chat, embedding, STT, TTS, realtime) + sumber (dasbor/server) + status kunci dimask. **U**: ganti provider/model/suara, simpan atau ganti kunci API, uji koneksi, hitung ulang embedding. **D**: hapus kunci dari dasbor atau kembalikan satu kemampuan ke konfigurasi server |
| **Pengaturan situs** | Nama, slogan, email dukungan, tema bawaan, teks layar kosong dan pernyataan AI; aturan akses (pendaftaran terbuka/tertutup, batas domain email, mode pemeliharaan); batas penggunaan; biaya; teks bantuan krisis; catatan persona operator; halaman hukum; webhook alert; penahanan audio suara. **Kembalikan ke bawaan** per bagian |
| **Fitur (kill switch)** | Matikan/nyalakan fitur seketika (hanya bisa mematikan yang menyala di server) |
| **Metrik** | Penggunaan, biaya (jika harga diisi), latensi, dan metrik operasional |
| **Log audit** | Semua tindakan admin: siapa, kapan, apa, sasaran, rincian. Disimpan 365 hari |

## Yang bisa diatur dari dasbor vs hanya dari server
| Dari dasbor | Hanya dari konfigurasi server (sengaja) |
|---|---|
| Semua isi tabel "Pengaturan situs", provider, model, suara, dimensi embedding, kunci API vendor | `MONGODB_URI`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `ALLOWED_ORIGINS`, `ADMIN_EMAILS` (siapa pemilik), `SETTINGS_ENCRYPTION_KEY`, base URL provider (`*_BASE_URL`, mencegah SSRF), `NODE_ENV`, port |

Nilai dari dasbor **menimpa** nilai env; mengosongkan/reset mengembalikan ke env. Halaman menampilkan nilai yang sedang berlaku beserta sumbernya.

## Keamanan (dan kenapa begitu)
- **Admin mengelola akun, bukan isi percakapan.** Tidak ada endpoint dasbor yang mengembalikan pesan, memori, atau ringkasan; hanya metadata dan hitungan.
- **Kunci API dienkripsi** (AES-256-GCM) dengan `SETTINGS_ENCRYPTION_KEY` dari env (`openssl rand -base64 32`). Kunci tidak pernah dikembalikan utuh (hanya 4 karakter terakhir), tidak masuk log audit (hanya "vendor: diganti/dihapus"), dan tidak tersimpan jika kunci enkripsi belum diatur. **Simpan cadangan `SETTINGS_ENCRYPTION_KEY` terpisah dari database**: tanpa itu kunci tersimpan tidak bisa dibaca (isi ulang).
- **Validasi ketat**: skema strict (field asing ditolak), rentang angka, nama model dibatasi karakter aman (mencegah penyisipan path), URL webhook wajib https, halaman hukum di-escape (tanpa HTML dari admin).
- **Mengganti embedding** membuat vektor lama tidak dipakai: butuh konfirmasi, lalu "Hitung ulang embedding".
- **Provider mock ditolak** di staging/production.
- **Catatan persona** operator tidak bisa mengalahkan aturan keselamatan (gate keselamatan ada di kode, bukan di prompt).
- **Mode pemeliharaan** tidak mengunci admin; pendaftaran tertutup tidak mengeluarkan pengguna lama.
- Semua perubahan tercatat di log audit.

## Alur umum
- **Menutup akses sementara**: Pengaturan situs > Akses > Mode pemeliharaan.
- **Beta tertutup**: tutup pendaftaran, undang email beta lewat Undangan.
- **Mengganti vendor AI**: Provider AI > Ubah (atau Isi kunci) > Uji koneksi. Untuk embedding: konfirmasi lalu Hitung ulang.
- **Pengguna bermasalah**: Pengguna > Kelola > Tangguhkan (sesi dan panggilan aktif langsung diakhiri).
- **Insiden**: lihat [RUNBOOK.md](RUNBOOK.md).
