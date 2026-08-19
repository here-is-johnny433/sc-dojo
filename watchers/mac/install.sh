#!/bin/bash
# Installs the Starcraft Dojo watcher on macOS (launchd, runs every 5 minutes).
# Usage: ./install.sh https://dojo.tudominio.com TU_UPLOAD_TOKEN
set -euo pipefail

URL="${1:?Uso: ./install.sh <url-de-la-plataforma> <upload-token>}"
TOKEN="${2:?Falta el upload token}"

CONFIG_DIR="$HOME/.config/starcraft-dojo"
BIN="$CONFIG_DIR/dojo-watcher.sh"
PLIST="$HOME/Library/LaunchAgents/com.starcraft-dojo.watcher.plist"

mkdir -p "$CONFIG_DIR"
cp "$(dirname "$0")/dojo-watcher.sh" "$BIN"
chmod +x "$BIN"

cat > "$CONFIG_DIR/watcher.env" <<EOF
DOJO_URL=$URL
DOJO_TOKEN=$TOKEN
EOF
chmod 600 "$CONFIG_DIR/watcher.env"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.starcraft-dojo.watcher</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$BIN</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$CONFIG_DIR/watcher.log</string>
  <key>StandardErrorPath</key><string>$CONFIG_DIR/watcher.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Watcher instalado. Corre cada 5 min. Log: $CONFIG_DIR/watcher.log"
