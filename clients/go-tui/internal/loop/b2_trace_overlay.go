// clients/go-tui/internal/loop/b2_trace_overlay.go
//
// PR-B2: view_trace overlay for the Go TUI StatusBehaviorHint.
// User-approved 2026-06-17. Per doc §18.2 B2.
//
// Press 'v' when the focused pane has Status == StatusBehaviorHint to open
// a centered overlay showing the last N behavior-trace entries for that
// pane's session. Data is fetched from GET /v1/context/trace (server-side
// runBehaviorTraceGet helper, src/nexus/app.ts:5605).
//
// State is package-level (not on InteractiveModel) to avoid touching the
// frozen struct during the user's Phase 6' WIP. Single observer per program;
// mutex-guarded for the fetch goroutine.
//
// Mirrors the overlay pattern from scope_drift (chrome.go:1739-1799) and the
// fetch pattern from health_tick.go + FetchLoopHealth (api/client.go:230).

package loop

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// b2TraceState is package-level (mirroring wsReadChannels in ws_read.go).
// Single observer per program; mutex-guarded for the fetch goroutine.
type b2TraceState struct {
	mu      sync.Mutex
	open    bool
	loading bool
	err     string
	entries []api.BehaviorTraceEntry
	lastPaneID string
}

var b2Trace = &b2TraceState{}

// b2TraceClient and b2TraceCwd are set once at boot by InitB2Trace.
var (
	b2TraceClient *api.Client
	b2TraceCwd    string
)

// InitB2Trace injects the loop client + cwd. Called once from
// cmd/bbl-loop/main.go at boot.
func InitB2Trace(client *api.Client, cwd string) {
	b2TraceClient = client
	b2TraceCwd = cwd
}

// IsB2TraceOpen reports whether the trace overlay is currently visible.
func IsB2TraceOpen() bool {
	b2Trace.mu.Lock()
	defer b2Trace.mu.Unlock()
	return b2Trace.open
}

// B2TraceViewState returns the overlay state for chromeViewState.
func B2TraceViewState() (open bool, lines []string) {
	b2Trace.mu.Lock()
	defer b2Trace.mu.Unlock()
	if !b2Trace.open {
		return false, nil
	}
	if b2Trace.loading {
		return true, []string{"loading..."}
	}
	if b2Trace.err != "" {
		return true, []string{"✗ " + b2Trace.err}
	}
	return true, BuildTraceLines(b2Trace.entries)
}

// HandleViewTraceKey handles a "v" keypress. Returns (handled, cmd).
// handled=false means the key was not "v" or the precondition is not met
// (focused pane is not StatusBehaviorHint) — the caller should fall through
// to the router.
// handled=true means state was updated (open/close/start-fetch).
func HandleViewTraceKey(msg tea.KeyPressMsg, model *InteractiveModel) (bool, tea.Cmd) {
	key := chromeKeyName(msg)

	// Close: same dismiss keys as other overlays.
	b2Trace.mu.Lock()
	if b2Trace.open {
		switch key {
		case "esc", "q", "?", "ctrl+c", "v":
			b2Trace.open = false
			b2Trace.loading = false
			b2Trace.err = ""
			b2Trace.entries = nil
			b2Trace.mu.Unlock()
			return true, nil
		default:
			// Any other key while overlay is open is swallowed.
			b2Trace.mu.Unlock()
			return true, nil
		}
	}
	b2Trace.mu.Unlock()

	// Open: only when 'v' and focused pane is StatusBehaviorHint.
	if key != "v" {
		return false, nil
	}
	focused, ok := model.loop.FocusedPane()
	if !ok {
		return false, nil
	}
	if focused.Status != StatusBehaviorHint {
		return false, nil
	}

	// Open the overlay and start the fetch.
	b2Trace.mu.Lock()
	b2Trace.open = true
	b2Trace.loading = true
	b2Trace.err = ""
	b2Trace.entries = nil
	b2Trace.lastPaneID = focused.PaneID
	paneID := focused.PaneID
	sessionID := focused.SessionID
	b2Trace.mu.Unlock()

	return true, fetchTraceCmd(paneID, sessionID)
}

