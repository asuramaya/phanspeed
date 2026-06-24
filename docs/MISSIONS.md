# Missions — the gestalt

PhanSpeed grew out of three crises on one laptop, and each taught it a mission.
What looked like a pile of levers (profiles, RAPL caps, EPP, turbo, GPU power,
auto-tuner) is really **one governor that fights the three things that cripple a
laptop** — and you pick which fight it's in.

| Mission | Born from | Objective | Hero metric |
|---------|-----------|-----------|-------------|
| 🧊 **Cool** | a dead CPU fan | survive heat — cap watts at the source | CPU temperature |
| 🔥 **Perf** | the fans, repaired | unleash — extract everything the chassis allows | clock / watts |
| 🔋 **Endure** | a 20 W power trickle | survive power — live on whatever wattage exists | power balance (break-even) |

A mission is the **top layer**; `intensity` (0–4) is **how hard you lean into
it**. Together they own the whole stance — profile, CPU PL1, EPP, turbo, and the
GPU — so you set one thing instead of six. Leaving `mission` empty (`""`) keeps
the original `mode`/`manual_profile` behaviour untouched.

```
phanspeed mission endure       # pick the stance
phanspeed intensity 4          # …and how hard
phanspeed survive              # shortcut: mission endure
phanspeed mission off          # back to legacy mode/profile control
```

In the pill it's a **mission chip row** with an **intensity dial** beneath it,
and the headline readout **re-skins to the active mission's metric**.

## 🧊 Cool — survive heat

The original mission, from when this Precision's CPU fan died and the package hit
96 °C. Temperature is the enemy; the lever is **watts at the source** (RAPL PL1)
plus cool/quiet fan profiles. Rising intensity = cooler profile, lower power cap,
power-biased EPP, and (top end) turbo off.

## 🔥 Perf — unleash

Once the fans were repaired, the opposite mission: cooling is no longer scarce,
so take everything the chassis allows. Max-cooling fan profile, the power cap
opened up (eventually to the firmware default), performance EPP, and turbo on
where the firmware permits it. Rising intensity pushes power and boost higher.

## 🔋 Endure — survive power

The third mission, from running on a **20 W USB-C trickle**. Here the objective
flips: not "fastest within thermal limits" but **lowest draw that keeps the
machine alive** — ideally net battery drain ≤ 0 so it holds or slowly charges on
whatever wattage the source provides.

Endure pulls every lever at once:

1. **Closed-loop CPU cap.** The PL1 cap *hunts* between an intensity-set floor
   and ceiling, watching the power balance: it **tightens while the battery
   drains and relaxes when there's surplus**, converging on break-even.
2. **dGPU sleep** (`endure_gpu_sleep`, default on). Drives the discrete GPU's PCI
   `power/control` to `auto` so it drops to **D3cold** when idle — the single
   biggest idle-power lever on an Optimus laptop, where the dGPU otherwise burns
   several watts at 0 % utilisation. Works even where `nvidia-smi -pl` is
   firmware-locked. *(Caveat: `nvidia-persistenced`, if running, pins the GPU on
   and defeats this — stop/mask it for the full saving.)*
3. **Power-biased EPP + turbo off** — the cheap, always-safe wins.
4. **"At all costs" trims** (`endure_trim`, default on) at intensity ≥ 3: dim the
   panel backlight and turn off the keyboard backlight. The prior levels are
   remembered and restored when you leave Endure (or on daemon exit).

### The instrument: power balance

Endure steers by a live reading the daemon publishes as `power_balance`:

| Field | Meaning |
|-------|---------|
| `in_w` | watts coming in from the charger / USB-C source(s) |
| `battery_w` | **net** battery power — `+` charging, `−` draining |
| `draw_w` | total system draw (`in_w − battery_w`) |
| `remaining_min` | runtime to empty (draining) or to full (charging) |
| `breakeven` | `true` when `battery_w ≥ 0` — i.e. you're holding or gaining |

`battery_w` comes from `power_now`/`current_now` where the battery reports them,
and otherwise from a **charge-gauge delta** between polls (this Dell reports
neither instantaneously). The pill renders it as the **break-even gauge** —
`+2W ▲ holding · 11h` or `−8W ▼ 1h12m` — so you can dial intensity (or close a
browser tab) until you cross into positive territory and watch it hold.

### Intensity → Endure cap window (base TDP ≈ 45 W)

| Intensity | Cap floor–ceiling | Trims |
|-----------|-------------------|-------|
| 0 (gentle) | ~25–45 W | — |
| 1 | ~25–31 W | — |
| 2 | ~18–22 W | — |
| 3 | ~12–18 W | panel + kbd |
| 4 (at all costs) | ~8–15 W | panel + kbd |

## Safety

Missions sit on top of the same failsafe as everything else: the thermal
**emergency override** always wins (above `emergency_temp` the daemon forces max
cooling + base TDP regardless of mission), and `sanitize_config()` validates
`mission`/`intensity` like every other socket-settable field. See
[ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](../SECURITY.md).
