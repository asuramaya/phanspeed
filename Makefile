# PhanSpeed — common tasks. Run `make help` for the list.
EXT := extension/phanspeed@asuramaya

.PHONY: help install uninstall lint test pack deb check verify-unit check-sutra clean

help:
	@echo "PhanSpeed targets:"
	@echo "  make install     install daemon + extension (sudo)"
	@echo "  make uninstall   remove everything (sudo)"
	@echo "  make check       run all static checks (CI-equivalent)"
	@echo "  make lint        ruff + shellcheck"
	@echo "  make test        adversarial fuzz suite (needs Dell hardware)"
	@echo "  make pack        build the extensions.gnome.org zip"
	@echo "  make deb         build the .deb package"
	@echo "  make clean       remove build artifacts"

install:
	sudo ./install.sh

uninstall:
	sudo ./uninstall.sh

lint:
	ruff check .
	shellcheck install.sh uninstall.sh make-extension-zip.sh bin/phanspeed-healthcheck \
		packaging/build-deb.sh packaging/debian/postinst packaging/debian/prerm \
		packaging/debian/postrm packaging/activate-uuid-migration.sh

verify-unit:
	@systemd-analyze verify ./systemd/phanspeed.service 2>&1 \
		| grep -v 'not executable' | { ! grep . ; } && echo "unit OK"

# drift guard for the vendored sutra copy: integrity (hash matches what
# vendor.sh recorded — the copy wasn't hand-edited) always runs; freshness
# (diff against the canonical source) only when that checkout is present,
# which it normally isn't in CI.
check-sutra:
	@ver=$$(cut -d' ' -f1 bin/sutra.version); \
	sha=$$(awk '{print $$NF}' bin/sutra.version); \
	actual=$$(sha256sum bin/sutra.py | cut -d' ' -f1); \
	if [ "$$sha" != "$$actual" ]; then \
	    echo "check-sutra FAIL: bin/sutra.py doesn't match bin/sutra.version" \
	         "(hand-edited? re-vendor: bash ~/code/REPOS/sutra/vendor.sh bin)"; \
	    exit 1; \
	fi; \
	echo "check-sutra: integrity ok (sutra $$ver, sha256 $$sha)"; \
	canon="$$HOME/code/REPOS/sutra/sutra.py"; \
	if [ -f "$$canon" ]; then \
	    if cmp -s bin/sutra.py "$$canon"; then \
	        echo "check-sutra: freshness ok (matches canonical)"; \
	    else \
	        echo "check-sutra FAIL: bin/sutra.py differs from canonical $$canon (re-vendor)"; \
	        exit 1; \
	    fi; \
	fi

check: check-sutra lint verify-unit
	python3 -m py_compile bin/phanspeedd bin/phanspeed bin/phanspeed-tune bin/phanspeed-update bin/sutra.py diag.py
	python3 tests/test_validation.py
	python3 tests/test_signing.py
	node --check $(EXT)/extension.js
	python3 -c "import json; json.load(open('$(EXT)/metadata.json'))"
	@echo "all static checks passed"

test:
	python3 tests/attack_socket.py

pack:
	./make-extension-zip.sh

deb:
	bash packaging/build-deb.sh

clean:
	rm -rf dist __pycache__ bin/__pycache__ tests/__pycache__
