# Submitting the pill to extensions.gnome.org (eGO)

The Quick Settings extension can be published to
[extensions.gnome.org](https://extensions.gnome.org) so users can install it
without cloning the repo. **The daemon (`phanspeedd`) still has to be installed
separately** — eGO only hosts the shell extension, so the listing must tell users
to install the daemon first (the description already links the repo).

## Build the zip

```bash
./make-extension-zip.sh
# -> dist/phanspeed@local.shell-extension.zip
```

Upload it at <https://extensions.gnome.org/upload/> while signed in.

## Reviewer checklist (eGO rules)

- [x] **`metadata.json`** has `uuid`, `name`, `description`, `shell-version`,
      `url`, integer `version`.
- [x] **Cleanup in `disable()`** — the GLib timeout is removed and the indicator
      destroyed; nothing survives disable.
- [x] **No top-level side effects** — all work happens in `enable()`.
- [x] **No excessive logging** — only `logError` on a genuine failure.
- [x] **No `eval`, no network, no spawning external processes.**
- [x] **GPL-compatible license** (GPL-3.0-or-later).
- [ ] Bump the integer `version` on every upload (eGO requires it to increase).

### Likely reviewer questions & answers

- **Why does it read `/run/phanspeed/status.json` and write a socket?**
  The privileged work (writing `platform_profile` / RAPL) is done by a separate
  root daemon; the extension only displays state and sends user-initiated
  commands. This is the standard split for hardware that needs root.
- **Synchronous IO.** Status is read from a small local file on a 2 s timer;
  the control socket uses a 2 s connect timeout and is only touched on a click.
  If a reviewer asks, the socket send can be moved to
  `Gio.SocketClient.connect_async` / `output_stream.write_all_async` — tracked as
  a follow-up; behaviour is unchanged.

## After approval

Add the eGO badge/link to the README install section.
