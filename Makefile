# PhanSpeed — common tasks. Run `make help` for the list.
EXT := extension/phanspeed@asuramaya

.PHONY: help install uninstall lint attack test pack deb check verify-unit check-sutra clean

help:
	@echo "PhanSpeed targets:"
	@echo "  make install     install daemon + extension (sudo)"
	@echo "  make uninstall   remove everything (sudo)"
	@echo "  make check       run all static checks (CI-equivalent)"
	@echo "  make lint        ruff + shellcheck"
	@echo "  make attack      adversarial fuzz suite (needs Dell hardware; 'test' still works)"
	@echo "  make pack        build the extensions.gnome.org zip"
	@echo "  make deb         build the .deb package"
	@echo "  make clean       remove build artifacts"
	@echo "  (signing anchor rebuild is now ~/code/REPOS/mudra/bin/mudra sync-signers phanspeed)"

install:
	sudo ./install.sh

uninstall:
	sudo ./uninstall.sh

lint:
	ruff check .
	shellcheck install.sh uninstall.sh make-extension-zip.sh \
		packaging/build-deb.sh packaging/debian/postinst packaging/debian/prerm \
		packaging/debian/postrm packaging/activate-uuid-migration.sh

verify-unit:
	@systemd-analyze verify ./systemd/phanspeed.service 2>&1 \
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
	for f in bin/sutra.py bin/sutra_update.py bin/sutra_xen.py $(EXT)/pill.js; do \
	    vf="$${f%.py}"; vf="$${vf%.js}.version"; \
	    cf="$${f%.py}"; cf="$${cf%.js}.commit"; \
	    ver=$$(cut -d' ' -f1 "$$vf" 2>/dev/null); \
	    sha=$$(awk '{print $$NF}' "$$vf" 2>/dev/null); \
	    actual=$$(sha256sum "$$f" | cut -d' ' -f1); \
	    if [ "$$sha" != "$$actual" ]; then \
	        echo "check-sutra FAIL: $$f doesn't match $$vf" \
	             "(hand-edited? re-vendor: bash ~/code/REPOS/sutra/vendor.sh bin $(EXT))"; \
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

check: check-sutra lint verify-unit
	python3 -m py_compile bin/phanspeedd bin/phanspeed bin/phanspeed-tune bin/phanspeed-update \
		bin/phanspeed-healthcheck bin/sutra.py bin/sutra_update.py bin/sutra_xen.py diag.py
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
	./make-extension-zip.sh

deb:
	bash packaging/build-deb.sh

clean:
	rm -rf dist __pycache__ bin/__pycache__ tests/__pycache__
