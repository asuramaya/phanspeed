# Architecture

A contributor-facing map of how PhanSpeed fits together. User-facing docs are in
the [README](../README.md).

## The hardware constraint that shapes everything

On modern Dells (verified on a Precision 5770 / i9-12900H), **direct fan RPM/PWM
control is firmware-locked** — `dell_smm_hwmon`'s `pwm*_enable` only accepts `1`
(BIOS-auto); `0`/`2`/`3` return `EINVAL` and `pwm` writes are ignored. So
PhanSpeed never tries to set fan speed. The levers that *do* work:

| Lever | Interface | Effect |
|-------|-----------|--------|
| Thermal profile | `/sys/firmware/acpi/platform_profile` | how aggressively the EC runs the fans |
| CPU power (PL1) | `/sys/class/powercap/intel-rapl:*` | sustained CPU watts → heat at the source |
| EPP | `cpufreq/energy_performance_preference` | HWP perf↔efficiency bias (per-state scenes) |
| Turbo | `intel_pstate/no_turbo` | boost on/off (often BIOS-locked, or the EC reverts our write — latched as uncontrollable either way, and the pill then hides the switch) |
| GPU power | `nvidia-smi -pl` | dGPU watts (locked on some laptop firmware) |
| dGPU sleep | PCI `power/control` → `auto` | lets the discrete GPU drop to D3cold when idle (Endure mission; works even where `-pl` is locked) |
| Panel / kbd | `backlight/*`, `leds/*kbd_backlight*` | brightness trims (Endure "at all costs") |

Other firmware levers seen **locked** on this class of machine and deliberately
not pursued: voltage **undervolting** (OC mailbox MSR 0x150 swallows offsets —
Plundervolt) and direct **fan RPM**. `diag.py` re-confirms what a given machine
allows. The daemon also *reads* per-core frequency to **detect** a hardware power
clamp (BD PROCHOT) — see the control loop below.

## Components

```
 phanspeed@asuramaya  (GNOME Shell extension, GJS/ESM, runs as the user)
   │  reads  /run/phanspeed/status.json   (owner+root, 0640, polled every 2s)
   │  writes /run/phanspeed/control.sock  (async; SO_PEERCRED + allow_uids gated)
   ▼
 phanspeedd  (systemd daemon, root, pure-stdlib Python)
   │  owns the control loop, the failsafe, and all privileged writes
   ▼
 platform_profile · intel-rapl PL1 · nvidia-smi
```

A `phanspeed-healthcheck.timer` restarts the daemon if it goes inactive or
`status.json` goes stale.

### Binaries (all pure-stdlib Python except the bash healthcheck)

| Binary | Role |
|--------|------|
| `phanspeedd` | the root control-loop daemon (above) |
| `phanspeed` | user CLI — one `phanspeed <verb>` entrypoint (status/profile/power/epp/tune/update/version) wrapping the socket; mirrors the sibling **kast** project's UX |
| `phanspeed-tune` | closed-loop RAPL power **auto-tuner** (see [AUTOTUNE.md](AUTOTUNE.md)) — sweeps the cap under load, derives AC (perf knee) + battery (MHz/W knee) scenes |
| `phanspeed-update` | self-updater — checks GitHub releases, verifies the `.deb` against `SHA256SUMS` (fails closed), `dpkg -i`. `phanspeed-update.timer` runs it daily with `--check` only (notify, never installs unattended); actual installs are interactive, via the pill's `pkexec` prompt or an explicit run. The only networked component (the daemon stays `IPAddressDeny=any`) |
| `phanspeed-healthcheck` | watchdog invoked by its timer |

**Packaging:** `make deb` / `packaging/build-deb.sh` builds a `.deb` (dpkg-deb, no
debhelper) installing binaries to `/usr/bin`, units to `/lib/systemd/system`, the
extension system-wide, and a default config conffile. `install.sh` is the
source/one-line (`curl | bash`) path. `VERSION` is the single source of truth.

## Missions (`mission` + `intensity`)

The user-facing stance is one of three **missions** — `cool` / `perf` / `endure`
— each owning the whole knob set (profile + PL1 + EPP + turbo + GPU) so you set
one thing, not six. `intensity` (0–4) is how hard you lean in. An empty `mission`
(`""`) falls back to the legacy `mode`/`manual_profile` path, fully intact. All
three remain valid daemon/CLI missions; **the pill (v0.26.0+) only offers `perf`
and `endure` as chips** — `cool` is CLI/config-only (`phanspeed mission cool`),
since Perf's own cooling-profile pick already covers the same ground. See
[MISSIONS.md](MISSIONS.md) for the design and the per-intensity tables.

While a mission owns the stance, the pill's Advanced section shows it
**read-only** rather than editable — a mission reasserts its own turbo/EPP/PL1
values every poll, so an edit there is a no-op a few seconds later. An explicit
"Leave mission" action (or `phanspeed mission off`) is required before Advanced
becomes editable again.

`endure` is the one with genuinely new control logic: a **closed loop** that
hunts the PL1 cap toward net battery drain ≤ 0, plus **dGPU sleep** and panel/kbd
**trims**. It steers by `power_balance` (below).

## Daemon control loop (`apply_once`, every `poll_interval` ≈ 3 s)

