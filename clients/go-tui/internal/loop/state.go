// internal/loop/state.go
//
// Phase 2a: state path resolution for the loop driver. Real
// persistence lands in Phase 5; this file only centralises the
// `~/.bbl/loop/state.json` default so main.go and any future
// sub-package agree on the location.

package loop

import (
	"os"
	"path/filepath"
)

// defaultStatePath returns the local loop state file path. We
// use `~/.bbl/loop/state.json` rather than `~/.babel-o/...` to
// keep loop driver state orthogonal to the Nexus-side config
// file; the two never write to the same path. The directory is
// created lazily on first persist (Phase 5).
func defaultStatePath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		// Fall back to a per-cwd cache so smoke runs still have
		// a writable target even when HOME is unset (CI sandboxes).
		return filepath.Join(os.TempDir(), "bbl-loop-state.json")
	}
	return filepath.Join(home, ".bbl", "loop", "state.json")
}
