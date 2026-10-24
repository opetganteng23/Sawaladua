# Deploy Sawala: Biznet Gio Cloud + PM2

Satu proses Node melayani **API dan PWA** (`web/dist`), jadi cukup satu aplikasi PM2 dan satu domain. Nginx hanya sebagai reverse proxy + TLS.

```
Internet -> Nginx :443 (TLS) -> Node/PM2 127.0.0.1:8787 -> MongoDB Atlas
```

> Langkah di panel Biznet Gio (membuat VM, firewall/security group, DNS) mengikuti konsol Biznet; saya tidak mengasumsikan detail konsolnya. Yang wajib: VM Linux (mis. Ubuntu LTS), port **80/443 terbuka**, port 8787 **tidak** dibuka ke publik, dan domain mengarah ke IP VM.

## 0. Sebelum produksi (jangan dilewati)

Dari MTS bab 18 (Gate 1), yang masih terbuka dan bukan urusan kode:
- Verifikasi ketentuan data provider AI (retensi, pelatihan, lokasi). **Sampai itu selesai, hanya pakai data sintetis / beta tertutup.**
- Isi `CRISIS_RESOURCES_TEXT` dari sumber resmi yang sudah diverifikasi.
- Kebijakan privasi, ketentuan penggunaan, usia minimum, retensi chat, kebijakan backup.
- Uji pemulihan backup MongoDB dan uji alur hapus akun di staging.

## 1. Siapkan VM

```bash
# Node.js 22 LTS atau lebih baru (contoh via NodeSource), git, nginx
sudo apt update && sudo apt install -y git nginx
node -v   # >= 22
sudo npm i -g pm2
```

Buat user non-root untuk aplikasi (mis. `sawala`) dan jalankan semua langkah berikut sebagai user itu.

## 2. MongoDB Atlas

1. Buat cluster dan user database dengan hak minimum pada database `sawala`.
2. Network Access: izinkan **hanya IP publik VM** (bukan 0.0.0.0/0).
3. Ambil connection string, isi `MONGODB_URI`.
4. (Opsional) Buat Vector Search index pada `memories.embedding` (dimensi = `EMBEDDING_DIMENSIONS`, cosine, filter field `userId` dan `status`), isi nama indexnya di `VECTOR_SEARCH_INDEX`. Tanpa ini, retrieval memakai cosine di aplikasi (tetap difilter `userId`).
5. Aktifkan backup Atlas dan uji restore.

## 3. Ambil kode dan build

```bash
git clone <repo-anda> sawala && cd sawala
npm ci
npm run build          # build web (web/dist) lalu server (server/dist)
mkdir -p logs
```

## 4. Konfigurasi `server/.env`

```bash
cp .env.example server/.env && chmod 600 server/.env
```

Minimal untuk produksi (nilai contoh, isi dengan milik Anda):

```
NODE_ENV=production
PORT=8787
MONGODB_URI=mongodb+srv://...
MONGODB_DB=sawala
SESSION_SECRET=<openssl rand -base64 48>
ALLOWED_ORIGINS=https://sawala.contoh.id        # origin publik persis, tanpa slash akhir
GOOGLE_CLIENT_ID=<client id OAuth web>
AUTH_DEV_LOGIN=false                             # wajib false; server menolak start jika true
LLM_PROVIDER=gemini
GEMINI_API_KEY=<...>
GEMINI_MODEL=<model dari dokumentasi resmi>
EMBEDDING_PROVIDER=gemini
GEMINI_EMBEDDING_MODEL=<...>
EMBEDDING_DIMENSIONS=256
CRISIS_RESOURCES_TEXT=<teks terverifikasi>
FEATURE_VOICE_CALLS=true
```

Server **menolak start** di production jika `AUTH_DEV_LOGIN=true`, `LLM_PROVIDER=mock`, atau `GOOGLE_CLIENT_ID` kosong. Di Google Cloud Console, tambahkan `https://sawala.contoh.id` ke *Authorized JavaScript origins* untuk Client ID tersebut.

## 5. Jalankan dengan PM2

```bash
npm run pm2:start            # = pm2 startOrReload ecosystem.config.cjs --env production
pm2 save
pm2 startup                  # jalankan perintah sudo yang ditampilkan agar hidup kembali setelah reboot
curl -s localhost:8787/healthz
```

