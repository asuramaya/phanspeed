# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [0.24.0] — 2026-06-30

### Fixed
- **The daemon no longer wakes the dGPU — which was clamping the CPU on AC.**
  Measured root cause of the "CPU stuck at 400 MHz–1.4 GHz for no reason" report:
  with the dGPU **awake**, this laptop's marginal AC budget (130 W charger +
  battery charging) leaves so little headroom that the EC asserts **BD PROCHOT**
  and clamps the CPU hard — dGPU awake → ~1.4 GHz / 24 W, dGPU asleep → ~2.5 GHz /
  44 W under the same load; no CPU lever (PL1/EPP/turbo/profile) moves it. The
  daemon was polling `nvidia-smi` every 3 s to feed the pill's GPU widget, helping
  keep the dGPU awake. `_gpu_status` now reads **only sysfs runtime-PM state** (no
  nvidia-smi), and `_apply_gpu` no longer attempts the firmware-locked GPU power
  cap (which required polling). Turbo Boost arbitrates CPU-vs-GPU power by design,
  so we let it. The Endure dGPU-sleep lever is unchanged.

### Changed
- **Pill trimmed of duplicate and hardware-dead controls** (extension version 15,
  needs a Wayland relogin): removed the **GPU power widget** (locked `-pl` + the
  harmful polling), the **GPU temperature** readout, and the **duplicate raw
  profile row** (`Cool/Quiet/Balanced/Perf` — `Cool`/`Perf` already exist as
  missions). Fan RPM stays as a **passive readout only** (PWM is firmware-locked —
  there is no fan control to offer). Kept: missions, intensity, clamp warning, CPU
  temp, CPU power, turbo, energy preference, quiet-on-battery.

## [0.23.0] — 2026-06-30

### Fixed
- **A transient fan-RPM glitch no longer bypasses the v0.22.0 Tjmax fix.** Live
  load-testing the v0.22.0 build showed it still firing a false emergency — but via
  the *dead-fan* path (`100°C >= 95°C (fan DEAD)`), not the relaxed fan-ok path. The
  cause: `cpu_fan_alive()` was evaluated fresh each poll, and the Dell `dell_smm`
  RPM read (a slow BIOS SMI call) momentarily returns `0`/unreadable under heavy
  all-core load — precisely when the chip is at Tjmax. One such glitch flipped the
  fan to "dead" and dropped the failsafe to the aggressive instant 95 °C trip. The
  fan-dead signal is now **debounced** (`FAN_DEAD_DEBOUNCE`, new `_sticky_fan_ok`):
  a real dead fan reads 0 rpm persistently, so we only believe it after 4
  consecutive dead reads; a single glitch is ignored and the fan-ok (105 °C, trust
  hardware) path stays in effect. Regression test added.

## [0.22.0] — 2026-06-30

### Fixed
- **Emergency failsafe no longer thrashes a healthy chip at Tjmax.** On an i9-12900H
  (and any modern mobile CPU) the *normal* sustained-load ceiling is Tjmax (~100 °C)
  — the silicon throttles itself there in hardware, by design. The fan-ok software
  trip sat at 99 °C, so any real workload pinned the package at 100 °C, tripped a
  false "emergency," forced the cool profile + clamped PL1, cleared ~2 s later, and
  repeated every minute or two (~20 trips overnight in the logs) — a redundant
  software clamp fighting the hardware throttle, felt as periodic stutter. With a
  CPU fan spinning we now **trust the hardware Tjmax throttle**: the fan-ok trip
  moves to 105 °C (unreachable while the silicon caps at 100 °C), so it only fires
  on a genuine sensor runaway. The dead-fan path is unchanged — instant trip at the
  configured `emergency_temp` (hard-capped ≤95 °C), full protection intact.
- **Don't poke `nvidia-smi` while the dGPU is runtime-suspended.** The telemetry
  query (2 s timeout) ran in the control loop; on a sleeping GPU it could block the
  whole poll for up to 2 s *and* wake the GPU, defeating the Endure sleep lever.
  `query()` now returns early when `runtime_status == suspended`.

## [0.21.0] — 2026-06-29