// fetchTraceCmd returns a tea.Cmd that calls FetchBehaviorTrace and
// returns a b2TraceLoadedMsg consumed by the next Update cycle.
func fetchTraceCmd(paneID, sessionID string) tea.Cmd {
	return func() tea.Msg {
		if b2TraceClient == nil || b2TraceCwd == "" {
			b2Trace.mu.Lock()
			b2Trace.loading = false
			b2Trace.err = "trace client not initialised"
			b2Trace.mu.Unlock()
			return b2TraceLoadedMsg{paneID: paneID}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		resp, err := b2TraceClient.FetchBehaviorTrace(ctx, b2TraceCwd, sessionID, 100, 0)
		b2Trace.mu.Lock()
		defer b2Trace.mu.Unlock()
		// Guard against a close that happened while the fetch was in flight.
		if !b2Trace.open || b2Trace.lastPaneID != paneID {
			return b2TraceLoadedMsg{paneID: paneID}
		}
		b2Trace.loading = false
		if err != nil {
			b2Trace.err = err.Error()
		} else {
			b2Trace.entries = resp.Entries
			b2Trace.err = ""
		}
		return b2TraceLoadedMsg{paneID: paneID}
	}
}

// b2TraceLoadedMsg is returned by fetchTraceCmd. Consumed by
// HandleB2TraceLoaded (no-op for B2 — the overlay re-renders on the next
// View based on package-level state, but we surface the msg so the
// Update cycle gets a tick).
type b2TraceLoadedMsg struct {
	paneID string
}

// HandleB2TraceLoaded is a no-op for B2. The overlay state is already
// updated by the fetch goroutine; returning nil tells the runtime to
// re-render. Callers wire this in the Update switch.
func HandleB2TraceLoaded(msg b2TraceLoadedMsg) tea.Cmd {
	return nil
}

// BuildTraceLines formats trace entries into display lines (pure function).
// Each entry is one line: "[<timestamp short>] <trigger> :: <errorCode> <errorMessage>"
// Empty entries produce a single placeholder line.
func BuildTraceLines(entries []api.BehaviorTraceEntry) []string {
	if len(entries) == 0 {
		return []string{"(no trace entries yet)"}
	}
	lines := make([]string, 0, len(entries))
	for _, e := range entries {
		// Short timestamp: just the time portion.
		ts := e.Timestamp
		if len(ts) > 19 && ts[10] == 'T' {
			ts = ts[11:19] // "HH:MM:SS"
		}
		trigger := e.Trigger
		code := e.Anomaly.ErrorCode
		if code == "" {
			code = "(no code)"
		}
		msg := e.Anomaly.ErrorMessage
		if msg == "" {
			msg = "(no message)"
		}
		// Optional fields for specific trigger types.
		if e.Anomaly.DenialReason != "" {
			msg = fmt.Sprintf("denied: %s", e.Anomaly.DenialReason)
		}
		if e.Anomaly.DriftPath != "" {
			msg = fmt.Sprintf("drift: %s → %s", e.Anomaly.DriftPath, e.Anomaly.ExpectedScope)
		}
		line := fmt.Sprintf("[%s] %s :: %s %s", ts, trigger, code, msg)
		lines = append(lines, line)
	}
	return lines
}

// RenderTraceOverlay splices the trace panel over the existing chrome content.
// Reads loading/error state from package-level b2Trace so the chrome dispatch
// doesn't need to carry extra params.
// Mirrors overlayScopeDrift (chrome.go:1739-1762).
func RenderTraceOverlay(content string, width, height int, lines []string) string {
	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 24
	}
	panelW := min(76, width-4)
	panelH := min(22, height-4)
	if panelW < 40 || panelH < 8 {
		return content + "\n" + mutedStyle.Render(truncatePlain("behavior trace: v toggle · press esc to close", width))
	}
	b2Trace.mu.Lock()
	traceErr := b2Trace.err
	traceLoading := b2Trace.loading
	b2Trace.mu.Unlock()
	panel := renderTracePanel(panelW, panelH, lines, traceErr, traceLoading)
	startY := (height - panelH) / 2
	if startY < 0 {
		startY = 0
	}
	startX := (width - panelW) / 2
	if startX < 0 {
		startX = 0
	}
	return splicePanel(content, startX, startY, panel, width, height)
}

// renderTracePanel builds the centered behavior-trace panel content.
// Mirrors renderScopeDriftPanel (chrome.go:1771-1799).
func renderTracePanel(width, height int, lines []string, err string, loading bool) string {
	innerW := max(10, width-2)
	var b strings.Builder
	b.WriteString(sectionHeaderStyle.Render("bbl loop · behavior trace"))
	b.WriteString("\n")
	b.WriteString(mutedStyle.Render(strings.Repeat("─", innerW)))
	b.WriteString("\n")

	if loading {
		b.WriteString(mutedStyle.Render("  loading trace…"))
	} else if err != "" {
		b.WriteString(styleForStatus(StatusBehaviorHint).Render("  ✗ " + err))
	} else if len(lines) == 0 {
		b.WriteString(mutedStyle.Render("  (no trace entries yet)"))
	} else {
		maxRows := height - 4
		if maxRows < 1 {
			maxRows = 1
		}
		for i, line := range lines {
			if i >= maxRows {
				b.WriteString(mutedStyle.Render(truncatePlain("  ...", innerW)))
				break
			}
			b.WriteString("  " + truncatePlain(line, innerW-2))
			b.WriteString("\n")
		}
	}
	b.WriteString("\n")
	b.WriteString(mutedStyle.Render(truncatePlain("press esc / q / v to close", innerW)))
	return b.String()
}
