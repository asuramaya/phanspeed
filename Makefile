# PhanSpeed — common tasks. Run `make help` for the list.
EXT := extension/phanspeed@local

.PHONY: help install uninstall lint test pack check verify-unit clean

help:
	@echo "PhanSpeed targets:"
	@echo "  make install     install daemon + extension (sudo)"
	@echo "  make uninstall   remove everything (sudo)"
	@echo "  make check       run all static checks (CI-equivalent)"
	@echo "  make lint        ruff + shellcheck"
	@echo "  make test        adversarial fuzz suite (needs Dell hardware)"
	@echo "  make pack        build the extensions.gnome.org zip"
	@echo "  make clean       remove build artifacts"

install:
	sudo ./install.sh

uninstall:
	sudo ./uninstall.sh

lint:
	ruff check .
	shellcheck install.sh uninstall.sh make-extension-zip.sh bin/phanspeed-healthcheck

verify-unit:
	@systemd-analyze verify ./systemd/phanspeed.service 2>&1 \
		| grep -v 'not executable' | { ! grep . ; } && echo "unit OK"

check: lint verify-unit
	python3 -m py_compile bin/phanspeedd bin/phanspeed-tune diag.py
	python3 tests/test_validation.py
	node --check $(EXT)/extension.js
	python3 -c "import json; json.load(open('$(EXT)/metadata.json'))"
	@echo "all static checks passed"

test:
	python3 tests/attack_socket.py

pack:
	./make-extension-zip.sh

clean:
	rm -rf dist __pycache__ bin/__pycache__ tests/__pycache__
