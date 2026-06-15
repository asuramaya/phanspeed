#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 asuramaya and PhanSpeed contributors
"""One-shot diagnostic: what fan control does this Dell actually allow?
Run: sudo python3 diag.py   (safe — restores original state, monitors temp)"""
import glob, os, time, errno

def rd(p):
    try:
        with open(p) as f: return f.read().strip()
    except OSError as e: return f"<err {e.errno}>"

def find(name):
    for d in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
        if rd(os.path.join(d,"name")) == name: return d

smm = find("dell_smm")
print(f"dell_smm hwmon: {smm}\n")

en1 = os.path.join(smm,"pwm1_enable"); pw1 = os.path.join(smm,"pwm1"); rp1 = os.path.join(smm,"fan1_input")
en2 = os.path.join(smm,"pwm2_enable"); pw2 = os.path.join(smm,"pwm2"); rp2 = os.path.join(smm,"fan2_input")
orig_en1, orig_en2 = rd(en1), rd(en2)
orig_pw1, orig_pw2 = rd(pw1), rd(pw2)
print(f"ORIGINAL  fan1: enable={orig_en1} pwm={orig_pw1} rpm={rd(rp1)}")
print(f"ORIGINAL  fan2: enable={orig_en2} pwm={orig_pw2} rpm={rd(rp2)}\n")

def trywrite(path, val):
    try:
        with open(path,"w") as f: f.write(str(val))
        return "OK", rd(path)
    except OSError as e:
        return f"FAIL errno={e.errno}({errno.errorcode.get(e.errno,'?')})", rd(path)

print("== which pwm1_enable values are accepted? ==")
for v in (0,1,2,3):
    status, back = trywrite(en1, v)
    print(f"  write {v}: {status}  (reads back {back})")
# restore enable before pwm test
trywrite(en1, orig_en1)

print("\n== does writing pwm change RPM? (testing fan1 = CPU fan) ==")
for enable_val in (2,0,1):
    s,_ = trywrite(en1, enable_val)
    if not s.startswith("OK"):
        print(f"  enable={enable_val}: cannot set ({s}) — skip"); continue
    trywrite(pw1, 255); time.sleep(3); hi = rd(rp1)
    trywrite(pw1, 0);   time.sleep(3); lo = rd(rp1)
    print(f"  enable={enable_val}: pwm255 -> {hi} RPM, pwm0 -> {lo} RPM")
    trywrite(en1, orig_en1)

print("\n== restoring original state ==")
trywrite(en1, orig_en1); trywrite(pw1, orig_pw1)
trywrite(en2, orig_en2); trywrite(pw2, orig_pw2)
print(f"  fan1: enable={rd(en1)} pwm={rd(pw1)} rpm={rd(rp1)}")
print(f"  fan2: enable={rd(en2)} pwm={rd(pw2)} rpm={rd(rp2)}")

print("\n== supported path: platform_profile (Dell thermal modes) ==")
pp = "/sys/firmware/acpi/platform_profile"
ppc = "/sys/firmware/acpi/platform_profile_choices"
print(f"  current : {rd(pp)}")
print(f"  choices : {rd(ppc)}")

print("\n== smbios-thermal-ctl present? ==")
print("  ", os.popen("which smbios-thermal-ctl 2>/dev/null || echo 'not installed'").read().strip())
