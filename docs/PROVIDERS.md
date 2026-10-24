# Provider AI yang bisa diganti-ganti

Setiap kemampuan dipilih **terpisah** lewat environment, jadi vendor bebas dicampur dan diganti tanpa mengubah kode.

| Kemampuan | Variabel | Pilihan | Catatan |
|---|---|---|---|
| Model bahasa (chat) | `LLM_PROVIDER` | `gemini`, `openai`, `anthropic`, `mock` | Model dari `GEMINI_MODEL` / `OPENAI_MODEL` / `ANTHROPIC_MODEL` |
| Embedding (memori, pencarian makna) | `EMBEDDING_PROVIDER` | `gemini`, `openai`, `mock` | **Anthropic tidak menyediakan embedding**; pakai Gemini/OpenAI |
| Speech-to-text | `STT_PROVIDER` | `none`, `gemini`, `openai`, `mock` | Dipakai mode cascade |
| Text-to-speech | `TTS_PROVIDER` | `none`, `gemini`, `openai`, `mock` | Tanpa TTS server, suara dibuat browser |
| Suara realtime | `REALTIME_PROVIDER` | `none`, `gemini`, `openai`, `cascade`, `mock` | Lihat bagian di bawah |

Kunci dan model per vendor ada di [.env.example](../.env.example). Semua nama model **diisi sendiri dari dokumentasi vendor** (tidak ditanam di kode, karena berubah). `OPENAI_BASE_URL` memungkinkan endpoint yang kompatibel dengan API OpenAI.

## Contoh kombinasi

```
# A. Satu vendor (paling sederhana): Gemini untuk semuanya
LLM_PROVIDER=gemini  EMBEDDING_PROVIDER=gemini  REALTIME_PROVIDER=gemini

# B. Claude untuk otak percakapan, OpenAI untuk embedding dan suara cascade
LLM_PROVIDER=anthropic  EMBEDDING_PROVIDER=openai
STT_PROVIDER=openai  TTS_PROVIDER=openai  REALTIME_PROVIDER=cascade

# C. Suara native OpenAI, chat teks tetap Claude
LLM_PROVIDER=anthropic  EMBEDDING_PROVIDER=openai  REALTIME_PROVIDER=openai
```

Server menolak start jika kunci/model yang dibutuhkan kurang, atau bila memilih kemampuan yang tidak dimiliki vendor (mis. embedding Anthropic). Di staging/production semua provider `mock` ditolak.

## Mengganti vendor: apa yang perlu dilakukan

| Yang diganti | Langkah |
|---|---|
| `LLM_PROVIDER` / model | Ubah env, `pm2 reload`. Prompt dan validasi output tetap sama. **Jalankan `npm -w server run eval` dan tinjau hasilnya**: persona/gaya bisa bergeser antar model |
| `EMBEDDING_PROVIDER` / model / dimensi | Ubah env, lalu `npm run db:reembed` (hitung ulang semua memori dan ringkasan). Sebelum itu, vektor lama otomatis **tidak dipakai** (ditandai tag provider/model/dimensi) sehingga tidak ada hasil ngawur. Jika memakai Atlas Vector Search, buat ulang index dengan dimensi baru (`npm run db:vector-index`) |
| `STT_PROVIDER` / `TTS_PROVIDER` | Ubah env dan reload |
| `REALTIME_PROVIDER` | Ubah env dan reload. Panggilan yang sedang berjalan tidak terputus oleh perubahan konfigurasi sampai proses di-reload |

Biaya, kuota, dan ketentuan data **berbeda per vendor**. Setiap penggantian vendor berarti meninjau ulang ketentuan datanya dan memperbarui kebijakan privasi (daftar pihak ketiga).

## Suara realtime ("AI speak")

Dua pendekatan, dipilih lewat `REALTIME_PROVIDER`:

