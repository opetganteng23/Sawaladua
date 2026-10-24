#!/usr/bin/env bash
# Deploy di server (dijalankan lewat SSH oleh workflow CD, atau manual).
# Pakai: scripts/deploy.sh <staging|production> [ref=main]
# Urutan: ambil kode -> npm ci -> build -> migrasi -> pm2 reload -> smoke test -> rollback otomatis jika gagal.
set -euo pipefail

ENV_NAME="${1:-}"
REF="${2:-main}"
case "$ENV_NAME" in staging|production) ;; *) echo "Pakai: $0 <staging|production> [ref]" >&2; exit 64 ;; esac
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Ref tidak valid" >&2; exit 64; }

cd "$(dirname "$0")/.."
PORT="${SMOKE_PORT:-$(grep -E '^PORT=' server/.env 2>/dev/null | tail -1 | cut -d= -f2 || true)}"
PORT="${PORT:-8787}"
[ -f server/.env ] || { echo "server/.env tidak ada. Salin dari .env.example / .env.staging.example dulu." >&2; exit 65; }

PREV="$(git rev-parse HEAD)"
echo "== Deploy $ENV_NAME ref=$REF (sebelumnya $PREV)"

build_and_reload() {
  npm ci --no-audit --no-fund
  npm run build
  npm run db:migrate
  mkdir -p logs
  npx pm2 startOrReload ecosystem.config.cjs --env "$ENV_NAME" --update-env
  npx pm2 save >/dev/null
}

smoke() {
  for i in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" | grep -q '"ok":true'; then echo "Smoke test OK"; return 0; fi
    sleep 2
  done
  return 1
}

git fetch --tags --prune origin
git checkout --quiet "$REF"
if git rev-parse --verify --quiet "origin/$REF" >/dev/null; then git merge --ff-only "origin/$REF"; fi

if build_and_reload && smoke; then
  echo "== Deploy berhasil: $(git rev-parse --short HEAD)"
  exit 0
fi

echo "!! Deploy gagal, rollback ke $PREV" >&2
git checkout --quiet "$PREV"
npm ci --no-audit --no-fund && npm run build && npx pm2 startOrReload ecosystem.config.cjs --env "$ENV_NAME" --update-env || true
smoke || echo "!! Rollback juga belum sehat, periksa: pm2 logs sawala" >&2
exit 1
