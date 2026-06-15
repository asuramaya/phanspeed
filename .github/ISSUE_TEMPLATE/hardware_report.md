---
name: Hardware compatibility report
about: Report whether PhanSpeed works on your Dell model
labels: hardware
---

**Model**

<!-- e.g. Dell XPS 15 9520, Precision 7770 -->

**Does it work?**

- [ ] The Quick Settings pill appears and changes the profile
- [ ] Auto-by-temperature visibly changes fan behaviour
- [ ] Direct RPM control works (rare — most Dells lock this)

**Details**

- Kernel (`uname -r`):
- GNOME Shell version:
- `cat /sys/firmware/acpi/platform_profile_choices`:
- Output of `sudo python3 diag.py`:

```
<!-- paste diag.py output -->
```
