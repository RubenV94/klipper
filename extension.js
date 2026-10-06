// Klipper – a simple clipboard history for GNOME Shell.
// Super+V opens it, Enter (or a click) pastes, Esc closes.
// Keeps text, pictures and screenshots.
//
// Everything is event-driven: nothing runs until you copy something or
// press the shortcut, so there is no background loop that can spin.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const HOTKEY = '<Super>v';
const MAX_ITEMS = 50;                     // entries kept (text and pictures together)
const MAX_TEXT = 200000;                  // ignore giant text copies
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // ignore pictures over 20 MB
const PREVIEW_LINES = 3;
const PREVIEW_CHARS = 200;
const SAVE_DELAY_MS = 500;
const PASTE_DELAY_MS = 80;

// Password managers (KeePassXC etc.) tag secrets with this – never store them.
const SECRET_MIME = 'x-kde-passwordManagerHint';

// Picture formats we keep, and the file extension each is saved with.
const IMAGE_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/webp': 'webp',
    'image/tiff': 'tiff',
};
const IMAGE_NAME_RE = /^[0-9a-f]{32}\.(png|jpg|gif|bmp|webp|tiff)$/;

// Terminals paste with Ctrl+Shift+V instead of Ctrl+V.
const TERMINALS = [
    'terminal', 'console', 'kgx', 'ptyxis', 'kitty', 'alacritty', 'wezterm',
    'tilix', 'konsole', 'foot', 'xterm', 'terminator', 'guake', 'blackbox',
];

function isPlainText(mime) {
    return mime.startsWith('text/plain') ||
        mime === 'UTF8_STRING' || mime === 'STRING' || mime === 'TEXT';
}

function preview(text) {
    const lines = text.replace(/\t/g, '  ').split('\n').map(l => l.trimEnd());
    while (lines.length && !lines[0].trim())
        lines.shift();
    let out = lines.slice(0, PREVIEW_LINES).join('\n');
    let cut = lines.length > PREVIEW_LINES;
    if (out.length > PREVIEW_CHARS) {
        out = out.slice(0, PREVIEW_CHARS);
        cut = true;
    }
    return cut ? `${out.trimEnd()}…` : out;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(v, hi));
}

// Two entries are "the same" if they hold the same text or the same picture.
function keyOf(item) {
    return item.type === 'image' ? `i:${item.file}` : `t:${item.text}`;
}

