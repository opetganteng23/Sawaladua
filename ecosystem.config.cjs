// PM2: satu proses Node melayani API + PWA (web/dist). Jalankan dari root repo setelah `npm run build`.
// Rate limiter tersimpan di MongoDB sehingga aman untuk lebih dari satu instance.
// Default 1 instance (fork). Untuk cluster: PM2_INSTANCES=2 npm run pm2:start (atau "max").
const n = process.env.PM2_INSTANCES || "1";
const cluster = n !== "1";

module.exports = {
  apps: [
    {
      name: "sawala",
      cwd: "./server", // server/.env dibaca dari sini
      script: "dist/index.js",
      exec_mode: cluster ? "cluster" : "fork",
      instances: cluster ? (n === "max" ? "max" : Number(n)) : 1,
      autorestart: true,
      max_memory_restart: "512M",
      kill_timeout: 10000, // beri waktu shutdown rapi
      time: true,
      out_file: "../logs/sawala.out.log", // hanya log operasional; isi curhat tidak dicatat aplikasi
      error_file: "../logs/sawala.err.log",
      merge_logs: true,
      env: { NODE_ENV: "development" },
      env_production: { NODE_ENV: "production" },
      env_staging: { NODE_ENV: "staging" },
    },
  ],
};
