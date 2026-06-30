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
        for bk in ("endure_gpu_sleep", "endure_trim"):
            assert isinstance(cfg[bk], bool), f"{bk} type"
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

if fails:
    print(f"\nFAILURES ({len(fails)}):")
    for f in fails[:20]:
        print("  -", f)
    raise SystemExit(1)
print("8000+ fuzzed configs — all invariants held ✔")
