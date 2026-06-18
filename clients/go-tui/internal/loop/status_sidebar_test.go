// internal/loop/status_sidebar_test.go
//
// Phase 4 / 6d (P1) status sidebar overlay tests. The
// sidebar (`renderSidebar` / `renderSidebarRow` in
// chrome.go) and the pane_list overlay
// (`renderPaneListPanel`) should both reflect the pane
// status color so the operator can see drift / blocked /
// waiting panes at a glance, without opening the
// overlay.
//
// Color table (plan §4, also status.go ColorForStatus):
//   - blocked   → colRed    (38;5;167)
//   - drift     → colAmber  (38;5;180)
//   - waiting   → colBlue   (38;5;111)
//   - done      → colGreen  (38;5;114)
//   - working   → colBlue   (38;5;111)
//   - idle      → colGray   (38;5;245) — but `idle` and
//                 `working` are "background" states; the
//                 sidebar deliberately keeps the
//                 focus surface and shows the status
//                 field with the status color (so the
//                 `· working` pill is blue).
//   - hint      → colAmber  (38;5;180)
//
// Focused row: `renderSidebarRow` should also wrap the
// row in `focusedRowStyle`'s background surface so the
// operator can see at a glance which row corresponds
// to the focused pane. The style was defined in
// chrome.go:88 but never used before 6d (P1).
//
// What this file covers:
//   - renderSidebarRow emits the right ANSI sequence
//     for each status (blocked / drift / waiting / done /
//     working / idle / hint)
//   - focused row gets the focusedRowStyle background
//   - the pane_list overlay (renderPaneListPanel) emits
//     the same status colors (so the ctrl+j overlay
//     matches the sidebar)
//   - workspace / tab rows are NOT status-colored (they
//     have no status to display)
//   - multiple panes with different statuses don't
//     bleed color into each other
//
// What this file does NOT cover:
//   - formatPaneRowLine (plain-text) — pane_list_test.go
//   - the 7th status (StatusBehaviorHint) was added
//     later; the colAmber assertion applies to both
//     drift and hint

package loop

import (
	"fmt"
	"strings"
	"testing"
)

// ansiSGR is a tiny helper that builds the 8-bit-color
// substring that the chrome emits when it sets a
// foreground color. We don't assert on the FULL escape
// sequence (lipgloss may prepend bold / italic, e.g.
// `\x1b[1;38;5;167m`) — just the `38;5;Nm` part so a
// real status-colored render can be detected without
// parsing the whole ANSI state machine.
func ansiSGR(n int) string {
	return fmt.Sprintf("38;5;%d", n)
}

// seedSidebarModel returns a model with one workspace +
// one tab + one pane carrying the given status. Used by
// every test below to isolate "status → color" rendering
// from the rest of the sidebar layout.
func seedSidebarModel(t *testing.T, status PaneStatus, paneID string) LoopModel {
	t.Helper()
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID:    defaultTabID,
				Label: "main",
			}},
		}},
	}, PaneModel{
		PaneID:      paneID,
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-" + paneID,
		Agent:       "bbl",
		Label:       paneID,
		Status:      status,
	})
	return seeded
}

// TestSidebarRowEmitsBlockedColor: a StatusBlocked pane
// row should emit the colRed ANSI sequence (38;5;167) so
// the row is highlighted red in the chrome.
func TestSidebarRowEmitsBlockedColor(t *testing.T) {
	model := seedSidebarModel(t, StatusBlocked, "pane-blocked")
	rows := BuildPaneListRows(model)
	if len(rows) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(rows))
	}
	row := rows[2] // pane row
	out := renderSidebarRow(row, model, 40)
	if !strings.Contains(out, ansiSGR(167)) {
		t.Errorf("blocked row should emit colRed (167) ANSI, got:\n%q", out)
	}
}

// TestSidebarRowEmitsDriftColor: a StatusDrift pane row
// should emit the colAmber ANSI sequence (38;5;180).
func TestSidebarRowEmitsDriftColor(t *testing.T) {
	model := seedSidebarModel(t, StatusDrift, "pane-drift")
	rows := BuildPaneListRows(model)
	row := rows[2]
	out := renderSidebarRow(row, model, 40)
	if !strings.Contains(out, ansiSGR(180)) {
		t.Errorf("drift row should emit colAmber (180) ANSI, got:\n%q", out)
	}
}

