#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 asuramaya and PhanSpeed contributors
"""One-shot diagnostic: what fan/thermal control does this Dell actually allow?

Run: sudo python3 diag.py   (safe — restores original state, monitors temp)
"""
import errno
import glob
import os
import shutil
import time


def rd(p):
    try:
        with open(p) as f:
            return f.read().strip()
    except OSError as e:
        return f"<err {e.errno}>"


def find(name):
    for d in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
        if rd(os.path.join(d, "name")) == name:
            return d
    return None


def trywrite(path, val):
    try:
        with open(path, "w") as f:
            f.write(str(val))
        return "OK", rd(path)
    except OSError as e:
        return f"FAIL errno={e.errno}({errno.errorcode.get(e.errno, '?')})", rd(path)


def probe_fans(smm):
    en1 = os.path.join(smm, "pwm1_enable")
    pw1 = os.path.join(smm, "pwm1")
    rp1 = os.path.join(smm, "fan1_input")
    en2 = os.path.join(smm, "pwm2_enable")
    pw2 = os.path.join(smm, "pwm2")
    rp2 = os.path.join(smm, "fan2_input")
    orig = {p: rd(p) for p in (en1, pw1, en2, pw2)}
    print(f"ORIGINAL  fan1: enable={orig[en1]} pwm={orig[pw1]} rpm={rd(rp1)}")
    print(f"ORIGINAL  fan2: enable={orig[en2]} pwm={orig[pw2]} rpm={rd(rp2)}\n")

    print("== which pwm1_enable values are accepted? ==")
    for v in (0, 1, 2, 3):
        status, back = trywrite(en1, v)
        print(f"  write {v}: {status}  (reads back {back})")
    trywrite(en1, orig[en1])

    print("\n== does writing pwm change RPM? (testing fan1 = CPU fan) ==")
    for enable_val in (2, 0, 1):
        status, _ = trywrite(en1, enable_val)
        if not status.startswith("OK"):
            print(f"  enable={enable_val}: cannot set ({status}) — skip")
            continue
        trywrite(pw1, 255)
        time.sleep(3)
        hi = rd(rp1)
        trywrite(pw1, 0)
        time.sleep(3)
        lo = rd(rp1)
        print(f"  enable={enable_val}: pwm255 -> {hi} RPM, pwm0 -> {lo} RPM")
        trywrite(en1, orig[en1])

    print("\n== restoring original fan state ==")
    trywrite(en1, orig[en1])
    trywrite(pw1, orig[pw1])
    trywrite(en2, orig[en2])
    trywrite(pw2, orig[pw2])
    print(f"  fan1: enable={rd(en1)} pwm={rd(pw1)} rpm={rd(rp1)}")
    print(f"  fan2: enable={rd(en2)} pwm={rd(pw2)} rpm={rd(rp2)}")


def probe_profile():
    print("\n== supported path: platform_profile (Dell thermal modes) ==")
    print(f"  current : {rd('/sys/firmware/acpi/platform_profile')}")
    print(f"  choices : {rd('/sys/firmware/acpi/platform_profile_choices')}")


def probe_rapl():
    print("\n== CPU power limit (Intel RAPL) ==")
    found = False
    for d in sorted(glob.glob("/sys/class/powercap/intel-rapl:*")):
        name = rd(os.path.join(d, "name"))
        if not name.startswith("package"):
            continue
        found = True
        pl1 = os.path.join(d, "constraint_0_power_limit_uw")
        base = rd(os.path.join(d, "constraint_0_max_power_uw"))
        cur = rd(pl1)
        writable = os.access(pl1, os.W_OK)
        base_w = f"{int(base) // 1_000_000} W" if base.isdigit() else "?"
        cur_w = f"{int(cur) // 1_000_000} W" if cur.isdigit() else "?"
        print(f"  {name}: PL1={cur_w} base={base_w} writable={writable}")
    if not found:
        print("  no RAPL package domain found")


def main():
    smm = find("dell_smm")
    print(f"dell_smm hwmon: {smm}\n")
    if smm:
        probe_fans(smm)
    else:
        print("dell_smm not found — fan readout/control unavailable")
    probe_profile()
    probe_rapl()
    print("\n== smbios-thermal-ctl present? ==")
    print("  ", shutil.which("smbios-thermal-ctl") or "not installed")


if __name__ == "__main__":
    main()
