#!/usr/bin/env bash
# Installs (or updates) Klipper for the current user.
set -euo pipefail

UUID="klipper@rubenv94.github.io"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"
DEST="$EXT_DIR/$UUID"

cd "$(dirname "$0")"

# Klipper used to be called Utklipp: remove the old extension and keep its history.
OLD_UUID="utklipp@rubenv94.github.io"
if [ -d "$EXT_DIR/$OLD_UUID" ]; then
  gnome-extensions disable "$OLD_UUID" 2>/dev/null || true
  rm -rf "${EXT_DIR:?}/$OLD_UUID"
  echo "Removed the old Utklipp extension."
fi
OLD_DATA="$HOME/.local/share/utklipp"
NEW_DATA="$HOME/.local/share/klipper"
if [ -d "$OLD_DATA" ] && [ ! -e "$NEW_DATA/history.json" ]; then
  mkdir -p "$NEW_DATA"
  cp -a "$OLD_DATA/." "$NEW_DATA/"
  rm -rf "$OLD_DATA"
  echo "Moved your clipboard history over from Utklipp."
fi

mkdir -p "$DEST"
cp metadata.json extension.js stylesheet.css "$DEST/"
echo "Installed to $DEST"

if gnome-extensions list | grep -qx "$UUID"; then
  gnome-extensions enable "$UUID"
  echo "Enabled. If you updated an existing install, restart GNOME Shell"
  echo "(X11: Alt+F2, r, Enter. Wayland: log out and back in) to load the new code."
else
  echo "Restart GNOME Shell (X11: Alt+F2, r, Enter. Wayland: log out and back in), then run:"
  echo "  gnome-extensions enable $UUID"
fi
