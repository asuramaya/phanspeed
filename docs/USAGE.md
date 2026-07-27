# Using PhanSpeed

How to drive PhanSpeed day to day: the pill, the CLI, tuning, and troubleshooting.
What PhanSpeed is and why to install it lives in the [README](../README.md); how
it's built lives in [ARCHITECTURE.md](ARCHITECTURE.md).

## The pill

Open Quick Settings and PhanSpeed sits next to Wi-Fi and Bluetooth: a **mission
chip row** (🔥 Perf · 🔋 Endure) and an **intensity dial**. The headline re-skins
to each mission's own metric, clock and watts for Perf, break-even balance for
Endure, and the icon changes with the active mission.

- **Click the pill** to cycle the mission (Perf → Endure).
- **Open ⚙ Advanced.** While a mission is active this is a **read-only status
  view**, CPU power, turbo, and energy preference as the mission currently has
  them, plus a **"Leave mission"** action. Editing these knobs while a mission
  owns the stance would just get overwritten a few seconds later, so the pill
  doesn't offer controls that don't do anything.
- **Leave mission** (or `phanspeed mission off`) drops to manual mode, where the
  same rows become a raw profile, CPU power limit (Intel RAPL PL1, fixed or
  scaled with temperature), turbo, and energy-preference picker again, plus live
  CPU temp and fan RPM (a passive readout only, PWM is firmware-locked).
- **Quiet on battery** is a manual-mode-only knob, hidden while a mission is
  active since missions handle their own battery behavior.
- The pill turns **red on the emergency override** (forced max cooling above
  90 °C, which also drops the CPU to its base TDP to cut heat at the source).
- **Update from the pill** shows the running version and an **⬆ Update to
  vX.Y.Z** item when a newer release is out, a one-click install through a
  polkit prompt. The daily background timer only checks for that notice; it
  never installs unattended.

There's deliberately no GPU power/temp widget: `nvidia-smi -pl` is
firmware-locked on the hardware this was built for, and polling the dGPU to
show live numbers keeps it awake, which can starve the CPU's power budget under
AC (see [ARCHITECTURE.md](ARCHITECTURE.md) for the BD PROCHOT finding). The
Endure mission still puts the dGPU to sleep when idle; it just doesn't poll it
for a widget.

Missions are covered end to end, including per-intensity tables, in
[MISSIONS.md](MISSIONS.md); this section is the pill's controls, not the
design behind them.

## Command line

One `phanspeed <verb>` entrypoint drives everything from a terminal:

```bash
phanspeed status [--json]                      # profile, temp, power, EPP, battery
phanspeed doctor [--json]                      # read-only firmware/thermal/watt-choke report
phanspeed profile <quiet|balanced|cool|performance|auto>
phanspeed power <WATTS|auto|full>              # CPU RAPL cap
phanspeed epp <performance|…|power|auto>       # HWP energy preference
phanspeed survive                              # shortcut for the Endure mission
phanspeed mission <perf|endure|cool|off>
phanspeed intensity <0-4>
phanspeed tune [--target both --apply]         # auto-tuner (needs sudo)
phanspeed update [--check]                     # check/install a newer release (.deb only)
phanspeed version
```

## Service commands

```bash
systemctl status phanspeed                     # daemon health
journalctl -u phanspeed -f                     # live log (profile changes, emergencies)
cat /run/phanspeed/status.json                 # what the pill sees
cat /sys/firmware/acpi/platform_profile         # active profile right now
gnome-extensions info phanspeed@asuramaya       # extension state
sudo phanspeedd --selftest                      # verify controllable hardware
systemctl status phanspeed-healthcheck.timer    # auto-restart watchdog
./uninstall.sh
```

A `phanspeed-healthcheck.timer` runs every few minutes and restarts the daemon
if it ever goes inactive, its control socket stops answering, or its status
snapshot goes stale.

## Tuning

Edit `/etc/phanspeed/config.json`, then `sudo systemctl restart phanspeed`:

| key | meaning |
|-----|---------|
| `quiet_below` | below this °C, Quiet |
| `cool_above`  | above this °C, Cool (between the two, Balanced) |
| `hysteresis`  | °C deadband so it doesn't flap |
| `emergency_temp` | force max cooling at/above this °C |
| `power_limit_w` | CPU sustained power cap (Intel RAPL PL1) in W; `0` = unmanaged |
| `power_auto` | scale the power cap with temperature (cool → full, warm → base TDP, hot → floor) |
| `power_floor_w` | the cap when hot under `power_auto`; `0` = base TDP |
| `battery_aware` | on battery, force `battery_profile` and cap CPU to base TDP |
| `battery_profile` | profile to use while on battery (default `quiet`) |
| `battery_power_w` | tuned CPU cap to use on battery (set by `phanspeed-tune`); `0` = base TDP |
| `turbo` | `auto` (leave alone), `on`, `off`; emergency/battery force it off |
| `epp` | HWP energy/perf preference on AC (`performance`…`power`); `""` = leave alone |
| `battery_epp` | EPP to use on battery; `""` = `balance_power` fallback |
| `gpu_power_limit_w` | NVIDIA GPU power cap in W; accepted and clamped but currently inert, `nvidia-smi -pl` is firmware-locked on the hardware this was built for, and applying it would poll the dGPU awake. Kept for forward-compat with unlocked hardware. `0` = default |
| `gpu_persistence` | enable `nvidia-smi -pm 1` (mainly for desktops, off by default) |

Under `power_auto` the CPU cap ramps smoothly from the firmware default at
`quiet_below` down to the floor at `cool_above`.

### Auto-tuning (`phanspeed-tune`)

Instead of guessing power caps, let the machine find them. `phanspeed-tune` runs
a closed-loop sweep under a controlled all-core load and derives two operating
points: the performance knee (AC) and the best MHz-per-watt knee (battery).

```bash
sudo phanspeed-tune --dry-run                 # show the plan, no stress
sudo phanspeed-tune --target both --apply     # full sweep, write results
sudo phanspeed-tune --ceiling 80 --step 5     # gentler ceiling, finer steps
```

The daemon keeps running during a sweep (its emergency failsafe stays armed);
the tuner just tells it to stop managing CPU power for the duration. Full
design, including the gated undervolt auto-tuner and its safety model:
[AUTOTUNE.md](AUTOTUNE.md).

The 5770 runs hot. `platform_profile` only changes *fan* behavior; to actually
cut the heat, cap CPU power with `power_limit_w` or the pill's CPU power limit
submenu. On 12th-gen+ Intel, RAPL is the lever that works (MSR undervolting is
locked by the Plundervolt mitigation). The emergency override also drops to
base TDP automatically.

## Troubleshooting

**The pill doesn't do anything, or profile writes fail.** Direct fan RPM/PWM
control is impossible on locked-down Dell firmware, that's expected;
`platform_profile` is the lever PhanSpeed uses instead. Run `sudo python3
diag.py` from a clone to see exactly what your machine allows: it's a one-shot,
safe probe that restores original state and never leaves anything changed.

**Your Dell model isn't confirmed working.** File a [hardware
report](../.github/ISSUE_TEMPLATE/hardware_report.md) with your model and
`diag.py`'s output. Confirmed hardware is listed in the README's Compatibility
table.

**The daemon won't start.** `systemctl status phanspeed` and `journalctl -u
phanspeed -e` first; `sudo phanspeedd --selftest` reports what it can and can't
control on this machine independent of the running daemon.

**Updates fail closed with a checksum or signature error.** That's the
updater refusing rather than installing something it can't verify, see
[RELEASE-SIGNING.md](RELEASE-SIGNING.md) for what it's checking and why.
