// internal/loop/model.go
//
// Phase 2b of docs/nexus/reference/go-tui-loop-multipane-plan.md:
// pure-data types for the multi-pane driver. State is separated
// from runtime (herdr AGENTS.md style): LoopModel / Workspace /
// Tab / PaneModel are immutable Go structs with constructor
// helpers and `assert_invariants_for_test` style sanity checks.
// No I/O, no goroutines, no bubble tea — runtime glue lives in
// later sub-steps.

package loop

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// PaneStatus mirrors the runtime-owned projection in
// `src/runtime/loopDiagnostics.ts` (Phase 1). It is a Go enum
// so renderers can switch on it; the runtime is still the
// source of truth — the driver only carries the projection.
//
// PR-17a (Track B Phase 2 §6.5.2 bbl loop P1 integration):
// StatusBehaviorHint is the 7th PaneStatus (priority 6, highest).
// Per INV-12 the existing 6 states are unchanged; the new state is
// only set when the runtime's applyBehaviorHint() projects
// pendingHints > 0. Per INV-15 this enum must mirror the server's
// STATUS_PRIORITY in src/runtime/loopDiagnostics.ts.
type PaneStatus int

const (
	StatusIdle PaneStatus = iota
	StatusWorking
	StatusBlocked
	StatusWaiting
	StatusDrift
	StatusDone
	StatusBehaviorHint
)

// String renders the status for transcript / sidebar use.
func (s PaneStatus) String() string {
	switch s {
	case StatusIdle:
		return "idle"
	case StatusWorking:
		return "working"
	case StatusBlocked:
		return "blocked"
	case StatusWaiting:
		return "waiting"
	case StatusDrift:
		return "drift"
	case StatusDone:
		return "done"
	case StatusBehaviorHint:
		return "behavior_hint"
	default:
		return fmt.Sprintf("unknown(%d)", int(s))
	}
}

// PaneModel is the per-pane state machine. Inputs and runtime
// wiring live elsewhere; this struct only carries the stable
// snapshot the Bubble Tea model reads.
type PaneModel struct {
	PaneID       string
	WorkspaceID  string
	TabID        string
	SessionID    string
	Agent        string
	Cwd          string
	Label        string
	Status       PaneStatus
	LastEventRev int64
	LastEventAt  time.Time
	// PR-17b (Track B §6.5.2): when Status == StatusBehaviorHint,
	// the runtime-provided LastHintPattern is rendered inline by
	// the chrome ("[hint] pattern: <pattern>"). Empty unless
	// the runtime projection sets it.
	LastHintPattern string
	// Transcript is the pane's recent event log shaped for the
	// focused-pane body (Phase 6b). Empty until 6c wires the
	// per-pane waitForEvent poll; the body renders the
	// placeholder in that case. BuildTranscriptLines consumes
	// this slice — keep entries single-line / pre-flattened.
	Transcript []TranscriptItem
	// Input is the per-pane draft prompt (Phase 6d-a). It
	// deliberately stays a plain string instead of a
	// bubbles textinput.Model so PaneModel remains pure data;
	// the Bubble Tea adapter owns key translation and writes
	// the resulting text back through ApplyPaneInputEvent.
	Input string
	// PendingPermission will carry the pane-scoped permission
	// dialog state in a later 6d slice. The first 6d-a slice
	// keeps it typed as a lightweight pointer so the model
	// can satisfy the plan's ownership boundary without
	// importing the single-pane TUI's pendingPermission type.
	PendingPermission *PanePermission
	// QueuedPrompt is the next prompt staged for this pane.
	// 6d-a sets it on Enter and paints a local transcript row;
	// a later slice will submit it to Nexus.
	QueuedPrompt string
	// InterruptionActive mirrors the single-pane TUI's
	// "What should BabeL-O do instead?" state. 6d-a only
	// carries the flag; cancel/interrupt wiring lands later.
	InterruptionActive bool
}

// PanePermission is the loop driver's pane-local permission
// projection. Runtime truth still lives in Nexus; the loop
// model only stores enough data for a future dialog renderer
// to attach to the pane that emitted the request.
type PanePermission struct {
	ToolUseID       string
	Name            string
	Risk            string
	Message         string
	SuggestedRule   string
	ScopeRisk       string
	TargetRoot      string
	TaskPrimaryRoot string
}

// FocusPath identifies the focused pane in a workspace/tab tree.
// `WorkspaceIdx` / `TabIdx` / `PaneIdx` are -1 when unset; the
// router normalises them before dispatching input.
type FocusPath struct {
	WorkspaceIdx int
	TabIdx       int
	PaneIdx      int
}

