# Release signing

Status: **`phanspeed-update` (the .deb auto-update path) verifies; `install.sh`'s
curl-pipe-bash bootstrap does NOT yet, and needs a design fix first — see
below, not just a missing feature.** `release-signing/allowed_signers` is
currently empty — no signing key has been provisioned. Until it holds a real
key, `phanspeed-update` behaves exactly as before (SHA256-only). The moment a
real key lands in that file and a release ships a matching `SHA256SUMS.sig`,
verification becomes fail-closed automatically there — no further code
changes needed for that path.

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

## Verification (client side — already built, v0.29.2)

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

## The install.sh gap (not yet fixed — real, not cosmetic)

`install.sh`'s curl-pipe-bash bootstrap fetches GitHub's **auto-generated**
`tarball_url` (a live source-archive snapshot), not the `.deb` release asset.
`SHA256SUMS` only ever contains the `.deb`'s hash (`packaging/build-deb.sh`
writes exactly one line) — so the bootstrap tarball has **no checksum
coverage today, signing or not**. Bolting a signature check onto the current
bootstrap would check a signed manifest that doesn't cover the artifact
actually being executed — worse than no check, since it would look
authoritative without being one.

The real fix changes what the bootstrap installs from: switch it to fetch the
release's own `.deb` + `SHA256SUMS` (+ `SHA256SUMS.sig` once provisioned) —
the same assets `phanspeed-update` already verifies — and either install via
`dpkg` directly or extract the pieces `install.sh` needs from inside the
verified `.deb`, instead of trusting an unrelated, uncovered tarball. That's a
behavior change to the bootstrap, not just an added check, so it wants its own
pass rather than being folded silently into this one.
