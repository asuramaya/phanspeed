#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 asuramaya and PhanSpeed contributors
# PhanSpeed installer — Dell thermal/fan control daemon + Quick Settings pill.
set -euo pipefail

REPO="asuramaya/phanspeed"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)"
REAL_USER="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
USER_UID="$(id -u "$REAL_USER")"
EXT_UUID="phanspeed@local"
EXT_DIR="$USER_HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

# Pinned release-signing key (docs/RELEASE-SIGNING.md), for the bootstrap
# below. A fresh `curl -fsSL .../install.sh | bash` fetches ONLY this file —
# not the sibling release-signing/ directory — so the trust anchor has to
# travel embedded in whichever copy of this script is currently executing,
# not be read from a file that hasn't been fetched yet (that would mean
# trusting the very release being verified). Empty = no key provisioned yet;
# falls back to SHA256-only with a warning, same as phanspeed-update. Keep in
# sync with release-signing/allowed_signers when a real key lands there.
RELEASE_ALLOWED_SIGNERS=""

# Bootstrap for the one-line install (`curl -fsSL .../install.sh | bash`): if
# we aren't sitting next to the source tree, fetch+verify the release's OWN
# .deb and install straight from it. NOT GitHub's auto-generated tarball_url
# (the previous approach) — that artifact has never had checksum coverage
# (packaging/build-deb.sh's SHA256SUMS only ever contains the .deb's hash),
# so no signature check could ever mean anything applied to it. Anyone
# wanting a source install instead should clone the repo and run this script
# from within it — untouched, and skips this block entirely.
if [[ ! -f "$SRC/bin/phanspeedd" ]]; then
  echo "== fetching latest PhanSpeed release =="
  command -v dpkg >/dev/null || {
    echo "dpkg not found — this quick-install path needs a Debian/Ubuntu"
    echo "system. Clone the repo and run install.sh from a full checkout"
    echo "instead."
    exit 1
  }
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  api_json="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" \
    || { echo "release metadata fetch failed"; exit 1; }
  deb_url="$(grep -m1 '"browser_download_url":.*\.deb"' <<<"$api_json" | cut -d'"' -f4)"
  sums_url="$(grep -m1 '"browser_download_url":.*/SHA256SUMS"' <<<"$api_json" | cut -d'"' -f4)"
  [[ -n "$deb_url" && -n "$sums_url" ]] \
    || { echo "release has no .deb/SHA256SUMS asset — refusing to install unverified."; exit 1; }

  curl -fsSL "$deb_url" -o "$TMP/phanspeed.deb" || { echo "deb download failed"; exit 1; }
  curl -fsSL "$sums_url" -o "$TMP/SHA256SUMS" || { echo "SHA256SUMS download failed"; exit 1; }

  debname="$(basename "$deb_url")"
  want="$(awk -v n="$debname" '$2==n || $2=="*"n {print $1}' "$TMP/SHA256SUMS")"
  [[ -n "$want" ]] || { echo "SHA256SUMS has no entry for $debname — aborting."; exit 1; }
  got="$(sha256sum "$TMP/phanspeed.deb" | cut -d' ' -f1)"
  [[ "$got" == "$want" ]] || { echo "CHECKSUM MISMATCH for $debname — aborting."; exit 1; }
  echo "sha256 verified."

  if [[ -n "$RELEASE_ALLOWED_SIGNERS" ]]; then
    sig_url="$(grep -m1 '"browser_download_url":.*SHA256SUMS\.sig"' <<<"$api_json" | cut -d'"' -f4)"
    [[ -n "$sig_url" ]] \
      || { echo "signing key is pinned but the release has no SHA256SUMS.sig — refusing to install unsigned."; exit 1; }
    curl -fsSL "$sig_url" -o "$TMP/SHA256SUMS.sig" || { echo "SHA256SUMS.sig download failed"; exit 1; }
    printf '%s\n' "$RELEASE_ALLOWED_SIGNERS" > "$TMP/allowed_signers"
    ssh-keygen -Y verify -f "$TMP/allowed_signers" -I phanspeed-release \
      -n phanspeed-release -s "$TMP/SHA256SUMS.sig" < "$TMP/SHA256SUMS" \
      || { echo "SIGNATURE VERIFICATION FAILED — aborting."; exit 1; }
    echo "signature verified."
  else
    echo "warning: no release-signing key provisioned yet (see"
    echo "docs/RELEASE-SIGNING.md) — proceeding on SHA256 alone."
  fi

  if [[ $EUID -eq 0 ]]; then
    dpkg -i "$TMP/phanspeed.deb"
  else
    echo "Installing (will prompt for sudo)..."
    sudo dpkg -i "$TMP/phanspeed.deb"
  fi
  sudo -u "$REAL_USER" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$USER_UID/bus" \
    gnome-extensions enable "$EXT_UUID" 2>/dev/null \
    && echo "pill enabled for $REAL_USER" \
    || echo "(enable it after your next login: gnome-extensions enable $EXT_UUID)"
  echo
  echo ">>> LOG OUT and back in once <<<  (Wayland must restart the shell to load a"
  echo "    new extension). After that the PhanSpeed pill appears in Quick Settings"
  echo "    next to Wi-Fi/Bluetooth — no further logouts ever needed."
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  echo "Re-running with sudo..."
  exec sudo -E bash "$0" "$@"
fi

umask 077   # anything we create is private by default; loosen explicitly below

echo "== PhanSpeed installer =="

# 0. migrate off the old prototype, if present
if systemctl list-unit-files dellfand.service &>/dev/null; then
  echo "-- removing old dellfand service"
  systemctl disable --now dellfand.service 2>/dev/null || true
  rm -f /etc/systemd/system/dellfand.service