### Added
- **`phanspeed doctor` — a read-only firmware/thermal snapshot that changes
  nothing.** One command to eyeball the box (handy after a reboot or a BIOS
  change): phanspeed/daemon state, BIOS version, thermal mode (`platform_profile`
  plus the staged `dell-wmi-sysman` `ThermalManagement`/`TurboMode` when run with
  `sudo`), turbo, and per-fan rpm/ceiling with an EC-under-drive flag.
- **A dedicated `WATT CHOKE` section** that verifies the cap which crippled the box
  before won't bite again: whether phanspeed *itself* is limiting watts (effective
  PL1 vs default, and which mission/intensity owns the cap), a live BD PROCHOT /
  power-budget clamp check, the actual package watts sampled from RAPL (with
  `sudo`), and a note that the hidden chipset cap is now BIOS-governed. Ends with a
  one-line verdict (✓ clear / ⚠ a cap is active). Pure reader — adds no privilege;
  degrades gracefully (prints a `sudo` hint) for the root-only firmware nodes.

## [0.20.0] — 2026-06-29

### Changed (security)
- **Removed all `/dev/mem` / MMIO RAPL control (v0.19.0) from the daemon.** Poking
  chipset MMIO required `CAP_SYS_RAWIO` + `/dev/mem` on the long-running root
  service — full physical-memory access 24/7, the heaviest privilege in the daemon
  and the worst-case if it were ever compromised. The EC also re-asserts the hidden
  cap every ~15 s, so it could never have been a fleeting one-shot. We chose the
  tighter posture: **the daemon is back to `CAP_CHOWN`-only**, governs only the
  MSR/sysfs PL1 (no special capability), and the hidden chipset power cap is lifted
  via **BIOS thermal/power policy** (e.g. `dell-wmi-sysman` `ThermalManagement`)
  instead. Trade-off: phanspeed no longer bypasses a vendor MMIO power cap itself.
  The unit drops `CAP_SYS_RAWIO` and the `/dev/mem` device grant; status loses
  `mmio_limit_w`/`mmio_locked` (`effective_limit_w` is again the MSR PL1).

## [0.19.0] — 2026-06-29

### Fixed
- **Turbo was never a "dead-switch" — that was our own bug.** The v0.17.0
  detection counted the daemon's *own* `no_turbo` writes (driven by a stale
  `turbo: "off"` config) as the EC "reverting" turbo, then latched it off and hid
  the pill switch. Proven false: with the daemon stopped, `no_turbo=0` holds and
  all-core load runs 3.0–3.2 GHz (turbo works). `set_turbo` now only latches when
  the firmware *rejects* the write (turbo genuinely disabled in BIOS).
- **Pill feedback loop killed.** On GNOME 50 the pill's `setToggleState` during a
  refresh re-emitted `toggled`, so it pushed `turbo`/`battery`/`power_auto` back to
  the daemon every poll with no user action — the real source of the turbo
  flip-flop, the config-save spam, and (with the v0.18 auto-clear) missions getting
  wiped. The switch handlers now ignore programmatic updates (a `_syncing` guard).
  metadata 13→14.
- **Mission auto-clear narrowed to the profile knob.** Setting an explicit
  `profile` still leaves the mission, but sub-knobs (turbo/epp/power) no longer do
  — so a chatty client echoing them can never silently drop the active mission.

### Added
- **Lifts the hidden chipset (MMIO) power cap.** Dell sets a low package PL1 in
  the chipset MCHBAR that the MSR/sysfs view (often 200 W) can't see — the
  hardware obeys the lower of the two, so a ~25 W MMIO cap silently pins the CPU.
  The daemon now reads/writes that register via `/dev/mem` and makes it track the
  intended PL1, so the hidden cap can't bind invisibly. The **Perf mission now
  truly unleashes** (raises the cap as intensity rises) instead of "releasing" to
  Dell's conservative default; with turbo on this is ~+40% all-core on the
  reference Precision 5770 (capped only by cooling). Degrades silently if
  `/dev/mem` is unavailable or the register is firmware-locked. New status fields
  `power.mmio_limit_w`, `power.mmio_locked`, and `effective_limit_w` now reflects
  `min(MSR, MMIO)`. Needs the new `CAP_SYS_RAWIO` + `/dev/mem` grant in the unit
  (a deliberate, scoped privilege expansion — see `systemd/phanspeed.service`).

## [0.18.0] — 2026-06-29

