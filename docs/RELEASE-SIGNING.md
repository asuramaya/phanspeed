# Release signing

Repo-specific notes. The canonical, fleet-wide doctrine lives in
`~/code/REPOS/RELEASE.md` (kast · phanspeed · coldspot · ByeByte · RAMstein ·
gestalt · sutra) — read that first; this file is phanspeed's application of
it.

Status (v0.30.0): both `install.sh`'s curl-pipe-bash bootstrap and
`bin/phanspeed-update` fetch and verify the release's own `.deb` +
`SHA256SUMS` (now a manifest covering the `.deb` **and** the release
tarball, one file, `.github/workflows/release.yml`), then `dpkg -i` /
install. Neither path enforces a *signature* yet: `release-signing/
allowed_signers` (and its install.sh-embedded twin, `RELEASE_ALLOWED_SIGNERS`)
are currently empty — the anchor is unarmed. Until it's armed, both degrade
to SHA256-only with a printed warning. Arming happens in the SAME act as
phanspeed's first signed release (`make sync-signers`, below) — never
before, per RELEASE.md's sequencing rule (arming early only bricks
`phanspeed-update` where a fail-closed verifier is already deployed; harmless
here since none is, but the doctrine is repo-uniform on purpose).

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

## Principal vs. namespace (fleet doctrine, ratified 2026-07-16/17)

**Principal = stable identity. Namespace = role.** The fleet's signing
ceremony (rotten-apple/Ra) settled this after finding a real footgun:
`ssh-keygen -t ed25519-sk` mints a *new* hardware credential per invocation,
but copying a handle file to another repo does not — it's the same
credential everywhere it's copied, and the pubkey/fingerprint is the only
real tell. So per-project resident credentials buy ~nothing (hardware-backed
private material never leaves the token regardless) while burning through
the ~25-resident-credential cap on the physical key for no benefit. The
fleet's actual model: the operator's existing FIDO2 identity (four resident
credentials, enrolled once for rotten-apple) **is** the one signing identity
for every pill. Isolation between repos/roles comes entirely from the SSH
*namespace* (`-n <namespace>` at sign and verify time, e.g. `phanspeed-release`
vs `rotten-apple-release`) plus each repo's own `allowed_signers` (which
keys are trusted, revocable per repo) — never from minting a distinct
credential per project.

This repo's docs used to conflate the two: `phanspeed-release` was used as
both the SSH principal (`-I`) *and* the namespace (`-n`), and the old setup
steps here generated a brand-new resident key just for phanspeed. Fixed:
principal is `phanspeed` (this repo's stable identity, matching the
convention every other pill uses — its own project name), namespace is
`phanspeed-release` (paired with the fleet-shared `pills-tag` namespace —
RELEASE.md's format is `<repo> namespaces="<repo>-release,pills-tag" ...`).
The key material to pin is **reused** from the fleet's already-enrolled
identity via `make sync-signers`, never freshly minted.

## Arming the anchor (operator, first signed release only — `make sync-signers`)

```sh
make sync-signers
```

`tools/sync-signers.sh` rebuilds `release-signing/allowed_signers` — always a
full rebuild from **all** canonical keys, never an append (RA's first
ceremony left 3 of 4 keys unpinned by appending one at a time) — from
`~/.ssh/asuramaya-master/*.pub` (exactly 4, refuses otherwise), and syncs the
byte-identical copy into `install.sh`'s `RELEASE_ALLOWED_SIGNERS` in the same
act (`.github/workflows/signing-sync.yml` checks the two never drift).
`allowed_signers` is safe to commit — public keys only. Per RELEASE.md's
"arm before tag" ordering: `make sync-signers` → commit → tag → CI builds →
operator signs, so the first *sealed* artifacts carry the anchor from birth.

## Per-release signing (operator, needs a FIDO2 key attached + a touch)

```sh
# Sign the manifest, not every artifact — SHA256SUMS covers the .deb AND the
# release tarball (release.yml), so signing it transitively covers both.
# -f names any ONE of the four canonical key handles (any one signs; which
# is just whichever hardware key is physically attached right now).
gh release download vX.Y.Z -p SHA256SUMS   # sign the PUBLISHED bytes, not local ones
ssh-keygen -Y sign -f ~/.ssh/asuramaya-master/id_asuramaya_master_1 \
  -n phanspeed-release SHA256SUMS
# -> produces SHA256SUMS.sig

gh release upload vX.Y.Z SHA256SUMS.sig
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
  -I phanspeed -n phanspeed-release \
  -s dist/SHA256SUMS.sig < dist/SHA256SUMS
```

Exit 0 = valid signature from the pinned principal. Anything else is a hard
failure — there is no "install anyway" path once a key is provisioned.

## The install.sh gap — FIXED (v0.29.4)

`install.sh`'s curl-pipe-bash bootstrap used to fetch GitHub's
**auto-generated** `tarball_url` (a live source-archive snapshot), not the
`.deb` release asset — and at the time, `SHA256SUMS` only ever contained the
`.deb`'s hash (`packaging/build-deb.sh` wrote exactly one line), so that
tarball had no checksum coverage at all, signing or not. (Since v0.30.0's
`release.yml`, `SHA256SUMS` is the family-standard manifest covering both the
`.deb` and phanspeed's own `git archive` tarball — a real release asset now,
not GitHub's auto-generated one — but the lookup below only ever needed the
`.deb`'s line, so nothing here changed.)

Fixed by changing what the bootstrap installs from: it now fetches the
release's own `.deb` + `SHA256SUMS` (+ `SHA256SUMS.sig` once provisioned) —
the exact same assets `phanspeed-update` verifies — checks them the same way,
and `dpkg -i`s the verified `.deb` directly (escalating only that one command
via `sudo`, not the whole script). Anyone wanting a source install instead
still clones the repo and runs `install.sh` from within it — that path is
unchanged and skips this block entirely, since `bin/phanspeedd` already
exists locally in that case. Requires `dpkg` on the host; a clear error
points source-install users at the checkout path if it's missing.