1. `_sample_busy()` + `power_balance()` — sample CPU busy% (`/proc/stat`) and the
   **power picture**: watts in, net battery power (`+`charging/`−`draining, from
   `power_now`/`current_now` or a charge-gauge delta), total draw, runtime ETA.
2. Read the hottest CPU sensor; latch/clear the **emergency** state (hysteresis).
3. Pick the stance, in priority order: **emergency** → **mission** (`cool`/`perf`/
   `endure` via `_apply_mission`) → legacy (battery → manual → auto curve).
   Emergency always wins and tears down any Endure trims.
4. `_apply_power` — set the CPU PL1 cap (fixed, smooth temp ramp under
   `power_auto`, or the Endure closed-loop hunt; emergency/battery clamp to base
   TDP). Reasserted each loop to defeat EC drift.
5. `_apply_cpu_pref` — drive turbo + EPP (emergency → off/`power`, battery →
   off/`battery_epp`, missions per their table, else config). A turbo write the
   firmware rejects is latched off so it doesn't retry/log-spam.
6. `_apply_gpu` — **persistence-only** as of v0.24.0: `nvidia-smi -pl` is
   firmware-locked on this class of hardware (the cap was always a no-op), and
   *attempting* it means polling the dGPU, which wakes it — see the BD PROCHOT
   note below. The only thing this step still does is opt-in `gpu_persistence`
   (`nvidia-smi -pm 1`, desktops). `_mission_endure` separately drives the
   dGPU's PCI `power/control` to `auto` so it can reach D3cold, and applies the
   panel/keyboard trims at high intensity. `gpu_power_limit_w` remains an
   accepted/clamped config field for forward-compat with unlocked hardware but
   is currently inert here.
7. `write_status()` — publish the JSON snapshot (always, including emergencies),
   with `power_balance`, `mission`/`intensity`, the dGPU `runtime_status`, and
   `cpu_clamp`: per-core freq + busy% flagging a hardware power/PROCHOT clamp (top
   core pinned near the floor under load with thermal headroom — a USB-C power
   draw / weak charger / battery limit, not heat).

**dGPU-awake → BD PROCHOT (found in v0.24.0):** on a power-starved AC budget
(weak charger + battery charging), an *awake* dGPU alone can trip BD PROCHOT and
clamp the CPU hard (~1.4 GHz vs ~2.5 GHz at the same load) — no CPU-side lever
(PL1/EPP/turbo/profile) moves it, only dGPU runtime-PM state does. This is why
`_gpu_status()` reads *only* sysfs `runtime_status`, never `nvidia-smi`, and why
step 6 above dropped the GPU power-cap attempt: either would poll the dGPU and
keep it awake. Turbo Boost 3.0 arbitrates CPU-vs-GPU power by design, so the
daemon lets it rather than fighting it with an extra GPU-side clamp.

On exit/crash the profile, CPU PL1, GPU limit, turbo, and EPP are restored to
neutral defaults, and any Endure panel/kbd trim + forced dGPU runtime PM is undone.

## Security model (see also [SECURITY.md](../SECURITY.md))

The daemon is root with a world-reachable socket, so **every input is hostile**:

- `sanitize_config()` is the single chokepoint — applied on config **load** and
  after every socket **set**. It clamps all numerics, validates enums against the
  live hardware, and enforces invariants (`emergency_temp ≤ 95`,
  `clear < emergency`, `cool > quiet`). The thermal failsafe can never be turned
  off from the socket or a tampered config file.
- Authorization is **SO_PEERCRED** (kernel-verified UID) + `allow_uids`; the
  socket is also chowned to the user, `0660`.
- Reads are size-capped (64 KB), commands rate-limited.
- The systemd unit is heavily sandboxed: **exactly one capability, `CAP_CHOWN`**
  (only to hand the socket + status file to the user), `ProtectSystem=strict`,
  `AF_UNIX`-only, `@system-service` seccomp, `MemoryDenyWriteExecute`,
  `DevicePolicy=closed` with `DeviceAllow` for only the NVIDIA nodes.
  `ProtectKernelTunables` and `ProcSubset=pid` are intentionally **off** —
  they'd block the `/sys` profile/RAPL writes and `/proc/stat` (clamp detection)
  respectively; other processes still stay hidden via `ProtectProc=invisible`.
- `allow_uids`, when unset, falls back to root + the **single seat owner**
  (`_status_target_uid`), not every logged-in session — verified live
  (`CapEff=0x1`) and narrowed in a self-audit (v0.25.0), which also hardened
  the separate, networked [update path](../SECURITY.md#update-path).

## Tests

- `tests/test_validation.py` — **hardware-free** fuzz of `sanitize_config`
  (8000+ cases). Runs in CI; this is where the failsafe-can't-be-disabled
  guarantee is enforced on every PR.
- `tests/attack_socket.py` — full adversarial suite against the live socket
  (peer-auth, oversized/garbage input, rate limiting). Needs real Dell hardware;
  run with `make test`.

## Adding a config field (checklist)

1. Add it to `DEFAULTS`.
2. Validate + clamp it in `sanitize_config`.
3. Accept it in `handle_cmd`'s `set` branch.
4. Apply it in the control loop.
5. Surface it in `status()`, the pill, and (if user-facing) the `phanspeed` CLI.
6. Add it to the fuzz lists in **both** test files.
7. Add it to the default config in **both** `install.sh` and
   `packaging/config.default.json`.
