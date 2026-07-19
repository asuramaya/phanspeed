<!-- Thanks for contributing! -->

## What & why

<!-- What does this change and why? -->

## Checklist

- [ ] `python3 tests/attack_socket.py` prints **ALL ATTACKS DEFENDED**
- [ ] `python3 -m py_compile bin/phanspeedd` is clean
- [ ] `node --check extension/phanspeed@asuramaya/extension.js` is clean (if touched)
- [ ] `systemd-analyze verify ./systemd/phanspeed.service` is clean (if touched)
- [ ] Any new socket/config field is validated & clamped in `sanitize_config` and
      added to the fuzz lists in `tests/attack_socket.py`
- [ ] Daemon stays dependency-free (Python stdlib only)
