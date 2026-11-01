#!/usr/bin/env bash
# FX Sniper — nyalakan panel localhost setelah login/restart.
#   panel http://localhost:8080  (analisis murni lokal, tanpa MT5 / bridge / terminal)
# Idempoten: yang sudah jalan tidak disentuh ulang, tidak ada yang dimatikan.
#   bash tools/autostart.sh --install    daftarkan ke autostart login (~/.config/autostart)
#   bash tools/autostart.sh              mulai apa yang belum jalan
#   bash tools/autostart.sh --status     lihat keadaan
#   bash tools/autostart.sh --uninstall  hapus entri autostart
set -u

# Autostart desktop berjalan dengan environment minimal (bukan shell rc), jadi PATH
# standar ditegaskan di sini; tanpa ini python3 bisa tidak ketemu.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/bin:/bin:$PATH"

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PANEL_PORT=8080
STATE_DIR="$HOME/.local/state/sniperfx"
LOG="$STATE_DIR/autostart.log"
mkdir -p "$STATE_DIR"
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# Deteksinya lewat port, bukan lewat nama proses: nama proses python sulit dipercaya
# dan pgrep -f sering ikut menjaring shell yang sedang menjalankan skrip ini.
up() { curl -sf --max-time 2 -o /dev/null "http://127.0.0.1:$1/" 2>/dev/null; }

status() {
  echo "panel  : $(up "$PANEL_PORT" && echo "jalan (http://localhost:$PANEL_PORT)" || echo tidak jalan)"
  echo "data   : $([ -f "$PROJ/stats/pair_stats.json" ] && echo "pair_stats.json ada" || echo "pair_stats.json BELUM ADA — jalankan: node tools/pair_stats.js")"
}

DESKTOP="$HOME/.config/autostart/sniperfx.desktop"

install_entry() {
  mkdir -p "$(dirname "$DESKTOP")"
  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=SniperFX autostart
Comment=panel analisis localhost:$PANEL_PORT setelah login
Exec=$PROJ/tools/autostart.sh
StartupNotify=false
Terminal=false
X-GNOME-Autostart-Enabled=true
EOF
  say "entri autostart ditulis: $DESKTOP -> $PROJ/tools/autostart.sh"
}

[ "${1:-}" = "--install" ] && { install_entry; exit 0; }
[ "${1:-}" = "--uninstall" ] && { rm -f "$DESKTOP" && say "entri autostart dihapus ($DESKTOP)"; exit 0; }
[ "${1:-}" = "--status" ] && { status; exit 0; }

say "autostart mulai (projek=$PROJ)"

if up "$PANEL_PORT"; then
  say "panel sudah jalan"
else
  ( cd "$PROJ" && setsid nohup python3 -m http.server "$PANEL_PORT" --bind 127.0.0.1 >> /tmp/sniper_panel.log 2>&1 < /dev/null & )
  say "panel dijalankan di http://localhost:$PANEL_PORT"
fi

sleep 2; status | tee -a "$LOG"
