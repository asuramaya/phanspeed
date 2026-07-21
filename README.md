# PhanSpeed

[![CI](https://github.com/asuramaya/phanspeed/actions/workflows/ci.yml/badge.svg)](https://github.com/asuramaya/phanspeed/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/asuramaya/phanspeed?sort=semver)](https://github.com/asuramaya/phanspeed/releases/latest)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![No deps](https://img.shields.io/badge/dependencies-stdlib%20only-success)

Dell thermal/fan control for GNOME, living where it belongs — a **Quick
Settings pill** next to Wi-Fi and Bluetooth. Built and tested on a **Precision
5770** (GNOME 50, Wayland); should work on any Dell that exposes
`platform_profile` via `dell-smm-hwmon`.

> **Not affiliated with or endorsed by Dell.** "Dell", "Precision", and "XPS"
> are trademarks of their respective owners. Use at your own risk — see the
> [thermal failsafe](#security-model) and the no-warranty terms in the license.

<p align="center">
  <img src="docs/pill-preview.svg" alt="PhanSpeed Quick Settings pill" width="380">
</p>

<sub>Mockup of the expanded pill. To capture a real recording on Wayland:
`gnome-extensions enable phanspeed@asuramaya`, open Quick Settings, then use the
built-in screen recorder (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd>)
and convert the WebM to GIF (e.g. `ffmpeg -i clip.webm docs/demo.gif`).</sub>

## Why a "thermal" pill and not RPM sliders

Direct fan/RPM control is **firmware-locked** on modern Dells — verified on this
machine: `pwm_enable` accepts only `1` (BIOS-auto), and `pwm` writes are ignored
(`EINVAL`). No Linux tool can set fan RPM here. The one lever the firmware honors
is the ACPI **platform_profile**: `cool · quiet · balanced · performance`.
`cool` makes the EC ramp fans early and hard; `quiet` keeps them calm. PhanSpeed
drives that, with a temperature auto-policy on top (the closest thing to a fan
curve the hardware allows).

## Two missions (+ one that still works, just not on the pill)

PhanSpeed is one governor fighting the things that cripple a laptop — you pick
which fight it's in, and the pill re-skins to that mission's metric:

- 🔥 **Perf** — *unleash*: take everything the chassis allows, including the
  most aggressive cooling profile. (Born from fixed fans.)
- 🔋 **Endure** — *survive power*: minimise draw to **live on a power trickle** —
  closed-loop CPU cap to **break-even**, dGPU sleep, panel/kbd trims, with a live
  `+2W ▲ / −8W ▼` balance gauge. (Born from a 20 W charger.)

🧊 **Cool** (*survive heat*, born from a dead fan that's since been repaired)
is still a fully working mission — `phanspeed mission cool` — it's just not a
pill chip: Perf's own cooling-profile pick already covers the same ground
mechanically (its max-cooling choice *is* the `cool` ACPI profile), so a third
chip was a distinction without a difference.

`phanspeed survive` / `phanspeed mission <perf|endure|cool>` + `phanspeed
intensity <0-4>`, or the mission chips in the pill. Full design:
[docs/MISSIONS.md](docs/MISSIONS.md).

## What you get

A Quick Settings pill that:
- A **mission chip row** (🔥 Perf · 🔋 Endure) + an **intensity dial**; the
  headline re-skins to clock-watts / break-even per mission. Everything else
  lives under one **⚙ Advanced** expander.
- Shows the active mission + its hero metric at a glance (icon changes per mission).
- **Click the pill** → cycle the mission (Perf → Endure).
- **Open ⚙ Advanced**: while a mission is active, this is a **read-only status
  view** (CPU power / turbo / energy preference as the mission has them right
  now) plus a **"Leave mission"** action — editing these knobs while a mission
  owns the stance would just get silently overwritten a few seconds later, so
  the pill doesn't offer controls that don't do anything. Hit "Leave mission"
  (or `phanspeed mission off`) to drop to manual mode, where the same rows
  become a raw profile / CPU power limit (Intel RAPL PL1, fixed or scaled with
  temperature) / turbo / energy-preference picker again, plus live CPU temp and
  fan RPM (fan RPM is a passive readout only — PWM is firmware-locked).
- **Quiet on battery** — a manual-mode-only knob; hidden while a mission is
  active (missions handle their own battery behavior).
- Turns red on the **emergency override** (forced max cooling above 90 °C, which
  also drops the CPU to its base TDP to cut heat at the source).
- **Update from the pill** — shows the running version, and an **⬆ Update to
  vX.Y.Z** item when a newer release is out (one-click install via a polkit
  prompt). The daily background timer only *checks* for that notice — it never
  installs unattended; you click to install.

There's deliberately no GPU power/temp widget: `nvidia-smi -pl` is firmware-locked
on this class of hardware anyway, and polling the dGPU to show live numbers keeps
it awake — which can starve the CPU's power budget under AC (see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the BD PROCHOT finding). The
Endure mission still puts the dGPU to sleep when idle; it just doesn't poll it
for a widget.

## Architecture

```
 GNOME Shell extension  (phanspeed@asuramaya — the pill, runs as you)
    │  reads  /run/phanspeed/status.json   (0640, owner+root only)
    │  writes /run/phanspeed/control.sock  (owner+root, SO_PEERCRED-gated)
    ▼
 phanspeedd  (systemd daemon, root)  ──writes──▶  platform_profile
```

The root daemon is the only thing that writes the profile and runs the auto
policy + emergency failsafe. The pill never needs root and never needs a special
group — it reads the status file and pokes the control socket as you.

## Security model

The daemon is root and accepts IPC, so it's locked down hard. Threat model: an
**unprivileged local process** trying to abuse the root daemon (no network
surface — it binds only an `AF_UNIX` socket).

- **Authorization** — every connection is authenticated by **SO_PEERCRED**; only
  root and the UIDs in `allow_uids` (the installer sets this to *you*) may issue
  commands. The socket is also chowned to you + mode `0660`, so others can't even
  connect.
- **Input is hostile by default** — all socket and config-file fields are
  type-checked and clamped. `emergency_temp` is **hard-capped at 95 °C**, so the
  thermal failsafe can never be disabled, and the invariants
  `clear < emergency` and `cool > quiet` are always enforced — on socket sets
  *and* on config load (a tampered config can't weaken safety).
- **DoS-resistant** — 64 KB read cap, per-command rate limiting, `/etc` written
  only on real change.
- **Sandboxed unit** — exactly one capability (`CAP_CHOWN`, only to hand the
  socket + status file to you), `ProtectSystem=strict`, read-only FS except
  `/etc/phanspeed`, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`,
  `SystemCallFilter=@system-service`, `MemoryDenyWriteExecute`, `ProtectProc`,
  private tmp/devices/keyring. (`ProtectKernelTunables` is intentionally off — it
  would block the `/sys` profile write.)
- **Least disclosure** — `status.json` is `0640` owner+root, `config.json` is
  `0600` root-only, neither world-readable.
- **The auto-updater is hardened separately** (it's the one component with
  network access — see [SECURITY.md](SECURITY.md)): the daily timer only
  *checks*, never installs unattended; installs fail closed on a missing/
  mismatched checksum; downloads land in an unpredictable, non-symlinkable temp
  file.

Adversarial tests live in `tests/attack_socket.py` (fuzzes the handler + socket,
asserts the failsafe invariants always hold). Run: `python3 tests/attack_socket.py`.

## Install

**Option A — `.deb` (recommended; gets update notices):**

```bash
sudo apt install ./phanspeed_*.deb        # from a GitHub release, or `make deb`
gnome-extensions enable phanspeed@asuramaya   # then log out/in once (Wayland)
```

The package installs the daemon, healthcheck, auto-tuner, the system-wide
extension, and a daily **update-check** timer (`phanspeed-update.timer`) that
looks for newer GitHub releases and surfaces an **⬆ Update to vX.Y.Z** notice in
the pill — it never installs anything unattended. Installing is a deliberate,
interactive step: click the pill's update item (a `pkexec` prompt) or run `sudo
phanspeed update` yourself. Either way the download is verified against the
release's `SHA256SUMS` and the install is refused (fails closed) if that
checksum is missing or doesn't match. (HTTPS + checksum is transport/corruption
integrity, not a GPG signature — signing is planned.) Disable the check timer
any time with `sudo systemctl disable --now phanspeed-update.timer`.

**Option B — one-line install (fetches the latest release):**

```bash
curl -fsSL https://raw.githubusercontent.com/asuramaya/phanspeed/main/install.sh | bash
```

**Option C — from a clone:**

```bash
cd phanspeed
./install.sh          # sudo: daemon + service, then extension into your home
```

Either way, **log out and back in once** — Wayland has to restart the shell to
load a brand-new extension. After that the pill is there permanently; no more
logouts. (The update-check timer is a `.deb`-only feature; source installs
update via `git pull && ./install.sh`.)

## Files

```
bin/phanspeedd                     root daemon (profile control, auto, failsafe)
extension/phanspeed@asuramaya/     GNOME Shell Quick Settings extension
systemd/phanspeed.service          starts the daemon at boot
diag.py                            one-shot hardware probe (proves RPM is locked)
install.sh / uninstall.sh
```

## Command line

One `phanspeed <verb>` entrypoint drives everything from a terminal:

```bash
phanspeed status [--json]                      # profile, temp, power, EPP, battery
phanspeed doctor [--json]                      # read-only firmware/thermal/watt-choke report
phanspeed profile <quiet|balanced|cool|performance|auto>
phanspeed power <WATTS|auto|full>              # CPU RAPL cap
phanspeed epp <performance|…|power|auto>       # HWP energy preference
phanspeed tune [--target both --apply]         # auto-tuner (needs sudo)
phanspeed update [--check]                      # check/install a newer release (.deb only); the daily timer only checks
phanspeed version
```

## Service commands

```bash
systemctl status phanspeed           # daemon health
journalctl -u phanspeed -f           # live log (profile changes, emergencies)
cat /run/phanspeed/status.json       # what the pill sees
cat /sys/firmware/acpi/platform_profile   # active profile right now
gnome-extensions info phanspeed@asuramaya # extension state
sudo phanspeedd --selftest                # verify controllable hardware
systemctl status phanspeed-healthcheck.timer   # auto-restart watchdog
./uninstall.sh
```

A `phanspeed-healthcheck.timer` runs every ~2 min and restarts the daemon if it
ever goes inactive, its control socket stops answering, or its status
snapshot goes stale.

## Tuning

Edit `/etc/phanspeed/config.json` (then `sudo systemctl restart phanspeed`):

| key | meaning |
|-----|---------|
| `quiet_below` | below this °C → Quiet |
| `cool_above`  | above this °C → Cool (between → Balanced) |
| `hysteresis`  | °C deadband so it doesn't flap |
| `emergency_temp` | force max cooling at/above this °C |
| `power_limit_w` | CPU sustained power cap (Intel RAPL PL1) in W; `0` = unmanaged |
| `power_auto` | scale the power cap with temperature (cool→full, warm→base TDP, hot→floor) |
| `power_floor_w` | the cap when hot under `power_auto`; `0` = base TDP |
| `battery_aware` | on battery, force `battery_profile` + cap CPU to base TDP |
| `battery_profile` | profile to use while on battery (default `quiet`) |
| `battery_power_w` | tuned CPU cap to use on battery (set by `phanspeed-tune`); `0` = base TDP |
| `turbo` | `auto` (leave alone) · `on` · `off` — force CPU turbo/boost; emergency/battery force it off |
| `epp` | HWP energy/perf preference on AC (`performance`…`power`); `""` = leave alone |
| `battery_epp` | EPP to use on battery; `""` = `balance_power` fallback |
| `gpu_power_limit_w` | NVIDIA GPU power cap in W; accepted/clamped but **currently inert** — `nvidia-smi -pl` is firmware-locked on the hardware this was built for, and applying it would mean polling the dGPU awake (see the Security model note on the dGPU widget above). Kept for forward-compat with unlocked hardware. `0` = default |
| `gpu_persistence` | enable `nvidia-smi -pm 1` (mainly for desktops; off by default) |

Under `power_auto` the CPU cap ramps **smoothly** from the firmware default at
`quiet_below` down to the floor at `cool_above`.

### Auto-tuning (`phanspeed-tune`)

Instead of guessing power caps, let the machine find them. `phanspeed-tune` runs a
closed-loop sweep: it drives the RAPL cap under a controlled all-core load,
measures steady-state temperature, package power and clock at each step, and
derives two operating points — the **performance knee** (AC: the lowest cap that
still reaches the best clock under a thermal ceiling — same speed, least heat) and
the **best MHz-per-watt knee** (battery). With `--apply` it writes a complete **scene** for each state — power cap
*plus* a matching EPP (`performance` on AC, `balance_power` on battery) — into the
config (`power_limit_w`/`epp` and `battery_power_w`/`battery_epp`), so the daemon
applies the right whole bundle per plug-state. On a voltage-locked machine (no
undervolting), capping power at the efficiency knee + the right EPP is the closest
equivalent to undervolting you can get.

```bash
sudo phanspeed-tune --dry-run                 # show the plan, no stress
sudo phanspeed-tune --target both --apply     # full sweep, write results
sudo phanspeed-tune --ceiling 80 --step 5     # gentler ceiling, finer steps
```

The phanspeed daemon keeps running during a sweep (its emergency failsafe stays
armed); the tuner just tells it to stop managing CPU power for the duration. RAPL
can only make the chip slower — never wrong — so this is safe and needs no
stability gate. Full design, including the (gated) undervolt auto-tuner and its
self-checking + boot-watchdog safety model: [docs/AUTOTUNE.md](docs/AUTOTUNE.md).

The 5770 runs hot. `platform_profile` only changes *fan* behaviour — to actually
cut the heat, cap CPU power: set `power_limit_w` (e.g. the chip's base TDP) or use
the **CPU power limit** submenu in the pill. On 12th-gen+ Intel, RAPL is the lever
that works (MSR undervolting is locked by the Plundervolt mitigation). The
emergency override also drops to base TDP automatically.

## Compatibility

| Requirement | Notes |
|-------------|-------|
| GNOME Shell | 46–50 (Quick Settings extension API) |
| `platform_profile` | must exist: `cat /sys/firmware/acpi/platform_profile_choices` |
| `dell-smm-hwmon` | for temp/fan readout (loaded by default on Dell) |
| Python | 3.x stdlib only (no pip deps) |
| `openssh-client` | `ssh-keygen`, for release-signature verification (see [packages.txt](packages.txt)) |

Confirmed: **Dell Precision 5770**. Other Dells with `platform_profile` should
work — please file a [hardware report](.github/ISSUE_TEMPLATE/hardware_report.md)
with your model and `diag.py` output.

> Direct fan **RPM/PWM** control is impossible on locked-down Dell firmware
> (the EC rejects it). Run `sudo python3 diag.py` to see what your machine
> allows; `platform_profile` is the lever PhanSpeed uses.

## Project

- [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) ·
  [Code of Conduct](CODE_OF_CONDUCT.md) · [Security policy](SECURITY.md) ·
  [Changelog](CHANGELOG.md) · [Auto-tuner design](docs/AUTOTUNE.md)
- Common tasks: `make help` (install, lint, attack, pack, check)
- Adversarial test suite: `make attack` (`python3 tests/attack_socket.py`; `make test` still works)
- License: [GPL-3.0-or-later](LICENSE)

