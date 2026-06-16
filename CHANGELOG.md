# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [0.5.0] — 2026-06-15

### Added
- **Discrete GPU support** (NVIDIA, via `nvidia-smi`) — cap GPU power
  (`gpu_power_limit_w`), and surface GPU temp / draw / utilization in the pill's
  new GPU submenu. Emergency and battery modes drop the GPU to its minimum.
- **Continuous CPU power scaling** — `power_auto` now ramps the cap smoothly with
  temperature (ceiling at `quiet_below` → floor at `cool_above`) instead of three
  discrete steps.
- **Self-healing** — `phanspeedd --selftest` (verifies controllable hardware) and
  a `phanspeed-healthcheck.timer` that restarts the daemon if it goes inactive or
  its status snapshot goes stale.

### Changed
- Hardened unit gains `DeviceAllow` for the NVIDIA nodes only (still
  `DevicePolicy=closed` for everything else).

## [0.4.0] — 2026-06-15

### Added
- **Quiet on battery** (`battery_aware` + `battery_profile`) — on battery, force
  a calm profile and cap the CPU to base TDP; a "Quiet on battery" switch in the
  pill, and `on_battery` in status.
- **Makefile** — `install`, `uninstall`, `lint`, `test`, `pack`, `check`.

### Changed
- The extension's control socket is now **fully asynchronous**
  (`connect_async`/`write_all_async` with a Cancellable cancelled on disable) —
  it can never block the compositor. eGO submission notes updated.

### Fixed
- The thermal **emergency state is now published to `status.json`** (the pill
  shows it); previously the emergency path returned before writing status.

## [0.3.0] — 2026-06-15

### Added
- **Temperature-coupled power** (`power_auto`) — scales the CPU power cap with
  temperature (cool → full, warm → base TDP, hot → `power_floor_w`), so it shaves
  watts progressively instead of only at the emergency cliff. Exposed as a
  "Scale with temperature" switch in the pill's power submenu.
- **CI linting** — `ruff` (Python) and `shellcheck` (bash) run on every
  push/PR; added `ruff.toml`.
- **extensions.gnome.org prep** — `make-extension-zip.sh` packaging script,
  `SUBMISSION.md` review checklist, and `url` in `metadata.json`.

### Changed
- `diag.py` rewritten to clean PEP 8 and now also reports the RAPL power state.
- CI uses `actions/checkout@v5` (Node 24).

## [0.2.0] — 2026-06-15

### Added
- **CPU power-limit control (Intel RAPL PL1)** — cap sustained CPU power to cut
  heat at the source, the real fix for thermal spikes that fan profiles can't
  solve (MSR undervolting is locked on 12th-gen+ Intel). Exposed as a **CPU power
  limit** submenu in the pill (Full + base-TDP-derived presets).
- The **emergency override** now also drops the CPU to its base TDP, not just the
  fan profile.
- Power state surfaced in `status.json`; `power_limit_w` config field, validated
  and clamped (`0` = unmanaged, otherwise `[8 W, 250 W]`), reasserted each loop,
  firmware default restored on exit. Covered by the fuzz suite.

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