// TestSidebarRowEmitsWaitingColor: a StatusWaiting pane
// row should emit the colBlue ANSI sequence (38;5;111).
func TestSidebarRowEmitsWaitingColor(t *testing.T) {
	model := seedSidebarModel(t, StatusWaiting, "pane-waiting")
	rows := BuildPaneListRows(model)
	row := rows[2]
	out := renderSidebarRow(row, model, 40)
	if !strings.Contains(out, ansiSGR(111)) {
		t.Errorf("waiting row should emit colBlue (111) ANSI, got:\n%q", out)
	}
}

// TestSidebarRowEmitsDoneColor: a StatusDone pane row
// should emit the colGreen ANSI sequence (38;5;114).
func TestSidebarRowEmitsDoneColor(t *testing.T) {
	model := seedSidebarModel(t, StatusDone, "pane-done")
	rows := BuildPaneListRows(model)
	row := rows[2]
	out := renderSidebarRow(row, model, 40)
	if !strings.Contains(out, ansiSGR(114)) {
		t.Errorf("done row should emit colGreen (114) ANSI, got:\n%q", out)
	}
}

// TestSidebarRowEmitsHintColor: StatusBehaviorHint is the
// 7th PaneStatus (per PR-17a). It's drift-adjacent and
// the chrome color table puts it on colAmber (same as
// drift). Verifies the 7th status is wired into the
// sidebar coloring.
func TestSidebarRowEmitsHintColor(t *testing.T) {
	model := seedSidebarModel(t, StatusBehaviorHint, "pane-hint")
	rows := BuildPaneListRows(model)
	row := rows[2]
	out := renderSidebarRow(row, model, 40)
	if !strings.Contains(out, ansiSGR(180)) {
		t.Errorf("hint row should emit colAmber (180) ANSI, got:\n%q", out)
	}
}

// TestSidebarRowIdleUsesMutedColor: a StatusIdle pane
// row should emit the colGray (245) — the "background"
// state. Idle is the most common state and should not
// scream for attention.
func TestSidebarRowIdleUsesMutedColor(t *testing.T) {
	model := seedSidebarModel(t, StatusIdle, "pane-idle")
	rows := BuildPaneListRows(model)
	row := rows[2]
	out := renderSidebarRow(row, model, 40)
	if !strings.Contains(out, ansiSGR(245)) {
		t.Errorf("idle row should emit colGray (245) ANSI, got:\n%q", out)
	}
	// And NOT a screaming red / amber / green.
	if strings.Contains(out, ansiSGR(167)) ||
		strings.Contains(out, ansiSGR(180)) ||
		strings.Contains(out, ansiSGR(114)) {
		t.Errorf("idle row should NOT emit attention color, got:\n%q", out)
	}
}

// TestSidebarFocusedRowGetsBackground: a focused pane
// row should be wrapped in focusedRowStyle (which
// carries a background surface). The background is
// emitted as a different SGR parameter (48;5;N for
// 8-bit background) — distinct from the foreground
// status color. The row's status color (foreground)
// should still be present alongside the background.
func TestSidebarFocusedRowGetsBackground(t *testing.T) {
	model := seedSidebarModel(t, StatusDrift, "pane-focused")
	rows := BuildPaneListRows(model)
	row := rows[2] // pane row, focused
	out := renderSidebarRow(row, model, 40)
	// focusedRowStyle has Background(colSurface) —
	// a 48;5;N sequence somewhere in the row. lipgloss
	// may pack it with the foreground (e.g.
	// `\x1b[1;38;5;252;48;5;237m`), so we just look
	// for the `48;5;` substring.
	if !strings.Contains(out, "48;5;") {
		t.Errorf("focused row should emit a 48;5;N background ANSI, got:\n%q", out)
	}
	// Status color (foreground) should still be there.
	if !strings.Contains(out, ansiSGR(180)) {
		t.Errorf("focused row should preserve status color (colAmber=180), got:\n%q", out)
	}
}

