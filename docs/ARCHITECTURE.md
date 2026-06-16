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
| GPU power | `nvidia-smi -pl` | dGPU watts |

`diag.py` re-confirms all of this on any machine.

## Components

```
 phanspeed@local  (GNOME Shell extension, GJS/ESM, runs as the user)
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

## Daemon control loop (`apply_once`, every `poll_interval` ≈ 3 s)

1. Read the hottest CPU sensor; latch/clear the **emergency** state (hysteresis).
2. Choose the profile, in priority order:
   emergency → battery (if `battery_aware` and on battery) → manual → auto curve.
3. `_apply_power` — set the CPU PL1 cap (fixed, or smooth temp ramp under
   `power_auto`; emergency/battery clamp to base TDP). Reasserted each loop to
   defeat EC drift.
4. `_apply_gpu` — set the GPU cap, but only when the **live enforced limit drifts
   from target** (survives runtime power-gating without spamming the slow
   `nvidia-smi -pl`).
5. `write_status()` — publish the JSON snapshot (always, including emergencies).

On exit/crash the profile, CPU PL1, and GPU limit are restored to neutral
defaults.

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
- The systemd unit is heavily sandboxed (zero caps, `ProtectSystem=strict`,
  `AF_UNIX`-only, `@system-service` seccomp, `MemoryDenyWriteExecute`,
  `DevicePolicy=closed` with `DeviceAllow` for only the NVIDIA nodes).

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
5. Surface it in `status()` and the pill.
6. Add it to the fuzz lists in **both** test files.
