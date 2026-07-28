# PhanSpeed — common tasks. Run `make help` for the list.
EXT := src/extension/phanspeed@asuramaya

.PHONY: help install uninstall lint attack test pack deb check verify-unit check-sutra check-repo clean

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

lint:
	ruff check --config packaging/ruff.toml .
	shellcheck install.sh uninstall.sh packaging/make-extension-zip.sh \
		packaging/build-deb.sh packaging/debian/postinst packaging/debian/prerm \
		packaging/debian/postrm packaging/activate-uuid-migration.sh

verify-unit:
	@systemd-analyze verify ./src/data/systemd/system/phanspeed.service 2>&1 \
		| grep -v 'not executable' | { ! grep . ; } && echo "unit OK"

# drift guard for every vendored sutra file: integrity (hash matches what
# vendor.sh recorded — the copy wasn't hand-edited) is the hard gate, always
# enforced. Freshness is a LAG-vs-DRIFT read (sutra's 0.7.0 ruling, custodian
# recipe, thread 2ac0a67f — ByeByte's check-sutra is the reference shape):
# a plain HEAD-compare reddened on ordinary LAG (an honest vendor from an
# earlier canonical commit, indistinguishable on sight from actual
# DRIFT/corruption), so this asks canonical git which of the two a recorded
# .commit anchor actually is. LAG warns and exits 0; DRIFT (the recorded
# commit isn't in canonical's history at all) is a hard fail. Only runs
# when the canonical checkout is present, which it normally isn't in CI.
check-sutra:
	@real_home=$$(getent passwd "$${SUDO_USER:-$$(id -un)}" | cut -d: -f6); \
	canon="$${real_home:-$$HOME}/code/REPOS/sutra"; \
	for f in src/bin/sutra.py src/bin/sutra_update.py src/bin/sutra_xen.py $(EXT)/pill.js; do \
	    vf="$${f%.py}"; vf="$${vf%.js}.version"; \
	    cf="$${f%.py}"; cf="$${cf%.js}.commit"; \
	    ver=$$(cut -d' ' -f1 "$$vf" 2>/dev/null); \
	    sha=$$(awk '{print $$NF}' "$$vf" 2>/dev/null); \
	    actual=$$(sha256sum "$$f" | cut -d' ' -f1); \
	    if [ "$$sha" != "$$actual" ]; then \
	        echo "check-sutra FAIL: $$f doesn't match $$vf" \
	             "(hand-edited? re-vendor: bash ~/code/REPOS/sutra/vendor.sh src/bin $(EXT))"; \
	        exit 1; \
	    fi; \
	    echo "check-sutra: integrity ok ($$f, $$ver, sha256 $$sha)"; \
	    if [ -d "$$canon/.git" ]; then \
	        if [ ! -f "$$cf" ]; then \
	            echo "check-sutra: freshness unknown ($$f has no .commit anchor, an older vendor)"; \
	        else \
	            recorded=$$(cat "$$cf"); \
	            head=$$(git -C "$$canon" rev-parse HEAD); \
	            if [ "$$recorded" = "$$head" ]; then \
	                echo "check-sutra: freshness ok ($$f matches canonical HEAD $$head)"; \
	            elif git -C "$$canon" merge-base --is-ancestor "$$recorded" HEAD 2>/dev/null; then \
	                echo "check-sutra: LAG ($$f vendored from $$recorded, canonical has since" \
	                     "moved to $$head) -- warn, not a failure"; \
	            else \
	                echo "check-sutra FAIL: DRIFT ($$f's vendored commit $$recorded is not in" \
	                     "canonical's history at $$canon) -- re-vendor"; \
	                exit 1; \
	            fi; \
	        fi; \
	    else \
	        echo "check-sutra: canonical sutra checkout not present, freshness skipped for $$f"; \
	    fi; \
	done

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
	rows=$$(find . -maxdepth 1 -mindepth 1 ! -name .git ! -name .claude ! -name .mcp.json ! -name .ruff_cache | wc -l); \
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

check: check-sutra lint verify-unit
	python3 -m py_compile src/bin/phanspeedd src/bin/phanspeed src/bin/phanspeed-tune src/bin/phanspeed-update \
		src/bin/phanspeed-healthcheck src/bin/sutra.py src/bin/sutra_update.py src/bin/sutra_xen.py tests/diag.py
	python3 tests/test_validation.py
	python3 tests/test_signing.py
	node --check $(EXT)/extension.js $(EXT)/pill.js
	python3 -c "import json; json.load(open('$(EXT)/metadata.json'))"
	@echo "all static checks passed"

# the thorough adversarial pass (full cmd surface + oversized/garbage/nested/
# stall) — canonical family verb (UNIFY.md row 6: `smoke attack check deb`);
# `test` stays as a back-compat alias (README/CI history call it that).
attack:
	python3 tests/attack_socket.py

test: attack

pack:
	./packaging/make-extension-zip.sh

deb:
	bash packaging/build-deb.sh

clean:
	rm -rf dist __pycache__ src/bin/__pycache__ tests/__pycache__ .ruff_cache