// LoopModel is the top-level container. Construct with
// `NewLoopModel` (or `TestNewLoopModel` in tests) so invariants
// stay in one place.
type LoopModel struct {
	Workspaces []Workspace
	Focus      FocusPath
	Width      int
	Height     int
}

// Workspace groups tabs that share an agent context. Each
// workspace has at least one tab; the model collapses workspaces
// without tabs into the "empty" state rather than dropping them.
type Workspace struct {
	ID    string
	Label string
	Tabs  []Tab
}

// Tab groups panes inside a workspace.
type Tab struct {
	ID    string
	Label string
	Panes []PaneModel
}

// NewID returns a short random hex id with a prefix so log /
// transcript output distinguishes workspace / tab / pane ids.
func NewID(prefix string) string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand failures are exceptional on supported
		// platforms; fall back to a stable-but-non-unique id
		// rather than panicking inside the model layer.
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return fmt.Sprintf("%s-%s", prefix, hex.EncodeToString(buf[:]))
}

// NewWorkspace returns a workspace with the given label and a
// single empty tab. The tab id is generated via NewID so call
// sites don't have to compose one.
func NewWorkspace(id, label string) Workspace {
	if id == "" {
		id = NewID("ws")
	}
	return Workspace{
		ID:    id,
		Label: label,
		Tabs: []Tab{
			{ID: id + ":1", Label: "main"},
		},
	}
}

// AddTab appends a tab; the new tab id is `workspace.id:N+1`.
func (w Workspace) AddTab(label string) Workspace {
	if label == "" {
		label = fmt.Sprintf("tab-%d", len(w.Tabs)+1)
	}
	tabID := fmt.Sprintf("%s:%d", w.ID, len(w.Tabs)+1)
	w.Tabs = append(w.Tabs, Tab{ID: tabID, Label: label})
	return w
}

// AddPane appends a pane with the given session metadata; the
// caller is expected to provide a non-empty sessionId.
func (t Tab) AddPane(p PaneModel) (Tab, error) {
	if p.PaneID == "" {
		return t, fmt.Errorf("loop: pane requires PaneID")
	}
	if p.SessionID == "" {
		return t, fmt.Errorf("loop: pane %q requires SessionID", p.PaneID)
	}
	if p.WorkspaceID == "" || p.TabID == "" {
		return t, fmt.Errorf("loop: pane %q requires WorkspaceID and TabID", p.PaneID)
	}
	if p.WorkspaceID != t.ID[:indexOrZero(t.ID, ":")] {
		return t, fmt.Errorf("loop: pane %q workspaceId=%q does not match parent tab %q",
			p.PaneID, p.WorkspaceID, t.ID)
	}
	if p.TabID != t.ID {
		return t, fmt.Errorf("loop: pane %q tabId=%q does not match parent tab %q",
			p.PaneID, p.TabID, t.ID)
	}
	t.Panes = append(t.Panes, p)
	return t, nil
}

// indexOrZero returns the index of sep in s, or 0 when not found.
// Used to derive the workspace id from a tab id like "ws-1:2".
func indexOrZero(s, sep string) int {
	for i := 0; i+len(sep) <= len(s); i++ {
		if s[i:i+len(sep)] == sep {
			return i
		}
	}
	return 0
}

// NewLoopModel returns an empty LoopModel with a single default
// workspace + tab. Width/Height default to 0; the renderer fills
// these from tea.WindowSizeMsg.
func NewLoopModel() LoopModel {
	return LoopModel{
		Workspaces: []Workspace{NewWorkspace("ws-default", "default")},
		Focus:      FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
	}
}

// FocusedPane returns a copy of the focused PaneModel and ok
// flag. Callers must not mutate the returned slice / map state;
// focus switching returns new LoopModel values.
func (m LoopModel) FocusedPane() (PaneModel, bool) {
	pane, ok := m.PaneAt(m.Focus.WorkspaceIdx, m.Focus.TabIdx, m.Focus.PaneIdx)
	return pane, ok
}

// PaneAt returns the pane at the given indices with bounds
// checking. Negative or out-of-range indices return ok=false so
// callers can fall back to a sane default.
func (m LoopModel) PaneAt(workspaceIdx, tabIdx, paneIdx int) (PaneModel, bool) {
	if workspaceIdx < 0 || workspaceIdx >= len(m.Workspaces) {
		return PaneModel{}, false
	}
	ws := m.Workspaces[workspaceIdx]
	if tabIdx < 0 || tabIdx >= len(ws.Tabs) {
		return PaneModel{}, false
	}
	tab := ws.Tabs[tabIdx]
	if paneIdx < 0 || paneIdx >= len(tab.Panes) {
		return PaneModel{}, false
	}
	return tab.Panes[paneIdx], true
}

