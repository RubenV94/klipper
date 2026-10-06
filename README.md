# Klipper

A simple clipboard history for GNOME (built and tested on Zorin OS 18 / GNOME Shell 46).

- **Super+V** opens the history at your mouse pointer (press it again or **Esc** to close)
- Type to search, **↑ / ↓** to move, **Enter** or click to paste
- Keeps text, pictures and screenshots
- ✕ removes a single entry, *Clear all* empties the list

It's a GNOME Shell extension, not a separate app. That means no background process, no polling, no `/dev/uinput` permissions and no `sudo`. It does nothing until you copy something or press the shortcut.

## Install

```bash
git clone https://github.com/RubenV94/klipper.git
cd klipper
./install.sh
```

Then restart GNOME Shell (on X11: `Alt+F2`, type `r`, Enter; on Wayland: log out and back in) and run:

```bash
gnome-extensions enable klipper@rubenv94.github.io
```

To update later: `git pull`, `./install.sh`, and restart GNOME Shell again.

## Uninstall

```bash
gnome-extensions disable klipper@rubenv94.github.io
rm -rf ~/.local/share/gnome-shell/extensions/klipper@rubenv94.github.io
rm -rf ~/.local/share/klipper        # deletes the saved history
```

## Details

- **Text and pictures.** Screenshots and copied images (PNG, JPEG, GIF, WebP, BMP, TIFF, up to 20 MB) show as thumbnails. Copied files from the file manager are not kept.
- **History is kept** in `~/.local/share/klipper/` (readable only by you): `history.json` for the list, `images/` for pictures. It holds the last 50 entries, and pictures are deleted when they drop off the list.
- **Search** looks through text entries; pictures show when the search box is empty.
- **Passwords:** anything a password manager marks as secret (KeePassXC and others) is never saved.
- **Terminals** get Ctrl+Shift+V instead of Ctrl+V automatically.
- **Super+V** is normally GNOME's shortcut for the notification list. Klipper takes it while enabled and gives it back when disabled. Super+M still opens notifications.
  If Super+V ever ends up unbound, run:
  `gsettings reset org.gnome.shell.keybindings toggle-message-tray`

## Troubleshooting

Watch the extension's log output:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i klipper
```

If the log says it could not grab Super+V, another app or a custom shortcut is using it. Check **Settings → Keyboard → Custom Shortcuts**.

## License

MIT


<img width="1001" height="645" alt="image" src="https://github.com/user-attachments/assets/92e4e0d8-21f8-4561-a83e-3a56a656ffc3" />
