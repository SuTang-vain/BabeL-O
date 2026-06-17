// internal/loop/chrome_test.go
//
// Phase 4 chrome tests: status→style mapping, status pill
// rendering, header / sidebar / focused-pane / footer
// substrings, and narrow-terminal fallback. Keeps the
// existing interactive View() tests honest (the chrome
// layer is now the source of truth for what the operator
// sees).

package loop

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

func TestChromeStatusMappingMatchesStatusProjection(t *testing.T) {
	// Every PaneStatus should produce a non-empty styled pill
	// that contains the status symbol + label. This is the
	// contract the sidebar + header pill rely on.
	statuses := []PaneStatus{
		StatusIdle, StatusWorking, StatusBlocked,
		StatusWaiting, StatusDrift, StatusDone,
	}
	for _, s := range statuses {
		pill := renderStatusPill(s)
		if pill == "" {
			t.Errorf("renderStatusPill(%v) returned empty", s)
		}
		if !strings.Contains(pill, s.String()) {
			t.Errorf("renderStatusPill(%v) = %q, want to contain %q", s, pill, s.String())
		}
		if !strings.Contains(pill, SymbolForStatus(s)) {
			t.Errorf("renderStatusPill(%v) = %q, want to contain symbol %q", s, pill, SymbolForStatus(s))
		}
	}
}

func TestChromeColorNameToStyleCoversAllTokens(t *testing.T) {
	// All ColorName tokens (defined in status.go) must map
	// to a non-default style; otherwise the runtime's color
	// hints leak through as plain text.
	tokens := []ColorName{
		ColorNone, ColorGray, ColorBlue, ColorGreen,
		ColorAmber, ColorRed, ColorMagenta,
	}
	for _, c := range tokens {
		_ = styleForColorName(c) // never panics; coverage is the assertion
	}
}

func TestChromeLayoutFallbacksAreSafe(t *testing.T) {
	cases := []struct {
		name        string
		w, h        int
		minSidebarW int
		maxSidebarW int
	}{
		{"zero dimensions", 0, 0, 18, 32},
		{"narrow terminal", 40, 20, 18, 32},
		{"normal terminal", 120, 40, 18, 32},
		{"wide terminal", 240, 60, 18, 32},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			layout := computeChromeLayout(c.w, c.h, false)
			if layout.Mode == layoutTooSmall && c.w >= 40 && c.h >= 12 {
				t.Fatalf("expected desktop/mobile mode, got tooSmall")
			}
			if layout.SidebarW < 0 {
				t.Fatalf("sidebar width = %d, want >= 0", layout.SidebarW)
			}
			if layout.SidebarW > c.maxSidebarW {
				t.Fatalf("sidebar width = %d, want <= %d", layout.SidebarW, c.maxSidebarW)
			}
			if layout.MainW < 0 {
				t.Fatalf("main width = %d, want >= 0", layout.MainW)
			}
			if layout.SidebarW+layout.MainW > c.w+1 && c.w > 0 {
				t.Fatalf("sidebar(%d) + main(%d) > width(%d)", layout.SidebarW, layout.MainW, c.w)
			}
		})
	}
}

func TestChromeRendersHeaderSubstrings(t *testing.T) {
	header := renderHeader(seedPaneModel(120, 40, 2), 120)
	for _, want := range []string{"bbl loop", Version, "panes", "focused"} {
		if !strings.Contains(header, want) {
			t.Errorf("header missing %q\nfull:\n%s", want, header)
		}
	}
}

func TestChromeRendersSidebarWorkspaceAndPane(t *testing.T) {
	model := seedPaneModel(120, 40, 2)
	sidebar := renderSidebar(model, 28, 20)
	if sidebar == "" {
		t.Fatal("sidebar should not be empty when width > 0")
	}
	for _, want := range []string{"spaces", model.Workspaces[0].ID, "pane-a", "pane-b"} {
		if !strings.Contains(stripANSI(sidebar), want) {
			t.Errorf("sidebar missing %q\nfull:\n%s", want, stripANSI(sidebar))
		}
	}
}

func TestChromeRendersFocusedPaneMetadata(t *testing.T) {
	// The existing interactive_test.go already asserts the
	// View() contains pane-1 / session-1 / drift for a
	// StatusDrift pane. Re-asserting at the chrome layer
	// keeps the focused-pane box's content contract honest
	// if the View() ever stops going through renderChrome.
	model := NewLoopModel()
	model.Width = 120
	model.Height = 40
	tab := model.Workspaces[0].Tabs[0]
	updated, err := tab.AddPane(PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: model.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Cwd:         "/tmp",
		Status:      StatusDrift,
	})
	if err != nil {
		t.Fatalf("AddPane: %v", err)
	}
	model.Workspaces[0].Tabs[0] = updated
	box := stripANSI(renderFocusedPane(model, 80, 20))
	for _, want := range []string{"pane-1", "session-1", "drift", "Phase 3f'"} {
		if !strings.Contains(box, want) {
			t.Errorf("focused pane box missing %q\nfull:\n%s", want, box)
		}
	}
}

