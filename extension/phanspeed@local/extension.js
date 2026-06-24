// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 asuramaya and PhanSpeed contributors
//
// PhanSpeed — Dell thermal/fan control as a GNOME Quick Settings pill.
// Reads the daemon's status snapshot for display and sends control commands to
// the daemon's Unix socket on user action.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

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
    quiet: 'Quiet', balanced: 'Balanced', cool: 'Cool', performance: 'Perf',
};
const EPP_LABEL = {
    performance: 'Performance', balance_performance: 'Balanced (perf)',
    default: 'Default', balance_power: 'Balanced (power)', power: 'Power saving',
};
const EPP_SHORT = {
    performance: 'perf', balance_performance: 'bal-perf', default: 'def',
    balance_power: 'bal-pwr', power: 'pwr',
};
const DEFAULT_ICON = 'power-profile-balanced-symbolic';

// The three missions — the gestalt of the app. Each fights one of the things
// that cripple a laptop and re-skins the pill's hero readout to its own metric.
const MISSIONS = ['cool', 'perf', 'endure'];
const MISSION_LABEL = {cool: '🧊 Cool', perf: '🔥 Perf', endure: '🔋 Endure'};
const MISSION_ICON = {
    cool: 'power-profile-power-saver-symbolic',
    perf: 'power-profile-performance-symbolic',
    endure: 'battery-symbolic',
};
const INTENSITY_MAX = 4;

// concept palette
const ACCENT = '#b9acff';
const DIM = '#9aa0a6';
const GOOD = '#4caf50';
const WARN = '#ffbb33';
const CHIP = 'border-radius:13px; padding:6px 2px; margin:0 2px; color:#dedde6;'
    + ' background-color:rgba(255,255,255,0.07);';
const CHIP_ON = 'border-radius:13px; padding:6px 2px; margin:0 2px; color:#ffffff;'
    + ' font-weight:bold; background-color:#5b50a8;';
const DOT = 'border-radius:9px; padding:2px 0; margin:0 3px; color:#9aa0a6;'
    + ' background-color:rgba(255,255,255,0.05);';
const DOT_ON = 'border-radius:9px; padding:2px 0; margin:0 3px; color:#ffffff;'
    + ' font-weight:bold; background-color:#5b50a8;';

