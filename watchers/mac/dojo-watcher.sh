#!/bin/bash
# Starcraft Dojo watcher (macOS): uploads new AutoSave replays to the platform.
# Requires: DOJO_URL and DOJO_TOKEN in ~/.config/starcraft-dojo/watcher.env
set -euo pipefail

CONFIG="$HOME/.config/starcraft-dojo/watcher.env"
STATE="$HOME/.config/starcraft-dojo/uploaded.txt"
REPLAYS="$HOME/Library/Application Support/Blizzard/StarCraft/Maps/Replays"

[ -f "$CONFIG" ] || { echo "Falta $CONFIG"; exit 1; }
# shellcheck source=/dev/null
source "$CONFIG"
: "${DOJO_URL:?DOJO_URL no definido}" "${DOJO_TOKEN:?DOJO_TOKEN no definido}"
mkdir -p "$(dirname "$STATE")"
touch "$STATE"

find "$REPLAYS" -iname "*.rep" -type f | while IFS= read -r rep; do
  hash=$(shasum -a 256 "$rep" | cut -c1-16)
  grep -q "^$hash$" "$STATE" && continue
  # BW autosave names contain commas/parens; curl -F needs the quoted-filename form
  status=$(curl -s -o /tmp/dojo-resp.json -w "%{http_code}" \
    -H "x-upload-token: $DOJO_TOKEN" \
    -F "file=@\"$rep\";filename=\"$(basename "$rep")\"" -F "source=autosave-mac" \
    "$DOJO_URL/api/upload") || status="000"
  if [ "$status" = "200" ]; then
    echo "$hash" >> "$STATE"
    echo "subido: $(basename "$rep")"
  else
    echo "error ($status): $(basename "$rep")" >&2
  fi
done
