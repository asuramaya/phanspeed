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
const EPP_LABEL = {
    performance: 'Performance',
    balance_performance: 'Balanced (perf)',
    default: 'Default',
    balance_power: 'Balanced (power)',
    power: 'Power saving',
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

// Cancellable for in-flight socket ops; reset on enable, cancelled on disable.
let _cancellable = null;

function sendCmd(obj) {
    // Fully asynchronous: connect -> write -> close, never blocking the shell.
    const client = new Gio.SocketClient();
    client.timeout = 2;
    const addr = new Gio.UnixSocketAddress({path: SOCK_PATH});
    const payload = new TextEncoder().encode(JSON.stringify(obj) + '\n');
    const cancel = _cancellable;
    client.connect_async(addr, cancel, (src, res) => {
        let conn;
        try {
            conn = src.connect_finish(res);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'PhanSpeed connect');
            return;
        }
        conn.get_output_stream().write_all_async(
            payload, GLib.PRIORITY_DEFAULT, cancel, (out, ores) => {
                try {
                    out.write_all_finish(ores);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'PhanSpeed write');
                }
                conn.close_async(GLib.PRIORITY_DEFAULT, null, null);
            });
    });
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

        // CPU turbo + energy-preference live in their own section so they keep
        // their place regardless of which power/GPU submenus get inserted.
        this._cpuPrefSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._cpuPrefSection);
        this._cpuPrefBuilt = false;
        this._turboItem = null;
        this._eppSub = null;
        this._eppItems = {};

        // power-limit submenus (added only when the hardware is available)
        this._powerSub = null;
        this._powerItems = {};
        this._gpuSub = null;
        this._gpuItems = {};

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Quiet on battery
        this._batteryItem = new PopupMenu.PopupSwitchMenuItem('Quiet on battery', false);
        this._batteryItem.connect('toggled', (_i, state) => {
            sendCmd({cmd: 'set', battery_aware: state});
            this._scheduleRefresh();
        });
        this.menu.addMenuItem(this._batteryItem);

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
        // a finer ladder than just quarters, so a moderate cap (~base*⅔, the
        // sweet spot for a thermally-limited machine) is directly selectable
        const presets = [...new Set([1.0, 0.8, 0.66, 0.55, 0.44]
            .map(r => Math.round(base * r)))]
            .filter(w => w >= min).sort((a, b) => b - a);

        this._powerSub = new PopupMenu.PopupSubMenuMenuItem('CPU power limit', true);
        this._powerSub.icon.icon_name = 'battery-symbolic';
        this._powerItems = {};

        // "scale with temperature" switch at the top of the submenu
        this._powerAutoItem = new PopupMenu.PopupSwitchMenuItem(
            'Scale with temperature', false);
        this._powerAutoItem.connect('toggled', (_i, state) => {
            sendCmd({cmd: 'set', power_auto: state});
            this._scheduleRefresh();
        });
        this._powerSub.menu.addMenuItem(this._powerAutoItem);
        this._powerSub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const add = (label, w) => {
            const it = new PopupMenu.PopupMenuItem(label);
            it.connect('activate', () => {
                // picking a fixed cap turns off temperature scaling
                sendCmd({cmd: 'set', power_auto: false, power_limit_w: w});
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

    _buildGpu(gpu) {
        const min = Math.round(gpu.min_w || 1);
        const max = Math.round(gpu.max_w || 1);
        const presets = [...new Set([max, Math.round(max * 0.75),
                                     Math.round(max * 0.5), min])]
            .filter(w => w >= min && w <= max).sort((a, b) => b - a);

        this._gpuSub = new PopupMenu.PopupSubMenuMenuItem('GPU power limit', true);
        this._gpuSub.icon.icon_name = 'video-display-symbolic';
        this._gpuItems = {};

        const add = (label, w) => {
            const it = new PopupMenu.PopupMenuItem(label);
            it.connect('activate', () => {
                sendCmd({cmd: 'set', gpu_power_limit_w: w});
                this._scheduleRefresh();
            });
            this._gpuSub.menu.addMenuItem(it);
            this._gpuItems[w] = it;
        };
        add('Max (default)', 0);
        for (const w of presets)
            add(`${w} W`, w);

        this.menu.addMenuItem(this._gpuSub, 2);
    }

    _buildCpuPref(pref) {
        this._cpuPrefSection.removeAll();
        this._eppItems = {};
        this._turboItem = null;
        this._eppSub = null;

        if (pref.turbo_available) {
            this._turboItem = new PopupMenu.PopupSwitchMenuItem('Turbo boost', false);
            this._turboItem.connect('toggled', (_i, state) => {
                sendCmd({cmd: 'set', turbo: state ? 'on' : 'off'});
                this._scheduleRefresh();
            });
            this._cpuPrefSection.addMenuItem(this._turboItem);
        }

        if (pref.epp_available && Array.isArray(pref.epp_choices) &&
            pref.epp_choices.length) {
            this._eppSub = new PopupMenu.PopupSubMenuMenuItem('Energy preference', true);
            this._eppSub.icon.icon_name = 'power-profile-balanced-symbolic';
            const add = (label, val) => {
                const it = new PopupMenu.PopupMenuItem(label);
                it.connect('activate', () => {
                    sendCmd({cmd: 'set', epp: val});
                    this._scheduleRefresh();
                });
                this._eppSub.menu.addMenuItem(it);
                this._eppItems[val] = it;
            };
            add('Auto (leave alone)', '');
            for (const c of pref.epp_choices)
                add(EPP_LABEL[c] || c, c);
            this._cpuPrefSection.addMenuItem(this._eppSub);
        }
        this._cpuPrefBuilt = true;
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

        const gpuInfo = isObj(st.gpu) ? st.gpu : {};
        if (!this._gpuSub && gpuInfo.available)
            this._buildGpu(gpuInfo);

        const pref = isObj(st.cpu_pref) ? st.cpu_pref : {};
        if (!this._cpuPrefBuilt && (pref.turbo_available || pref.epp_available))
            this._buildCpuPref(pref);

        const cfg = isObj(st.config) ? st.config : {};
        const profile = typeof st.active_profile === 'string' ? st.active_profile : '';
        const auto = st.mode === 'auto';
        const onBattery = st.on_battery === true;
        const batteryAware = cfg.battery_aware === true;
        const temps = isObj(st.temps) ? st.temps : {};
        const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
        const cpu = num(temps['coretemp:Package id 0'] ?? temps['dell_ddv:CPU']);
        const gpuTemp = num(gpuInfo.temp) ?? num(temps['dell_ddv:Video']);
        const lbl = PROFILE_LABEL[profile] || profile || '—';

        this.iconName = st.emergency
            ? 'power-profile-performance-symbolic'
            : (PROFILE_ICON[profile] || DEFAULT_ICON);
        this.checked = auto;
        this._batteryItem.setToggleState(batteryAware);

        let sub = auto ? `Auto · ${lbl}` : lbl;
        if (onBattery && batteryAware)
            sub = `🔋 ${lbl}`;
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
            const pauto = power.auto === true;
            const limit = num(power.limit_w) || 0;       // 0 = unmanaged
            const cur = num(power.current_w);
            this._powerAutoItem.setToggleState(pauto);
            if (pauto)
                this._powerSub.label.text =
                    `CPU power: auto${cur != null ? ` · ${cur} W` : ''}`;
            else
                this._powerSub.label.text = limit > 0
                    ? `CPU power: ${limit} W`
                    : (cur != null ? `CPU power: ${cur} W (default)` : 'CPU power limit');
            for (const [w, item] of Object.entries(this._powerItems)) {
                const active = !pauto && Number(w) === limit;
                item.setOrnament(active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }
        }

        // GPU submenu: label shows the live cap + draw, ornament marks the cap
        if (this._gpuSub) {
            const cap = num(gpuInfo.cap_w) || 0;       // 0 = default/max
            const lim = num(gpuInfo.limit);
            const draw = num(gpuInfo.draw);
            this._gpuSub.label.text = cap > 0
                ? `GPU power: ${cap} W`
                : `GPU power: ${lim != null ? `${Math.round(lim)} W` : 'max'}${
                    draw != null ? ` · ${Math.round(draw)} W draw` : ''}`;
            for (const [w, item] of Object.entries(this._gpuItems)) {
                const active = Number(w) === cap;
                item.setOrnament(active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }
        }

        // turbo switch reflects the actual boost state; EPP submenu marks the cap
        if (this._turboItem)
            this._turboItem.setToggleState(pref.turbo === true);
        if (this._eppSub) {
            const eppCfg = typeof pref.epp_cfg === 'string' ? pref.epp_cfg : '';
            const eppCur = typeof pref.epp === 'string' ? pref.epp : null;
            this._eppSub.label.text = eppCfg
                ? `Energy: ${EPP_LABEL[eppCfg] || eppCfg}`
                : `Energy: auto${eppCur ? ` · ${EPP_LABEL[eppCur] || eppCur}` : ''}`;
            for (const [val, item] of Object.entries(this._eppItems)) {
                item.setOrnament(val === eppCfg
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }
        }

        const line = [];
        if (cpu != null)
            line.push(`CPU ${Math.round(cpu)}°`);
        if (gpuTemp != null)
            line.push(`GPU ${Math.round(gpuTemp)}°`);
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
        _cancellable = new Gio.Cancellable();
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
        if (_cancellable) {
            _cancellable.cancel();
            _cancellable = null;
        }
        this._indicator?.quickSettingsItems.forEach(i => i.destroy());
        this._indicator?.destroy();
        this._indicator = null;
    }
}
