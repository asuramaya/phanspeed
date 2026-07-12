# E-core-first power policy — spec (v0.29.0) and the rotten-apple composition

Status: **spec, not yet built.** Bare-metal half targets phanspeed v0.29.0;
the Xen half is a contract for rotten-apple to consume, not phanspeed code.

## The idea in one line

On battery, background work should be physically incapable of waking a P-core:
confine it to the E-cores (cpu 12–19 on the i9-12900H), giving battery drain a
hard *ceiling* instead of a hope. This is the macOS QoS-to-E-cluster policy,
which Linux does not ship: ITMT actually biases the scheduler *toward* P-cores.

Measured basis (2026-07-12, Precision 5770, all 8 E-cores enabled):

* The battery-load limiter is **EDP/ICCmax (current), not thermal or RAPL** —
  the exact ceiling E-cores duck (turbostat + MSR 0x64f, every sample).
* Confinement of user+system+init to E-cores at *heavy* background churn:
  idle package 17.3 W → 14.9 W, drain −3.8 W. At *light* load: ≈0. The value
  is the ceiling, not the average.
* A runaway workload on battery burns 8 E-cores at ≤3.8 GHz instead of
  6 P-cores at 4.9 GHz + HT.

## Part 1 — bare metal (phanspeed v0.29.0)

### Topology detection

Pure function `little_cpus()`: parse
`/sys/devices/system/cpu/cpu*/topology/thread_siblings_list`; CPUs whose
sibling list is a singleton are E-cores (Intel hybrid: E-cores have no HT).
Guards, all mandatory:

* **Hybrid guard** — both sets non-empty, else feature is inert (covers
  HT-off machines, which would misclassify every core as "E").
* **Hypervisor guard** — `/sys/hypervisor/type` exists ⇒ inert. Under Xen,
  dom0's vCPU topology is virtual; confining dom0 processes to "cpu 12–19"
  pins nothing physical. Placement belongs to the hypervisor layer (Part 2).

### Trigger matrix

Confine iff **all** of: `mission == endure` · `on_battery` · `intensity ≥ 3`
· config `endure_ecores` (default true). Anything else ⇒ released.

### Actuator

`systemctl set-property --runtime <slice> AllowedCPUs=<E-set>` on
`user.slice`, `system.slice`, `init.scope` (config
`endure_confine_slices`; `machine.slice` deliberately NOT default — VM
placement belongs to the orchestrator, see Part 2). `--runtime` means a crash
or reboot can never wedge the machine confined. Release = set-property with
empty `AllowedCPUs`.

Failsafe: on daemon start, unconditionally release all managed slices before
first evaluation (recovers from a killed daemon that left cpusets applied).
Release also on: AC attach, mission change, intensity drop, daemon exit
(atexit, same path as profile/RAPL restore).

### Unit pausing (the agent-fleet lever)

Config `endure_pause_units: []` — user-named systemd units stopped on
battery-endure entry and started again on release (`--runtime` state only;
never enable/disable). Measured motivation: an idle Claude-harness support
fleet (agents daemon + spares + pty hosts) burns ~⅔ of the background CPU on
this box. Default empty: phanspeed never guesses which services are expendable.

### Surface

* status: `endure.ecores: bool`, `endure.paused_units: [names]`
* pill (ext v21): `E‑cores` tag in the Endure hero row while confined.
* CLI: `phanspeed status` shows the same; no new verbs.

### Tests

* `little_cpus` parser: 12900H shape → `12-19`; HT-everywhere → inert;
  no-HT → inert; holes in numbering.
* Trigger matrix truth table (pure function, like `arbitrate_cap`).
* Idempotence: apply twice = once; release without apply = no-op.

### Non-goals

No CPU hotplug (cpu0 can't offline; cpusets achieve the same), no ITMT/EAS
tuning, no per-process QoS classification (that's a scheduler's job, not a
daemon's), no cgroup writes outside the named slices.

## Part 2 — the rotten-apple composition

rotten-apple is the single-libxl-owner Xen orchestrator (JSON-RPC over
`/run/rotten-apple.sock` + vsock into guests). The box has two boot
personalities, and the policy has to survive both:

| | bare-metal boot (today) | `rotten-apple Xen` boot |
|---|---|---|
| owns pCPUs & P/C-states | Linux kernel | **Xen** (`xenpm`, not dom0) |
| phanspeed's cpuset lever | works (Part 1) | **inert by guard** — dom0 vCPUs are virtual |
| phanspeed's RAPL lever | works (MSR + MMIO) | MSR powercap driver absent under Xen; treat caps as unavailable |
| battery/fans/WMI/ACPI sensors | phanspeed | still phanspeed (dom0 owns ACPI) |
| who places workloads on E-cores | systemd cpusets | **rotten-apple via Xen cpupools** |

### Division of labor

**phanspeed = power-state oracle. rotten-apple = placement actuator.**
phanspeed keeps doing what only it does well — reading the battery, the
firmware, the missions, the wall-budget arbitration — and *publishes* the
power state. rotten-apple keeps doing what only it can do — it is the single
libxl owner — and *acts* on that state at the hypervisor layer.

### The contract (already mostly shipped)

`/run/phanspeed/status.json` is world-readable and updated every poll. The
orchestrator watches it (inotify; zero polling cost) and reads:

```json
{ "on_battery": true, "mission": "endure", "intensity": 4,
  "power_balance": {"budget_w": null, "battery_w": -21.0},
  "endure": {"ecores": true} }
```

Orchestrator policy sketch (rotten-apple side, not phanspeed's code):

* At Xen boot, create two cpupools: `pcores` (0–11) and `ecores` (12–19),
  dom0 vCPUs pinned to a small E-core subset.
* On `on_battery && mission == endure`: `xl cpupool-migrate` every domU to
  `ecores`, balloon guests down, `xenpm set-max-cstate`/governor for the
  deep-idle floor. On AC: migrate back, balloon up.
* GPU rule: the A3000 passed through to a domU cannot be runtime-suspended
  by dom0 — on battery the orchestrator should refuse to *start* GPU
  instances (and optionally shut them down), because a passthrough GPU held
  awake costs ~8.5 W plus the package-C-state penalty (measured: it caps the
  whole package at PC2).

### The pin API (Soundwave's ask, same contract)

The promised job-scoped pin rides the same socket: a tenant (or the
orchestrator relaying for a guest over vsock) sends
`{"pin": {"mission": "perf", "ttl_s": 3600, "owner": "domU:soundwave"}}`;
phanspeed holds the mission until TTL/expiry/release and reports the owner in
status. On battery-endure a pin request is *answered* (denied or granted per
config), never silently ignored — the v0.26.2 incident class (one team's
power choice invisibly clamping another's GPU) becomes a visible, negotiated
transaction. Guests never talk to phanspeed directly; the orchestrator is the
only client, so the daemon's attack surface doesn't grow.

### Why this shape

One brain per layer, one writer per knob: phanspeed is the only writer of
platform_profile/RAPL/EPP (bare metal) and the only reader of missions;
rotten-apple is the only libxl owner. The alternative — phanspeed calling
`xl`, or the orchestrator writing sysfs — gives two writers per knob, which
is exactly what caused the platform_profile GPU-clamp incident. The contract
between them is one JSON file and one socket, both of which already exist.
