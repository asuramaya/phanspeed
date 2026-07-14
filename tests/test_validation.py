#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Hardware-free unit test for the config validator.

Imports phanspeedd (no hardware touched at import time) and fuzzes
sanitize_config + _coerce_num, asserting the safety invariants ALWAYS hold —
in particular that the thermal failsafe can never be disabled. Runs in CI on
every push/PR. Exit 0 = pass.
"""
import contextlib
import importlib.machinery as machinery
import importlib.util as util
import io
import json
import math
import os
import random
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
loader = machinery.SourceFileLoader("phanspeedd", os.path.join(HERE, "bin", "phanspeedd"))
spec = util.spec_from_loader("phanspeedd", loader)
m = util.module_from_spec(spec)
loader.exec_module(m)

CHOICES = ["cool", "quiet", "balanced", "performance"]
SENSORS = {"dell_ddv:CPU", "coretemp:Package id 0", "dell_ddv:Video"}
fails = []


def check(cfg, where):
    try:
        # failsafe can never be disabled or made meaningless
        assert isinstance(cfg["emergency_temp"], (int, float)), "emergency_temp type"
        assert cfg["emergency_temp"] <= 95, "FAILSAFE CEILING BREACHED"
        assert cfg["emergency_clear_temp"] < cfg["emergency_temp"], "clear>=emergency"
        assert cfg["cool_above"] > cfg["quiet_below"], "cool<=quiet"
        # enums
        assert cfg["mode"] in ("auto", "manual"), "bad mode"
        assert cfg["manual_profile"] in CHOICES, "bad manual_profile"
        assert cfg["battery_profile"] in CHOICES, "bad battery_profile"
        assert cfg["sensor"] == "auto" or cfg["sensor"] in SENSORS, "bad sensor"
        # numeric ranges + types
        for k in ("quiet_below", "cool_above", "hysteresis",
                  "emergency_temp", "emergency_clear_temp", "rate_limit"):
            v = cfg[k]
            assert isinstance(v, (int, float)) and not isinstance(v, bool), f"{k} type"
            assert not (isinstance(v, float) and math.isnan(v)), f"{k} nan"
        for k in ("power_limit_w", "power_floor_w", "battery_power_w",
                  "gpu_power_limit_w"):
            v = cfg[k]
            assert isinstance(v, int) and not isinstance(v, bool), f"{k} type"
            assert v == 0 or 8 <= v <= 250, f"{k} out of range"
        for k in ("power_auto", "battery_aware", "gpu_persistence"):
            assert isinstance(cfg[k], bool), f"{k} type"
        assert cfg["turbo"] in ("auto", "on", "off"), "bad turbo"
        for ek in ("epp", "battery_epp"):
            assert cfg[ek] == "" or cfg[ek] in m.VALID_EPP, f"bad {ek}"
        assert cfg["mission"] in ("", "cool", "perf", "endure"), "bad mission"
        iv = cfg["intensity"]
        assert isinstance(iv, int) and not isinstance(iv, bool), "intensity type"
        assert 0 <= iv <= m.INTENSITY_MAX, "intensity range"
        for bk in ("endure_gpu_sleep", "endure_trim", "endure_ecores",
                   "pin_deny_on_battery_endure"):
            assert isinstance(cfg[bk], bool), f"{bk} type"
        pu = cfg["endure_pause_units"]
        assert isinstance(pu, list) and len(pu) <= 16, "endure_pause_units shape"
        assert all(m.valid_unit_name(u) for u in pu), "invalid unit survived"
        assert all(isinstance(u, int) for u in cfg["allow_uids"]), "allow_uids type"
    except AssertionError as e:
        fails.append(f"[{where}] {e}")


# --- coerce edge cases -----------------------------------------------------
assert m._coerce_num(True, 0, 100) is None
assert m._coerce_num("5", 0, 100) is None
assert m._coerce_num(float("nan"), 0, 100) is None
assert m._coerce_num(float("inf"), 0, 100) is None
assert m._coerce_num(5, 0, 100) == 5
assert m._coerce_num(999, 0, 100) == 100
print("coerce edge cases OK")

# --- hostile fixed cases ---------------------------------------------------
HOSTILE = [
    {"emergency_temp": 9999, "mode": "manual", "manual_profile": "quiet"},
    {"quiet_below": "x", "cool_above": None, "hysteresis": True},
    {"cool_above": 10, "quiet_below": 80},
    {"emergency_clear_temp": 999},
    {"sensor": ["unhashable"], "battery_profile": {"x": 1}},
    {"power_limit_w": -5, "power_floor_w": 9e9, "gpu_power_limit_w": "max"},
    {"allow_uids": "everyone", "rate_limit": float("nan")},
    {"power_auto": "yes", "battery_aware": 1, "gpu_persistence": []},
    {"turbo": "maybe", "epp": "turbocharged"},
    {"turbo": 1, "epp": ["performance"], "battery_epp": 7},
    {"battery_epp": "fast"},
    {"mission": "ascend", "intensity": 99},
    {"mission": ["endure"], "intensity": "max"},
    {"mission": "endure", "intensity": -3, "endure_gpu_sleep": "yes"},
    {"endure_trim": 1, "endure_gpu_sleep": None},
]
for h in HOSTILE:
    cfg = m.sanitize_config(dict(m.DEFAULTS, **h), CHOICES, SENSORS)
    check(cfg, f"hostile:{list(h)}")

# --- random fuzz -----------------------------------------------------------
random.seed(7)
KEYS = list(m.DEFAULTS)
VALS = [None, True, False, -1e9, 1e9, "x", "auto", "cool", [], {}, 0, 8, 95,
        9999, float("nan"), float("inf"), -50, 3.5, "on", "off", "performance",
        "balance_power", "", "endure", "perf", 2, 4]
for _ in range(8000):
    bad = {}
    for k in random.sample(KEYS, random.randint(1, 6)):
        bad[k] = random.choice(VALS)
    cfg = m.sanitize_config(dict(m.DEFAULTS, **bad), CHOICES, SENSORS)
    check(cfg, "fuzz")

# --- legit values preserved ------------------------------------------------
cfg = m.sanitize_config(dict(m.DEFAULTS, mode="manual", manual_profile="cool",
                             power_limit_w=35, gpu_power_limit_w=40,
                             battery_aware=True, turbo="off",
                             epp="performance", battery_epp="balance_power"),
                        CHOICES, SENSORS)
assert cfg["manual_profile"] == "cool" and cfg["power_limit_w"] == 35
assert cfg["gpu_power_limit_w"] == 40 and cfg["battery_aware"] is True
assert cfg["turbo"] == "off" and cfg["epp"] == "performance"
assert cfg["battery_epp"] == "balance_power"
cfg = m.sanitize_config(dict(m.DEFAULTS, mission="endure", intensity=4,
                             endure_gpu_sleep=False, endure_trim=True),
                        CHOICES, SENSORS)
assert cfg["mission"] == "endure" and cfg["intensity"] == 4
assert cfg["endure_gpu_sleep"] is False and cfg["endure_trim"] is True
print("legit values preserved OK")

# --- fan-aware failsafe ----------------------------------------------------
# Constants must stay sane: the relaxed (fan-ok) ceiling sits at/above the locked
# config ceiling, and the debounce is at least one sample.
assert m.EMERGENCY_FAN_OK_TEMP >= m.NUM_LIMITS["emergency_temp"][1], "fan-ok ceiling too low"
assert m.EMERGENCY_DEBOUNCE >= 1, "debounce must be >= 1"


class _FanStub:
    def __init__(self, fans, rpm):
        self.fans, self._rpm = fans, rpm

    def read_rpm(self, idx):
        return self._rpm.get(idx)


_FanStub.cpu_fan_alive = m.Hardware.cpu_fan_alive
# a spinning CPU fan is detected even if the video fan is idle
assert _FanStub({"1": {"label": "CPU Fan"}, "2": {"label": "Video Fan"}},
                {"1": 2500, "2": 0}).cpu_fan_alive() is True
# a dead CPU fan (0 rpm) is NOT alive even when another fan spins
assert _FanStub({"1": {"label": "CPU Fan"}, "2": {"label": "Video Fan"}},
                {"1": 0, "2": 3000}).cpu_fan_alive() is False
# unreadable rpm => treated as dead (conservative)
assert _FanStub({"1": {"label": "CPU Fan"}}, {"1": None}).cpu_fan_alive() is False
# no CPU-labelled fan => fall back to any fan
assert _FanStub({"2": {"label": "Video Fan"}}, {"2": 2000}).cpu_fan_alive() is True
# regression: the fan-ok emergency trip must sit ABOVE Tjmax (~100 °C) so a chip
# that normally runs at its 100 °C ceiling under load doesn't trip the failsafe
# every burst (the v0.18→v0.21 thrash). Dead-fan path stays clamped at <=95.
assert m.EMERGENCY_FAN_OK_TEMP > 100, "fan-ok trip dropped to/under Tjmax"
assert m.NUM_LIMITS["emergency_temp"][1] <= 95, "dead-fan ceiling raised"
# sticky fan-alive: one transient dead read (SMI glitch under load) must NOT flip
# us to the aggressive dead-fan trip; a *persistent* dead fan eventually does.
deb = m.FAN_DEAD_DEBOUNCE
assert deb >= 2, "fan-dead debounce too small to absorb a glitch"
ok, streak = m._sticky_fan_ok(True, 0, deb)
assert ok and streak == 0
# single glitch while previously alive -> still considered alive
ok, streak = m._sticky_fan_ok(False, 0, deb)
assert ok is True and streak == 1, (ok, streak)
# a real dead fan reads 0 every poll -> after `deb` consecutive reads, believe it
s = 0
for _ in range(deb):
    ok, s = m._sticky_fan_ok(False, s, deb)
assert ok is False, f"persistent dead fan not detected after {deb} reads"
# one good read resets the streak (fan recovered / glitch passed)
ok, s = m._sticky_fan_ok(True, s, deb)
assert ok is True and s == 0
print("fan-aware failsafe logic OK")

# ---- phanspeed doctor: read-only reporter logic ---- #
ploader = machinery.SourceFileLoader("phanspeed_cli",
                                     os.path.join(HERE, "bin", "phanspeed"))
pcli = util.module_from_spec(util.spec_from_loader("phanspeed_cli", ploader))
ploader.exec_module(pcli)

# fan merge: two chips expose the same fans (one with labels, one with maxes);
# the doctor must show each fan ONCE, with both its label and its ceiling.
_orig_glob, _orig_readfile = pcli.glob.glob, pcli._readfile
_FAN_FS = {
    "/sys/class/hwmon/hwmon0/fan1_input": "1800",   # dell_smm: labels, no max
    "/sys/class/hwmon/hwmon0/fan1_label": "CPU Fan",
    "/sys/class/hwmon/hwmon0/fan2_input": "1700",
    "/sys/class/hwmon/hwmon0/fan2_label": "Video Fan",
    "/sys/class/hwmon/hwmon1/fan1_input": "1800",   # dell_ddv: maxes, no labels
    "/sys/class/hwmon/hwmon1/fan1_max": "4200",
    "/sys/class/hwmon/hwmon1/fan2_input": "1700",
    "/sys/class/hwmon/hwmon1/fan2_max": "4200",
}
pcli.glob.glob = lambda pat: ([k for k in _FAN_FS if k.endswith("fan1_input")
                               or k.endswith("fan2_input")]
                              if "fan" in pat else [])
pcli._readfile = lambda p: _FAN_FS.get(p)
fans = pcli._fans_hwmon()
pcli.glob.glob, pcli._readfile = _orig_glob, _orig_readfile
assert fans == [("CPU Fan", 1800, 4200), ("Video Fan", 1700, 4200)], fans
print("doctor fan-merge OK")

# watt-choke verdict: a mission cap below default must trip the warning; an
# unmanaged PL1 (effective == default) must read clear.
def _doctor_json(status):
    pcli._status = lambda: status
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        pcli.cmd_doctor(["--json"])
    return json.loads(buf.getvalue())


_capped = _doctor_json({"version": "x", "power": {
    "available": True, "effective_limit_w": 27, "default_w": 45},
    "mission": "cool", "intensity": 3})
assert _capped["effective_w"] == 27 and _capped["default_w"] == 45, _capped
assert _capped["mission"] == "cool"
_clear = _doctor_json({"version": "x", "power": {
    "available": True, "effective_limit_w": 200, "default_w": 200},
    "cpu_clamp": {"clamped": False}})
assert _clear["effective_w"] == 200 and not _clear["clamped"], _clear
print("doctor watt-choke fields OK")

# ---- wall-input plausibility (v0.28.0) ---- #
# the real WD22TB4 numbers: reported 32.5W (bogus 5V x 6.5A), contract 126.75W
# (19.5V x 6.5A), measured outflow ~90W → impossible, use the contract + latch
r = m.plausible_in_w(32.5, 126.75, 90.0, False)
assert r == (126.75, True, True), r
# latched: keeps trusting the contract even when the floor drops (idle)
r = m.plausible_in_w(32.5, 126.75, 5.0, True)
assert r == (126.75, True, True), r
# unproven at idle: reported covers the floor → keep it, no latch
r = m.plausible_in_w(32.5, 126.75, 20.0, False)
assert r == (32.5, False, False), r
# a genuine weak 5V charger: battery drains under load → floor stays 0/None,
# never falls back to the (over-optimistic) contract ceiling
r = m.plausible_in_w(15.0, 60.0, 0, False)
assert r == (15.0, False, False), r
r = m.plausible_in_w(15.0, None, 50.0, False)
assert r == (15.0, False, False), r

# ---- top-PDO detector (v0.28.1) ---- #
# the stealth case: on the 130W barrel the shift lands on an 18V PDO, so the
# reported 117W is *plausible* and no physics check can catch it. But the sink
# drew the source's full current (6.5A == current_max), which only its top fixed
# PDO can grant — so the contract is 20V x 6.5A, whatever voltage_now claims.
r = m.plausible_in_w(117.0, 130.0, 40.0, False, True)
assert r == (130.0, True, False), r        # deterministic — no latch needed
# proving it must not need load: true at idle too
r = m.plausible_in_w(117.0, 130.0, 0, False, True)
assert r == (130.0, True, False), r
# healthy firmware: voltage_now already == voltage_max, so contract == reported
# and nothing is substituted (contract_w <= reported_w short-circuits)
r = m.plausible_in_w(130.0, 130.0, 40.0, False, True)
assert r == (130.0, False, False), r
# partial contract (sink asked below the source's max current) → no top-PDO
# claim; falls through to the physics check, which clears it
r = m.plausible_in_w(45.0, 60.0, 40.0, False, False)
assert r == (45.0, False, False), r
print("wall-input plausibility OK")

# ---- Mains gate (v0.28.2) ---- #
# A USB-C connector can sit at online=1 with its last negotiated contract long
# after the dock stops delivering. Only the Mains supply drops the instant the
# plug leaves, so it is the authority on whether anything is feeding us.


def _psy(root, name, typ, online):
    d = os.path.join(root, name)
    os.makedirs(d)
    with open(os.path.join(d, "type"), "w") as f:
        f.write(typ + "\n")
    if online is not None:
        with open(os.path.join(d, "online"), "w") as f:
            f.write(str(online) + "\n")


with tempfile.TemporaryDirectory() as td:
    # the exact live trap: mains gone, but the PD source still claims online
    _psy(td, "AC", "Mains", 0)
    _psy(td, "ucsi-source-psy-USBC000:003", "USB", 1)
    _psy(td, "BAT0", "Battery", None)
    assert m.mains_online(td) is False, "stale PD source must not count as input"

with tempfile.TemporaryDirectory() as td:
    _psy(td, "AC", "Mains", 1)
    _psy(td, "ucsi-source-psy-USBC000:003", "USB", 1)
    assert m.mains_online(td) is True

with tempfile.TemporaryDirectory() as td:
    # a platform with no Mains supply at all: we cannot check, so don't blind
    # the ledger — fall back to trusting the sources
    _psy(td, "ucsi-source-psy-USBC000:003", "USB", 1)
    assert m.mains_online(td) is True, "no Mains supply → must not gate"

with tempfile.TemporaryDirectory() as td:
    # more than one Mains (dock + barrel): any one of them online counts
    _psy(td, "AC", "Mains", 0)
    _psy(td, "ADP1", "Mains", 1)
    assert m.mains_online(td) is True

print("Mains gate OK")

# ---- Endure E-core confinement (v0.29.0) ---- #
# topology parser: P-cores are the HT pairs, E-cores the singletons
SIB_12900H = ([(c, f"{c & ~1}-{(c & ~1) + 1}") for c in range(12)]
              + [(c, str(c)) for c in range(12, 20)])
assert m.little_cpus(SIB_12900H) == "12-19"
# non-contiguous E-cores compress into range lists
assert m.little_cpus([(0, "0-1"), (1, "0-1"), (4, "4"), (5, "5"), (9, "9")]) \
    == "4-5,9"
# HT everywhere (no E-cores) and HT nowhere (would misread all cores as E):
# both non-hybrid shapes must leave the feature inert
assert m.little_cpus([(c, f"{c & ~1}-{(c & ~1) + 1}") for c in range(8)]) is None
assert m.little_cpus([(c, str(c)) for c in range(8)]) is None
assert m.little_cpus([]) is None
# unreadable sibling files are skipped, not misclassified
assert m.little_cpus([(0, ""), (1, None), (2, "2"), (3, "3-4")]) == "2"

# trigger matrix: endure + battery + intensity>=3 + enabled + hybrid — only then
W = m.ecores_wanted
assert W("endure", 4, True, True, "12-19") is True
assert W("endure", 3, True, True, "12-19") is True
assert W("endure", 2, True, True, "12-19") is False   # intensity too low
assert W("endure", 4, False, True, "12-19") is False  # on AC
assert W("endure", 4, True, False, "12-19") is False  # disabled by config
assert W("endure", 4, True, True, None) is False      # not hybrid / hypervisor
assert W("perf", 4, True, True, "12-19") is False     # wrong mission
assert W("", 4, True, True, "12-19") is False         # emergency/legacy path

# unit-name gate: the daemon must never be able to stop itself, and only
# plausible systemd unit names are eligible at all
assert m.valid_unit_name("gestalt.service") is True
assert m.valid_unit_name("snap.cups.cupsd.service") is True
assert m.valid_unit_name("phanspeed.service") is False
assert m.valid_unit_name("phanspeedd.service") is False
assert m.valid_unit_name("rm -rf /.service") is False
assert m.valid_unit_name("noext") is False
assert m.valid_unit_name("") is False
assert m.valid_unit_name(42) is False
assert m.valid_unit_name("a" * 65 + ".service") is False
print("E-core confinement OK")

# ---- GPU idle-release (v0.28.3) ---- #
# polling an awake GPU resets its autosuspend timer, so after GPU_IDLE_POLLS
# consecutive idle samples the poller must let go
n, rel = m.gpu_idle_step(0, 0.0)
assert (n, rel) == (1, False)
n, rel = m.gpu_idle_step(1, 0.0)
assert (n, rel) == (2, False)
n, rel = m.gpu_idle_step(2, 0.0)
assert (n, rel) == (0, True), "third idle sample must release"
# genuine load resets the counter — a busy GPU is never released
n, rel = m.gpu_idle_step(2, 80.0)
assert (n, rel) == (0, False)
# unreadable utilization is NOT idle evidence (never release blind)
n, rel = m.gpu_idle_step(2, None)
assert (n, rel) == (0, False)
# boundary: exactly GPU_IDLE_UTIL_PCT still counts as idle
n, rel = m.gpu_idle_step(0, float(m.GPU_IDLE_UTIL_PCT))
assert (n, rel) == (1, False)
print("GPU idle-release OK")

# ---- exact mission-energy ledger (v0.29.1) ---- #
# total_uj/baseline_uj come from the daemon's already-unwrapped, monotonically
# accumulated CPU-package joule counter, so this is unit conversion only — no
# wraparound handling belongs here (that already happened before accumulation).
assert m.energy_wh(None) is None
assert m.energy_wh(3_600_000_000) == 1.0            # 3.6 MJ = 1 Wh, lifetime (baseline 0)
assert m.energy_wh(3_600_000_000, 1_800_000_000) == 0.5   # since a snapshot
assert m.energy_wh(1_000_000, 1_000_000) == 0.0      # no time elapsed yet
# baseline ahead of total should never happen (accumulator only grows), but
# must not go negative if it somehow does — floor at 0
assert m.energy_wh(1_000_000, 5_000_000) == 0.0
assert m.energy_wh(1_000_000) == round(1_000_000 / 1e6 / 3600, 3)  # default baseline 0
print("mission-energy ledger OK")

# ---- job-scoped mission pin (v0.29.3) ---- #
# every request gets an explicit grant/deny — that's the whole point, so each
# denial path is tested individually, not just "returns False somewhere"
g, r = m.pin_decision("perf", 3600, "domU:soundwave", False, "", None, True)
assert g is True, r
g, r = m.pin_decision("ascend", 3600, "x", False, "", None, True)
assert g is False and "mission" in r
for bad_ttl in (0, -1, m.PIN_TTL_MAX_S + 1, "3600", True, None, float("nan")):
    g, r = m.pin_decision("perf", bad_ttl, "x", False, "", None, True)
    assert g is False and "ttl_s" in r, (bad_ttl, g, r)
for bad_owner in ("", None, 42, "x" * (m.PIN_OWNER_MAX_LEN + 1)):
    g, r = m.pin_decision("perf", 60, bad_owner, False, "", None, True)
    assert g is False and "owner" in r, (bad_owner, g, r)
# a second pin never silently clobbers the first
held = {"mission": "perf", "owner": "domU:already-here", "ttl_s": 60,
        "granted_at": 0.0}
g, r = m.pin_decision("cool", 60, "domU:newcomer", False, "", held, True)
assert g is False and "already-here" in r, r
# operator conserving battery: a conflicting pin is denied by default...
g, r = m.pin_decision("perf", 60, "x", True, "endure", None, True)
assert g is False and "battery" in r.lower(), r
# ...a pin for endure itself never fights conservation, so it's granted...
g, r = m.pin_decision("endure", 60, "x", True, "endure", None, True)
assert g is True, r
# ...and the policy can be explicitly relaxed
g, r = m.pin_decision("perf", 60, "x", True, "endure", None, False)
assert g is True, r
# battery alone (not actively conserving via endure) doesn't trigger the policy
g, r = m.pin_decision("cool", 60, "x", True, "perf", None, True)
assert g is True, r
print("pin_decision OK")

assert m.pin_expired(None, 999) is False
p = {"mission": "perf", "owner": "x", "ttl_s": 60, "granted_at": 100.0}
assert m.pin_expired(p, 159.9) is False
assert m.pin_expired(p, 160.0) is True          # boundary: >= ttl_s has elapsed
assert m.pin_expired(p, 200.0) is True
print("pin_expired OK")

# ---- GPU-first cap arbitration (v0.28.0) ---- #
# GPU eating 60W of a 127W budget → CPU cap yields to the leftover
assert m.arbitrate_cap(81, 126.8, 60.0) == 51
# leftover above the mission cap → mission cap stands
assert m.arbitrate_cap(45, 126.8, 20.0) == 45
# GPU idle/asleep (or below the engage threshold) → never shrinks the cap
assert m.arbitrate_cap(81, 126.8, None) == 81
assert m.arbitrate_cap(81, 126.8, 5.0) == 81
# no wall budget (battery / unknown) → untouched
assert m.arbitrate_cap(81, None, 60.0) == 81
# pathological squeeze can never go below the usability floor
assert m.arbitrate_cap(81, 40.0, 30.0) == m.PL_MIN_W
# cap==0 means "release" — arbitration must not resurrect a cap
assert m.arbitrate_cap(0, 126.8, 60.0) == 0
print("GPU-first arbitration OK")

if fails:
    print(f"\nFAILURES ({len(fails)}):")
    for f in fails[:20]:
        print("  -", f)
    raise SystemExit(1)
print("8000+ fuzzed configs — all invariants held ✔")
