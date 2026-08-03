# PhanSpeed — common tasks. Run `make help` for the list.
EXT := src/extension/phanspeed@asuramaya

# The family's shared recipe layer (sutra.mk, vendored like code under its
# own .version/.commit anchor -- see docs/BOOTSTRAP.md in the sutra repo
# and ruling 3e44bd95). Supplies check-sutra (integrity+freshness for the
# three vendored .py modules, plus pill.js via SUTRA_EXT_DIR below),
# SUTRA_ROOT_ROWS (the canonical tracked-files row count check-repo uses),
# and check-vendored-path[-all] (the checkout-run resolution guard). PILL
# must be set before the include; everything else in sutra.mk resolves
# relative to its own vendored location, never this Makefile's.
PILL := phanspeed
include src/share/phanspeed/lib/sutra.mk

# phanspeed vendors pill.js too (sutra.mk's own check-sutra loops only the
# three .py modules by default; this opts pill.js into the same
# integrity+freshness check via sutra.mk's own escape hatch). sutra 0.11.1
# resolves this Make-level throughout (patsubst, not a shell read of an
# unexported Make variable) -- the 0.11.0 form needed `export SUTRA_EXT_DIR`
# as a workaround (Werner's byebyte fix); that workaround is unnecessary on
# 0.11.1, which closes the gap at its source instead.
SUTRA_EXT_DIR := $(EXT)

# sutra.mk's check-vendored-path validates one binary per call; phanspeed
# carries the bootstrap preamble in three (phanspeedd, phanspeed-update,
# phanspeed-healthcheck -- phanspeed and phanspeed-tune don't import
# sutra), so check-vendored-path-all loops it. phanspeed-update binds
# sutra_update, not sutra -- the ":sutra_update" form checks that one
# against the right attribute; the other two take sutra.mk's own default
# (SUTRA_CHECK_MODULE=sutra).
SUTRA_CHECK_BINS := src/bin/phanspeedd src/bin/phanspeed-healthcheck src/bin/phanspeed-update:sutra_update

# phanspeedd/phanspeed-update already carry pill-specific, author-verified
# safe flags (--selftest / --check) rather than a generic --help assumed
# harmless -- sutra.mk's SUTRA_CHECK_ARGS doc names this pattern as the
# model after a hand-rolled arg parser elsewhere fell through an
# unrecognized --help into a live default verb. Left unset here
# deliberately: check-vendored-path's resolution check (which module a
# binary actually imported) is safe against any binary regardless of
# argument parsing and needs no subprocess call to prove it, so this adds
# no coverage phanspeed's own check-sutra guard didn't already have.

.PHONY: help install uninstall lint lint-ruff lint-shell attack test pack deb check-deb check \
	verify-unit check-repo check-py check-validation check-signing check-js \
	check-json check-shell-syntax check-man smoke clean

help:
	@echo "PhanSpeed targets:"
	@echo "  make install     install daemon + extension (sudo)"
	@echo "  make uninstall   remove everything (sudo)"
	@echo "  make check       run all static checks (CI-equivalent)"
	@echo "  make lint        ruff + shellcheck"
	@echo "  make attack      adversarial fuzz suite (needs Dell hardware; 'test' still works)"
	@echo "  make pack        build the extensions.gnome.org zip"
	@echo "  make deb         build the .deb package"
	@echo "  make check-repo  verify the repo matches REPO-STANDARD.md's structural gate"
	@echo "  make clean       remove build artifacts"
	@echo "  (signing anchor rebuild is now ~/code/REPOS/mudra/bin/mudra sync-signers phanspeed)"

install:
	sudo ./install.sh

uninstall:
	sudo ./uninstall.sh

# Split into two so CI can report each separately (a named step per target,
# REPO-STANDARD.md's ruling: ci.yml calls Makefile targets, never carries its
# own copy of the command behind one); `make lint` still runs both together.
lint-ruff:
	ruff check --config packaging/ruff.toml .