fi
rm -f /usr/local/bin/dellfand /usr/local/bin/dellfanctl \
      /usr/local/share/applications/dellfanctl.desktop \
      /usr/local/share/icons/hicolor/scalable/apps/dellfanctl.svg 2>/dev/null || true

# 1. daemon + healthcheck binaries (root-owned, not group/world writable)
echo "-- installing daemon -> /usr/local/bin/phanspeedd"
install -m 0755 -o root -g root "$SRC/bin/phanspeedd" /usr/local/bin/phanspeedd
install -m 0755 -o root -g root "$SRC/bin/phanspeed" /usr/local/bin/phanspeed
install -m 0755 -o root -g root "$SRC/bin/phanspeed-healthcheck" /usr/local/bin/phanspeed-healthcheck
install -m 0755 -o root -g root "$SRC/bin/phanspeed-tune" /usr/local/bin/phanspeed-tune
install -m 0755 -o root -g root "$SRC/bin/phanspeed-update" /usr/local/bin/phanspeed-update
# version marker so `phanspeed version` works on source installs too
install -d -m 0755 /usr/share/phanspeed
install -m 0644 "$SRC/VERSION" /usr/share/phanspeed/VERSION
# release-signing trust anchor (docs/RELEASE-SIGNING.md) -- empty until a key
# is provisioned; phanspeed-update degrades to SHA256-only until it isn't
install -m 0644 "$SRC/release-signing/allowed_signers" \
        /usr/share/phanspeed/allowed_signers

# 2. default config (auto mode); allow_uids locks control to the installing user
echo "-- writing default config -> /etc/phanspeed/config.json (allow_uids=[$USER_UID])"
install -d -m 0755 -o root -g root /etc/phanspeed
if [[ ! -f /etc/phanspeed/config.json ]]; then
  cat > /etc/phanspeed/config.json <<JSON
{
  "poll_interval": 3.0,
  "mode": "auto",
  "manual_profile": "balanced",
  "sensor": "auto",
  "quiet_below": 60,
  "cool_above": 80,
  "hysteresis": 4,
  "emergency_temp": 90,
  "emergency_clear_temp": 78,
  "allow_uids": [${USER_UID}],
  "rate_limit": 10,
  "power_limit_w": 0,
  "power_auto": false,
  "power_floor_w": 0,
  "battery_aware": false,
  "battery_profile": "quiet",
  "battery_power_w": 0,
  "turbo": "auto",
  "epp": "",
  "battery_epp": "",
  "gpu_power_limit_w": 0,
  "gpu_persistence": false,
  "mission": "",
  "intensity": 2,
  "endure_gpu_sleep": true,
  "endure_trim": true
}
JSON
fi
chown root:root /etc/phanspeed/config.json
chmod 0600 /etc/phanspeed/config.json

# 3. systemd service + healthcheck timer
echo "-- installing + enabling phanspeed.service"
install -m 0644 "$SRC/systemd/phanspeed.service" /etc/systemd/system/phanspeed.service
install -m 0644 "$SRC/systemd/phanspeed-healthcheck.service" /etc/systemd/system/phanspeed-healthcheck.service
install -m 0644 "$SRC/systemd/phanspeed-healthcheck.timer" /etc/systemd/system/phanspeed-healthcheck.timer
systemctl daemon-reload
systemctl enable --now phanspeed.service
systemctl enable --now phanspeed-healthcheck.timer
# NOTE: the daily auto-update timer is intentionally NOT enabled for a source
# install — auto-update installs a .deb (into /usr/bin), which would be shadowed
# by these /usr/local/bin copies. `phanspeed update --check` still works for
# manual notification; install the .deb for in-place auto-updates.

# 4. GNOME Shell extension (into the real user's home)
echo "-- installing Quick Settings extension -> $EXT_DIR"
sudo -u "$REAL_USER" mkdir -p "$EXT_DIR"
install -m 0644 -o "$REAL_USER" -g "$REAL_USER" \
  "$SRC/extension/$EXT_UUID/metadata.json" "$EXT_DIR/metadata.json"
install -m 0644 -o "$REAL_USER" -g "$REAL_USER" \
  "$SRC/extension/$EXT_UUID/extension.js" "$EXT_DIR/extension.js"

echo "-- enabling extension for $REAL_USER"
sudo -u "$REAL_USER" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$USER_UID/bus" \
  gnome-extensions enable "$EXT_UUID" 2>/dev/null \
  && echo "   enabled" \
  || echo "   (will enable on next login; or run: gnome-extensions enable $EXT_UUID)"

# 5. verify nothing is group/world-writable and perms are as intended
echo "-- verifying permissions"
verify() {  # path  expected-octal
  local p="$1" want="$2" got
  got="$(stat -c '%a' "$p" 2>/dev/null || echo '?')"
  if [[ "$got" == "$want" ]]; then echo "   OK   $p ($got)"
  else echo "   WARN $p is $got, expected $want"; fi
}
verify /usr/local/bin/phanspeedd 755
verify /etc/phanspeed/config.json 600
verify /etc/systemd/system/phanspeed.service 644
ww="$(find /usr/local/bin/phanspeedd /etc/phanspeed /etc/systemd/system/phanspeed.service -perm -o+w 2>/dev/null || true)"
[[ -z "$ww" ]] && echo "   OK   no world-writable install artifacts" || echo "   WARN world-writable: $ww"

echo
echo "== done =="
systemctl --no-pager --full status phanspeed.service | head -n 5 || true
echo
echo ">>> LOG OUT and back in once <<<  (Wayland must restart the shell to load a"
echo "    new extension). After that the PhanSpeed pill appears in Quick Settings"
echo "    next to Wi-Fi/Bluetooth — no further logouts ever needed."
