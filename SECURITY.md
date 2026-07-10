# Security Policy

PhanSpeed runs a **root daemon** that accepts commands over a local Unix socket,
so security is taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead use GitHub's
private reporting:

1. Go to the repo's **Security** tab → **Report a vulnerability**.
2. Describe the issue, affected version, and a reproduction if possible.

You'll get a response as soon as reasonably possible.

## Threat model

The relevant attacker is an **unprivileged local process** abusing the root
daemon. There is no network attack surface — the daemon binds only an `AF_UNIX`
socket (`IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`).

Hardening in place (see the daemon and `systemd/phanspeed.service`):

- **SO_PEERCRED** authorization — only root and configured `allow_uids` may issue
  commands; the socket is owned by the user, mode `0660`.
- **All input is clamped/validated** on the socket *and* on config load.
  `emergency_temp` is hard-capped (95 °C) so the thermal failsafe can never be
  disabled; safety invariants are always enforced.
- **DoS-resistant** — 64 KB read cap, per-command rate limiting.
- **Sandboxed unit** — exactly one capability (`CAP_CHOWN`, only to hand the
  socket + status file to the logged-in user), `ProtectSystem=strict`,
  `MemoryDenyWriteExecute`, `SystemCallFilter=@system-service`, private
  tmp/devices/keyring, least-privilege file modes. `DevicePolicy=closed` with a
  `DeviceAllow` for only the NVIDIA nodes (for optional GPU power control via
  `nvidia-smi`); no other device access.
- **`allow_uids` fallback is narrow, not "any session"** — with none configured
  (never the shipped default, which is set to the installing user), the daemon
  falls back to root + the single seat owner, not every logged-in session.
- **`/etc/phanspeed/config.json` is mode `0600`**, root-owned only.

## Update path

The daemon has no network access; `phanspeed-update` is the one component that
does, so it gets its own threat model. As of **v0.25.0**:

- The daily timer runs it with **`--check` only** — it checks and logs, it never
  installs unattended. Installing a new `.deb` happens interactively, either via
  the pill's `pkexec` prompt or an explicit `sudo phanspeed update` run.
- Install **fails closed** on integrity: no `SHA256SUMS` asset, no matching entry
  for the exact `.deb`, or a hash mismatch all abort rather than installing
  anyway. (This is still corruption/tamper-of-transit protection over HTTPS +
  checksum, not a cryptographic signature — GPG/minisign signing is a planned
  hardening step.)
- The download is written to an unpredictable `mkstemp()` file (`O_EXCL`, mode
  `0600`) instead of a predictable name in world-writable `/tmp`, and the unit
  has `PrivateTmp=yes` — closing a symlink/TOCTOU write-through a local user
  could otherwise set up.
- The response body is capped (128 MiB) so a compromised or MITM'd endpoint
  can't exhaust memory on the root process.

Adversarial tests live in `tests/attack_socket.py` and assert the failsafe
invariants hold under fuzzing. Please keep them passing in any security-relevant
PR.