| Mode | Cara kerja | Kelebihan | Kekurangan |
|---|---|---|---|
| **native** (`gemini`, `openai`) | Model speech-to-speech: audio masuk, audio keluar, latensi rendah | Paling natural dan cepat | Model menjawab **langsung** sebelum teksnya bisa divalidasi penuh; keselamatan dijaga dengan pengaman di bawah |
| **cascade** (`cascade`) | VAD di server → STT → balasan tervalidasi (LLM vendor mana pun, termasuk Claude) → TTS | Seluruh jaminan keselamatan chat teks berlaku penuh; bebas vendor | Lebih lambat (menunggu satu ucapan selesai) |
| Web Speech (otomatis jika realtime tidak dikonfigurasi) | Pengenalan suara di browser (Chrome/Edge) | Tanpa biaya provider | Terbatas browser; audio bisa ke vendor browser |

### Pengaman pada mode native

Karena model berbicara langsung, relay server (`server/src/voice/relay.ts`) menambah lapisan:

1. **Instruksi disusun server**: persona + gaya + memori + ringkasan sesi (bukan dari klien).
2. **Penahanan audio** (`VOICE_SAFETY_HOLD_MS`, default 600 ms): audio balasan ditahan sampai transkrip ucapan pengguna lolos safety gate, atau jeda habis.
3. **Pengunci sesi**: bila ucapan pengguna berisiko (level ≥ 2) atau model mengucapkan hal berbahaya, jawaban model dihentikan dan dibuang, lalu **seluruh sisa panggilan** berjalan lewat jalur tervalidasi yang sama dengan chat teks (respons tinjauan-manusia pada bahaya segera; LLM + instruksi keselamatan pada risiko lain), diucapkan lewat TTS server atau suara browser.
4. **Anggaran dan kuota**: dicek di awal dan tiap ucapan; pengguna berisiko tetap dijawab walau anggaran habis.
5. Transkrip disimpan/dihapus sesuai persetujuan; **audio tidak pernah disimpan**.

**Batas yang jujur:** (a) audio yang sudah terucap sebelum risiko terdeteksi tidak bisa ditarik; (b) memori hanya disuntik di awal panggilan, tidak per giliran; (c) provider native yang transkripsinya lambat membuat pemeriksaan tertinggal. Jika ini tidak bisa diterima untuk kelompok pengguna Anda, pakai **cascade**.

### Status verifikasi adapter

| Adapter | Diuji terhadap | Belum |
|---|---|---|
| OpenAI/Anthropic/Gemini HTTP (chat, embedding, STT, TTS) | Server HTTP palsu yang meniru bentuk API | **API asli** (butuh kunci Anda) |
| OpenAI Realtime, Gemini Live | Server WebSocket palsu sesuai dokumentasi publik | **API asli**. Nama event/field bisa berbeda antar versi; verifikasi sebelum rilis |
| Relay, VAD, cascade, WebSocket, klien browser | Provider mock + Chromium dengan mikrofon palsu (E2E) | Kualitas suara/latensi bahasa Indonesia di perangkat nyata |

## LiveKit: pilihan lanjutan

LiveKit (SFU WebRTC + kerangka agen) bisa meringankan **transport audio**: jitter buffer, adaptasi bandwidth, echo handling, dan TURN sudah ditangani, dan ada plugin STT/LLM/TTS serta model realtime. Untuk Sawala saat ini belum dipakai karena:

- Menambah komponen yang harus dijalankan (server LiveKit dengan port UDP, TLS/TURN, plus proses agen), padahal deployment Anda sengaja sederhana (Node + PM2, tanpa Docker). LiveKit Cloud menghilangkan beban itu tapi berbayar dan menambah pihak ketiga yang memproses audio.
- Jalur WebSocket yang ada sudah teruji end-to-end di sini, sedangkan LiveKit tidak bisa saya uji tanpa server dan kredensial Anda.

Pintu masuknya sudah disiapkan: logika keselamatan/privasi ada di `VoiceRelay`, terpisah dari transport lewat antarmuka `ClientLink` dan `RealtimeProvider`. Integrasi LiveKit nanti berupa agen (Node/Python) yang menjembatani audio track ke `VoiceRelay`, tanpa menulis ulang aturan keselamatan. Layak dipertimbangkan bila: pengguna banyak di jaringan buruk (seluler), latensi WebSocket terasa mengganggu, atau Anda mau panggilan multi-peserta. Cek dokumentasi LiveKit untuk persyaratan port dan versi terbaru.