### Fixed
- **Fan-aware thermal failsafe — no more emergency thrash.** The software
  emergency was tuned for the dead-CPU-fan era (low ceiling, instant trip,
  whole-stance slam). On a working-fan i9 that legitimately touches 100 °C on
  boost bursts, it tripped every poll and oscillated, crippling the machine.
  Now: when a CPU fan is actually spinning, the failsafe only fires on a
  *sustained* runaway (99 °C held for several samples); when no CPU fan spins it
  falls back to the conservative, instant configured `emergency_temp`. The
  hard-locked config ceiling is unchanged, so the dead-fan protection is intact.
- **Missions no longer silently override a raw stance knob.** Setting `profile`,
  `power`, `epp`, `turbo`, or `mode` (CLI or pill) now drops the active mission,
  so the knob actually takes effect instead of being re-overridden every loop
  (the "I set Perf but it stays Cool" trap).
- **Cool mission is usable at intensity 3.** It no longer jumps to EPP `power`
  (which pins the CPU near ~1 GHz); `power` is reserved for max intensity, with
  `balance_power` below it.
- **Status tells the truth about the power cap.** `cpu pwr` now shows the
  *programmed* PL1 (including a mission's cap) and tags it `(mission)`, instead
  of always reporting `cap full`. New status fields `power.effective_limit_w` and
  `mission_active`.
- **No more config-save spam.** `save_config` is idempotent — it skips the write
  and the log line when the on-disk file already matches.
- **Upgrades now restart the daemon.** The `.deb` postinst `try-restart`s
  `phanspeed.service`, so an auto-update's new code takes effect immediately
  instead of sitting inert until the next reboot.

## [0.17.0] — 2026-06-25

### Changed
- **Pill is now mission-first.** The face is just the three mission chips
  (🧊 Cool · 🔥 Perf · 🔋 Endure), the intensity dial, and one hero readout that
  re-skins per mission. Everything else — raw profile, CPU/GPU power, turbo, EPP,
  quiet-on-battery — collapses under a single **⚙ Advanced** expander (closed by
  default). This kills the old duplicate **Cool/Perf** that appeared in both the
  mission row and a separate profile row. Clicking the tile now **cycles missions**
  (Cool → Perf → Endure). metadata 12→13.

### Added
- **Dead-switch detection for turbo.** Some firmware (this Precision with BIOS
  Turbo "enabled") *accepts* a `no_turbo=0` write but the EC reverts it within
  seconds — so turbo can be capped OFF but never held ON. The daemon now detects
  the revert (after a few attempts) and latches turbo as uncontrollable, and the
  pill **hides the turbo switch** rather than showing a control that does nothing.
  A lever that can't move the hardware shouldn't look like a switch — the same
  rule that already hides fan-RPM control.

## [0.16.0] — 2026-06-25

### Added
- **Update notice + version in the pill** (kast-style). The menu now has a dimmed
  `phanspeed vX.Y.Z` footer, and when a newer release exists an actionable
  **⬆ Update to vX.Y.Z** item appears — clicking it installs via a polkit
  (`pkexec`) prompt. The extension checks on enable and every 6 h by running the
  isolated updater in the user session (the daemon still has no network).
- **`phanspeed update --json`** — machine-readable check output
  (`{"current","latest","available"}`) for the pill and scripts; also closes the
  `--json` parity gap with the sibling kast CLI. `--json` implies `--check`.
- **Daemon publishes its `version`** in the status snapshot (read from
  `/usr/share/phanspeed/VERSION`), so the pill can show it without shelling out.

### Changed
- Pill metadata 11→12.

## [0.15.1] — 2026-06-24

### Fixed
- **Source installs never got the self-updater.** `install.sh` installed
  `phanspeedd`/`phanspeed`/`-healthcheck`/`-tune` but not `phanspeed-update`, so
  `phanspeed update` failed with *"cannot run phanspeed-update: No such file or
  directory"* on every `curl | bash` / source install. The binary is now
  installed (the `.deb` always had it).
- **Auto-update could split-brain a source install.** `phanspeed-update` fell back
  to the VERSION file that `install.sh` writes, so its "not a .deb install" guard
  never fired — it would `dpkg -i` a `.deb` into `/usr/bin` while the running
  `/usr/local/bin` copies shadowed it. The install step now gates on a real dpkg
  registration and gives source installs clear guidance instead. `install.sh` no
  longer enables the daily auto-update timer for the source layout (auto-update is
  a packaged-install feature; `phanspeed update --check` still works manually).
- **`.deb` migration left the old CLI behind.** The postinst removed the old
  `/usr/local/bin` daemon/helpers when migrating off a source install but missed
  the main `phanspeed` CLI, leaving a stale copy to shadow the packaged one. Now
  removed too. `uninstall.sh` also cleans up the updater + its units.

## [0.15.0] — 2026-06-24

### Added
- **The third mission — Endure.** PhanSpeed's two earlier crises taught it to
  *survive heat* and *unleash performance*; the third is **surviving power**.
  PhanSpeed is now a single governor with three stances, each redefining the
  control objective and re-skinning the pill's hero readout:
  - 🧊 **Cool** — cap watts at the source (temperature is the metric).
  - 🔥 **Perf** — full power + boost where allowed (clock/watts is the metric).
  - 🔋 **Endure** — minimise total draw to live on a power trickle (the
    **power-balance / break-even gauge** is the metric).
  See [docs/MISSIONS.md](docs/MISSIONS.md).
- **`mission` + `intensity` config** (`""`/`cool`/`perf`/`endure`; `0–4`). A
  mission owns the whole stance (profile + CPU power + EPP + turbo + GPU);
  `""` keeps the legacy `mode`/`manual_profile` behaviour. `intensity` is how
  hard you lean into the active mission.
- **Power-balance instrument** (`power_balance` in status): watts in from the
  charger, **net battery power** (+ charging / − draining, from `power_now`/
  `current_now`, or a charge-gauge delta on batteries like this Dell that report
  neither), total **system draw**, and a **runtime estimate**. This is the
  break-even gauge the Endure mission steers by.
- **Discrete-GPU sleep** — the daemon can drive the dGPU's PCI `power/control`
  to `auto` so it drops to D3cold when idle (the single biggest idle-power lever
  on an Optimus laptop: it otherwise burns several watts at 0% utilisation).
  Works even where `nvidia-smi -pl` is firmware-locked. `runtime_status`/`asleep`
  are reported in status. *(Note: `nvidia-persistenced`, if running, pins the GPU
  on and defeats this.)*
- **Endure "at all costs" trims** — at high intensity the daemon dims the panel
  backlight and turns off the keyboard backlight (remembered + restored on exit
  or mission change). Gated by `endure_trim`; dGPU sleep by `endure_gpu_sleep`.
- **Endure closed loop** — in Endure the CPU PL1 cap *hunts* between an
  intensity-set floor and ceiling toward **net battery drain ≤ 0**: it tightens
  while the battery drains and relaxes when there's surplus.
- **CLI:** `phanspeed mission <cool|perf|endure|off>`, `phanspeed survive`
  (shortcut for Endure), `phanspeed intensity <0-4|+|->`; `phanspeed status` now
  shows the mission, the break-even balance line, and the dGPU runtime state.

### Changed
- **Pill is now two-layer** (metadata 10→11): a **mission chip row**
  (🧊 Cool · 🔥 Perf · 🔋 Endure) with an **intensity dial** beneath it. The
  headline readout re-skins to the active mission — temperature for Cool,
  clock/watts for Perf, and the **break-even gauge** (`+2W ▲ holding · 11h` /
  `−8W ▼ 1h12m`, plus watts in / draw / dGPU state) for Endure. Picking a raw
  profile or toggling Auto exits mission mode.

## [0.14.0] — 2026-06-21

### Added
- **Power-clamp detection.** The daemon reads per-core frequency + CPU busy%
  (`/proc/stat`) and flags a hardware **power/PROCHOT clamp** — when the top core
  is pinned near the frequency floor under real load with ample thermal headroom
  (classic cause: a USB-C device drawing power, an underpowered charger, or a
  battery limit, *not* heat). Surfaced as `cpu_clamp` in status, a ⚠ banner in the
  pill, and on the tile subtitle. `--selftest` prints the live freq range.

### Changed
- **Pill UX polish toward the concept mockup**: profiles are now a **horizontal
  chip row** (active chip filled) instead of a vertical list; the live readout is
  **colour-coded** (green/amber/red temps, accent RPM) via Pango markup; submenus
  moved into stable sections. metadata version 9→10.
- `phanspeed.service`: dropped `ProcSubset=pid` (it hid `/proc/stat`, needed for
  clamp detection); other processes stay hidden via `ProtectProc=invisible`.

## [0.13.0] — 2026-06-19

### Added
- **Unified `phanspeed` CLI** — one verb entrypoint mirroring the sibling `kast`
  project's UX: `phanspeed status [--json]`, `profile`, `power`, `epp`, `tune`
  (→ phanspeed-tune), `update` (→ phanspeed-update), `version`. Wraps the control
  socket; the `phanspeed-*` helpers stay for systemd but humans get one command.
- **One-line install** — `curl -fsSL …/install.sh | bash`; the installer
  bootstraps by fetching the latest release when run outside a checkout.
- **`CODE_OF_CONDUCT.md`**, a release badge, and a `phanspeed version` source of
  truth (`/usr/share/phanspeed/VERSION`, from the repo `VERSION` file) — aligning
  conventions with the kast project.

### Note
Cross-project alignment with [kast](https://github.com/asuramaya/kast): both now
share the `<tool> <verb>` CLI shape, a one-line installer, the same doc set/badge
order, and a `VERSION` single-source-of-truth. The MIT (kast) vs GPL-3.0
(phanspeed) **license difference is intentional and unchanged.**

## [0.12.0] — 2026-06-19

### Added
- **`.deb` package** — `make deb` (or `packaging/build-deb.sh`) builds an
  installable `phanspeed_<ver>_all.deb` with `dpkg-deb` (no debhelper). Ships the
  daemon, healthcheck, auto-tuner, updater, the system-wide GNOME extension, and a
  default config (marked a conffile so upgrades don't clobber edits). postinst
  enables the services and migrates off a prior `install.sh` deployment. CI now
  builds the package on every push.
- **Auto-updates** — `phanspeed-update` checks the latest GitHub release, compares
  it to the installed version, and installs a newer `.deb`, verifying the download
  against the release's `SHA256SUMS`. Driven by `phanspeed-update.timer` (daily,
  enabled by the package). It's a deliberately separate, isolated component — the
  hardened daemon keeps `IPAddressDeny=any`, so only the updater touches the
  network. Pure stdlib (`urllib`). Releases now publish a `SHA256SUMS` asset.

### Security note
The updater uses HTTPS + SHA256 verification (transport/corruption integrity with
GitHub as trust anchor); it is **not** a cryptographic signature. GPG-signed
releases are a planned hardening step.

## [0.11.0] — 2026-06-19

### Added
- **Pill shows the adaptive scenes.** A new readout in the Quick Settings menu
  displays both operating points — `🔌 45W·perf   🔋 35W·bal-pwr` — with the active
  plug-state marked (`▶`). Surfaces the battery scene (`battery_power_w` /
  `battery_epp`), which the pill previously hid, so the tuner's output is visible
  at a glance. metadata version 8→9.

## [0.10.1] — 2026-06-19

### Changed
- **`phanspeed-tune` AC pick is now the performance *knee*** — the lowest cap that
  still reaches (within 1% of) the best clock under the thermal ceiling, instead of
  blindly the highest under-ceiling cap. Same top performance, less heat and
  headroom. On a turbo-locked chip this collapses AC to the point where the clock
  plateaus (~base TDP); with Turbo Boost enabled it finds the genuine
  diminishing-returns point where extra watts stop buying clock.

## [0.10.0] — 2026-06-19

### Added
- **Adaptive power+EPP scenes** — the closest equivalent to undervolting on a
  voltage-locked machine. New `battery_epp` config makes the per-state EPP fully
  tunable (was a hardcoded `balance_power` on battery): AC uses `epp`, battery uses
  `battery_epp` (falling back to `balance_power`), emergency still forces `power`.
- **`phanspeed-tune` now writes complete scenes** — `--apply` sets a power cap
  *and* a matching EPP for each state (AC → `performance` + max-perf cap; battery →
  `balance_power` + efficiency-knee cap), so each plug-state gets a coherent
  power/governor bundle instead of just a wattage.
- status `cpu_pref.battery_epp_cfg`; installer seeds `battery_epp`; both fuzz
  suites cover it.

### Note
Undervolting was verified **locked** on the Precision 5770 (OC mailbox MSR 0x150
swallows the offset — Plundervolt/BIOS lock), so operating at the efficiency knee
via power cap + EPP is the supported substitute. Re-enabling Turbo Boost in BIOS
remains the largest available performance gain.

## [0.9.0] — 2026-06-19

### Added
- **`phanspeed-tune` — closed-loop RAPL power auto-tuner (Tier 1, safe).** Sweeps
  the CPU package power cap under a controlled all-core load, measures
  steady-state temp/power/clock per step, and derives two operating points: the
  highest cap under a thermal ceiling (**AC, max sustained performance**) and the
  best MHz-per-watt knee (**battery, efficiency**). `--apply` writes both to the
  config; `--dry-run` shows the plan without stressing. The daemon stays up with
  its failsafe armed during a sweep (tuner disarms only its power management).
- **Adaptive battery power point** — new `battery_power_w` config: when set, the
  daemon uses it as the CPU cap on battery instead of falling back to base TDP, so
  AC and battery each get their own tuned ceiling. Covered by both fuzz suites.
- **`docs/AUTOTUNE.md`** — the auto-tuner design: objective (adaptive AC/battery),
  the calibration state machine, daemon coordination, and the safety model
  (self-checking workload + probation/boot-watchdog) required before the gated
  undervolt auto-tuner can ship.

## [0.8.0] — 2026-06-19

### Added
- **CPU turbo/boost control** — new `turbo` config (`auto`/`on`/`off`) and a
  **Turbo boost** switch in the pill, driving `intel_pstate/no_turbo`. Emergency
  and battery modes force boost off to cut heat/draw; the neutral state (on) is
  restored when management is released.
- **HWP energy-performance preference (EPP)** — new `epp` config and an **Energy
  preference** submenu (Performance → Power saving), writing each CPU's
  `energy_performance_preference`. Emergency forces `power`, battery forces
  `balance_power`. Both levers are plain sysfs writes — no new capability, the
  daemon's single `CAP_CHOWN` posture is unchanged.
- Status snapshot gains a `cpu_pref` block; `--selftest` reports turbo + EPP;
  installer seeds `turbo`/`epp` in the default config; config-fuzz test covers the
  new fields.

## [0.7.1] — 2026-06-16

### Fixed
- **Pill could never read status or send commands** — the unit dropped *all*
  capabilities (`CapabilityBoundingSet=`), so the daemon's `chown` of the control
  socket and status file to the logged-in user silently failed (EPERM). Both
  stayed `root:root`, leaving the unprivileged pill locked out ("daemon offline").
  The unit now grants exactly one capability, `CAP_CHOWN`, for that hand-off and
  nothing else (verified `CapEff=…01`).
- **`status.json` mode was wrong + logged an error every poll** — `write_status()`
  chmod'd *after* chown, but once the file belongs to the user a root process
  without `CAP_FOWNER` can't chmod it, so the mode stuck at `0600` and each cycle
  logged "status write failed". Reordered to chmod-then-chown (matching the socket
  path); the snapshot is now a clean `0640` owner+root.

## [0.7.0] — 2026-06-16

### Changed
- **Finer CPU-power presets in the pill** — the "CPU power limit" submenu now
  offers a five-step ladder (≈100/80/66/55/44 % of base TDP, e.g. 45/36/30/25/20 W
  on a 45 W chip) instead of quarters, so a moderate cap — the sweet spot for a
  thermally-limited machine (e.g. one running on a single working fan) — is
  directly selectable.
- **Installer writes the power/battery/GPU keys into the default config**, so all
  tunables are visible in `/etc/phanspeed/config.json` from first install and
  obviously persist across reboots (the daemon already saved them on every set).

## [0.6.0] — 2026-06-15

### Added
- **GPU power-cap persistence** — the GPU cap is re-asserted whenever the dGPU's
  live enforced limit drifts from our target (so it survives runtime
  power-gating), without forcing persistence mode. Optional `gpu_persistence`
  config runs `nvidia-smi -pm 1` for desktops.
- **`tests/test_validation.py`** — a hardware-free fuzz of the config validator
  (8000+ cases) asserting the failsafe invariants always hold; now part of CI, so
  the security guarantees are checked on every push/PR.
- **README preview** — an SVG mockup of the Quick Settings pill, plus
  instructions for capturing a live recording.

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
