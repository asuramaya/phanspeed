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

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Pill from './pill.js';

const {isObj, num, esc, row, wrapRow} = Pill;
const {PALETTE, CHIP, CHIP_ON, DOT, DOT_ON} = Pill;
const {ACCENT, DIM, GOOD, WARN} = PALETTE;

const STATUS_PATH = '/run/phanspeed/status.json';
const SOCK_PATH = '/run/phanspeed/control.sock';

// re-check cadence for the pill's own "update available" row — independent of
// phanspeed-update.timer (which only notifies/logs, never paints the UI).
const UPDATE_CHECK_SECONDS = 6 * 3600;

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

// The missions — the gestalt of the app. Each fights one of the things that
// cripple a laptop and re-skins the pill's hero readout to its own metric.
// `cool` stays a fully valid daemon/CLI mission (`phanspeed mission cool`) —
// it's just not offered as a pill chip: it was born from a dead fan that's
// since been repaired, and Perf's own fan-curve pick already covers it
// mechanically (LEVEL_NAMES[2] prefers 'cool'), so a third chip was a
// distinction without a difference for day-to-day use.
const MISSIONS = ['cool', 'perf', 'endure'];
const PILL_MISSIONS = ['perf', 'endure'];
const MISSION_LABEL = {cool: '🧊 Cool', perf: '🔥 Perf', endure: '🔋 Endure'};
const MISSION_ICON = {
    cool: 'power-profile-power-saver-symbolic',
    perf: 'power-profile-performance-symbolic',
    endure: 'battery-symbolic',
};
const INTENSITY_MAX = 4;

