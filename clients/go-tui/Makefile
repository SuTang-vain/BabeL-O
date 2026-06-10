# Phase 8 PR1: canonical Go TUI build recipe.
#
# `make build` produces a release binary at bin/go-tui (or
# bin/go-tui.exe on Windows). The version metadata is embedded
# via -ldflags from the npm package.json `version` field +
# the current short git commit + an ISO 8601 UTC build
# timestamp. `make dev` is the local development build (no
# ldflags, fast).
#
# The Phase 8 PR2 release pipeline will call `make build`
# from the GitHub Actions runner; the resulting `bin/go-tui`
# artifact is what gets uploaded as
# bbl-go-tui-<platform>-<arch>.

PACKAGE_VERSION ?= $(shell node -p "require('../../package.json').version" 2>/dev/null || echo "0.0.0-dev")
COMMIT         ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE     ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS        := -X main.Version=$(PACKAGE_VERSION) \
                 -X main.Commit=$(COMMIT) \
                 -X main.BuildDate=$(BUILD_DATE)

.PHONY: dev build test version clean

dev:
	go build -o bin/go-tui .

build:
	mkdir -p bin
	go build -ldflags "$(LDFLAGS)" -o bin/go-tui .
	@echo "Built bin/go-tui (version=$(PACKAGE_VERSION) commit=$(COMMIT) built=$(BUILD_DATE))"

test:
	go test -count=1 ./...

version:
	@echo "Version:    $(PACKAGE_VERSION)"
	@echo "Commit:     $(COMMIT)"
	@echo "Build date: $(BUILD_DATE)"

clean:
	rm -rf bin
