// cmd/bbl-loop/main.go
//
// Phase 4b': standalone entry point for the multi-pane
// `bbl loop` driver. Wires the Bubble Tea InteractiveModel
// with the snapshot store, the Reconciler (Phase 5b/5c'),
// the periodic /v1/runtime/loop/health poll (Phase 4b),
// the platform-appropriate SoundPlayer (notifications),
// and the ToastQueue (status-transition dedup + focused-tab
// suppression). The actual LoopModel lives in internal/loop/;
// this file is just flags + dispatch.

package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop"
	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
	"github.com/sutang-vain/babel-o/clients/go-tui/internal/notifications"
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
	store, err := openLoopStore(cfg.StatePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bbl loop store open: %v\n", err)
		os.Exit(1)
	}
	defer func() {
		if store != nil {
			_ = store.Close()
		}
	}()
	model := buildInitialLoopModel(cfg)
	client := api.NewClient(cfg.BaseURL, cfg.APIKey)
	toastQueue := notifications.NewToastQueue()
	soundPlayer := notifications.NewSoundPlayerForPlatform()
	if err := runLoop(model, store, client, toastQueue, soundPlayer, cfg); err != nil {
		fmt.Fprintf(os.Stderr, "bbl loop failed: %v\n", err)
		os.Exit(1)
	}
}

// runLoop wires the periodic reconcile + health poll into
// the InteractiveModel and hands it to the Bubble Tea
// program. The reconciler runs the loop_state sync (Phase
// 5b/5c'); the health poll drives per-pane status
// projections (Phase 4b). When the operator passes
// --health-interval-ms=0 or --no-reconcile, the
// corresponding driver is dropped so the TUI runs in
// in-memory mode.
func runLoop(
	model loop.LoopModel,
	store *loop.Store,
	client *api.Client,
	toastQueue *notifications.ToastQueue,
	soundPlayer notifications.SoundPlayer,
	cfg loop.Config,
) error {
	reconcileInterval := time.Duration(cfg.PollIntervalMs) * time.Millisecond
	healthInterval := time.Duration(cfg.HealthIntervalMs) * time.Millisecond
	var reconciler *loop.Reconciler
	if store != nil && client != nil {
		reconciler = &loop.Reconciler{
			Store:       store,
			Client:      client,
			WorkspaceID: cfg.WorkspaceID,
		}
	}
	// PR-17c (B1): wire the per-CWD WS observer. Default-on
	// (no --ws-observe flag per spec). Empty sessionID = no
	// filter. The observer is the loop-level glue that
	// reconnects on read errors + calls Reconciler.RunOnce
	// once on reconnect to repair drift; the api.Client
	// method (api/working_set_observer.go) is transport-only
	// with no auto-reconnect. Reconciler pointer is passed
	// via the ReconcilerRunner interface seam defined in
	// loop/ws_observer.go so we don't need to modify the
	// frozen reconcile_worker.go.
	var wsObserver *loop.WorkingSetObserver
	if client != nil {
		wsObserver = loop.NewWorkingSetObserver(client, reconciler, cfg.Cwd, "")
	}
	im := loop.NewInteractiveModelWithLoopClient(
		model,
		store,
		reconciler,
		reconcileInterval,
		client,
		healthInterval,
		toastQueue,
		soundPlayer,
	)
	im = loop.NewInteractiveModelWithWorkingSetObserver(im, wsObserver)
	im = loop.NewInteractiveModelWithRuntimeOptions(im, cfg.AltScreen, cfg.MouseCapture)
	im = loop.NewInteractiveModelWithExecuteTimeout(im, time.Duration(cfg.ExecuteTimeoutMs)*time.Millisecond)
	prog := tea.NewProgram(im)
	finalModel, err := prog.Run()
	if err != nil {
		return fmt.Errorf("loop: bubbletea run: %w", err)
	}
	typed, ok := finalModel.(loop.InteractiveModel)
	if !ok {
		return fmt.Errorf("loop: unexpected final model %T", finalModel)
	}
	if typed.Store() != nil {
		_ = typed.Store().Close()
	}
	return nil
}

// openLoopStore creates the on-disk snapshot store from the
// CLI's --state flag (or the default ~/.bbl/loop/state.json).
// Returns (nil, nil) when the caller passes an empty
// --state path AND no default is desired; cmd/bbl-loop
// currently always opens the default, so this is a future
// escape hatch.
func openLoopStore(statePath string) (*loop.Store, error) {
	store, err := loop.NewStore(statePath)
	if err != nil {
		return nil, err
	}
	return store, nil
}

// buildInitialLoopModel turns the parsed CLI config into the
// pure-data LoopModel that the Bubble Tea adapter consumes.
func buildInitialLoopModel(cfg loop.Config) loop.LoopModel {
	model := loop.NewLoopModel()
	if cfg.WorkspaceID != "" {
		model.Workspaces[0].ID = cfg.WorkspaceID
		model.Workspaces[0].Label = cfg.WorkspaceID
	}
	return model
}

func parseFlags(cfg *loop.Config) error {
	cwd, _ := os.Getwd()
	flag.StringVar(&cfg.BaseURL, "url", "http://127.0.0.1:3000", "BabeL-O Nexus base URL")
	flag.StringVar(&cfg.Cwd, "cwd", cwd, "workspace directory sent to Nexus")
	flag.StringVar(&cfg.SessionID, "session", "", "optional existing session id to attach to")
	flag.StringVar(&cfg.StatePath, "state", "", "optional override path for ~/.bbl/loop/state.json")
	flag.StringVar(&cfg.WorkspaceID, "workspace", "ws-default", "loop workspace id (auto-created on first run)")
	flag.IntVar(&cfg.PollIntervalMs, "poll-interval-ms", 5000, "background /v1/loop/workspaces reconcile interval in milliseconds; 0 disables reconcile")
	flag.IntVar(&cfg.HealthIntervalMs, "health-interval-ms", 3000, "background /v1/runtime/loop/health poll interval in milliseconds; 0 disables the status sidebar live updates")
	flag.IntVar(&cfg.WaitTimeoutMs, "wait-timeout-ms", 5000, "max wait window per /v1/sessions/:id/wait call in milliseconds")
	flag.IntVar(&cfg.ExecuteTimeoutMs, "execute-timeout-ms", 180000, "max HTTP /v1/execute window for pane prompt submission in milliseconds")
	flag.BoolVar(&cfg.AltScreen, "alt", true, "use terminal alternate screen")
	flag.BoolVar(&cfg.MouseCapture, "mouse", true, "capture mouse drag / wheel; set --mouse=false to let the terminal own selection and scrollback")
	flag.BoolVar(&cfg.PrintVersion, "version", false, "print version and exit")
	flag.BoolVar(&cfg.PrintVersion, "v", false, "print version and exit (shorthand)")
	flag.Parse()
	cfg.APIKey = os.Getenv("NEXUS_API_KEY")
	return nil
}