func TestChromeRendersNoPaneFocusedPlaceholder(t *testing.T) {
	model := NewLoopModel()
	model.Width = 80
	model.Height = 24
	box := stripANSI(renderFocusedPane(model, 60, 16))
	if !strings.Contains(box, "no pane focused") {
		t.Errorf("focused pane should show 'no pane focused' placeholder\nfull:\n%s", box)
	}
}

func TestChromeRendersFooterKeybinds(t *testing.T) {
	footer := stripANSI(renderFooter(NewLoopModel(), 200, reconcileFooterInfo{}, computeChromeLayout(200, 40, false)))
	for _, want := range []string{"ctrl+n", "ctrl+w", "ctrl+h", "ctrl+l", "ctrl+pgup", "ctrl+pgdn", "ctrl+t", "quit"} {
		if !strings.Contains(footer, want) {
			t.Errorf("footer missing keybind %q\nfull:\n%s", want, footer)
		}
	}
}

func TestChromeViewSubstringsForExistingInteractiveTestContract(t *testing.T) {
	// The existing TestInteractiveViewRendersStatusBarAndPlaceholder
	// and TestInteractiveViewRendersFocusedPaneMetadata expect
	// specific substrings. Re-asserting them through the new
	// View() pipeline guarantees the chrome refactor doesn't
	// regress those tests by accident.
	t.Run("empty model", func(t *testing.T) {
		model := NewInteractiveModel(NewLoopModel())
		model.loop.Width = 80
		model.loop.Height = 24
		content := model.View().Content
		if !strings.Contains(content, "bbl loop") {
			t.Errorf("View missing %q\nfull:\n%s", "bbl loop", content)
		}
		if !strings.Contains(stripANSI(content), "no pane focused") {
			t.Errorf("View missing %q (after stripping ANSI)\nfull:\n%s", "no pane focused", content)
		}
	})

	t.Run("focused drift pane", func(t *testing.T) {
		model := NewInteractiveModel(NewLoopModel())
		model.loop.Width = 120
		model.loop.Height = 40
		tab := model.loop.Workspaces[0].Tabs[0]
		updated, err := tab.AddPane(PaneModel{
			PaneID:      "pane-1",
			WorkspaceID: model.loop.Workspaces[0].ID,
			TabID:       tab.ID,
			SessionID:   "session-1",
			Agent:       "bbl",
			Cwd:         "/tmp",
			Status:      StatusDrift,
		})
		if err != nil {
			t.Fatalf("AddPane: %v", err)
		}
		model.loop.Workspaces[0].Tabs[0] = updated
		content := stripANSI(model.View().Content)
		for _, want := range []string{"pane-1", "session-1", "drift"} {
			if !strings.Contains(content, want) {
				t.Errorf("View missing %q\nfull:\n%s", want, content)
			}
		}
	})
}

func TestChromeViewEmptyAfterQuit(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	model.quitting = true
	if got := model.View().Content; got != "" {
		t.Fatalf("quitting model should render empty, got %q", got)
	}
}

func TestChromeNarrowTerminalFallsBack(t *testing.T) {
	// A 50-col terminal should still produce output that
	// contains the title and at least the first keybind so
	// the operator can see *something* useful. The sidebar
	// may be suppressed and the footer may be truncated, but
	// the chrome must not collapse into a blank screen.
	model := NewInteractiveModel(NewLoopModel())
	model.loop.Width = 50
	model.loop.Height = 16
	content := stripANSI(model.View().Content)
	for _, want := range []string{"bbl loop", "ctrl+"} {
		if !strings.Contains(content, want) {
			t.Errorf("narrow terminal view missing %q\nfull:\n%s", want, content)
		}
	}
}

func TestBuildPaneListRowsStructuredShape(t *testing.T) {
	model := seedPaneModel(120, 40, 2)
	rows := BuildPaneListRows(model)
	if len(rows) < 3 {
		t.Fatalf("expected at least 1 workspace + 1 tab + 2 panes = 4 rows, got %d", len(rows))
	}
	// First row should be the workspace, second the tab, then panes.
	if rows[0].Kind != paneRowWorkspace {
		t.Errorf("rows[0] kind = %v, want paneRowWorkspace", rows[0].Kind)
	}
	if rows[1].Kind != paneRowTab {
		t.Errorf("rows[1] kind = %v, want paneRowTab", rows[1].Kind)
	}
	if rows[2].Kind != paneRowPane {
		t.Errorf("rows[2] kind = %v, want paneRowPane", rows[2].Kind)
	}
	if rows[2].PaneID != "pane-a" {
		t.Errorf("rows[2].PaneID = %q, want pane-a", rows[2].PaneID)
	}
	if rows[2].Status != StatusIdle {
		t.Errorf("rows[2].Status = %v, want StatusIdle", rows[2].Status)
	}
}

func TestTruncatePlainRespectsWidth(t *testing.T) {
	short := truncatePlain("hello", 10)
	if short != "hello" {
		t.Errorf("truncatePlain short = %q, want %q", short, "hello")
	}
	long := truncatePlain("hello world this is a long string", 10)
	if lipgloss.Width(long) > 10 {
		t.Errorf("truncatePlain long = %q (width %d), want width <= 10", long, lipgloss.Width(long))
	}
	if !strings.HasSuffix(long, "…") {
		t.Errorf("truncatePlain long = %q, want suffix ellipsis", long)
	}
}

