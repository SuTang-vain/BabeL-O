package main

import (
	"fmt"
	"strings"
)

// Phase 8 PR1: Go TUI build-time version metadata. The three
// vars below are set via -ldflags at build time (see the
// Makefile in this directory for the canonical build recipe).
// When the binary is built without -ldflags (e.g. via plain
// `go build .` or `go run .` during development) the values
// fall back to the "dev" defaults so the binary still works.
//
// The build pipeline (Phase 8 PR2) will set these from the
// npm package.json `version` field + `git rev-parse HEAD` +
// `date -u +%Y-%m-%dT%H:%M:%SZ` so a release binary always
// prints a meaningful version string at startup or via
// `--version`.
var (
	// Version is the semantic version of the Go TUI binary
	// (mirrors package.json `version` for the release that
	// produced this build).
	Version = "dev"
	// Commit is the short git commit hash the binary was
	// built from. Empty in dev builds.
	Commit = ""
	// BuildDate is the RFC 3339 UTC timestamp of the build.
	// Empty in dev builds.
	BuildDate = ""
)

// versionString is the human-readable form printed by
// `--version` and used in the runtime-version-compat check
// at startup.
func versionString() string {
	out := "bbl-go-tui " + Version
	if Commit != "" {
		out += " (commit " + Commit + ")"
	}
	if BuildDate != "" {
		out += " built " + BuildDate
	}
	return out
}

// majorVersion returns the leading integer of the Version
// (everything before the first dot). Returns 0 for the "dev"
// fallback so dev builds always pass any "major-must-match"
// check. The compatibility policy for production builds is
// "major must match" — a major version bump means a breaking
// change in either the Nexus schema or the CLI surface, and
// the Go TUI should refuse to launch (or at minimum, surface
// a hard warning) when the local major is older than the
// Nexus server's reported max-compatible major.
func majorVersion() int {
	if Version == "" || Version == "dev" {
		return 0
	}
	dot := strings.IndexByte(Version, '.')
	if dot < 0 {
		// Bare integer or pre-release tag — treat as the
		// major itself.
		var n int
		if _, err := fmt.Sscanf(Version, "%d", &n); err == nil {
			return n
		}
		return 0
	}
	var n int
	if _, err := fmt.Sscanf(Version[:dot], "%d", &n); err == nil {
		return n
	}
	return 0
}

// isGoTuiMajorCompatible reports whether the local Go TUI
// major version is in the server's supportedMajors list. A
// dev build (major == 0) is always considered compatible so
// the warning never fires in `go run .` dev loops. An empty
// supportedMajors list is treated as "no policy declared"
// and the check passes (the Nexus is just saying "we don't
// know what's compatible, use at your own risk").
func isGoTuiMajorCompatible(supportedMajors []int) bool {
	local := majorVersion()
	if local == 0 {
		return true
	}
	if len(supportedMajors) == 0 {
		return true
	}
	for _, m := range supportedMajors {
		if m == local {
			return true
		}
	}
	return false
}
