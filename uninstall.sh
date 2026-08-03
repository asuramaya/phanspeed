#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 asuramaya and phanspeed contributors
set -euo pipefail
REAL_USER="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
USER_UID="$(id -u "$REAL_USER")"
EXT_UUID="phanspeed@asuramaya"
PREFIX="${PREFIX:-/usr/local}"
if [[ $EUID -ne 0 ]]; then exec sudo -E bash "$0" "$@"; fi

echo "== uninstalling phanspeed =="
systemctl disable --now phanspeed-update.timer 2>/dev/null || true
systemctl disable --now phanspeed-healthcheck.timer 2>/dev/null || true
systemctl disable --now phanspeed.service 2>/dev/null || true
echo balanced > /sys/firmware/acpi/platform_profile 2>/dev/null || true
rm -f /etc/systemd/system/phanspeed.service \
      /etc/systemd/system/phanspeed-healthcheck.service \
      /etc/systemd/system/phanspeed-healthcheck.timer \
      /etc/systemd/system/phanspeed-update.service \
      /etc/systemd/system/phanspeed-update.timer
rm -f "$PREFIX/bin/phanspeedd" "$PREFIX/bin/phanspeed" \
      "$PREFIX/bin/phanspeed-healthcheck" "$PREFIX/bin/phanspeed-tune" \
      "$PREFIX/bin/phanspeed-update"
# $PREFIX/share/phanspeed/lib (the current vendor location, see install.sh)
# is covered by the rm -rf below. An install from before the private-lib-dir
# move (BOOTSTRAP.md, ruling 3e44bd95) may have left vendored sutra copies
# beside the binaries instead -- nothing else on the machine cleans those up.
rm -f "$PREFIX"/bin/sutra*.py "$PREFIX"/bin/sutra*.version "$PREFIX"/bin/sutra*.commit
rm -rf "$PREFIX/share/phanspeed"
# VERSION + the release-signing anchor install.sh writes at a fixed path
# regardless of $PREFIX (see install.sh's note on why).
rm -rf /usr/share/phanspeed
systemctl daemon-reload

# disable + remove the extension as the user
sudo -u "$REAL_USER" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$USER_UID/bus" \
  gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
rm -rf "$USER_HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "Removed (config in /etc/phanspeed left in place). Log out/in to drop the pill."