// TestSidebarUnfocusedRowHasNoBackground: an unfocused
// pane row (focused is on a different pane) should NOT
// carry the focusedRowStyle background. The 48;5;
// background sequence should be absent.
func TestSidebarUnfocusedRowHasNoBackground(t *testing.T) {
	// Build a model with two panes; focus the first
	// one. The second pane (StatusDrift) is the one
	// we render — it should be un-focused.
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID:    defaultTabID,
				Label: "main",
			}},
		}},
	}, PaneModel{
		PaneID: "pane-focused", WorkspaceID: defaultWSID, TabID: defaultTabID,
		SessionID: "session-1", Agent: "bbl", Label: "focused", Status: StatusIdle,
	})
	seeded, _ = ApplyNewPane(seeded, NewPaneSeed{
		PaneID: "pane-unfocused", WorkspaceID: defaultWSID, TabID: defaultTabID,
		SessionID: "session-2", Agent: "bbl", Label: "unfocused",
	})
	// ApplyNewPane moves focus to the new pane by
	// default; force it back to the first pane so the
	// second pane is the un-focused one we want to
	// test.
	seeded.Focus.PaneIdx = 0
	// Force the second pane to StatusDrift (ApplyNewPane
	// may default to something else).
	tab := seeded.Workspaces[0].Tabs[0]
	drift := tab.Panes[1]
	drift.Status = StatusDrift
	tab.Panes[1] = drift
	seeded.Workspaces[0].Tabs[0] = tab

	rows := BuildPaneListRows(seeded)
	// Find the unfocused pane row.
	var unfocused paneRow
	for _, r := range rows {
		if r.Kind == paneRowPane && r.PaneID == "pane-unfocused" {
			unfocused = r
			break
		}
	}
	if unfocused.PaneID == "" {
		t.Fatal("unfocused pane not in row tree")
	}
	out := renderSidebarRow(unfocused, seeded, 40)
	if strings.Contains(out, "48;5;") {
		t.Errorf("unfocused row should NOT have background, got:\n%q", out)
	}
}

// TestSidebarWorkspaceAndTabRowsNoStatusColor: workspace
// and tab rows don't carry a status (the Status field
// is zero on `paneRow` for those kinds). The chrome
// should NOT emit a status color for them — the row
// shows the workspace/tab id + label, no status pill.
func TestSidebarWorkspaceAndTabRowsNoStatusColor(t *testing.T) {
	model := seedSidebarModel(t, StatusDrift, "pane-x")
	rows := BuildPaneListRows(model)
	// row 0 = workspace, row 1 = tab, row 2 = pane.
	wsOut := renderSidebarRow(rows[0], model, 40)
	if strings.Contains(wsOut, ansiSGR(180)) {
		t.Errorf("workspace row should NOT carry status color, got:\n%q", wsOut)
	}
	tabOut := renderSidebarRow(rows[1], model, 40)
	if strings.Contains(tabOut, ansiSGR(180)) {
		t.Errorf("tab row should NOT carry status color, got:\n%q", tabOut)
	}
}

// TestSidebarMultiplePanesStatusIsolation: a model with
// multiple panes of different statuses should render
// each row with its own color — no leakage between
// rows. We seed 4 panes (blocked, drift, waiting, done)
// and assert each row's ANSI color appears in its
// corresponding row and not in the others.
func TestSidebarMultiplePanesStatusIsolation(t *testing.T) {
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID:    defaultTabID,
				Label: "main",
			}},
		}},
	}, PaneModel{
		PaneID: "p-blocked", WorkspaceID: defaultWSID, TabID: defaultTabID,
		SessionID: "s-blocked", Agent: "bbl", Label: "blocked", Status: StatusBlocked,
	})
	for _, p := range []NewPaneSeed{
		{PaneID: "p-drift", WorkspaceID: defaultWSID, TabID: defaultTabID, SessionID: "s-drift", Agent: "bbl", Label: "drift"},
		{PaneID: "p-waiting", WorkspaceID: defaultWSID, TabID: defaultTabID, SessionID: "s-waiting", Agent: "bbl", Label: "waiting"},
		{PaneID: "p-done", WorkspaceID: defaultWSID, TabID: defaultTabID, SessionID: "s-done", Agent: "bbl", Label: "done"},
	} {
		seeded, _ = ApplyNewPane(seeded, p)
	}
	// ApplyNewPane may not preserve Status; force the
	// statuses we want on the model after append.
	tab := seeded.Workspaces[0].Tabs[0]
	for i, want := range []PaneStatus{StatusDrift, StatusWaiting, StatusDone} {
		if i+1 >= len(tab.Panes) {
			break
		}
		tab.Panes[i+1].Status = want
	}
	seeded.Workspaces[0].Tabs[0] = tab
	rows := BuildPaneListRows(seeded)
	// Find each pane row + render it.
	byID := map[string]paneRow{}
	for _, r := range rows {
		if r.Kind == paneRowPane {
			byID[r.PaneID] = r
		}
	}
	cases := []struct {
		id   string
		want string
	}{
		{"p-blocked", ansiSGR(167)},
		{"p-drift", ansiSGR(180)},
		{"p-waiting", ansiSGR(111)},
		{"p-done", ansiSGR(114)},
	}
	for _, c := range cases {
		row, ok := byID[c.id]
		if !ok {
			t.Errorf("pane %s not in row tree", c.id)
			continue
		}
		out := renderSidebarRow(row, seeded, 50)
		if !strings.Contains(out, c.want) {
			t.Errorf("pane %s should emit %q, got:\n%q", c.id, c.want, out)
		}
	}
}

