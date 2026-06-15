---
name: Bug report
about: Something isn't working
labels: bug
---

**What happened**

<!-- A clear description of the bug. -->

**Expected**

<!-- What you expected instead. -->

**Environment**

- Laptop model:
- Distro + GNOME Shell version (`gnome-shell --version`):
- Kernel (`uname -r`):
- Session: Wayland / X11

**Diagnostics**

```
# daemon status + recent log
systemctl status phanspeed
journalctl -u phanspeed -n 50 --no-pager

# what the hardware exposes
cat /sys/firmware/acpi/platform_profile_choices
sudo python3 diag.py     # if fan/profile control isn't working

# extension
gnome-extensions info phanspeed@local
```

<!-- Paste relevant output above. -->