Default **satu instance (fork)**. Rate limiter tersimpan di MongoDB sehingga aman untuk cluster: `PM2_INSTANCES=2 npm run pm2:start`. Tugas berkala (sapu percakapan sementara, lanjutan penghapusan) idempoten sehingga aman berjalan di tiap instance.

Log rotasi:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M && pm2 set pm2-logrotate:retain 14
```

Log aplikasi hanya berisi field operasional (request id, status, durasi, token); isi curhat tidak pernah dicatat. Jangan menambah log request body di Nginx.

## 6. Nginx + TLS

`/etc/nginx/sites-available/sawala`:

```nginx
server {
  listen 80;
  server_name sawala.contoh.id;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://$host$request_uri; }
}

server {
  listen 443 ssl http2;
  server_name sawala.contoh.id;
  # sertifikat dari certbot (langkah di bawah)
  ssl_certificate     /etc/letsencrypt/live/sawala.contoh.id/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sawala.contoh.id/privkey.pem;

  client_max_body_size 64k;
  access_log off;                       # hindari log yang bisa memuat data pengguna

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # Suara realtime (WebSocket): wajib meneruskan header Upgrade dan batas waktu baca panjang
  location ~ ^/api/calls/[a-f0-9]+/realtime$ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }

  # Streaming SSE: matikan buffering agar balasan mengalir
  location /api/chat {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 120s;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/sawala /etc/nginx/sites-enabled/
# Terbitkan sertifikat dulu (blok 443 belum bisa dimuat tanpa sertifikat):
sudo apt install -y certbot && sudo certbot certonly --webroot -w /var/www/html -d sawala.contoh.id
sudo nginx -t && sudo systemctl reload nginx
```

Cookie sesi bertanda `Secure` di production, jadi aplikasi **hanya berfungsi lewat HTTPS**; `X-Forwarded-Proto` wajib diteruskan (sudah di atas).

## 7. Update versi

```bash
cd ~/sawala && git pull && npm ci && npm test && npm run build
npm run pm2:start        # reload; shutdown rapi lewat SIGTERM
curl -s https://sawala.contoh.id/healthz
```

Rollback: `git checkout <tag/commit lama>`, build ulang, `npm run pm2:start`.

## 8. Checklist cepat pasca-deploy

- [ ] `https://domain/healthz` -> `{"ok":true}`
- [ ] Login Google berhasil; cookie `sawala_sid` HttpOnly + Secure
- [ ] Balasan chat mengalir (bukan datang sekaligus di akhir)
- [ ] `curl -I https://domain/api/conversations` -> 401 tanpa sesi
- [ ] Port 8787 tidak bisa diakses dari luar VM
- [ ] Hapus akun uji: statusnya `completed`
- [ ] Backup Atlas aktif dan restore pernah diuji
- [ ] `pm2 status` online dan `pm2 startup` sudah dijalankan

## 9. Staging

Pisahkan staging dari production: **database, kredensial Google, dan kunci provider berbeda**. Contoh konfigurasi: `.env.staging.example` (salin ke `server/.env` di server staging). Jalankan dengan `pm2 startOrReload ecosystem.config.cjs --env staging`. Server menolak start di staging bila dev login aktif atau LLM mock. Uji alur rilis di staging dulu: login, chat, hapus akun, restore backup, dan (jika suara dinyalakan) satu panggilan di perangkat nyata. Jangan menyalin data produksi ke staging.

## 10. Anggaran, biaya, dan metrik

- Batas token harian: `DAILY_TOKEN_BUDGET_GLOBAL` dan `DAILY_TOKEN_BUDGET_PER_USER` (0 = mati). Saat habis, pengguna menerima pesan jujur (`QUOTA_EXHAUSTED`) dan pesannya tetap tersimpan; pengguna dengan sinyal risiko tetap mendapat respons keselamatan tanpa memanggil model. Peringatan 80% dicatat di log (`budget_alert`).
- Isi `COST_PER_1M_INPUT_TOKENS` / `COST_PER_1M_OUTPUT_TOKENS` dari harga provider yang sudah Anda verifikasi untuk melihat estimasi biaya.
- Metrik agregat (tanpa isi percakapan): `GET /api/admin/usage?days=7` untuk email di `ADMIN_EMAILS`. Pasang pemeriksaan berkala/alert eksternal pada `/healthz` dan pantau error rate dari endpoint tersebut.

## 11. Panggilan suara

`FEATURE_VOICE_CALLS=true` menyalakan fitur (sudah true di contoh env). Tanpa `REALTIME_PROVIDER`, panggilan memakai mode browser (Chrome/Edge; server tidak menerima audio). Dengan `REALTIME_PROVIDER`, audio lewat server Sawala ke penyedia AI (lihat bagian 13 dan [docs/PROVIDERS.md](docs/PROVIDERS.md)). Syarat sebelum membuka ke pengguna: Gate 3 di [docs/RELEASE_GATES.md](docs/RELEASE_GATES.md); uji dulu di staging. Halaman harus HTTPS agar mikrofon diizinkan browser. Jika ada masalah, matikan seketika lewat kill switch di `/admin`.

## 12. Deploy otomatis (CD), migrasi, dan operasional lanjutan

**Skrip deploy** [scripts/deploy.sh](scripts/deploy.sh) (`scripts/deploy.sh <staging|production> [ref]`): ambil kode, `npm ci`, build, `npm run db:migrate`, `pm2 startOrReload`, smoke test `/healthz`, dan **rollback otomatis** ke commit sebelumnya jika gagal. Bisa dijalankan manual di server.

**Workflow GitHub** [.github/workflows/deploy.yml](.github/workflows/deploy.yml) (manual, `workflow_dispatch`): menjalankan CI dulu, lalu deploy lewat SSH, lalu smoke test dari luar. Siapkan sekali:
1. Di server, clone repo ke `~/sawala`, siapkan `server/.env`, dan buat user SSH khusus deploy dengan kunci SSH (bukan kata sandi).
2. GitHub > Settings > Environments: buat `staging` dan `production`. Aktifkan **Required reviewers** pada `production` agar ada persetujuan sebelum deploy.
3. Per environment, isi secret `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS` (hasil `ssh-keyscan`), dan variable `APP_URL`.
4. Staging dan production sebaiknya di server berbeda (nama proses PM2 sama: `sawala`).

**Migrasi database**: `server/src/migrations/`. Dijalankan otomatis saat server start dan eksplisit lewat `npm run db:migrate` (dipakai skrip deploy). Idempoten dan tidak destruktif. Migrasi 003 memasang validator `$jsonSchema` (level moderate) sebagai lapisan kedua di bawah validasi aplikasi.

**Atlas Vector Search**: `npm run db:vector-index` membuat index sesuai `VECTOR_SEARCH_INDEX` dan `EMBEDDING_DIMENSIONS` (hanya di Atlas). Menolak jika index sudah ada dengan dimensi berbeda. Tunggu status READY di konsol Atlas.

**Alert**: isi `ALERT_WEBHOOK_URL` (https) untuk menerima peringatan: anggaran 80%, kuota habis, error rate tinggi (>20% dalam 15 menit), error tak terduga, dan penghapusan akun gagal. Payload tanpa isi percakapan dan tanpa identitas pengguna; satu jenis maksimal sekali per jam.

**Dasbor dan kill switch**: email di `ADMIN_EMAILS` melihat tautan **Metrik** (`/admin`): penggunaan harian, latensi, error rate, estimasi biaya (jika harga diisi), dan saklar untuk mematikan fitur seketika tanpa restart (lintas instance ~10 detik). Saklar hanya bisa mematikan, tidak bisa menyalakan fitur yang mati di environment. Gunakan saat insiden (RUNBOOK).

**Dokumentasi API**: [docs/openapi.yaml](docs/openapi.yaml); tes memastikan isinya selalu sama dengan rute yang terdaftar.

## 13. Suara realtime dan penggantian provider

- Pilih provider lewat env (lihat [docs/PROVIDERS.md](docs/PROVIDERS.md)): contoh `REALTIME_PROVIDER=gemini` + `GEMINI_REALTIME_MODEL=...`, atau `cascade` dengan LLM/STT/TTS vendor mana pun.
- Nginx **wajib** meneruskan WebSocket (blok `location ~ ^/api/calls/.../realtime` di bagian 6). Tanpa itu panggilan gagal tersambung.
- Batas satu panggilan per pengguna dihitung per proses; pada PM2 cluster dua tab di instance berbeda bisa membuka dua panggilan. Server tetap membatasi total per proses.
- Verifikasi adapter native (OpenAI Realtime/Gemini Live) dengan kunci Anda di **staging** sebelum rilis: periksa latensi, kualitas bahasa Indonesia, dan alur keselamatan (ucapkan kalimat uji sintetis yang berisiko; harus muncul respons aman dan audio model berhenti).
- Mengganti model embedding: ikuti tabel di PROVIDERS.md (`npm run db:reembed`).
