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
- **Sandboxed unit** — zero capabilities, `ProtectSystem=strict`,
  `MemoryDenyWriteExecute`, `SystemCallFilter=@system-service`, private
  tmp/devices/keyring, least-privilege file modes.

Adversarial tests live in `tests/attack_socket.py` and assert the failsafe
invariants hold under fuzzing. Please keep them passing in any security-relevant
PR.
