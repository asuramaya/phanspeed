# Submitting the pill to extensions.gnome.org (eGO)

The Quick Settings extension can be published to
[extensions.gnome.org](https://extensions.gnome.org) so users can install it
without cloning the repo. **The daemon (`phanspeedd`) still has to be installed
separately** — eGO only hosts the shell extension, so the listing must tell users
to install the daemon first (the description already links the repo).

## Build the zip

```bash
./make-extension-zip.sh
# -> dist/phanspeed@asuramaya.shell-extension.zip
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
- **IO model.** The control socket is **fully asynchronous**
  (`connect_async` → `write_all_async` → `close_async`, with a Cancellable that
  is cancelled in `disable()`), so it can never block the compositor. Status is
  read from a small local file (`/run/phanspeed/status.json`, tmpfs) on a 2 s
  timer — a negligible synchronous read.

## After approval

Add the eGO badge/link to the README install section.
