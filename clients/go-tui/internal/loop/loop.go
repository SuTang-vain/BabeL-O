// Package loop hosts the multi-pane driver behind `bbl loop`.
//
// Phase 2 of docs/nexus/reference/go-tui-loop-multipane-plan.md:
// reuses the same Bubble Tea plumbing as internal/tui but drives
// a workspace/tab/pane container. This file only sets up the
// package-level plumbing (Config + version string + entry-point
// glue). Pure-data types live in model.go; the API client lives
// in api/client.go; persistence in persistence.go; layout in
// layout.go. Phase 2a only adds the entry-point skeleton.
package loop

import (
	"fmt"
	"io"
	"os"
)

// VersionString returns the human-readable loop driver version.
// Kept as a constant so cmd/bbl-loop can dump it on `--version`
// without depending on the rest of the package wiring.
const Version = "0.1.0-loop-alpha"

// Config holds the command-line / env configuration accepted by
// the loop driver. Phase 2a only reads the values; the consumer
// wiring lives in subsequent sub-steps.
type Config struct {
	BaseURL          string
	Cwd              string
	SessionID        string
	StatePath        string
	WorkspaceID      string
	PollIntervalMs   int
	HealthIntervalMs int
	WaitTimeoutMs    int
	ExecuteTimeoutMs int
	AltScreen        bool
	MouseCapture     bool
	APIKey           string
	PrintVersion     bool
}

// VersionString renders the loop driver version for `--version`.
func VersionString() string {
	return fmt.Sprintf("bbl loop %s", Version)
}

// Run is the package entry point invoked by cmd/bbl-loop/main.go.
// Phase 2a implements only a minimal smoke path that prints the
// configuration so the binary can be launched end-to-end while
// the LoopModel / API client / persistence layers land in
// Phase 2b / 2c. Real interaction arrives in Phase 3.
func Run(cfg Config) error {
	return runSmoke(cfg, os.Stdout)
}

func runSmoke(cfg Config, sink io.Writer) error {
	if cfg.StatePath == "" {
		cfg.StatePath = defaultStatePath()
	}
	fmt.Fprintf(sink, "bbl loop %s\n", Version)
	fmt.Fprintf(sink, "  url=%s cwd=%s workspace=%s state=%s\n",
		cfg.BaseURL, cfg.Cwd, cfg.WorkspaceID, cfg.StatePath)
	fmt.Fprintf(sink, "  pollIntervalMs=%d healthIntervalMs=%d waitTimeoutMs=%d altScreen=%v mouse=%v\n",
		cfg.PollIntervalMs, cfg.HealthIntervalMs, cfg.WaitTimeoutMs, cfg.AltScreen, cfg.MouseCapture)
	return nil
}
