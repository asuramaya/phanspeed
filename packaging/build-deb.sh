#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Build a phanspeed .deb from the repo with dpkg-deb (no debhelper needed).
# Output: dist/phanspeed_<version>_all.deb  +  dist/SHA256SUMS
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(tr -d '[:space:]' < "$SRC/packaging/VERSION")"
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
          "$ROOT/usr/share/phanspeed/lib" \
          "$ROOT/usr/share/man/man1" \
          "$ROOT/usr/share/man/man8" \
          "$ROOT/etc/phanspeed"

# binaries -> /usr/bin
for b in phanspeedd phanspeed phanspeed-healthcheck phanspeed-tune phanspeed-update; do
    install -m 0755 "$SRC/src/bin/$b" "$ROOT/usr/bin/$b"
done

# vendored sutra backbone -> a PRIVATE per-pill dir under /usr/share, found
# via the bootstrap preamble pasted at the top of every binary that imports
# it -- never /usr/bin, where two pills vendoring identically-named
# sutra.py would make dpkg refuse the second package outright (BOOTSTRAP.md,
# ruling 3e44bd95). .version/.commit travel with the .py so the installed
# copy stays checkable (phanspeed-healthcheck verifies it), not just the
# dev-tree one. sutra_xen ships unconditionally, unimported for now.
for f in "$SRC"/src/data/lib/*; do
    [ -f "$f" ] || continue   # skip __pycache__ etc. left by a local py_compile
    install -m 0644 "$f" "$ROOT/usr/share/phanspeed/lib/$(basename "$f")"
done

# man pages
install -m 0644 "$SRC/src/data/man/man1/phanspeed.1" "$ROOT/usr/share/man/man1/phanspeed.1"
install -m 0644 "$SRC/src/data/man/man8/phanspeedd.8" "$ROOT/usr/share/man/man8/phanspeedd.8"

# systemd units -> /lib/systemd/system, rewriting /usr/local/bin -> /usr/bin
for u in phanspeed.service phanspeed-healthcheck.service phanspeed-healthcheck.timer \
         phanspeed-update.service phanspeed-update.timer; do
    sed 's#/usr/local/bin#/usr/bin#g' "$SRC/src/data/systemd/system/$u" \
        > "$ROOT/lib/systemd/system/$u"
done

# GNOME extension -> system-wide (users still `gnome-extensions enable`)
install -m 0644 "$SRC/src/extension/phanspeed@asuramaya/extension.js" \
        "$ROOT/usr/share/gnome-shell/extensions/phanspeed@asuramaya/extension.js"
install -m 0644 "$SRC/src/extension/phanspeed@asuramaya/pill.js" \
        "$ROOT/usr/share/gnome-shell/extensions/phanspeed@asuramaya/pill.js"
install -m 0644 "$SRC/src/extension/phanspeed@asuramaya/metadata.json" \
        "$ROOT/usr/share/gnome-shell/extensions/phanspeed@asuramaya/metadata.json"

# version marker (used by phanspeed-update as a dpkg-query fallback) + default config
echo "$VER" > "$ROOT/usr/share/phanspeed/VERSION"
install -m 0600 "$SRC/packaging/config.default.json" "$ROOT/etc/phanspeed/config.json"

# release-signing trust anchor (docs/RELEASE-SIGNING.md) -- empty until a key
# is provisioned; phanspeed-update degrades to SHA256-only until it isn't
install -m 0644 "$SRC/packaging/release-signing/allowed_signers" \
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