function isObj(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
}
function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
}
function tColor(t) {
    if (t == null)
        return DIM;
    if (t < 60)
        return '#4caf50';
    if (t < 80)
        return '#ffbb33';
    return '#ff5b5b';
}
function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}
function fmtMin(rem) {
    if (rem == null)
        return '';
    const h = Math.floor(rem / 60), m = Math.round(rem % 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}
// The Endure mission's break-even gauge: "+2W ▲ 11h" (holding) / "−8W ▼ 1h12m".
function balanceMarkup(bal) {
    const bw = num(bal && bal.battery_w);
    if (bw == null)
        return null;
    const up = bw >= 0;
    const arrow = up ? '▲' : '▼';
    const sign = bw > 0 ? '+' : (bw < 0 ? '−' : '');
    let s = `<span foreground="${up ? GOOD : WARN}" font_weight="bold">`
        + `${sign}${Math.abs(bw)}W ${arrow}</span>`;
    const rem = fmtMin(num(bal.remaining_min));
    if (rem)
        s += ` <span foreground="${DIM}">${up ? 'to full ' : ''}${rem}</span>`;
    return s;
}

function readStatus() {
    try {
        const [ok, bytes] = GLib.file_get_contents(STATUS_PATH);
        if (!ok)
            return null;
        const o = JSON.parse(new TextDecoder().decode(bytes));
        return isObj(o) ? o : null;
    } catch (_e) {
        return null;
    }
}

// Cancellable for in-flight socket ops; reset on enable, cancelled on disable.
let _cancellable = null;

function sendCmd(obj) {
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
        super._init({title: 'PhanSpeed', iconName: DEFAULT_ICON, toggleMode: true});
        this.menu.setHeader(DEFAULT_ICON, 'PhanSpeed', 'Thermal control');

        // mission chips (the primary, top-layer control) + intensity dots
        this._missionItems = {};
        this._missionSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._missionSection);
        this._buildMissions();
        this._intensityItems = [];
        this._intensitySection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._intensitySection);
        this._buildIntensity();

        // profile chips (secondary layer — picking one exits mission mode)
        this._profileItems = {};
        this._profileSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profileSection);

        // power-clamp / alert banner (hidden until something's wrong)
        this._alertSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._alertSection);
        this._clampItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._clampItem.visible = false;
        this._alertSection.addMenuItem(this._clampItem);

        // power + gpu submenus go in their own section (built lazily)
        this._powerSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._powerSection);
        this._powerSub = null;
        this._powerItems = {};
        this._gpuSub = null;
        this._gpuItems = {};

        // turbo + energy preference
        this._cpuPrefSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._cpuPrefSection);
        this._cpuPrefBuilt = false;
        this._turboItem = null;
        this._eppSub = null;
        this._eppItems = {};

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._batteryItem = new PopupMenu.PopupSwitchMenuItem('Quiet on battery', false);
        this._batteryItem.connect('toggled', (_i, state) => {
            sendCmd({cmd: 'set', battery_aware: state});
            this._scheduleRefresh();
        });
        this.menu.addMenuItem(this._batteryItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._sceneItem = new PopupMenu.PopupMenuItem('—', {reactive: false});
        this.menu.addMenuItem(this._sceneItem);
        this._tempItem = new PopupMenu.PopupMenuItem('—', {reactive: false});
        this.menu.addMenuItem(this._tempItem);

        // clicking the pill body toggles Auto on/off (and exits any mission)
        this.connect('clicked', () => {
            sendCmd({cmd: 'set', mission: '', mode: this.checked ? 'auto' : 'manual'});
            this._scheduleRefresh();
        });
        this._built = false;
    }

    _buildProfiles(choices) {
        this._profileSection.removeAll();
        this._profileItems = {};
        const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({x_expand: true});
        for (const name of choices) {
            const btn = new St.Button({
                label: PROFILE_LABEL[name] || name,
                x_expand: true, can_focus: true, style: CHIP,
            });
            btn.connect('clicked', () => {
                // picking a raw profile exits mission mode (legacy control)
                sendCmd({cmd: 'set', mission: '', mode: 'manual', manual_profile: name});
                this._scheduleRefresh();
            });
            box.add_child(btn);
            this._profileItems[name] = btn;
        }
        row.add_child(box);
        this._profileSection.addMenuItem(row);
        this._built = true;
    }

    _buildMissions() {
        const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({x_expand: true});
        for (const m of MISSIONS) {
            const btn = new St.Button({
                label: MISSION_LABEL[m], x_expand: true, can_focus: true, style: CHIP,
            });
            btn.connect('clicked', () => {
                // toggle: clicking the active mission drops back to legacy control
                const off = this._activeMission === m;
                sendCmd({cmd: 'set', mission: off ? '' : m});
                this._scheduleRefresh();
            });
            box.add_child(btn);
            this._missionItems[m] = btn;
        }
        row.add_child(box);
        this._missionSection.addMenuItem(row);
    }

    _buildIntensity() {
        const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({x_expand: true});
        const lab = new St.Label({text: 'intensity', style: `color:${DIM}; padding-right:8px;`});
        lab.y_align = 2;     // Clutter.ActorAlign.CENTER
        box.add_child(lab);
        this._intensityItems = [];
        for (let i = 0; i <= INTENSITY_MAX; i++) {
            const btn = new St.Button({
                label: String(i), x_expand: true, can_focus: true, style: DOT,
            });
            btn.connect('clicked', () => {
                sendCmd({cmd: 'set', intensity: i});
                this._scheduleRefresh();
            });
            box.add_child(btn);
            this._intensityItems.push(btn);
        }
        row.add_child(box);
        this._intensitySection.addMenuItem(row);
        this._intensityRow = row;
    }

    _buildPower(power) {
        const base = (typeof power.base_w === 'number' && power.base_w > 0)
            ? power.base_w : 45;
        const min = power.min_w || 8;
        const presets = [...new Set([1.0, 0.8, 0.66, 0.55, 0.44]
            .map(r => Math.round(base * r)))].filter(w => w >= min).sort((a, b) => b - a);

        this._powerSub = new PopupMenu.PopupSubMenuMenuItem('CPU power limit', true);
        this._powerSub.icon.icon_name = 'battery-symbolic';
        this._powerItems = {};
        this._powerAutoItem = new PopupMenu.PopupSwitchMenuItem('Scale with temperature', false);
        this._powerAutoItem.connect('toggled', (_i, state) => {
            sendCmd({cmd: 'set', power_auto: state});
            this._scheduleRefresh();
        });
        this._powerSub.menu.addMenuItem(this._powerAutoItem);
        this._powerSub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const add = (label, w) => {
            const it = new PopupMenu.PopupMenuItem(label);
            it.connect('activate', () => {
                sendCmd({cmd: 'set', power_auto: false, power_limit_w: w});
                this._scheduleRefresh();
            });
            this._powerSub.menu.addMenuItem(it);
            this._powerItems[w] = it;
        };
        add('Full (default)', 0);
        for (const w of presets)
            add(`${w} W`, w);
        this._powerSection.addMenuItem(this._powerSub);
    }

    _buildGpu(gpu) {
        const min = Math.round(gpu.min_w || 1);
        const max = Math.round(gpu.max_w || 1);
        const presets = [...new Set([max, Math.round(max * 0.75),
            Math.round(max * 0.5), min])].filter(w => w >= min && w <= max).sort((a, b) => b - a);
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
        this._powerSection.addMenuItem(this._gpuSub);
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
        if (pref.epp_available && Array.isArray(pref.epp_choices) && pref.epp_choices.length) {
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
            this._clampItem.visible = false;
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
        const clamp = isObj(st.cpu_clamp) ? st.cpu_clamp : {};
        const cpu = num(temps['coretemp:Package id 0'] ?? temps['dell_ddv:CPU']);
        const gpuTemp = num(gpuInfo.temp) ?? num(temps['dell_ddv:Video']);
        const lbl = PROFILE_LABEL[profile] || profile || '—';
        const mission = (typeof st.mission === 'string' && MISSIONS.includes(st.mission))
            ? st.mission : '';
        const intensity = num(st.intensity) ?? 2;
        const bal = isObj(st.power_balance) ? st.power_balance : {};
        this._activeMission = mission;

        this.iconName = (st.emergency || clamp.clamped)
            ? 'power-profile-performance-symbolic'
            : (mission ? MISSION_ICON[mission] : (PROFILE_ICON[profile] || DEFAULT_ICON));
        this.checked = auto || mission !== '';
        this._batteryItem.setToggleState(batteryAware);

        // subtitle (shown on the tile): the active mission re-skins it to its
        // own hero metric; clamp/emergency always win.
        let sub;
        if (mission === 'endure') {
            const bm = num(bal.battery_w);
            sub = bm != null
                ? `🔋 ${bm >= 0 ? '+' : '−'}${Math.abs(bm)}W ${bm >= 0 ? '▲' : '▼'}`
                    + (bal.remaining_min != null ? ` ${fmtMin(bal.remaining_min)}` : '')
                : '🔋 Endure';
        } else if (mission === 'perf') {
            const w = num(power.current_w);
            sub = `🔥 Perf${w != null ? ` · ${w}W` : ''}`
                + (cpu != null ? ` · ${Math.round(cpu)}°` : '');
        } else if (mission === 'cool') {
            sub = `🧊 Cool${cpu != null ? ` · ${Math.round(cpu)}°` : ''}`;
        } else {
            sub = auto ? `Auto · ${lbl}` : lbl;
            if (onBattery && batteryAware)
                sub = `🔋 ${lbl}`;
            if (cpu != null)
                sub += ` · ${Math.round(cpu)}°`;
        }
        if (clamp.clamped)
            sub = `⚠ Clamped · ${clamp.cur_max_mhz} MHz`;
        if (st.emergency)
            sub = `⚠ Emergency · ${Math.round(cpu ?? 0)}°`;
        this.subtitle = sub;

        // mission chips: highlight active; intensity dots only while in a mission
        for (const m of MISSIONS)
            this._missionItems[m]?.set_style(m === mission ? CHIP_ON : CHIP);
        if (this._intensityRow)
            this._intensityRow.visible = mission !== '';
        this._intensityItems.forEach((b, i) =>
            b.set_style(i === intensity ? DOT_ON : DOT));

        // profile chips: highlight the active one (only meaningful with no mission)
        for (const [name, btn] of Object.entries(this._profileItems))
            btn.set_style(!mission && name === profile ? CHIP_ON : CHIP);

        // clamp banner
        if (clamp.clamped) {
            this._clampItem.visible = true;
            this._clampItem.label.clutter_text.set_markup(
                `<span foreground="#ffbb33">⚠ CPU clamped at ${clamp.cur_max_mhz} MHz`
                + ` — ${esc(clamp.reason || 'power limit')}</span>`);
        } else {
            this._clampItem.visible = false;
        }

        if (this._powerSub) {
            const pauto = power.auto === true;
            const limit = num(power.limit_w) || 0;
            const cur = num(power.current_w);
            this._powerAutoItem.setToggleState(pauto);
            if (pauto)
                this._powerSub.label.text = `CPU power: auto${cur != null ? ` · ${cur} W` : ''}`;
            else
                this._powerSub.label.text = limit > 0
                    ? `CPU power: ${limit} W`
                    : (cur != null ? `CPU power: ${cur} W (default)` : 'CPU power limit');
            for (const [w, item] of Object.entries(this._powerItems))
                item.setOrnament(!pauto && Number(w) === limit
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        if (this._gpuSub) {
            const cap = num(gpuInfo.cap_w) || 0;
            const lim = num(gpuInfo.limit);
            const draw = num(gpuInfo.draw);
            this._gpuSub.label.text = cap > 0
                ? `GPU power: ${cap} W`
                : `GPU power: ${lim != null ? `${Math.round(lim)} W` : 'max'}${
                    draw != null ? ` · ${Math.round(draw)} W draw` : ''}`;
            for (const [w, item] of Object.entries(this._gpuItems))
                item.setOrnament(Number(w) === cap
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        if (this._turboItem)
            this._turboItem.setToggleState(pref.turbo === true);
        if (this._eppSub) {
            const eppCfg = typeof pref.epp_cfg === 'string' ? pref.epp_cfg : '';
            const eppCur = typeof pref.epp === 'string' ? pref.epp : null;
            this._eppSub.label.text = eppCfg
                ? `Energy: ${EPP_LABEL[eppCfg] || eppCfg}`
                : `Energy: auto${eppCur ? ` · ${EPP_LABEL[eppCur] || eppCur}` : ''}`;
            for (const [val, item] of Object.entries(this._eppItems))
                item.setOrnament(val === eppCfg
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }

        // headline readout — re-skinned to the active mission's hero metric
        if (mission === 'endure') {
            const bm = balanceMarkup(bal);
            const inw = num(bal.in_w), draw = num(bal.draw_w);
            const dgpu = typeof gpuInfo.runtime_status === 'string'
                ? gpuInfo.runtime_status : null;
            const extra = [];
            if (inw != null)
                extra.push(`in ${inw}W`);
            if (draw != null)
                extra.push(`draw ${draw}W`);
            if (dgpu)
                extra.push(`dGPU ${dgpu === 'suspended' ? 'asleep' : dgpu}`);
            this._sceneItem.label.clutter_text.set_markup(
                (bm || `<span foreground="${DIM}">🔋 measuring…</span>`)
                + (extra.length
                    ? `   <span foreground="${DIM}">${esc(extra.join(' · '))}</span>` : ''));
        } else if (mission === 'perf') {
            const w = num(power.current_w);
            const mhz = num(clamp.cur_max_mhz);
            const bits = [];
            if (mhz)
                bits.push(`<span foreground="${ACCENT}" font_weight="bold">${(mhz / 1000).toFixed(1)} GHz</span>`);
            if (w != null)
                bits.push(`<span foreground="${ACCENT}">${w} W</span>`);
            this._sceneItem.label.clutter_text.set_markup(bits.join('     ') || '🔥 Perf');
        } else if (mission === 'cool') {
            const w = num(power.current_w);
            this._sceneItem.label.clutter_text.set_markup(
                `<span foreground="${ACCENT}">🧊 ${w != null ? `${w} W cap` : 'cooling'}</span>`);
        } else if (power.available) {
            // legacy: adaptive scene readout (AC vs battery)
            const eppAvail = pref.epp_available === true;
            const acCapN = num(power.limit_w) || 0;
            const bCapN = num(power.battery_w) || 0;
            const acEpp = eppAvail
                ? (typeof pref.epp_cfg === 'string' && pref.epp_cfg
                    ? EPP_SHORT[pref.epp_cfg] || pref.epp_cfg : 'auto') : null;
            const bEpp = eppAvail
                ? EPP_SHORT[(typeof pref.battery_epp_cfg === 'string' &&
                    pref.battery_epp_cfg) || 'balance_power'] || 'bal-pwr' : null;
            const ac = `🔌 ${acCapN > 0 ? `${acCapN}W` : 'full'}${acEpp ? `·${acEpp}` : ''}`;
            const bt = `🔋 ${bCapN > 0 ? `${bCapN}W` : 'base'}${bEpp ? `·${bEpp}` : ''}`;
            this._sceneItem.label.clutter_text.set_markup(
                `<span foreground="${onBattery ? DIM : ACCENT}">${onBattery ? '  ' : '▶ '}${ac}</span>`
                + `    <span foreground="${onBattery ? ACCENT : DIM}">${onBattery ? '▶ ' : '  '}${bt}</span>`);
        } else {
            this._sceneItem.label.text = '—';
        }

        // colour-coded live readout
        const parts = [];
        if (cpu != null)
            parts.push(`CPU <span foreground="${tColor(cpu)}" font_weight="bold">${Math.round(cpu)}°</span>`);
        if (gpuTemp != null)
            parts.push(`GPU <span foreground="${tColor(gpuTemp)}" font_weight="bold">${Math.round(gpuTemp)}°</span>`);
        const fans = Object.values(isObj(st.fans) ? st.fans : {}).filter(isObj)
            .map(f => `${esc(String(f.label || 'Fan').replace(' Fan', ''))} `
                + `<span foreground="${ACCENT}">${f.rpm ? f.rpm : 'off'}</span>`);
        const markup = [parts.join('   '), fans.join('   ')].filter(s => s).join('   ·   ') || '—';
        this._tempItem.label.clutter_text.set_markup(`<span foreground="${DIM}">${markup}</span>`);

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