lint-shell:
	shellcheck install.sh uninstall.sh packaging/make-extension-zip.sh \
		packaging/build-deb.sh packaging/debian/postinst packaging/debian/prerm \
		packaging/debian/postrm packaging/activate-uuid-migration.sh

lint: lint-ruff lint-shell

check-shell-syntax:
	bash -n install.sh
	bash -n uninstall.sh

verify-unit:
	@systemd-analyze verify ./src/data/systemd/system/phanspeed.service 2>&1 \
		| grep -v 'not executable' | { ! grep . ; } && echo "unit OK"

# check-sutra (integrity+freshness of the vendored .py modules and, via
# SUTRA_EXT_DIR above, pill.js) and check-vendored-path[-all] (the
# checkout-run resolution guard -- supersedes phanspeed's own earlier
# ModuleNotFoundError-grep version: sutra.mk's form loads each binary as a
# real module and compares the ACTUAL resolved <module>.__file__ against
# the expected path, not just the absence of an import exception, which
# also catches a binary that silently imported a DIFFERENT stale sutra.py
# off sys.path) both now come from sutra.mk, included above.

# The family's structural gate (REPO-STANDARD.md §5), mechanical only: it
# cannot judge whether a document is any good, only that the shape it's
# supposed to have is actually there and nothing contradicts it. Ported from
# coldspot's reference implementation, the first repo in the family to land
# this target.
check-repo:
	@fail=0; \
	for f in README.md LICENSE Makefile install.sh uninstall.sh .gitignore .gitattributes \
	         docs/USAGE.md docs/ARCHITECTURE.md docs/RELEASING.md; do \
	    if [ ! -e "$$f" ]; then echo "check-repo FAIL: missing $$f"; fail=1; fi; \
	done; \
	if [ ! -e src/data/man/man1/phanspeed.1 ] && ! grep -q 'man1/phanspeed.1' docs/ARCHITECTURE.md 2>/dev/null; then \
	    echo "check-repo FAIL: no src/data/man/man1/phanspeed.1 and no exemption for it"; fail=1; \
	fi; \
	rows=$(SUTRA_ROOT_ROWS); \
	if [ "$$rows" -gt 12 ]; then \
	    echo "check-repo FAIL: root has $$rows rows, standard caps it at 12"; fail=1; \
	else \
	    echo "check-repo: root row count ok ($$rows)"; \
	fi; \
	if ! grep -q '^## Map' README.md 2>/dev/null; then \
	    echo "check-repo FAIL: README.md has no navigation block (## Map)"; fail=1; \
	fi; \
	for h in Troubleshooting "Repo Layout"; do \
	    if grep -q "^## $$h" README.md 2>/dev/null; then \
	        echo "check-repo FAIL: README.md carries a post-install heading ('$$h') that belongs in docs/USAGE.md"; fail=1; \
	    fi; \
	done; \
	if [ ! -f packaging/VERSION ]; then \
	    echo "check-repo FAIL: no packaging/VERSION"; fail=1; \
	fi; \
	if grep -rn "VERSION[[:space:]]*=[[:space:]]*['\"][0-9]" \
	    src/bin/phanspeed src/bin/phanspeedd src/bin/phanspeed-tune src/bin/phanspeed-update \
	    src/bin/phanspeed-healthcheck install.sh uninstall.sh \
	    packaging/build-deb.sh packaging/make-extension-zip.sh "$(EXT)/extension.js" 2>/dev/null; then \
	    echo "check-repo FAIL: a literal version string exists outside packaging/VERSION"; fail=1; \
	fi; \
	if grep -v '^[[:space:]]*#' .github/workflows/release.yml 2>/dev/null | grep -q -- '--generate-notes'; then \
	    echo "check-repo FAIL: release.yml still uses --generate-notes, not --notes-file"; fail=1; \
	fi; \
	stray=$$(find docs -name '*.md' -not -path '*/.*' | while read -r f; do git ls-files --error-unmatch "$$f" >/dev/null 2>&1 || echo "$$f"; done); \
	if [ -n "$$stray" ]; then \
	    echo "check-repo FAIL: untracked *.md under docs/: $$stray"; fail=1; \
	fi; \
	spec=$$(find . -name '*-SPEC.md' -not -path './.git/*'); \
	if [ -n "$$spec" ]; then \
	    echo "check-repo FAIL: *-SPEC.md left in the repo (specs belong in the seat's office): $$spec"; fail=1; \
	fi; \
	if [ -f docs/ARCHITECTURE.md ] && grep -q '^## Standard exemptions' docs/ARCHITECTURE.md; then \
	    bad=$$(awk '/^## Standard exemptions/{f=1;next} f && /^\|/ && !/^\| *Item *\|/ && !/^\|---/{ n=gsub(/\|/,"|"); if (n<3) print }' docs/ARCHITECTURE.md); \
	    if [ -n "$$bad" ]; then echo "check-repo FAIL: exemptions table has a row missing a column"; fail=1; fi; \
	fi; \
	if [ "$$fail" -eq 0 ]; then echo "check-repo: all mechanical checks passed"; else exit 1; fi