export default class KlipperExtension extends Extension {
    enable() {
        // Items, newest first: {type: 'text', text} or {type: 'image', file, mime}
        this._items = [];
        this._visible = [];
        this._rows = [];
        this._selected = 0;
        this._loaded = false;
        this._isOpen = false;
        this._timeouts = new Set();
        this._saveId = 0;
        this._action = 0;

        this._clipboard = St.Clipboard.get_default();
        const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'klipper']);
        this._dataFile = Gio.File.new_for_path(GLib.build_filenamev([dataDir, 'history.json']));
        this._imageDir = Gio.File.new_for_path(GLib.build_filenamev([dataDir, 'images']));
        this._load();

        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed',
            (_sel, type, source) => this._onOwnerChanged(type, source));

        this._freeSuperV();
        this._acceleratorId = global.display.connect('accelerator-activated',
            (_display, action) => {
                if (action === this._action)
                    this._toggle();
            });
        this._grabHotkey(5);
    }

    disable() {
        this._close();

        if (this._action) {
            global.display.ungrab_accelerator(this._action);
            Main.wm.allowKeybinding(this._bindingName, Shell.ActionMode.NONE);
            this._action = 0;
        }
        global.display.disconnect(this._acceleratorId);
        this._selection.disconnect(this._ownerId);

        const pendingSave = this._saveId !== 0;
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._saveId = 0;
        if (pendingSave)
            this._save();

        this._restoreSuperV();

        this._backdrop?.destroy();
        this._backdrop = null;
        this._popup = null;
        this._search = null;
        this._list = null;
        this._vkbd = null;
        this._shellKeys = null;
        this._selection = null;
        this._clipboard = null;
        this._items = null;
        this._visible = null;
        this._rows = null;
    }

    // ---------------------------------------------------------------- timers

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    // -------------------------------------------------------------- shortcut

    // GNOME uses Super+V for the notification list by default. Take it while
    // the extension is on and give it back when it's turned off.
    _freeSuperV() {
        this._shellKeys = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        const current = this._shellKeys.get_strv('toggle-message-tray');
        const kept = current.filter(k => k.toLowerCase() !== HOTKEY.toLowerCase());
        this._tookSuperV = kept.length !== current.length;
        if (this._tookSuperV)
            this._shellKeys.set_strv('toggle-message-tray', kept);
    }

    _restoreSuperV() {
        if (!this._tookSuperV || !this._shellKeys)
            return;
        const current = this._shellKeys.get_strv('toggle-message-tray');
        if (!current.some(k => k.toLowerCase() === HOTKEY.toLowerCase()))
            this._shellKeys.set_strv('toggle-message-tray', [HOTKEY, ...current]);
    }

    // GNOME releases Super+V a moment after the setting changes, so retry a
    // few times (a handful of attempts total, not a loop).
    _grabHotkey(retries) {
        const action = global.display.grab_accelerator(HOTKEY, Meta.KeyBindingFlags.NONE);
        if (action !== Meta.KeyBindingAction.NONE) {
            this._action = action;
            this._bindingName = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(this._bindingName,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
            return;
        }
        if (retries > 0)
            this._later(300, () => this._grabHotkey(retries - 1));
        else
            console.warn('[Klipper] Could not grab Super+V – another app or setting is using it.');
    }

    // ------------------------------------------------------------- clipboard

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source)
            return;
        const mimes = source.get_mimetypes();
        if (mimes.includes(SECRET_MIME))
            return;

        // Plain text wins when an app offers both (e.g. office apps).
        if (mimes.some(isPlainText)) {
            this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
                if (this._items)
                    this._addText(text);
            });
            return;
        }

        const mime = mimes.includes('image/png')
            ? 'image/png'
            : mimes.find(m => m in IMAGE_EXT);
        if (!mime)
            return;
        this._clipboard.get_content(St.ClipboardType.CLIPBOARD, mime, (_cb, bytes) => {
            if (this._items)
                this._addImage(bytes, mime);
        });
    }

    _addText(text) {
        if (!text || !text.trim() || text.length > MAX_TEXT)
            return;
        this._pushTop({type: 'text', text});
    }

    _addImage(bytes, mime) {
        const size = bytes?.get_size() ?? 0;
        if (size === 0 || size > MAX_IMAGE_BYTES)
            return;

        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes).slice(0, 32);
        const name = `${hash}.${IMAGE_EXT[mime]}`;
        const item = {type: 'image', file: name, mime};

        // Same picture copied again: just move it to the top.
        if (this._items.some(it => keyOf(it) === keyOf(item))) {
            this._pushTop(item);
            return;
        }

        GLib.mkdir_with_parents(this._imageDir.get_path(), 0o700);
        this._imageDir.get_child(name).replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null, (file, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    console.warn(`[Klipper] Could not save picture: ${e.message}`);
                    return;
                }
                if (this._items)
                    this._pushTop(item);
            });
    }

    _pushTop(item) {
        const key = keyOf(item);
        const i = this._items.findIndex(it => keyOf(it) === key);
        if (i === 0)
            return;
        if (i > 0)
            this._items.splice(i, 1);
        this._items.unshift(item);
        this._changed();
    }

    _changed() {
        if (this._items.length > MAX_ITEMS) {
            for (const old of this._items.splice(MAX_ITEMS))
                this._dropImageFile(old);
        }
        this._queueSave();
        if (this._isOpen)
            this._render();
    }

    _remove(item) {
        const i = this._items.indexOf(item);
        if (i < 0)
            return;
        this._items.splice(i, 1);
        this._dropImageFile(item);
        this._changed();
    }

    _clearAll() {
        const old = this._items;
        this._items = [];
        for (const it of old)
            this._dropImageFile(it);
        this._selected = 0;
        this._changed();
    }

    // Delete a picture's file once no entry uses it any more.
    _dropImageFile(item) {
        if (item.type !== 'image' || this._items.some(it => it.file === item.file))
            return;
        this._imageDir.get_child(item.file).delete_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
            try {
                file.delete_finish(res);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    console.warn(`[Klipper] Could not delete picture: ${e.message}`);
            }
        });
    }

    // --------------------------------------------------------------- storage

    _load() {
        this._dataFile.load_contents_async(null, (file, res) => {
            let loaded = [];
            try {
                const [, bytes] = file.load_contents_finish(res);
                const data = JSON.parse(new TextDecoder().decode(bytes));
                if (Array.isArray(data?.items)) {
                    for (const it of data.items) {
                        if (it?.type === 'image' && IMAGE_NAME_RE.test(it.file ?? '') && it.mime in IMAGE_EXT)
                            loaded.push({type: 'image', file: it.file, mime: it.mime});
                        else if (typeof it?.text === 'string')
                            loaded.push({type: 'text', text: it.text});
                    }
                }
            } catch (e) {
                const notFound = e instanceof GLib.Error &&
                    e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
                if (!notFound)
                    console.warn(`[Klipper] Could not read history: ${e.message}`);
            }
            if (!this._items)  // disabled in the meantime
                return;

            // Anything copied while the file was loading goes on top.
            const fresh = this._items;
            this._items = loaded.slice(0, MAX_ITEMS);
            this._loaded = true;
            for (const it of fresh.reverse())
                this._pushTop(it);
            this._removeOrphanImages();
            if (this._isOpen)
                this._render();
        });
    }

    // Clean up picture files that no entry points to (e.g. after a crash).
    _removeOrphanImages() {
        const used = new Set(this._items.filter(it => it.type === 'image').map(it => it.file));
        this._imageDir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null, (dir, res) => {
                let en;
                try {
                    en = dir.enumerate_children_finish(res);
                } catch {
                    return;  // no images folder yet
                }
                en.next_files_async(1000, GLib.PRIORITY_LOW, null, (_en, res2) => {
                    let infos = [];
                    try {
                        infos = en.next_files_finish(res2);
                    } catch {}
                    en.close_async(GLib.PRIORITY_LOW, null, null);
                    if (!this._items)
                        return;
                    for (const info of infos) {
                        const name = info.get_name();
                        if (IMAGE_NAME_RE.test(name) && !used.has(name) &&
                            !this._items.some(it => it.file === name))
                            this._dropImageFile({type: 'image', file: name});
                    }
                });
            });
    }

    _queueSave() {
        if (this._saveId)
            return;
        this._saveId = this._later(SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._save();
        });
    }

    _save() {
        if (!this._loaded)  // never overwrite the file before we've read it
            return;
        GLib.mkdir_with_parents(this._dataFile.get_parent().get_path(), 0o700);
        const json = JSON.stringify({version: 2, items: this._items});
        const bytes = new GLib.Bytes(new TextEncoder().encode(json));
        this._dataFile.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null, (file, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    console.warn(`[Klipper] Could not save history: ${e.message}`);
                }
            });
    }

    // -------------------------------------------------------------------- UI

    _buildUi() {
        // A transparent full-screen layer so clicks outside the popup close it.
        this._backdrop = new St.Widget({reactive: true, visible: false});
        this._backdrop.connect('button-press-event', (_actor, event) => {
            if (!this._isInsidePopup(event))
                this._close();
            return Clutter.EVENT_PROPAGATE;
        });

        this._popup = new St.BoxLayout({vertical: true, style_class: 'klipper-popup'});
        this._backdrop.add_child(this._popup);

        const header = new St.BoxLayout({style_class: 'klipper-header'});
        header.add_child(new St.Label({
            text: 'Clipboard',
            style_class: 'klipper-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const clearBtn = new St.Button({
            label: 'Clear all',
            style_class: 'klipper-clear',
            can_focus: false,
        });
        clearBtn.connect('clicked', () => this._clearAll());
        header.add_child(clearBtn);
        this._popup.add_child(header);

        this._search = new St.Entry({
            hint_text: 'Search…',
            style_class: 'klipper-search',
            can_focus: true,
        });
        this._search.clutter_text.connect('text-changed', () => {
            this._selected = 0;
            this._render();
        });
        this._search.clutter_text.connect('key-press-event',
            (_actor, event) => this._onKey(event));
        this._popup.add_child(this._search);

        this._list = new St.BoxLayout({vertical: true, style_class: 'klipper-list'});
        this._scroll = new St.ScrollView({
            style_class: 'klipper-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.child = this._list;
        this._popup.add_child(this._scroll);

        Main.layoutManager.uiGroup.add_child(this._backdrop);
    }

    _isInsidePopup(event) {
        const [x, y] = event.get_coords();
        const [px, py] = this._popup.get_transformed_position();
        const [w, h] = this._popup.get_transformed_size();
        return x >= px && x < px + w && y >= py && y < py + h;
    }

    _render() {
        this._list.destroy_all_children();
        this._rows = [];

        // Searching only looks at text; pictures show when the search is empty.
        const q = this._search.get_text().trim().toLowerCase();
        this._visible = q
            ? this._items.filter(it => it.type === 'text' && it.text.toLowerCase().includes(q))
            : [...this._items];

        if (!this._visible.length) {
            this._list.add_child(new St.Label({
                text: q ? 'No matches' : 'Nothing copied yet',
                style_class: 'klipper-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        this._visible.forEach((item, idx) => this._list.add_child(this._makeRow(item, idx)));
        this._select(this._selected, false);
    }

    _makeContent(item) {
        if (item.type === 'image') {
            const uri = this._imageDir.get_child(item.file).get_uri();
            return new St.Widget({
                style_class: 'klipper-thumb',
                style: `background-image: url("${uri}");`,
                x_expand: true,
            });
        }

        const label = new St.Label({
            text: preview(item.text),
            style_class: 'klipper-text',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return label;
    }

    _makeRow(item, idx) {
        const row = new St.BoxLayout({
            style_class: 'klipper-row',
            reactive: true,
            track_hover: true,
        });

        const body = new St.Button({
            style_class: 'klipper-item',
            x_expand: true,
            can_focus: false,
            child: this._makeContent(item),
        });
        body.connect('clicked', () => this._paste(item));
        row.add_child(body);

        const del = new St.Button({
            style_class: 'klipper-icon-btn',
            can_focus: false,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
        });
        del.connect('clicked', () => this._remove(item));
        row.add_child(del);

        row.connect('notify::hover', () => {
            if (row.hover)
                this._select(idx, false);
        });

        this._rows.push(row);
        return row;
    }

    _select(idx, scroll = true) {
        if (!this._rows.length)
            return;
        for (const r of this._rows)
            r.remove_style_pseudo_class('selected');
        this._selected = clamp(idx, 0, this._rows.length - 1);
        const row = this._rows[this._selected];
        row.add_style_pseudo_class('selected');
        if (scroll)
            this._scrollTo(row);
    }

    _scrollTo(row) {
        const adj = this._list.vadjustment;
        if (!adj)
            return;
        const box = row.get_allocation_box();
        if (box.y1 < adj.value)
            adj.value = box.y1;
        else if (box.y2 > adj.value + adj.page_size)
            adj.value = box.y2 - adj.page_size;
    }

    _onKey(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            this._close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter: {
            const item = this._visible[this._selected];
            if (item)
                this._paste(item);
            return Clutter.EVENT_STOP;
        }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ------------------------------------------------------------ open/close

    _toggle() {
        if (this._isOpen)
            this._close();
        else
            this._open();
    }

    _open() {
        if (!this._backdrop)
            this._buildUi();

        this._selected = 0;
        this._search.set_text('');
        this._render();

        this._backdrop.set_position(0, 0);
        this._backdrop.set_size(global.stage.width, global.stage.height);
        this._backdrop.show();
        if (this._list.vadjustment)
            this._list.vadjustment.value = 0;

        // Place the popup at the mouse pointer, kept inside that monitor.
        const [px, py] = global.get_pointer();
        const monitors = Main.layoutManager.monitors;
        const mi = Math.max(0, monitors.findIndex(m =>
            px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height));
        const wa = Main.layoutManager.getWorkAreaForMonitor(mi);
        const [, w] = this._popup.get_preferred_width(-1);
        const [, h] = this._popup.get_preferred_height(w);
        this._popup.set_position(
            Math.round(clamp(px, wa.x + 8, wa.x + wa.width - w - 8)),
            Math.round(clamp(py, wa.y + 8, wa.y + wa.height - h - 8)));

        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        if ((this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(this._grab);
            this._grab = null;
            this._backdrop.hide();
            return;
        }
        this._isOpen = true;
        this._search.grab_key_focus();
    }

    _close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._backdrop.hide();
    }

    // ----------------------------------------------------------------- paste

    _paste(item) {
        const shift = this._focusIsTerminal();
        this._close();

        if (item.type === 'text') {
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, item.text);
            // Give focus a moment to return to the window before pressing Ctrl+V.
            this._later(PASTE_DELAY_MS, () => this._sendPasteKeys(shift));
            return;
        }

        this._imageDir.get_child(item.file).load_contents_async(null, (file, res) => {
            let contents;
            try {
                [, contents] = file.load_contents_finish(res);
            } catch (e) {
                console.warn(`[Klipper] Could not read picture: ${e.message}`);
                this._remove(item);
                return;
            }
            if (!this._clipboard)
                return;
            this._clipboard.set_content(St.ClipboardType.CLIPBOARD, item.mime, new GLib.Bytes(contents));
            this._later(PASTE_DELAY_MS, () => this._sendPasteKeys(shift));
        });
    }

    _focusIsTerminal() {
        const w = global.display.get_focus_window();
        if (!w)
            return false;
        const cls = `${w.get_wm_class() ?? ''} ${w.get_wm_class_instance() ?? ''}`.toLowerCase();
        return TERMINALS.some(t => cls.includes(t));
    }

    // Uses GNOME's own virtual keyboard – no /dev/uinput or extra permissions.
    _sendPasteKeys(shift) {
        if (!this._vkbd) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._vkbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        const now = () => GLib.get_monotonic_time();
        const mods = shift ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L] : [Clutter.KEY_Control_L];
        for (const k of mods)
            this._vkbd.notify_keyval(now(), k, Clutter.KeyState.PRESSED);
        this._vkbd.notify_keyval(now(), Clutter.KEY_v, Clutter.KeyState.PRESSED);
        this._vkbd.notify_keyval(now(), Clutter.KEY_v, Clutter.KeyState.RELEASED);
        for (const k of [...mods].reverse())
            this._vkbd.notify_keyval(now(), k, Clutter.KeyState.RELEASED);
    }
}
