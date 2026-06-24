#!/usr/bin/env python3
"""
Adversarial test harness for phanspeedd.

Runs the real daemon (read-only init; sysfs writes no-op as non-root) against a
temp socket and attacks it: malformed/oversized/hostile JSON, fuzzed config
fields, rate-limit flooding, and SO_PEERCRED authorization. Asserts the daemon
never crashes and the thermal-failsafe invariants ALWAYS hold.

Run as your normal user:  python3 tests/attack_socket.py
"""
import importlib.machinery as M
import importlib.util as U
import json
import os
import random
import socket
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Load the daemon module, redirect all runtime paths into a tempdir.
tmp = tempfile.mkdtemp(prefix="phanspeed-test-")
loader = M.SourceFileLoader("phanspeedd", os.path.join(HERE, "bin", "phanspeedd"))
spec = U.spec_from_loader("phanspeedd", loader)
m = U.module_from_spec(spec)
loader.exec_module(m)
m.RUN_DIR = tmp
m.SOCK_PATH = os.path.join(tmp, "control.sock")
m.STATUS_PATH = os.path.join(tmp, "status.json")
m.CONFIG_PATH = os.path.join(tmp, "config.json")

ME = os.getuid()
fails = []


def check_invariants(cfg, where):
    """The properties that MUST hold no matter what an attacker sent."""
    try:
        assert isinstance(cfg["emergency_temp"], (int, float)), "emergency_temp type"
        assert cfg["emergency_temp"] <= 95, "failsafe ceiling breached!"
        assert cfg["emergency_clear_temp"] < cfg["emergency_temp"], "clear>=emergency"
        assert cfg["cool_above"] > cfg["quiet_below"], "cool<=quiet"
        assert cfg["mode"] in ("auto", "manual"), "bad mode"
        assert cfg["manual_profile"] in d.hw.choices, "bad profile"
        assert cfg["sensor"] == "auto" or cfg["sensor"] in d.hw.sensors, "bad sensor"
        for k in ("quiet_below", "cool_above", "hysteresis",
                  "emergency_temp", "emergency_clear_temp", "rate_limit"):
            assert isinstance(cfg[k], (int, float)) and not isinstance(cfg[k], bool), \
                f"{k} type"
        assert all(isinstance(u, int) for u in cfg["allow_uids"]), "allow_uids type"
        for pk in ("power_limit_w", "power_floor_w", "gpu_power_limit_w"):
            pw = cfg[pk]
            assert isinstance(pw, int) and not isinstance(pw, bool), f"{pk} type"
            assert pw == 0 or 8 <= pw <= 250, f"{pk} out of safe range"
        assert isinstance(cfg["power_auto"], bool), "power_auto type"
        assert isinstance(cfg["battery_aware"], bool), "battery_aware type"
        assert cfg["battery_profile"] in d.hw.choices, "battery_profile invalid"
    except AssertionError as e:
        fails.append(f"[{where}] invariant: {e}")


d = m.Daemon()
d.config["allow_uids"] = [ME]   # authorize this test process

# ---------------------------------------------------------------- direct fuzz
print("== direct handle_cmd fuzz ==")
HOSTILE = [
    {"cmd": "set", "emergency_temp": 9999, "mode": "manual", "manual_profile": "quiet"},
    {"cmd": "set", "emergency_temp": -100},
    {"cmd": "set", "quiet_below": "hot", "cool_above": None, "hysteresis": True},
    {"cmd": "set", "cool_above": 10, "quiet_below": 80},
    {"cmd": "set", "emergency_clear_temp": 999},
    {"cmd": "set", "mode": ["array"], "manual_profile": {"x": 1}},
    {"cmd": "set", "manual_profile": "$(reboot)"},
    {"cmd": "set", "sensor": "../../etc/passwd"},
    {"cmd": "set", "allow_uids": "everyone"},
    {"cmd": "set", "rate_limit": -5},
    {"cmd": "set", "emergency_temp": float("inf")},
    {"cmd": "set", "emergency_temp": float("nan")},
    {"cmd": "set", "power_limit_w": 999999},   # absurd cap -> clamp
    {"cmd": "set", "power_limit_w": 1},         # below usable min -> clamp up
    {"cmd": "set", "power_limit_w": -50},       # negative -> clamp
    {"cmd": "set", "power_limit_w": "max"},     # wrong type -> unmanaged
    {"cmd": "set", "power_limit_w": [45]},      # list -> rejected
    {"cmd": "set", "turbo": "maybe"},           # bad enum -> rejected
    {"cmd": "set", "turbo": 1},                 # wrong type -> rejected
    {"cmd": "set", "epp": "turbocharged"},      # not a real EPP -> rejected
    {"cmd": "set", "epp": ["performance"]},     # list -> rejected
    {"cmd": "set", "battery_epp": "zoom"},      # bad battery EPP -> rejected
    {"cmd": "set", "mission": "ascend"},        # bad mission -> rejected
    {"cmd": "set", "mission": ["endure"]},      # list -> rejected
    {"cmd": "set", "intensity": 99},            # out of range -> clamp
    {"cmd": "set", "intensity": "max"},         # wrong type -> rejected
    {"cmd": "set", "endure_gpu_sleep": "yes"},  # non-bool -> rejected
    {"cmd": "wat"}, {"cmd": 123}, {}, {"cmd": "get"},
]
for msg in HOSTILE:
    try:
        r = d.handle_cmd(msg)
        assert isinstance(r, dict)
    except Exception as e:
        fails.append(f"handle_cmd raised on {msg}: {e!r}")
    check_invariants(d.config, "hostile")

