// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 asuramaya and PhanSpeed contributors
//
// PhanSpeed — Dell thermal/fan control as a GNOME Quick Settings pill.
// Reads the daemon's world-readable status snapshot for display, and sends
// control commands to the daemon's Unix socket on user action.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const STATUS_PATH = '/run/phanspeed/status.json';
const SOCK_PATH = '/run/phanspeed/control.sock';

const PROFILE_ICON = {
    quiet: 'power-profile-power-saver-symbolic',
    balanced: 'power-profile-balanced-symbolic',
    cool: 'power-profile-performance-symbolic',
    performance: 'power-profile-performance-symbolic',
};
const PROFILE_LABEL = {
    quiet: 'Quiet', balanced: 'Balanced', cool: 'Cool', performance: 'Performance',
};
const DEFAULT_ICON = 'power-profile-balanced-symbolic';

function isObj(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
}

function readStatus() {
    try {
        const [ok, bytes] = GLib.file_get_contents(STATUS_PATH);
        if (!ok)
            return null;
        const o = JSON.parse(new TextDecoder().decode(bytes));
        return isObj(o) ? o : null;     // defensively reject non-objects
    } catch (_e) {
        return null;
    }
}

function sendCmd(obj) {
    try {
        const client = new Gio.SocketClient();
        client.timeout = 2;             // never let a hung daemon freeze the shell
        const addr = new Gio.UnixSocketAddress({path: SOCK_PATH});
        const conn = client.connect(addr, null);
        const out = conn.get_output_stream();
        out.write_all(new TextEncoder().encode(JSON.stringify(obj) + '\n'), null);
        out.flush(null);
        conn.close(null);
        return true;
    } catch (e) {
        logError(e, 'PhanSpeed sendCmd');
        return false;
    }
}

const PhanToggle = GObject.registerClass(
class PhanToggle extends QuickMenuToggle {
    _init() {
        super._init({
            title: 'PhanSpeed',
            iconName: DEFAULT_ICON,
            toggleMode: true,
        });

        this.menu.setHeader(DEFAULT_ICON, 'PhanSpeed', 'Thermal control');

        this._profileItems = {};
        this._profileSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profileSection);

        // CPU power-limit submenu (added only when RAPL is available)
        this._powerSub = null;
        this._powerItems = {};

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._tempItem = new PopupMenu.PopupMenuItem('—', {reactive: false});
        this.menu.addMenuItem(this._tempItem);

        // Clicking the pill body toggles Auto (checked) on/off.
        this.connect('clicked', () => {
            sendCmd({cmd: 'set', mode: this.checked ? 'auto' : 'manual'});
            this._scheduleRefresh();
        });

        this._built = false;
    }

    _buildProfiles(choices) {
        this._profileSection.removeAll();
        this._profileItems = {};
        for (const name of choices) {
            const item = new PopupMenu.PopupMenuItem(PROFILE_LABEL[name] || name);
            item.connect('activate', () => {
                sendCmd({cmd: 'set', mode: 'manual', manual_profile: name});
                this._scheduleRefresh();
            });
            this._profileSection.addMenuItem(item);
            this._profileItems[name] = item;
        }
        this._built = true;
    }

    _buildPower(power) {
        // presets derived from the chip's base TDP, plus "Full"
        const base = (typeof power.base_w === 'number' && power.base_w > 0)
            ? power.base_w : 45;
        const min = power.min_w || 8;
        const presets = [...new Set([base, Math.round(base * 0.8),
                                     Math.round(base * 0.6), Math.round(base * 0.4)])]
            .filter(w => w >= min).sort((a, b) => b - a);

        this._powerSub = new PopupMenu.PopupSubMenuMenuItem('CPU power limit', true);
        this._powerSub.icon.icon_name = 'battery-symbolic';
        this._powerItems = {};

        const add = (label, w) => {
            const it = new PopupMenu.PopupMenuItem(label);
            it.connect('activate', () => {
                sendCmd({cmd: 'set', power_limit_w: w});
                this._scheduleRefresh();
            });
            this._powerSub.menu.addMenuItem(it);
            this._powerItems[w] = it;
        };
        add('Full (default)', 0);
        for (const w of presets)
            add(`${w} W`, w);

        // insert the submenu right after the profile section
        this.menu.addMenuItem(this._powerSub, 1);
    }

    _scheduleRefresh() {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    refresh() {
        const st = readStatus();
        if (!st || !st.ok) {
            this.subtitle = 'daemon offline';
            this.checked = false;
            this.iconName = DEFAULT_ICON;
            this._tempItem.label.text = 'phanspeedd not running';
            return;
        }
        if (!this._built && Array.isArray(st.choices))
            this._buildProfiles(st.choices.filter(c => typeof c === 'string'));

        const power = isObj(st.power) ? st.power : {};
        if (!this._powerSub && power.available)
            this._buildPower(power);

        const profile = typeof st.active_profile === 'string' ? st.active_profile : '';
        const auto = st.mode === 'auto';
        const temps = isObj(st.temps) ? st.temps : {};
        const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
        const cpu = num(temps['coretemp:Package id 0'] ?? temps['dell_ddv:CPU']);
        const gpu = num(temps['dell_ddv:Video']);
        const lbl = PROFILE_LABEL[profile] || profile || '—';

        this.iconName = st.emergency
            ? 'power-profile-performance-symbolic'
            : (PROFILE_ICON[profile] || DEFAULT_ICON);
        this.checked = auto;

        let sub = auto ? `Auto · ${lbl}` : lbl;
        if (cpu != null)
            sub += ` · ${Math.round(cpu)}°`;
        if (st.emergency)
            sub = `⚠ Emergency · ${Math.round(cpu ?? 0)}°`;
        this.subtitle = sub;

        for (const [name, item] of Object.entries(this._profileItems)) {
            const active = !auto && name === profile;
            item.setOrnament(active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }

        // power submenu: label shows the live cap, ornament marks the active preset
        if (this._powerSub) {
            const limit = num(power.limit_w) || 0;       // 0 = unmanaged
            const cur = num(power.current_w);
            this._powerSub.label.text = limit > 0
                ? `CPU power: ${limit} W`
                : (cur != null ? `CPU power: ${cur} W (default)` : 'CPU power limit');
            for (const [w, item] of Object.entries(this._powerItems)) {
                const active = Number(w) === limit;
                item.setOrnament(active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }
        }

        const line = [];
        if (cpu != null)
            line.push(`CPU ${Math.round(cpu)}°`);
        if (gpu != null)
            line.push(`GPU ${Math.round(gpu)}°`);
        const fans = Object.values(isObj(st.fans) ? st.fans : {})
            .filter(isObj)
            .map(f => `${String(f.label || 'Fan').replace(' Fan', '')} ${f.rpm ? f.rpm : 'off'}`);
        this._tempItem.label.text =
            [line.join('   '), fans.join('   ')].filter(s => s).join('   ·   ') || '—';

        this.menu.setHeader(this.iconName, 'PhanSpeed', sub);
    }
});

const PhanIndicator = GObject.registerClass(
class PhanIndicator extends SystemIndicator {
    _init() {
        super._init();
        this.toggle = new PhanToggle();
        this.quickSettingsItems.push(this.toggle);
    }
});

export default class PhanSpeedExtension extends Extension {
    enable() {
        this._indicator = new PhanIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._indicator.toggle.refresh();
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._indicator.toggle.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = null;
        }
        this._indicator?.quickSettingsItems.forEach(i => i.destroy());
        this._indicator?.destroy();
        this._indicator = null;
    }
}