// SetFocus returns a copy of the model with the focus path
// updated. Indices outside the bounds collapse to the nearest
// valid index (or -1 for "nothing focused").
func (m LoopModel) SetFocus(workspaceIdx, tabIdx, paneIdx int) LoopModel {
	m.Focus = FocusPath{
		WorkspaceIdx: clampIndex(workspaceIdx, len(m.Workspaces)),
		TabIdx:       tabIdx,
		PaneIdx:      paneIdx,
	}
	if workspaceIdx >= 0 && workspaceIdx < len(m.Workspaces) {
		m.Focus.TabIdx = clampIndex(tabIdx, len(m.Workspaces[workspaceIdx].Tabs))
		if m.Focus.TabIdx >= 0 {
			m.Focus.PaneIdx = clampIndex(paneIdx, len(m.Workspaces[workspaceIdx].Tabs[m.Focus.TabIdx].Panes))
		} else {
			m.Focus.PaneIdx = -1
		}
	} else {
		m.Focus.TabIdx = -1
		m.Focus.PaneIdx = -1
	}
	return m
}

func clampIndex(idx, length int) int {
	if length <= 0 {
		return -1
	}
	if idx < 0 {
		return 0
	}
	if idx >= length {
		return length - 1
	}
	return idx
}

// AssertInvariantsForTest checks the model's structural invariants.
// Tests should call this after every constructor or mutation. It
// returns nil on success and a non-nil error otherwise so tests
// can use `if err := m.AssertInvariantsForTest(); err != nil { … }`.
// Mirrors herdr's `Workspace::assert_invariants_for_test`.
func (m LoopModel) AssertInvariantsForTest() error {
	if len(m.Workspaces) == 0 {
		return fmt.Errorf("loop: must have at least one workspace")
	}
	for wi, ws := range m.Workspaces {
		if ws.ID == "" {
			return fmt.Errorf("loop: workspace[%d] has empty id", wi)
		}
		if len(ws.Tabs) == 0 {
			return fmt.Errorf("loop: workspace %q has no tabs", ws.ID)
		}
		for ti, tab := range ws.Tabs {
			if tab.ID == "" {
				return fmt.Errorf("loop: workspace %q tab[%d] has empty id", ws.ID, ti)
			}
			seen := make(map[string]struct{}, len(tab.Panes))
			for pi, pane := range tab.Panes {
				if pane.PaneID == "" {
					return fmt.Errorf("loop: workspace %q tab %q pane[%d] has empty id", ws.ID, tab.ID, pi)
				}
				if pane.WorkspaceID != ws.ID {
					return fmt.Errorf("loop: pane %q workspaceId=%q does not match parent %q",
						pane.PaneID, pane.WorkspaceID, ws.ID)
				}
				if pane.TabID != tab.ID {
					return fmt.Errorf("loop: pane %q tabId=%q does not match parent %q",
						pane.PaneID, pane.TabID, tab.ID)
				}
				if pane.SessionID == "" {
					return fmt.Errorf("loop: pane %q has empty sessionId", pane.PaneID)
				}
				if _, dup := seen[pane.PaneID]; dup {
					return fmt.Errorf("loop: duplicate pane id %q in tab %q", pane.PaneID, tab.ID)
				}
				seen[pane.PaneID] = struct{}{}
			}
		}
	}
	return nil
}

// String renders a compact multi-line summary useful for tests
// and for the eventual `bbl loop --status` smoke output.
func (m LoopModel) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "loop(%d workspaces, focus=w%d/t%d/p%d)",
		len(m.Workspaces), m.Focus.WorkspaceIdx, m.Focus.TabIdx, m.Focus.PaneIdx)
	for wi, ws := range m.Workspaces {
		fmt.Fprintf(&b, "\n  ws[%d] %s (%q)", wi, ws.ID, ws.Label)
		for ti, tab := range ws.Tabs {
			fmt.Fprintf(&b, "\n    tab[%d] %s (%q) panes=%d", ti, tab.ID, tab.Label, len(tab.Panes))
			for pi, pane := range tab.Panes {
				fmt.Fprintf(&b, "\n      pane[%d] %s session=%s status=%s", pi, pane.PaneID, pane.SessionID, pane.Status)
			}
		}
	}
	return b.String()
}