random.seed(1)
KEYS = ["mode", "manual_profile", "sensor", "quiet_below", "cool_above",
        "hysteresis", "emergency_temp", "emergency_clear_temp", "allow_uids",
        "rate_limit", "power_limit_w", "power_floor_w", "battery_power_w",
        "power_auto", "battery_aware", "battery_profile", "gpu_power_limit_w",
        "turbo", "epp", "battery_epp", "mission", "intensity",
        "endure_gpu_sleep", "endure_trim"]
VALS = [None, True, -1e9, 1e9, "x", [], {}, 0, 95, 9999, float("nan"), "auto",
        "cool", "on", "off", "performance", "balance_power", "", "endure",
        "perf", 2, 4]
for _ in range(3000):
    msg = {"cmd": random.choice(["set", "get", "x"])}
    for k in random.sample(KEYS, random.randint(0, 4)):
        msg[k] = random.choice(VALS)
    try:
        d.config["allow_uids"] = [ME]  # keep authorized; ignore rate limit returns
        r = d.handle_cmd(msg)
        assert isinstance(r, dict)
    except Exception as e:
        fails.append(f"fuzz raised on {msg}: {e!r}")
    check_invariants(d.config, "randfuzz")
print(f"   {len(HOSTILE)} hostile + 3000 random msgs, invariants held: {not fails}")

# ---------------------------------------------------------------- socket layer
print("== socket-level attacks ==")
d._stop.clear()
t = threading.Thread(target=d.serve_socket, daemon=True)
t.start()
time.sleep(0.4)


def raw(payload, allow_uid=ME, read=True):
    d.config["allow_uids"] = [allow_uid]
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(3)
    s.connect(m.SOCK_PATH)
    if payload is not None:
        s.sendall(payload)
    out = b""
    if read:
        try:
            while b"\n" not in out:
                c = s.recv(4096)
                if not c:
                    break
                out += c
        except socket.timeout:
            pass
    s.close()
    return out


# peer auth: authorized uid works, foreign uid denied
r = json.loads(raw(b'{"cmd":"get"}\n', allow_uid=ME) or b"{}")
if not r.get("ok"):
    fails.append("authorized peer rejected")
r = json.loads(raw(b'{"cmd":"get"}\n', allow_uid=ME + 99999) or b"{}")
if r.get("error") != "unauthorized":
    fails.append(f"foreign uid NOT denied: {r}")
print(f"   peer auth: authorized ok, foreign denied -> {r.get('error')}")

# oversized message must be refused, server must survive
big = b'{"cmd":"set","x":"' + b"A" * (200 * 1024) + b'"}\n'
r = json.loads(raw(big, allow_uid=ME) or b'{"ok":false}')
if r.get("ok"):
    fails.append("oversized message accepted")
# server still alive?
r = json.loads(raw(b'{"cmd":"get"}\n', allow_uid=ME) or b"{}")
if not r.get("ok"):
    fails.append("daemon died after oversized message")
print(f"   oversized rejected, daemon alive: {r.get('ok')}")

# garbage / non-object
for p in (b'not json\n', b'[1,2,3]\n', b'\x00\xff\n', b'\n'):
    raw(p, allow_uid=ME)
r = json.loads(raw(b'{"cmd":"get"}\n', allow_uid=ME) or b"{}")
if not r.get("ok"):
    fails.append("daemon died after garbage input")
print("   survived garbage/binary/non-object input")

# rate limiting: flood real changes, expect 'rate limited' eventually
d.config["allow_uids"] = [ME]
d.config["rate_limit"] = 5
d._cmd_times = []
seen_limit = False
for i in range(30):
    prof = "cool" if i % 2 == 0 else "quiet"
    rr = json.loads(raw(json.dumps({"cmd": "set", "mode": "manual",
                                    "manual_profile": prof}).encode() + b"\n",
                        allow_uid=ME) or b"{}")
    if rr.get("error") == "rate limited":
        seen_limit = True
if not seen_limit:
    fails.append("rate limiting never triggered")
print(f"   rate limiting triggered under flood: {seen_limit}")

d._stop.set()
time.sleep(1.2)

# ---------------------------------------------------------------- result
print()
if fails:
    print("FAILURES:")
    for f in fails:
        print("  -", f)
    raise SystemExit(1)
print("ALL ATTACKS DEFENDED ✔")
