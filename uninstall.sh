#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 asuramaya and PhanSpeed contributors
set -euo pipefail
REAL_USER="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
USER_UID="$(id -u "$REAL_USER")"
EXT_UUID="phanspeed@local"
if [[ $EUID -ne 0 ]]; then exec sudo -E bash "$0" "$@"; fi

echo "== uninstalling PhanSpeed =="
systemctl disable --now phanspeed-healthcheck.timer 2>/dev/null || true
systemctl disable --now phanspeed.service 2>/dev/null || true
echo balanced > /sys/firmware/acpi/platform_profile 2>/dev/null || true
rm -f /etc/systemd/system/phanspeed.service \
      /etc/systemd/system/phanspeed-healthcheck.service \
      /etc/systemd/system/phanspeed-healthcheck.timer
rm -f /usr/local/bin/phanspeedd /usr/local/bin/phanspeed \
      /usr/local/bin/phanspeed-healthcheck /usr/local/bin/phanspeed-tune
rm -rf /usr/share/phanspeed
systemctl daemon-reload

# disable + remove the extension as the user
sudo -u "$REAL_USER" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$USER_UID/bus" \
  gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
rm -rf "$USER_HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "Removed (config in /etc/phanspeed left in place). Log out/in to drop the pill."