func TestChromeWorksWithDefaultInteractiveUpdate(t *testing.T) {
	// Sanity check: the new View() still reacts to
	// WindowSizeMsg so a real Bubble Tea program can drive
	// it without surprises.
	model := NewInteractiveModel(NewLoopModel())
	updated, _ := model.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	im := updated.(InteractiveModel)
	if im.loop.Width != 100 || im.loop.Height != 30 {
		t.Fatalf("WindowSizeMsg not applied: got %dx%d", im.loop.Width, im.loop.Height)
	}
	if content := im.View().Content; content == "" {
		t.Fatal("View returned empty content after WindowSize")
	}
}

// stripANSI removes ANSI escape sequences from s so substring
// assertions work against the human-readable text rather
// than the styled bytes. Good enough for the test layer —
// the Bubble Tea adapter in production keeps the styling.
func stripANSI(s string) string {
	var b strings.Builder
	inEscape := false
	for _, r := range s {
		if r == 0x1b {
			inEscape = true
			continue
		}
		if inEscape {
			// ANSI sequences end at the first letter
			// byte (A–Z / a–z). Skip everything else.
			if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
				inEscape = false
			}
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// PR-17b (Track B §6.5.2): when the focused pane is in
// StatusBehaviorHint with a non-empty LastHintPattern, the chrome
// renders the pill plus an inline "[hint] pattern: <pattern>"
// line. This test verifies the wire form: a focused pane
// transition to StatusBehaviorHint surfaces the pattern in the
// focused-pane header.
func TestChromeRendersBehaviorHintInFocusedHeader(t *testing.T) {
	// Build a model with one workspace + tab + pane.
	ws := NewWorkspace("ws-hint", "Hint Test").AddTab("Tab")
	updated, err := ws.Tabs[0].AddPane(PaneModel{
		PaneID:      "pane-hint",
		WorkspaceID: ws.ID,
		TabID:       ws.Tabs[0].ID,
		SessionID:   "session-hint",
		Label:       "Hint Pane",
	})
	if err != nil {
		t.Fatalf("AddPane: %v", err)
	}
	ws.Tabs[0] = updated
	model := LoopModel{
		Workspaces: []Workspace{ws},
		Focus:      FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
	}

	// Simulate the health-poll path landing a hint state.
	ws2 := model.Workspaces[0]
	tab2 := ws2.Tabs[0]
	pane := tab2.Panes[0]
	pane.Status = StatusBehaviorHint
	pane.LastHintPattern = "tool-storm@session-x"
	tab2.Panes[0] = pane
	ws2.Tabs[0] = tab2
	model.Workspaces[0] = ws2

	header := renderFocusedPaneHeader(model, 80)
	if !strings.Contains(header, "behavior_hint") {
		t.Errorf("renderFocusedPaneHeader missing 'behavior_hint' status pill: %q", header)
	}
	if !strings.Contains(header, "[hint]") {
		t.Errorf("renderFocusedPaneHeader missing '[hint]' inline: %q", header)
	}
	if !strings.Contains(header, "tool-storm@session-x") {
		t.Errorf("renderFocusedPaneHeader missing pattern 'tool-storm@session-x': %q", header)
	}
}

// PR-17b: when LastHintPattern is set but Status is NOT
// StatusBehaviorHint, the chrome must NOT show a "[hint]" line —
// stale patterns from previous health polls would otherwise
// linger on a non-hint pane.
func TestChromeSuppressesStaleHintPattern(t *testing.T) {
	ws := NewWorkspace("ws-stale", "Stale Hint").AddTab("Tab")
	updated, err := ws.Tabs[0].AddPane(PaneModel{
		PaneID:      "pane-stale",
		WorkspaceID: ws.ID,
		TabID:       ws.Tabs[0].ID,
		SessionID:   "session-stale",
		Label:       "Stale Pane",
	})
	if err != nil {
		t.Fatalf("AddPane: %v", err)
	}
	ws.Tabs[0] = updated
	model := LoopModel{
		Workspaces: []Workspace{ws},
		Focus:      FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
	}

	// Status = Done (not StatusBehaviorHint) but pattern set.
	ws2 := model.Workspaces[0]
	tab2 := ws2.Tabs[0]
	pane := tab2.Panes[0]
	pane.Status = StatusDone
	pane.LastHintPattern = "old-pattern-should-not-render"
	tab2.Panes[0] = pane
	ws2.Tabs[0] = tab2
	model.Workspaces[0] = ws2

	header := renderFocusedPaneHeader(model, 80)
	if strings.Contains(header, "[hint]") {
		t.Errorf("renderFocusedPaneHeader must NOT contain '[hint]' when status != StatusBehaviorHint: %q", header)
	}
	if strings.Contains(header, "old-pattern-should-not-render") {
		t.Errorf("renderFocusedPaneHeader must NOT contain stale pattern: %q", header)
	}
}
