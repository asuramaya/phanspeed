#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# One-command activation for the phanspeed@local -> phanspeed@asuramaya
# extension UUID migration (staged on branch uuid-migration-asuramaya,
# Alfred/bytebye charter). NOT run automatically by install.sh/postinst --
# this is the operator's own call, at a logout/login of their choosing
# (GNOME Shell only loads a new extension UUID after a Wayland relogin,
# same as any extension version bump -- no full reboot required).
#
# Prerequisite: a phanspeed release built from this migration must already
# be installed (i.e. /usr/share/gnome-shell/extensions/phanspeed@asuramaya
# exists) before running this. Run as the normal desktop user, NOT root --
# gnome-extensions enable/disable is per-user dconf state.
set -euo pipefail

OLD_UUID="phanspeed@local"
NEW_UUID="phanspeed@asuramaya"
LOCAL_EXT_DIR="$HOME/.local/share/gnome-shell/extensions"

if [[ $EUID -eq 0 ]]; then
  echo "error: run this as your normal desktop user, not root."
  exit 1
fi

if ! [[ -d "/usr/share/gnome-shell/extensions/$NEW_UUID" ]]; then
  echo "error: $NEW_UUID isn't installed system-wide yet --"
  echo "       install a phanspeed release built from this migration first."
  exit 1
fi

# A source install (install.sh, pre-migration) puts a copy under
# ~/.local/share/... which SHADOWS the packaged system-wide copy (documented
# gotcha -- see README "Install-layout"). A leftover local phanspeed@local
# would otherwise shadow the new packaged phanspeed@asuramaya forever.
if [[ -d "$LOCAL_EXT_DIR/$OLD_UUID" ]]; then
  echo "-- removing shadowing local copy: $LOCAL_EXT_DIR/$OLD_UUID"
  rm -rf "${LOCAL_EXT_DIR:?}/$OLD_UUID"
fi

echo "-- disabling $OLD_UUID"
gnome-extensions disable "$OLD_UUID" 2>/dev/null || true

echo "-- enabling $NEW_UUID"
gnome-extensions enable "$NEW_UUID"

echo
echo "Done. Log out and back in once (Wayland) for GNOME Shell to load the"
echo "new UUID -- same as any extension version bump."
