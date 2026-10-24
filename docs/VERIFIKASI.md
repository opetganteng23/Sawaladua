# Catatan verifikasi sumber (MTS bab 22)

MTS meminta: sebelum beta/rilis, verifikasi dokumentasi resmi penyedia dan layanan yang benar-benar dipakai, **catat tanggal pemeriksaan dan keputusan**. Dokumen ini adalah templatnya. Saya tidak mengisi nilai karena harga, kuota, dan ketentuan berubah dan harus dibaca dari sumber resmi.

| Hal yang diverifikasi | Sumber resmi (URL) | Tanggal diperiksa | Temuan | Keputusan |
|---|---|---|---|---|
| Penyedia LLM: nama model, harga, kuota, rate limit | | | | |
| Penyedia LLM: retensi data, penggunaan untuk pelatihan, lokasi pemrosesan, opsi penghapusan (untuk paket yang dipakai) | | | | |
| Penyedia embedding: model, dimensi, harga, ketentuan data | | | | |
| Penyedia STT/TTS/realtime: model, harga, ketentuan data audio | | | | |
| Protokol realtime (OpenAI Realtime / Gemini Live): nama event/field versi terkini cocok dengan adapter (`server/src/voice/providers`) | | | | |
| MongoDB Atlas: tier, Vector Search (dimensi maks, filter), backup, enkripsi at-rest, region | | | | |
| Google OAuth: persyaratan consent screen, authorized origins, verifikasi aplikasi | | | | |
| Hosting (Biznet Gio): spesifikasi VM, port, backup, lokasi data | | | | |
| UU PDP dan peraturan turunan yang berlaku untuk layanan ini (bersama penasihat hukum) | | | | |
| Info layanan krisis Indonesia untuk `CRISIS_RESOURCES_TEXT` (nomor/lembaga resmi) | | | | |
| Kebijakan toko aplikasi (hanya jika membuat pembungkus native) | | | | |

Pedoman pengisian:
- Tulis URL halaman resmi, bukan ringkasan dari pihak ketiga.
- Setiap keputusan yang memengaruhi privasi/biaya/keamanan dicatat bersama alasannya.
- Ulangi saat mengganti vendor/model/paket (lihat [PROVIDERS.md](PROVIDERS.md)).