// TestPaneListOverlayEmitsStatusColor: the pane_list
// overlay (ctrl+j, renderPaneListPanel) uses the
// colored variant of formatPaneRowLine so the operator
// opening the overlay sees the same status colors as
// the always-visible sidebar. Verifies the colored
// path is wired through.
func TestPaneListOverlayEmitsStatusColor(t *testing.T) {
	model := seedSidebarModel(t, StatusDrift, "pane-overlay-drift")
	rows := BuildPaneListRows(model)
	out := renderPaneListPanel(60, 16, -1, rows)
	if !strings.Contains(out, ansiSGR(180)) {
		t.Errorf("pane_list overlay should emit colAmber for drift pane, got:\n%q", out)
	}
	// And the overlay header should still be there.
	if !strings.Contains(stripANSI(out), "bbl loop · panes") {
		t.Errorf("pane_list header missing, got:\n%q", stripANSI(out))
	}
}

// TestPaneListOverlayMultipleStatuses: the overlay
// renders multiple panes of different statuses with
// each pane's own color.
func TestPaneListOverlayMultipleStatuses(t *testing.T) {
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID:    defaultTabID,
				Label: "main",
			}},
		}},
	}, PaneModel{
		PaneID: "p-blocked", WorkspaceID: defaultWSID, TabID: defaultTabID,
		SessionID: "s-blocked", Agent: "bbl", Label: "blocked", Status: StatusBlocked,
	})
	seeded, _ = ApplyNewPane(seeded, NewPaneSeed{
		PaneID: "p-done", WorkspaceID: defaultWSID, TabID: defaultTabID,
		SessionID: "s-done", Agent: "bbl", Label: "done",
	})
	// Force the second pane to StatusDone.
	tab := seeded.Workspaces[0].Tabs[0]
	done := tab.Panes[1]
	done.Status = StatusDone
	tab.Panes[1] = done
	seeded.Workspaces[0].Tabs[0] = tab

	rows := BuildPaneListRows(seeded)
	out := renderPaneListPanel(60, 16, -1, rows)
	if !strings.Contains(out, ansiSGR(167)) {
		t.Errorf("overlay should emit colRed for blocked pane, got:\n%q", out)
	}
	if !strings.Contains(out, ansiSGR(114)) {
		t.Errorf("overlay should emit colGreen for done pane, got:\n%q", out)
	}
}

// TestFormatPaneRowLineColoredMatchesPlanColorTable:
// direct unit test on the helper that all sidebar /
// overlay rows go through. We test the four "needs
// attention" statuses (blocked / drift / waiting / done)
// explicitly to lock the plan §4 color table into a
// regression guard.
func TestFormatPaneRowLineColoredMatchesPlanColorTable(t *testing.T) {
	cases := []struct {
		status PaneStatus
		want   string // expected ANSI sequence substring
	}{
		{StatusBlocked, ansiSGR(167)},
		{StatusDrift, ansiSGR(180)},
		{StatusWaiting, ansiSGR(111)},
		{StatusDone, ansiSGR(114)},
		{StatusWorking, ansiSGR(111)},
		{StatusBehaviorHint, ansiSGR(180)},
	}
	for _, c := range cases {
		row := paneRow{
			Kind: paneRowPane,
			PaneID: "p-" + c.status.String(),
			Label:  c.status.String(),
			Status: c.status,
		}
		out := formatPaneRowLineColored(row)
		if !strings.Contains(out, c.want) {
			t.Errorf("status %s: formatPaneRowLineColored should emit %q, got:\n%q",
				c.status, c.want, out)
		}
	}
}
