# Release signing

Status: **both paths verify (v0.29.4).** `install.sh`'s curl-pipe-bash
bootstrap no longer installs from GitHub's auto-generated (uncovered) source
tarball — it fetches and verifies the release's own `.deb` + `SHA256SUMS`
directly, same as `phanspeed-update`, then `dpkg -i`s it. Neither path
enforces a *signature* yet: `release-signing/allowed_signers` (and its
install.sh-embedded twin, `RELEASE_ALLOWED_SIGNERS`) are currently empty — no
signing key has been provisioned. Until one is, both degrade to SHA256-only
with a printed warning. The moment a real key exists in both places and a
release ships a matching `SHA256SUMS.sig`, verification becomes fail-closed
automatically — no further code changes needed.

## Why this exists

The SHA256 check phanspeed has always done proves a download wasn't corrupted
or truncated in transit. It proves nothing about *authenticity*: the checksum
comes from the same GitHub release it's checking, so a compromised release
asset carries its own "valid" checksum. Closing that gap needs a signature
from a key that lives outside GitHub's control entirely.

## Mechanism: SSH signatures, FIDO2 hardware key

Chosen over GPG/minisign: SSH signature verification (`ssh-keygen -Y sign` /
`-Y verify`) is already in every OpenSSH install, needs no new dependency on
either side, and — the reason for the FIDO2 requirement — supports **resident,
touch-required hardware keys** (`ecdsa-sk` / `ed25519-sk`). The private key
material never leaves the hardware token, and every signature needs a physical
touch. A compromised CI runner or build machine cannot forge a release; it
would need the physical key in hand.

**The signing key must never be provisioned into CI.** That's the whole point
— CI compromise is exactly the threat this defends against. Releases are
signed by hand, from the maintainer's machine, with the hardware key attached.

## One-time setup (maintainer, needs a FIDO2 key attached)

```sh
# Generate a resident, touch-required key. Store the private handle
# somewhere durable (it's tiny — the real secret stays on the hardware token).
ssh-keygen -t ed25519-sk -O resident -O verify-required \
  -f release-signing/id_release -C "phanspeed-release"

# Populate the trust anchor that ships in the repo and gets pinned on every
# install. Format: "<principal> <keytype> <base64-key>".
echo "phanspeed-release $(cut -d' ' -f1,2 release-signing/id_release.pub)" \
  > release-signing/allowed_signers

# install.sh's curl-pipe-bash bootstrap only ever fetches ONE file (itself),
# so it can't read the sibling allowed_signers file — the same line has to
# be embedded directly in install.sh's RELEASE_ALLOWED_SIGNERS constant too.
# Keep both in sync on every rotation.
sed -i "s|^RELEASE_ALLOWED_SIGNERS=.*|RELEASE_ALLOWED_SIGNERS=\"$(cat release-signing/allowed_signers)\"|" \
  install.sh

# The .pub file and allowed_signers are safe to commit. id_release (the
# handle) is NOT secret by itself without the hardware key, but keep it out
# of the repo anyway — store it with the key, not in git.
```

## Per-release signing (maintainer, needs the FIDO2 key attached + a touch)

```sh
# Sign the manifest, not every binary — SHA256SUMS already covers the .deb
# via its checksum entry, so signing it transitively covers the release.
ssh-keygen -Y sign -f release-signing/id_release.pub -n phanspeed-release \
  dist/SHA256SUMS
# -> produces dist/SHA256SUMS.sig

gh release upload vX.Y.Z dist/SHA256SUMS.sig
```

## Verification (client side — already built, v0.29.2 + v0.29.4)

Both `bin/phanspeed-update` and `install.sh`'s curl-pipe-bash bootstrap:

1. Check whether `release-signing/allowed_signers` has any real key line
   (blank/absent → **skip verification, print a warning, fall back to
   SHA256-only** — today's behavior, so nothing breaks before a key exists).
2. If a real key is present: require a `SHA256SUMS.sig` asset on the release.
   Missing asset, or a signature that doesn't verify against the pinned
   principal → **abort, no install.** Matches the audit criterion from
   thread 806a784f (Coldspot's installer fails open on a missing/bad
   signature; this one must not).

```sh
ssh-keygen -Y verify -f release-signing/allowed_signers \
  -I phanspeed-release -n phanspeed-release \
  -s dist/SHA256SUMS.sig < dist/SHA256SUMS
```

Exit 0 = valid signature from the pinned principal. Anything else is a hard
failure — there is no "install anyway" path once a key is provisioned.

## The install.sh gap — FIXED (v0.29.4)

`install.sh`'s curl-pipe-bash bootstrap used to fetch GitHub's
**auto-generated** `tarball_url` (a live source-archive snapshot), not the
`.deb` release asset — and `SHA256SUMS` only ever contains the `.deb`'s hash
(`packaging/build-deb.sh` writes exactly one line), so that tarball had no
checksum coverage at all, signing or not.

Fixed by changing what the bootstrap installs from: it now fetches the
release's own `.deb` + `SHA256SUMS` (+ `SHA256SUMS.sig` once provisioned) —
the exact same assets `phanspeed-update` verifies — checks them the same way,
and `dpkg -i`s the verified `.deb` directly (escalating only that one command
via `sudo`, not the whole script). Anyone wanting a source install instead
still clones the repo and runs `install.sh` from within it — that path is
unchanged and skips this block entirely, since `bin/phanspeedd` already
exists locally in that case. Requires `dpkg` on the host; a clear error
points source-install users at the checkout path if it's missing.
