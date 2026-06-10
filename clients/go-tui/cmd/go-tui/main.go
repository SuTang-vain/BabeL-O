package main

import (
	"flag"
	"fmt"
	"os"

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
	flag.IntVar(&cfg.PollIntervalMs, "poll-interval-ms", 30000, "background /v1/runtime/config poll interval in milliseconds; 0 disables polling")
	flag.BoolVar(&cfg.PrintVersion, "version", false, "print version and exit")
	flag.BoolVar(&cfg.PrintVersion, "v", false, "print version and exit (shorthand)")
	flag.Parse()
	cfg.APIKey = os.Getenv("NEXUS_API_KEY")
	return cfg
}
