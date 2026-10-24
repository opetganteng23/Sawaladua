# Model ancaman ringkas dan keputusan enkripsi (MTS 11.2)

Status: **rekomendasi untuk disetujui pemilik layanan**. Bukan penilaian keamanan independen.

## Aset utama
Isi curhat (pesan, transkrip), memori dan ringkasan, identitas akun, kunci provider AI, rahasia sesi.

## Ancaman dan kontrol yang ada

| Ancaman | Kontrol di aplikasi | Sisa risiko |
|---|---|---|
| Pengguna membaca/mengubah data pengguna lain | `userId` hanya dari sesi server; semua query difilter; tes isolasi untuk chat, memori, panggilan, sesi | Bug baru; jaga lewat tes regresi |
| Pembajakan sesi / CSRF / WebSocket lintas situs | Cookie httpOnly+SameSite, cek Origin dan header kustom; WebSocket mensyaratkan Origin terdaftar; sesi bisa dicabut | Perangkat pengguna dikuasai malware |
| Injeksi lewat isi percakapan (prompt injection) | Pesan pengguna diperlakukan sebagai data; gate keselamatan di server tidak bergantung prompt; output divalidasi | Model bisa dibujuk menjawab di luar persona; dipantau lewat evaluasi |
| Kebocoran lewat log/alert | Logger allowlist; alert dan metrik tanpa isi/identitas | Kesalahan manusia di konfigurasi proxy (mis. access log Nginx) |
| Kebocoran kunci | Kunci hanya di server; pemindai secret di CI; `.env` di-ignore | Kunci bocor dari server/backup |
| Penyalahgunaan biaya | Rate limit, batas harian, anggaran token, alert, kill switch | Penyalahgunaan terdistribusi |
| Akses berlebihan operator | Prosedur di DATA_LIFECYCLE; akun individual | Orang dalam dengan akses DB |
| Pencurian data dari database/backup | Tergantung enkripsi at-rest penyedia + kontrol akses | **Lihat keputusan di bawah** |

## Keputusan: enkripsi field-level di aplikasi

**Rekomendasi: tidak diterapkan di MVP**, dengan alasan:
1. Teks pesan dipakai untuk pencarian (regex/teks) dan ringkasan; enkripsi di sisi aplikasi merusak kueri database dan memaksa dekripsi massal di aplikasi.
2. Embedding memori tetap membocorkan informasi semantik walau teksnya dienkripsi, sehingga manfaat keamanannya sebagian.
3. Menulis sendiri manajemen kunci (rotasi, backup kunci, pemulihan) berisiko lebih besar daripada manfaatnya untuk beta kecil. Kehilangan kunci = kehilangan seluruh data.
4. Operator yang dapat mengakses server aplikasi tetap bisa mengakses kunci.

**Kontrol yang dipakai sebagai gantinya:** TLS di semua koneksi, enkripsi at-rest bawaan penyedia database, akses database terbatas (IP allowlist + akun individual), backup terenkripsi dengan akses terbatas, minimisasi data (konteks minimum ke provider, tanpa audio tersimpan, retensi yang bisa diatur).

**Kapan ditinjau ulang:** bila ada persyaratan hukum/kontrak yang menuntutnya, atau bila skala/sensitivitas meningkat. Opsi yang dipertimbangkan saat itu (verifikasi dukungan terkini di dokumentasi MongoDB): Client-Side Field Level Encryption atau Queryable Encryption, dengan KMS terkelola; lalu uji dampaknya pada pencarian dan Vector Search sebelum diterapkan.

**Yang tidak boleh diklaim** sebelum ada rancangan yang benar-benar memenuhinya: "enkripsi end-to-end".

## Yang perlu Anda putuskan
- [ ] Menyetujui keputusan di atas, atau meminta enkripsi field-level pada koleksi tertentu.
- [ ] Menentukan siapa yang punya akses produksi dan bagaimana akses dicatat.
