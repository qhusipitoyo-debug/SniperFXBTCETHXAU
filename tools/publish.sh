#!/usr/bin/env bash
# ============================================================
# tools/publish.sh — kirim hasil collector ke branch, dipakai oleh
# .github/workflows/collector.yml tiap akhir segmen.
#
# Kenapa dipisah dari YAML: logic "commit kalau ada yang berubah, rebase kalau branch
# bergerak, jangan pernah commit separuh berkas" adalah logic yang bisa salah dan harus
# bisa diuji di luar Actions. Jalankan dengan PUBLISH_DRY=1 untuk melihat apa yang akan
# terjadi tanpa menulis apa pun.
#
# Yang ditulis hanya keluaran collector & konteks pasar (calendar + sentiment).
# pair_stats.json dan seluruh kode tidak disentuh.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(stats/live_ledger.jsonl stats/live_stats.json stats/open_trades.json stats/calendar.json stats/sentiment.json)
BRANCH="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"
DRY="${PUBLISH_DRY:-0}"

for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then git add -- "$f"; fi
done

if git diff --cached --quiet; then
  echo "publish: tidak ada yang berubah di ledger — tidak ada commit"
  exit 0
fi

if [ "$DRY" = "1" ]; then
  echo "publish: DRY RUN (PUBLISH_DRY=1) — ini yang akan di-commit ke $BRANCH:"
  git status --short -- "${FILES[@]}"
  git diff --cached --numstat -- "${FILES[@]}"
  git reset -q -- "${FILES[@]}"   # dry run tidak boleh meninggalkan berkas di index
  exit 0
fi

git config user.name  "${GIT_AUTHOR_NAME:-github-actions[bot]}"
git config user.email "${GIT_AUTHOR_EMAIL:-419863+github-actions[bot]@users.noreply.github.com}"

LEDGER="${FILES[0]}"
NPLAN=0
if [ -f "$LEDGER" ]; then NPLAN=$(wc -l < "$LEDGER" | tr -d ' '); fi
MSG="stats: collector ${GITHUB_RUN_ID:-lokal} segmen ${PUBLISH_SEGMENT:-auto} — ${NPLAN} plan selesai"

git commit -q -m "$MSG"

# Branch bisa bergerak selama job berjalan (misalnya ada push lain). Ledger bersifat
# append-only dan ringkasannya ditulis utuh, jadi rebase di atas versi terbaru adalah
# jalan yang benar; dibatasi 3 percobaan supaya tidak jadi loop kalau konfliknya asli.
for i in 1 2 3; do
  if git push -q "origin" "HEAD:${BRANCH}"; then
    echo "publish: terkirim ke ${BRANCH} (${NPLAN} plan) — percobaan $i"
    exit 0
  fi
  echo "publish: push percobaan $i gagal, tarik ulang lalu coba lagi" >&2
  git pull --rebase -q "origin" "$BRANCH" || true
done

echo "publish: tetap gagal setelah 3 percobaan — baris segmen ini hilang, segmen berikutnya masih dicoba" >&2
exit 1
