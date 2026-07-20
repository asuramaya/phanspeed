#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Build a phanspeed .deb from the repo with dpkg-deb (no debhelper needed).
# Output: dist/phanspeed_<version>_all.deb  +  dist/SHA256SUMS
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(tr -d '[:space:]' < "$SRC/VERSION")"
PKG="phanspeed"
DIST="$SRC/dist"
BUILD="$(mktemp -d)"
ROOT="$BUILD/${PKG}_${VER}"
trap 'rm -rf "$BUILD"' EXIT

echo "== building ${PKG} ${VER} =="

install -d "$ROOT/DEBIAN" \
          "$ROOT/usr/bin" \
          "$ROOT/lib/systemd/system" \
          "$ROOT/usr/share/gnome-shell/extensions/phanspeed@asuramaya" \
          "$ROOT/usr/share/phanspeed" \
          "$ROOT/usr/share/man/man1" \
          "$ROOT/usr/share/man/man8" \
          "$ROOT/etc/phanspeed"

# binaries -> /usr/bin
for b in phanspeedd phanspeed phanspeed-healthcheck phanspeed-tune phanspeed-update; do
    install -m 0755 "$SRC/bin/$b" "$ROOT/usr/bin/$b"
done

# vendored sutra backbone -> sibling of the bins that import it (they add
# their own directory to sys.path automatically; not executable itself)
install -m 0644 "$SRC/bin/sutra.py" "$ROOT/usr/bin/sutra.py"

# man pages
install -m 0644 "$SRC/man/phanspeed.1" "$ROOT/usr/share/man/man1/phanspeed.1"
install -m 0644 "$SRC/man/phanspeedd.8" "$ROOT/usr/share/man/man8/phanspeedd.8"

# systemd units -> /lib/systemd/system, rewriting /usr/local/bin -> /usr/bin
for u in phanspeed.service phanspeed-healthcheck.service phanspeed-healthcheck.timer \
         phanspeed-update.service phanspeed-update.timer; do
    sed 's#/usr/local/bin#/usr/bin#g' "$SRC/systemd/$u" \
        > "$ROOT/lib/systemd/system/$u"
done

# GNOME extension -> system-wide (users still `gnome-extensions enable`)
install -m 0644 "$SRC/extension/phanspeed@asuramaya/extension.js" \
        "$ROOT/usr/share/gnome-shell/extensions/phanspeed@asuramaya/extension.js"
install -m 0644 "$SRC/extension/phanspeed@asuramaya/metadata.json" \
        "$ROOT/usr/share/gnome-shell/extensions/phanspeed@asuramaya/metadata.json"

# version marker (used by phanspeed-update as a dpkg-query fallback) + default config
echo "$VER" > "$ROOT/usr/share/phanspeed/VERSION"
install -m 0600 "$SRC/packaging/config.default.json" "$ROOT/etc/phanspeed/config.json"

# release-signing trust anchor (docs/RELEASE-SIGNING.md) -- empty until a key
# is provisioned; phanspeed-update degrades to SHA256-only until it isn't
install -m 0644 "$SRC/release-signing/allowed_signers" \
        "$ROOT/usr/share/phanspeed/allowed_signers"

# control + maintainer scripts
sed "s/@VERSION@/$VER/" "$SRC/packaging/debian/control" > "$ROOT/DEBIAN/control"
install -m 0644 "$SRC/packaging/debian/conffiles" "$ROOT/DEBIAN/conffiles"
for s in postinst prerm postrm; do
    install -m 0755 "$SRC/packaging/debian/$s" "$ROOT/DEBIAN/$s"
done

mkdir -p "$DIST"
DEB="$DIST/${PKG}_${VER}_all.deb"
dpkg-deb --root-owner-group --build "$ROOT" "$DEB"

# checksums for the release (phanspeed-update verifies the .deb against this)
( cd "$DIST" && sha256sum "$(basename "$DEB")" > SHA256SUMS )

echo "built: $DEB"
echo "sums : $DIST/SHA256SUMS"
dpkg-deb --info "$DEB" | sed -n '1,3p;/Description/p'
