#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 asuramaya and PhanSpeed contributors
# PhanSpeed installer — Dell thermal/fan control daemon + Quick Settings pill.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
REAL_USER="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
USER_UID="$(id -u "$REAL_USER")"
EXT_UUID="phanspeed@local"
EXT_DIR="$USER_HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

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

# 1. daemon binary (root-owned, not group/world writable)
echo "-- installing daemon -> /usr/local/bin/phanspeedd"
install -m 0755 -o root -g root "$SRC/bin/phanspeedd" /usr/local/bin/phanspeedd

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
  "rate_limit": 10
}
JSON
fi
chown root:root /etc/phanspeed/config.json
chmod 0600 /etc/phanspeed/config.json

# 3. systemd service
echo "-- installing + enabling phanspeed.service"
install -m 0644 "$SRC/systemd/phanspeed.service" /etc/systemd/system/phanspeed.service
systemctl daemon-reload
systemctl enable --now phanspeed.service

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