function tColor(t) {
    if (t == null)
        return DIM;
    if (t < 60)
        return '#4caf50';
    if (t < 80)
        return '#ffbb33';
    return '#ff5b5b';
}
function fmtMin(rem) {
    if (rem == null)
        return '';
    const h = Math.floor(rem / 60), m = Math.round(rem % 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}
function fmtWh(wh) {
    return wh < 1 ? wh.toFixed(2) : wh.toFixed(1);
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
    return Pill.readStatusFile(STATUS_PATH);
}

const PhanToggle = GObject.registerClass(
class PhanToggle extends QuickMenuToggle {
    _init(cancellable) {
        super._init({title: 'PhanSpeed', iconName: DEFAULT_ICON, toggleMode: true});
        this.menu.setHeader(DEFAULT_ICON, 'PhanSpeed', 'Thermal control');
        this._cancellable = cancellable;

        // ---- the face: mission chips + intensity + one hero readout ---- //
        this._missionItems = {};
        this._missionSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._missionSection);
        this._buildMissions();
        this._intensityItems = [];
        this._intensitySection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._intensitySection);
        this._buildIntensity();

        // power-clamp / alert banner (hidden until something's wrong)
        this._alertSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._alertSection);
        this._clampItem = row('');
        this._clampItem.visible = false;
        this._alertSection.addMenuItem(this._clampItem);
        this._gpuClampItem = row('');
        this._gpuClampItem.visible = false;
        this._alertSection.addMenuItem(this._gpuClampItem);

        // always-visible power readout — CPU/GPU actual watts + clocks, so a
        // repeat of the platform_profile GPU-clamp incident (v0.26.2) is
        // obvious at a glance instead of needing a shell to diagnose. Wraps
        // instead of ellipsizing: the parts glue their own words with NBSPs,
        // so a wrap can only ever land on a separator.
        this._powerReadoutItem = wrapRow('');
        this.menu.addMenuItem(this._powerReadoutItem);

        // hero readout (re-skins per mission) + live temps/fans
        this._sceneItem = row('—');
        this.menu.addMenuItem(this._sceneItem);
        this._tempItem = row('—');
        this.menu.addMenuItem(this._tempItem);

        // ---- Advanced (collapsed): raw profile + power/gpu/turbo/epp/battery ---- //
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._advancedOpen = false;
        this._advancedToggle = new PopupMenu.PopupMenuItem('');
        this._advancedToggle.connect('activate', () => {
            this._advancedOpen = !this._advancedOpen;
            this._advancedBody.actor.visible = this._advancedOpen;
            this._updateAdvancedLabel();
        });
        this.menu.addMenuItem(this._advancedToggle);
        this._advancedBody = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._advancedBody);

        // While a mission owns the stance, it reasserts its own fixed power/
        // turbo/EPP values every poll — editing them here would silently get
        // overwritten a few seconds later, which is exactly the "what does this
        // slider even do" confusion the mission abstraction exists to prevent.
        // So Advanced is read-only status while a mission is active; editing
        // requires explicitly leaving the mission first.
        this._missionStatusSection = new PopupMenu.PopupMenuSection();
        this._advancedBody.addMenuItem(this._missionStatusSection);
        this._powerStatusItem = row('');
        this._missionStatusSection.addMenuItem(this._powerStatusItem);
        this._turboStatusItem = row('');
        this._missionStatusSection.addMenuItem(this._turboStatusItem);
        this._eppStatusItem = row('');
        this._missionStatusSection.addMenuItem(this._eppStatusItem);
        this._energyStatusItem = row('');
        this._missionStatusSection.addMenuItem(this._energyStatusItem);
        this._exitMissionItem = new PopupMenu.PopupMenuItem(
            '↩ Leave mission (manual control)');
        this._exitMissionItem.connect('activate', () => {
            this._send({cmd: 'set', mission: ''});
            this._scheduleRefresh();
        });
        this._missionStatusSection.addMenuItem(this._exitMissionItem);

        // CPU power submenu (built lazily). The legacy raw-profile row was removed
        // — Cool/Perf already exist as missions above, so it was a duplicate; and
        // the GPU power widget was removed (nvidia-smi -pl is firmware-locked here,
        // and polling the dGPU to feed it wakes it and clamps the CPU). These
        // editable widgets are only shown when no mission is active — see above.
        this._powerSection = new PopupMenu.PopupMenuSection();
        this._advancedBody.addMenuItem(this._powerSection);
        this._powerSub = null;
        this._powerItems = {};
        // turbo + energy preference
        this._cpuPrefSection = new PopupMenu.PopupMenuSection();
        this._advancedBody.addMenuItem(this._cpuPrefSection);
        this._cpuPrefBuilt = false;
        this._turboItem = null;
        this._eppSub = null;
        this._eppItems = {};
        this._batteryItem = new PopupMenu.PopupSwitchMenuItem('Quiet on battery', false);
        this._batteryItem.connect('toggled', (_i, state) => {
            if (this._syncing) return;   // ignore programmatic setToggleState echoes
            this._send({cmd: 'set', battery_aware: state});
            this._scheduleRefresh();
        });
        this._advancedBody.addMenuItem(this._batteryItem);
        this._advancedBody.actor.visible = false;
        this._updateAdvancedLabel();

        // update notice (hidden until a newer release is found) + version footer
        // — the update spine's face, shared with every pill (UNIFY.md Wave A #1/2).
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._updateSurface = new Pill.UpdateSurface('phanspeed', {
            cancellable: this._cancellable, onChanged: () => this._scheduleRefresh(),
        });
        this.menu.addMenuItem(this._updateSurface.updateItem);
        this.menu.addMenuItem(this._updateSurface.versionItem);

        // clicking the pill body cycles the mission: Perf → Endure → Perf → …
        this.connect('clicked', () => {
            const i = PILL_MISSIONS.indexOf(this._activeMission);   // '' or 'cool' → -1 → Perf
            this._send({cmd: 'set', mission: PILL_MISSIONS[(i + 1) % PILL_MISSIONS.length]});
            this._scheduleRefresh();
        });
        this._syncing = false;   // true while refresh() pushes state into widgets,
                                 // so their 'toggled' echoes don't loop back to the daemon
    }

    _send(obj) {
        Pill.sendCmd(SOCK_PATH, obj, this._cancellable, 'PhanSpeed');
    }

    checkForUpdate() {
        this._updateSurface.checkNow();
    }

    _updateAdvancedLabel() {
        this._advancedToggle.label.clutter_text.set_markup(
            `<span foreground="${DIM}">⚙ Advanced  ${this._advancedOpen ? '⌄' : '›'}</span>`);
    }

    _buildMissions() {
        const box = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const layout = new St.BoxLayout({x_expand: true});
        for (const m of PILL_MISSIONS) {
            const btn = new St.Button({
                label: MISSION_LABEL[m], x_expand: true, can_focus: true, style: CHIP,
            });
            btn.connect('clicked', () => {
                // toggle: clicking the active mission drops back to legacy control
                const off = this._activeMission === m;
                this._send({cmd: 'set', mission: off ? '' : m});
                this._scheduleRefresh();
            });
            layout.add_child(btn);
            this._missionItems[m] = btn;
        }
        box.add_child(layout);
        this._missionSection.addMenuItem(box);
    }

    _buildIntensity() {
        const box = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const layout = new St.BoxLayout({x_expand: true});
        const lab = new St.Label({text: 'intensity', style: `color:${DIM}; padding-right:8px;`});
        lab.y_align = 2;     // Clutter.ActorAlign.CENTER
        layout.add_child(lab);
        this._intensityItems = [];
        for (let i = 0; i <= INTENSITY_MAX; i++) {
            const btn = new St.Button({
                label: String(i), x_expand: true, can_focus: true, style: DOT,
            });
            btn.connect('clicked', () => {
                this._send({cmd: 'set', intensity: i});
                this._scheduleRefresh();
            });
            layout.add_child(btn);
            this._intensityItems.push(btn);
        }
        box.add_child(layout);
        this._intensitySection.addMenuItem(box);
        this._intensityRow = box;
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
            if (this._syncing) return;   // ignore programmatic setToggleState echoes
            this._send({cmd: 'set', power_auto: state});
            this._scheduleRefresh();
        });
        this._powerSub.menu.addMenuItem(this._powerAutoItem);
        this._powerSub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const add = (label, w) => {
            const it = new PopupMenu.PopupMenuItem(label);
            it.connect('activate', () => {
                this._send({cmd: 'set', power_auto: false, power_limit_w: w});
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

    _buildCpuPref(pref) {
        this._cpuPrefSection.removeAll();
        this._eppItems = {};
        this._turboItem = null;
        this._eppSub = null;
        if (pref.turbo_available) {
            this._turboItem = new PopupMenu.PopupSwitchMenuItem('Turbo boost', false);
            this._turboItem.connect('toggled', (_i, state) => {
                if (this._syncing) return;   // ignore programmatic setToggleState echoes
                this._send({cmd: 'set', turbo: state ? 'on' : 'off'});
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
                    this._send({cmd: 'set', epp: val});
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
            this._updateSurface.setVersion(null);   // updater is independent of the daemon
            return;
        }
        this._syncing = true;
        try {
            this._applyStatus(st);
        } finally {
            this._syncing = false;
        }
    }

    _applyStatus(st) {
        const power = isObj(st.power) ? st.power : {};
        if (!this._powerSub && power.available)
            this._buildPower(power);
        const gpuInfo = isObj(st.gpu) ? st.gpu : {};
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
        const lbl = PROFILE_LABEL[profile] || profile || '—';
        const mission = (typeof st.mission === 'string' && MISSIONS.includes(st.mission))
            ? st.mission : '';
        const intensity = num(st.intensity) ?? 2;
        const bal = isObj(st.power_balance) ? st.power_balance : {};
        this._activeMission = mission;

        this.iconName = (st.emergency || clamp.clamped)
            ? 'power-profile-performance-symbolic'
            : (mission ? MISSION_ICON[mission] : (PROFILE_ICON[profile] || DEFAULT_ICON));
        const inMission = mission !== '';
        this.checked = inMission;
        // battery_aware is a legacy-only knob — missions ignore it entirely — so
        // hide it while a mission is active rather than let it look live and do
        // nothing (matches the read-only-while-missioned treatment below).
        this._batteryItem.visible = !inMission;
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
        for (const m of PILL_MISSIONS)
            this._missionItems[m]?.set_style(m === mission ? CHIP_ON : CHIP);
        if (this._intensityRow)
            this._intensityRow.visible = mission !== '';
        this._intensityItems.forEach((b, i) =>
            b.set_style(i === intensity ? DOT_ON : DOT));

        // clamp banners — CPU (power-budget floor-clamp) and GPU (pinned to
        // an idle pstate despite real load, e.g. a platform_profile side
        // effect: busy-but-slow, invisible to a power-draw-only reading).
        if (clamp.clamped) {
            this._clampItem.visible = true;
            this._clampItem.label.clutter_text.set_markup(
                `<span foreground="#ffbb33">⚠ CPU clamped at ${clamp.cur_max_mhz} MHz`
                + ` — ${esc(clamp.reason || 'power limit')}</span>`);
        } else {
            this._clampItem.visible = false;
        }
        if (gpuInfo.clamped) {
            this._gpuClampItem.visible = true;
            const mhz = num(gpuInfo.clock_mhz), max = num(gpuInfo.max_clock_mhz);
            this._gpuClampItem.label.clutter_text.set_markup(
                `<span foreground="#ffbb33">⚠ GPU clamped at ${mhz != null ? Math.round(mhz) : '?'} MHz`
                + `${max ? ` of ${Math.round(max)}` : ''} despite load — check platform_profile</span>`);
        } else {
            this._gpuClampItem.visible = false;
        }

        // A mission reasserts its own fixed power/turbo/EPP values every poll, so
        // editing these while one's active is a silent no-op a few seconds later.
        // Swap to the read-only status rows + an explicit exit action instead.
        this._missionStatusSection.actor.visible = inMission;

        if (this._powerSub) {
            this._powerSub.visible = !inMission;
            const pauto = power.auto === true;
            const limit = num(power.limit_w) || 0;
            const cur = num(power.current_w);
            this._powerAutoItem.setToggleState(pauto);
            const label = pauto
                ? `CPU power: auto${cur != null ? ` · ${cur} W` : ''}`
                : (limit > 0 ? `CPU power: ${limit} W`
                    : (cur != null ? `CPU power: ${cur} W (default)` : 'CPU power limit'));
            this._powerSub.label.text = label;
            this._powerStatusItem.label.text = label;
            for (const [w, item] of Object.entries(this._powerItems))
                item.setOrnament(!pauto && Number(w) === limit
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        this._powerStatusItem.visible = power.available === true;

        if (this._turboItem) {
            // hide the editable switch entirely when turbo can't actually be
            // controlled (firmware-locked or it won't hold), or while a mission
            // owns it — a dead/no-op switch is worse than none
            this._turboItem.visible = pref.turbo_available === true && !inMission;
            this._turboItem.setToggleState(pref.turbo === true);
        }
        this._turboStatusItem.visible = pref.turbo_available === true;
        this._turboStatusItem.label.text = `Turbo boost: ${pref.turbo === true ? 'on' : 'off'}`;

        if (this._eppSub) {
            this._eppSub.visible = !inMission;
            const eppCfg = typeof pref.epp_cfg === 'string' ? pref.epp_cfg : '';
            const eppCur = typeof pref.epp === 'string' ? pref.epp : null;
            const label = eppCfg
                ? `Energy: ${EPP_LABEL[eppCfg] || eppCfg}`
                : `Energy: auto${eppCur ? ` · ${EPP_LABEL[eppCur] || eppCur}` : ''}`;
            this._eppSub.label.text = label;
            this._eppStatusItem.label.text = label;
            for (const [val, item] of Object.entries(this._eppItems))
                item.setOrnament(val === eppCfg
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        this._eppStatusItem.visible = !!this._eppSub;

        // exact energy spent since this mission started — the hardware RAPL
        // joule counter itself (see energy_wh in the daemon), not a periodic-
        // sample estimate
        const missionWh = num(st.mission_wh);
        this._energyStatusItem.visible = missionWh != null;
        if (missionWh != null) {
            const sinceS = num(st.mission_since_s);
            const parts = [`${fmtWh(missionWh)} Wh`];
            if (sinceS != null) {
                parts.push(fmtMin(sinceS / 60));
                if (sinceS > 0)
                    parts.push(`${(missionWh * 3600 / sinceS).toFixed(1)} W avg`);
            }
            this._energyStatusItem.label.text = `Session energy: ${parts.join(' · ')}`;
        }

        // headline readout — re-skinned to the active mission's hero metric
        if (mission === 'endure') {
            const bm = balanceMarkup(bal);
            const inw = num(bal.in_w), draw = num(bal.draw_w);
            const dgpu = typeof gpuInfo.runtime_status === 'string'
                ? gpuInfo.runtime_status : null;
            const extra = [];
            if (inw != null)
                extra.push(`in ${bal.in_est === true ? '~' : ''}${inw}W`);
            if (draw != null)
                extra.push(`draw ${draw}W`);
            if (dgpu)
                extra.push(`dGPU ${dgpu === 'suspended' ? 'asleep' : dgpu}`);
            // battery-only: all background work confined to the E-cores
            if (isObj(st.endure) && st.endure.ecores === true)
                extra.push('E-cores');
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

        // colour-coded live readout: CPU temp + fan RPM (passive readout only —
        // fan PWM is firmware-locked here, so there is no fan control to offer).
        const parts = [];
        if (cpu != null)
            parts.push(`CPU <span foreground="${tColor(cpu)}" font_weight="bold">${Math.round(cpu)}°</span>`);
        const fans = Object.values(isObj(st.fans) ? st.fans : {}).filter(isObj)
            .map(f => `${esc(String(f.label || 'Fan').replace(' Fan', ''))} `
                + `<span foreground="${DIM}">${f.rpm ? f.rpm : 'off'}</span>`);
        const markup = [parts.join('   '), fans.join('   ')].filter(s => s).join('   ·   ') || '—';
        this._tempItem.label.clutter_text.set_markup(`<span foreground="${DIM}">${markup}</span>`);

        // power readout: what's actually being drawn right now, not just the
        // configured cap — the number that would have caught the platform_profile
        // GPU-clamp incident (power draw alone looked "fine"; clock didn't).
        const cpuW = num(power.actual_w);
        const gpuW = num(gpuInfo.power_w), gpuMhz = num(gpuInfo.clock_mhz);
        const gpuMax = num(gpuInfo.max_clock_mhz);
        const inW = num(bal.in_w);
        const NB = ' ';   // NBSP: keeps each figure whole when the row wraps
        const pParts = [];
        if (cpuW != null)
            pParts.push(`CPU${NB}<span foreground="${ACCENT}">${cpuW}W</span>`);
        if (gpuInfo.asleep) {
            pParts.push(`GPU${NB}<span foreground="${DIM}">asleep</span>`);
        } else if (gpuInfo.releasing === true) {
            // idle and deliberately unpolled, so the driver can suspend it
            pParts.push(`GPU${NB}<span foreground="${DIM}">idle</span>`);
        } else if (gpuW != null || gpuMhz != null) {
            const gc = gpuInfo.clamped ? '#ff5b5b' : ACCENT;
            pParts.push(`GPU${NB}<span foreground="${gc}">`
                + `${gpuW != null ? `${Math.round(gpuW)}W` : '?W'}`
                + `${gpuMhz != null ? `${NB}@${NB}${Math.round(gpuMhz)}` : ''}`
                + `${gpuMax ? `/${Math.round(gpuMax)}` : ''}MHz</span>`);
        }
        if (inW != null) {
            // '~' marks a reconstructed figure: the firmware's own wall reading
            // was contradicted by the negotiated contract, so the contract is
            // shown instead (see plausible_in_w in the daemon).
            const tilde = bal.in_est === true ? '~' : '';
            pParts.push(`in${NB}<span foreground="${DIM}">${tilde}${inW}W</span>`);
        }
        if (pParts.length)
            this._powerReadoutItem.label.clutter_text.set_markup(
                `<span foreground="${DIM}">${pParts.join('  ·  ')}</span>`);
        this._powerReadoutItem.visible = pParts.length > 0;

        this.menu.setHeader(this.iconName, 'PhanSpeed', sub);

        // version footer + update notice — the update spine's face
        this._updateSurface.setVersion(typeof st.version === 'string' ? st.version : null);
    }
});

export default class PhanSpeedExtension extends Extension {
    enable() {
        this._cancellable = new Gio.Cancellable();
        this._toggle = new PhanToggle(this._cancellable);
        this._indicator = Pill.addQuickSettingsToggle(this._toggle);
        this._toggle.refresh();
        this._toggle.checkForUpdate();

        // event-driven: the daemon's atomic status.json rename lands here as
        // soon as it happens, plus a slow fallback tick for daemon-death/
        // monitor-miss detection (Pill.StatusWatcher, UNIFY.md Wave A #2).
        this._watcher = new Pill.StatusWatcher(
            STATUS_PATH, () => this._toggle.refresh(), {fallbackSeconds: 60});
        this._updateTimeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, UPDATE_CHECK_SECONDS, () => {
                this._toggle.checkForUpdate();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._updateTimeout) {
            GLib.source_remove(this._updateTimeout);
            this._updateTimeout = null;
        }
        this._watcher?.destroy();
        this._watcher = null;
        Pill.removeIndicator(this._indicator);
        this._indicator = null;
        this._toggle = null;
    }
}
