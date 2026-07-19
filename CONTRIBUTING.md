# Contributing to PhanSpeed

Thanks for your interest! PhanSpeed is small and dependency-free on purpose —
keep changes simple and self-contained.

## Project layout

```
bin/phanspeedd                 root daemon (pure Python stdlib, no deps)
extension/phanspeed@asuramaya/ GNOME Shell Quick Settings extension (GJS, ESM)
systemd/phanspeed.service      hardened systemd unit
tests/attack_socket.py         adversarial test harness
diag.py                        hardware probe (proves what your Dell allows)
install.sh / uninstall.sh
```

## Dev setup

No build step. To work on the daemon without installing system-wide, you can run
the test harness, which exercises the real code against a temp socket:

```bash
python3 tests/attack_socket.py     # must print "ALL ATTACKS DEFENDED"
python3 -m py_compile bin/phanspeedd
```

For the extension, after editing `extension/phanspeed@asuramaya/extension.js`:

```bash
node --check extension/phanspeed@asuramaya/extension.js   # syntax
# install + log out/in (Wayland) to load it, then watch:
journalctl -f -o cat /usr/bin/gnome-shell             # extension logs
```

## Before opening a PR

- `python3 tests/attack_socket.py` passes.
- `systemd-analyze verify ./systemd/phanspeed.service` is clean.
- Any new socket/config field is **validated and clamped** in `sanitize_config`
  (and covered by the fuzz lists in `tests/attack_socket.py`). The daemon runs as
  root on a world-reachable socket — untrusted input must never crash it or
  weaken the thermal failsafe.
- Keep the daemon dependency-free (Python stdlib only).

## Hardware support

PhanSpeed was built on a Dell Precision 5770 but should work on any Dell exposing
`platform_profile` via `dell-smm-hwmon`. If you test it on another model, please
open an issue/PR noting the model, kernel, and `diag.py` output so we can grow a
compatibility list.

## License

By contributing you agree your contributions are licensed under
**GPL-3.0-or-later**, matching the project.
