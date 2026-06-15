# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-06-15

First public release.

### Added
- `phanspeedd` — root systemd daemon that controls the ACPI `platform_profile`
  (`cool` / `quiet` / `balanced` / `performance`) on firmware-locked Dell
  laptops where direct fan-RPM control is rejected by the EC.
- Temperature **auto policy** (quiet → balanced → cool with hysteresis) plus a
  latching **emergency override** that forces max cooling above a threshold and
  restores a neutral profile on stop/crash.
- **GNOME Shell Quick Settings pill** (`phanspeed@local`, GNOME 46–50): pick a
  profile, toggle auto, and see live CPU/GPU temps and fan RPM.
- Hardened IPC: world-readable status snapshot replaced with an owner-only file;
  control socket gated by **SO_PEERCRED** + `allow_uids`; all input validated and
  clamped; rate limiting; 64 KB read cap.
- Heavily sandboxed systemd unit (zero capabilities, `ProtectSystem=strict`,
  `AF_UNIX`-only, syscall filter, etc.).
- `diag.py` hardware probe and `tests/attack_socket.py` adversarial test harness.

### Known limitations
- Direct fan **RPM/PWM** control is impossible on locked-down Dell firmware
  (verified on Precision 5770); `platform_profile` is the only lever available.
