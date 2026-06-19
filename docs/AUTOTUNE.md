<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# PhanSpeed auto-tuner — design

A closed-loop calibrator that drives a lever, stress-tests each setting, measures
the result, and converges on the best **stable** operating point — so the machine
tunes itself instead of you turning knobs by hand.

## Objective: adaptive (AC vs battery)

The tuner finds and stores **two** operating points and phanspeed switches between
them automatically on plug/unplug:

| State | Objective | Converges at |
|-------|-----------|--------------|
| **AC** | max sustained performance | the **performance knee** — lowest cap that still reaches the best clock under the thermal ceiling (extra watts past it buy no clock) |
| **Battery** | best perf-per-watt | the *knee* of the curve — max MHz delivered per watt |

## The loop (state machine)

```
IDLE ──start──▶ CALIBRATING ──converged──▶ PROBATION ──survives reboot──▶ COMMITTED
                   │  set lever → load → dwell → measure → judge → step
                   └─ instability / over-ceiling ─▶ revert to last-known-good
```

1. **Lever + search.** Levers are 1-D and monotonic, so the search is simple:
   - *Power (RAPL):* ramp PL1 **up** until the package reaches the ceiling under
     load; settle just below (AC) or pick the MHz/W knee (battery). **Safe — RAPL
     can only make the chip slow, never wrong.** This is Tier 1, available today.
   - *Undervolt:* step the offset **down** until instability, back off with a
     safety margin. **Gated** — see Safety below.
2. **Load.** A repeatable all-core burst per step, long enough to reach thermal
   steady state (`--dwell`, default 60 s).
3. **Measure.** Per step: steady-state package temp, package watts, and achieved
   clock (the average of the last N samples, after the transient settles).
4. **Judge.** AC: the **performance knee** — the lowest cap that still reaches
   (within 1% of) the best clock seen under the ceiling, so it's max performance at
   minimum heat/headroom rather than blindly the highest cap. Battery: maximize
   MHz/W. Undervolt adds a **stability gate** (below).

## Coordination with the daemon

The calibrator does **not** stop the daemon — that would disarm the thermal
failsafe during a stress run. Instead it sets `power_limit_w = 0` over the socket
(daemon stops managing CPU power) and drives the RAPL node directly. The daemon's
**emergency branch still overrides** to base TDP if a sensor crosses
`emergency_temp`, so the failsafe stays armed throughout calibration.

## Safety (what makes auto-undervolt acceptable — Tier 2)

An undervolt search deliberately drives the CPU to the edge of instability, so two
guardrails are **mandatory** before it ships:

- **Self-checking workload.** An unstable undervolt produces *silently wrong
  answers*, not just crashes. The load must compute a known-answer workload
  (deterministic hash/matrix) and **verify the result** each step; a mismatch — or
  a WHEA/MCE in `dmesg` — counts as instability even with no crash.
- **Probation / commit + boot watchdog.** A candidate is applied **live only**,
  never written as the boot default until it survives the full pass *and* a reboot
  confirm. The daemon writes an "attempting X" flag before applying at boot; if it
  finds the flag still set on next boot (i.e. the last boot crashed), it reverts to
  last-known-good and refuses X. Self-healing against the tuner's own search.

## Status

- **Tier 1 — RAPL power auto-tune:** implemented in `bin/phanspeed-tune`
  (`--target ac|battery|both`). Safe; no new daemon capability.
- **Tier 2 — undervolt auto-tune:** blocked on (a) verifying undervolt works at
  all on this firmware (Plundervolt/SGX may swallow offsets) and (b) the
  self-checking + boot-watchdog harness above.