check-py:
	python3 -m py_compile src/bin/phanspeedd src/bin/phanspeed src/bin/phanspeed-tune src/bin/phanspeed-update \
		src/bin/phanspeed-healthcheck src/share/phanspeed/lib/sutra.py src/share/phanspeed/lib/sutra_update.py \
		src/share/phanspeed/lib/sutra_xen.py tests/diag.py

# `node --check <path>` on a file with a top-level import/export silently
# skips real syntax validation -- confirmed directly: a file starting with
# `import Foo from "bar";` followed by an unambiguous syntax error (an
# unclosed brace) still exits 0. Every extension.js/pill.js in the family is
# an ES module, always, by construction, so the bare form has been passing
# malformed GJS since this line was written (Till/ramstein 18d7d15, the
# negative control that caught it). `--input-type=module` over stdin parses
# for real -- verified against the same known-bad file: catches it, exit 1.
check-js:
	@for f in "$(EXT)/extension.js" "$(EXT)/pill.js"; do \
	  node --input-type=module --check < "$$f" || exit 1; \
	done

check-json:
	python3 -c "import json; json.load(open('$(EXT)/metadata.json'))"

# groff directly, not `man`/mandb: the ubuntu-latest CI image strips man
# pages at unpack time and stubs the man command (REPO-STANDARD.md's
# container note). -t and -k: phanspeedd.8 has a .TS/.TE table (needs tbl)
# and both pages carry literal UTF-8 (needs preconv); without both flags
# this runs clean (exit 0) but silently skips real verification of either.
check-man:
	groff -t -k -man -Tutf8 -ww src/data/man/man1/phanspeed.1 src/data/man/man8/phanspeedd.8 > /dev/null

check-deb: deb
	dpkg-deb --info dist/phanspeed_"$$(cat packaging/VERSION)"_all.deb >/dev/null

check: check-sutra check-vendored-path-all lint verify-unit check-shell-syntax check-py \
	check-js check-json check-man
	@echo "all static checks passed"

# hardware-free daemon/signing tests -- deliberately excluded from `check`
# above, same as the rest of the family (real daemon init, real sockets,
# slower than a plain static pass should be). check-validation imports
# phanspeedd and fuzzes sanitize_config; check-signing exercises the real
# release-signing trust chain end to end. Canonical family verb order
# (UNIFY.md row 6): `smoke attack check deb`.
smoke: check-validation check-signing

check-validation:
	python3 tests/test_validation.py

check-signing:
	python3 tests/test_signing.py

# the thorough adversarial pass (full cmd surface + oversized/garbage/nested/
# stall) — needs real Dell hardware (dell-smm-hwmon + platform_profile),
# run by maintainers on-device, not in CI. `test` stays as a back-compat
# alias (README/CI history call it that).
attack:
	python3 tests/attack_socket.py

test: attack

pack:
	./packaging/make-extension-zip.sh

deb:
	bash packaging/build-deb.sh

clean:
	rm -rf dist __pycache__ src/bin/__pycache__ src/share/phanspeed/lib/__pycache__ tests/__pycache__ .ruff_cache
