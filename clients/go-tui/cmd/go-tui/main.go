package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/tui"
)

func main() {
	cfg := parseFlags()
	if cfg.PrintVersion {
		fmt.Println(tui.VersionString())
		return
	}
	if err := tui.Run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "go-tui failed: %v\n", err)
		os.Exit(1)
	}
}

func parseFlags() tui.Config {
	cwd, _ := os.Getwd()
	cfg := tui.Config{}
	flag.StringVar(&cfg.BaseURL, "url", "http://127.0.0.1:3000", "BabeL-O Nexus base URL")
	flag.StringVar(&cfg.Cwd, "cwd", cwd, "workspace directory sent to Nexus")
	flag.StringVar(&cfg.SessionID, "session", "", "optional existing session id")
	flag.BoolVar(&cfg.AltScreen, "alt", true, "use terminal alternate screen")
	flag.BoolVar(&cfg.MouseCapture, "mouse", true, "capture mouse drag / wheel (default true, set to false to let terminal handle copy/paste)")
	flag.IntVar(&cfg.PollIntervalMs, "poll-interval-ms", 30000, "background /v1/runtime/config poll interval in milliseconds; 0 disables polling")
	flag.BoolVar(&cfg.PrintVersion, "version", false, "print version and exit")
	flag.BoolVar(&cfg.PrintVersion, "v", false, "print version and exit (shorthand)")
	// Phase D of
	// docs/nexus/reference/go-tui-permission-policy-governance-plan.md.
	// Comma-separated; pass multiple times to extend the list. Empty
	// (default) → per-turn `allowedTools` override off; server-startup
	// policy applies. Use "*" or "all" for the wildcard that maps
	// to allowAllTools on the Nexus side. Examples:
	//   --allow-tools Bash,Edit
	//   --allow-tools Bash --allow-tools Edit
	//   --allow-tools "*"
	flag.Func("allow-tools", "comma-separated per-turn tool allowlist (Phase D); '*' or 'all' for wildcard", func(v string) error {
		for _, name := range strings.Split(v, ",") {
			trimmed := strings.TrimSpace(name)
			if trimmed == "" {
				continue
			}
			cfg.AllowTools = append(cfg.AllowTools, trimmed)
		}
		return nil
	})
	flag.Parse()
	cfg.APIKey = os.Getenv("NEXUS_API_KEY")
	// Apply the default per-turn execute timeout for the WebSocket /v1/stream
	// payload. The Nexus server-side default is 30s which is too tight for
	// long multi-tool turns, so we send a 3-minute budget by default and
	// still let explicit --execute-timeout-ms (or env BABEL_O_GO_TUI_TIMEOUT_MS)
	// override it via Config.ExecuteTimeoutMs.
	if cfg.ExecuteTimeoutMs <= 0 {
		if v := os.Getenv("BABEL_O_GO_TUI_TIMEOUT_MS"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				cfg.ExecuteTimeoutMs = parsed
			}
		}
		if cfg.ExecuteTimeoutMs <= 0 {
			cfg.ExecuteTimeoutMs = 180_000
		}
	}
	return cfg
}
