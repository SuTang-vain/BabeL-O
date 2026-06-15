// cmd/bbl-loop/main.go
//
// Phase 2a of docs/nexus/reference/go-tui-loop-multipane-plan.md:
// standalone entry point for the multi-pane `bbl loop` driver.
// Reuses the same Nexus HTTP/WS plumbing as cmd/go-tui but
// drives a workspace/tab/pane container instead of a single
// session. This file only handles flags + dispatch; the actual
// LoopModel lives in internal/loop/ (Phase 2b/2c).

package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop"
)

func main() {
	cfg := loop.Config{}
	if err := parseFlags(&cfg); err != nil {
		fmt.Fprintf(os.Stderr, "bbl loop: %v\n", err)
		os.Exit(2)
	}
	if cfg.PrintVersion {
		fmt.Println(loop.VersionString())
		return
	}
	if err := loop.Run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "bbl loop failed: %v\n", err)
		os.Exit(1)
	}
}

func parseFlags(cfg *loop.Config) error {
	cwd, _ := os.Getwd()
	flag.StringVar(&cfg.BaseURL, "url", "http://127.0.0.1:3000", "BabeL-O Nexus base URL")
	flag.StringVar(&cfg.Cwd, "cwd", cwd, "workspace directory sent to Nexus")
	flag.StringVar(&cfg.SessionID, "session", "", "optional existing session id to attach to")
	flag.StringVar(&cfg.StatePath, "state", "", "optional override path for ~/.bbl/loop/state.json")
	flag.StringVar(&cfg.WorkspaceID, "workspace", "ws-default", "loop workspace id (auto-created on first run)")
	flag.IntVar(&cfg.PollIntervalMs, "poll-interval-ms", 5000, "background /v1/runtime/loop/health poll interval in milliseconds; 0 disables polling")
	flag.IntVar(&cfg.WaitTimeoutMs, "wait-timeout-ms", 5000, "max wait window per /v1/sessions/:id/wait call in milliseconds")
	flag.BoolVar(&cfg.AltScreen, "alt", true, "use terminal alternate screen")
	flag.BoolVar(&cfg.MouseCapture, "mouse", true, "capture mouse drag / wheel; set --mouse=false to let the terminal own selection and scrollback")
	flag.BoolVar(&cfg.PrintVersion, "version", false, "print version and exit")
	flag.BoolVar(&cfg.PrintVersion, "v", false, "print version and exit (shorthand)")
	flag.Parse()
	cfg.APIKey = os.Getenv("NEXUS_API_KEY")
	return nil
}
