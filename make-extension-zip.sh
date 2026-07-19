#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Build the GNOME Shell extension zip for upload to extensions.gnome.org.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p dist
gnome-extensions pack extension/phanspeed@asuramaya --force --out-dir dist

zip="dist/phanspeed@asuramaya.shell-extension.zip"
echo "built: $zip"
echo "contents:"
unzip -l "$zip"
echo
echo "Next: upload $zip at https://extensions.gnome.org/upload/ (see SUBMISSION.md)"
