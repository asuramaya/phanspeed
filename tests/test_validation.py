#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Hardware-free unit test for the config validator.

Imports phanspeedd (no hardware touched at import time) and fuzzes
sanitize_config + _coerce_num, asserting the safety invariants ALWAYS hold —
in particular that the thermal failsafe can never be disabled. Runs in CI on
every push/PR. Exit 0 = pass.
"""
import importlib.machinery as machinery
import importlib.util as util
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
print("fan-aware failsafe logic OK")

# --- MMIO RAPL PL1 bit-math ------------------------------------------------
# Real PACKAGE_RAPL_LIMIT register read off the Precision 5770 (PL1=25W, PL2=115W,
# power unit 0.125 W). Decoding and re-encoding must be exact and lossless.
U = 0.125
REG = 0x0043839800df80c8
assert round(m._rapl_pl1_watts(REG, U)) == 25, "PL1 decode"
assert round(((REG >> 32) & 0x7FFF) * U) == 115, "PL2 (sanity of the fixture)"
reg45 = m._rapl_with_pl1(REG, 45, U)
assert round(m._rapl_pl1_watts(reg45, U)) == 45, "PL1 re-encode"
assert (reg45 >> 15) & 1 == 1, "PL1 enable bit set"
assert (reg45 >> 32) == (REG >> 32), "upper half (PL2/time windows) preserved"
assert (reg45 >> 63) & 1 == (REG >> 63) & 1, "lock bit untouched"
# round-trip a range of caps
for w in (8, 25, 45, 64, 90, 200):
    assert round(m._rapl_pl1_watts(m._rapl_with_pl1(REG, w, U), U)) == w, f"rt {w}"
print("MMIO RAPL PL1 bit-math OK")

if fails:
    print(f"\nFAILURES ({len(fails)}):")
    for f in fails[:20]:
        print("  -", f)
    raise SystemExit(1)
print("8000+ fuzzed configs — all invariants held ✔")
