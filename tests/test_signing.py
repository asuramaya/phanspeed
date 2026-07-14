#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Unit test for phanspeed-update's release-signing verification
(docs/RELEASE-SIGNING.md). Generates a throwaway (non-hardware) ed25519 key to
prove the ssh-keygen -Y sign/verify roundtrip itself is wired correctly —
verification doesn't care what backed the real signing key, only that a valid
signature exists, so this is a faithful test of the mechanism the real FIDO2
key will use. Skips (not fails) if ssh-keygen is unavailable. Exit 0 = pass.
"""
import importlib.machinery as machinery
import importlib.util as util
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
loader = machinery.SourceFileLoader("phanspeed_update",
                                    os.path.join(HERE, "bin", "phanspeed-update"))
spec = util.spec_from_loader("phanspeed_update", loader)
m = util.module_from_spec(spec)
loader.exec_module(m)

if subprocess.run(["ssh-keygen", "-Y", "sign"], capture_output=True).returncode == 127:
    print("ssh-keygen not found — skipping signing tests")
    sys.exit(0)

NS = "phanspeed-release"

# --- the shipped placeholder must be empty: no key provisioned yet --------
with open(os.path.join(HERE, "release-signing", "allowed_signers")) as f:
    assert f.read().strip() == "", (
        "release-signing/allowed_signers must ship empty until a real key is "
        "provisioned by hand — see docs/RELEASE-SIGNING.md")
print("shipped allowed_signers is the empty placeholder OK")

# --- has_signing_key() ------------------------------------------------------
with tempfile.TemporaryDirectory() as td:
    empty = os.path.join(td, "empty")
    open(empty, "w").close()
    assert m.has_signing_key(empty) is False

    blank_lines = os.path.join(td, "blank")
    with open(blank_lines, "w") as f:
        f.write("\n\n   \n")
    assert m.has_signing_key(blank_lines) is False, "whitespace-only must not count"

    missing = os.path.join(td, "does-not-exist")
    assert m.has_signing_key(missing) is False

with tempfile.TemporaryDirectory() as td:
    keyfile = os.path.join(td, "id_test")
    subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "test",
                   "-f", keyfile], check=True, capture_output=True)
    with open(keyfile + ".pub") as f:
        pub = f.read().strip()
    signers = os.path.join(td, "allowed_signers")
    with open(signers, "w") as f:
        f.write(f"{NS} {pub}\n")
    assert m.has_signing_key(signers) is True
    print("has_signing_key() OK")

    # --- verify_signature(): real roundtrip -------------------------------
    data = b"the exact bytes a SHA256SUMS manifest would contain\n"
    sig = subprocess.run(
        ["ssh-keygen", "-Y", "sign", "-f", keyfile + ".pub", "-n", NS],
        input=data, capture_output=True, check=True).stdout
    assert m.verify_signature(data, sig, signers, NS) is True
    print("verify_signature(): valid signature accepted OK")

    # tampered data must fail
    assert m.verify_signature(data + b"tampered", sig, signers, NS) is False
    print("verify_signature(): tampered data rejected OK")

    # signature from a DIFFERENT (untrusted) key must fail against this
    # allowed_signers
    otherkey = os.path.join(td, "id_other")
    subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "other",
                   "-f", otherkey], check=True, capture_output=True)
    other_sig = subprocess.run(
        ["ssh-keygen", "-Y", "sign", "-f", otherkey + ".pub", "-n", NS],
        input=data, capture_output=True, check=True).stdout
    assert m.verify_signature(data, other_sig, signers, NS) is False
    print("verify_signature(): untrusted key rejected OK")

    # wrong namespace must fail (binds the signature to its intended use)
    assert m.verify_signature(data, sig, signers, "some-other-namespace") is False
    print("verify_signature(): namespace mismatch rejected OK")

print("release-signing verification OK")
