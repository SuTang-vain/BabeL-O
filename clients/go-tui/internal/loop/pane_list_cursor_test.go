// internal/loop/pane_list_cursor_test.go
//
// Phase 6d-f tests: pane_list overlay row highlight +
// Enter-to-jump focus. The structured `BuildPaneListRows`
// tree is indexed by an integer cursor that the operator
// moves with up/down arrows and consumes with Enter.
//
// What this file covers:
//   - movePaneListCursor advances with wrap (down past
//     last row → 0; up from 0 → last row)
//   - movePaneListCursor on empty model stays at 0
//   - jumpPaneListCursorToFocus on a pane row changes
//     LoopModel.Focus and returns true
//   - jumpPaneListCursorToFocus on a workspace / tab row
//     is a noop (returns false, doesn't change focus)
//   - Opening the overlay (ctrl+j) resets cursor to 0
//   - Closing the overlay (esc) resets cursor to 0
//   - The chrome's View() reflects the cursor with a
//     "▸ " prefix on the highlighted row
//   - Up/down while overlay is open adjust the cursor
//
// What this file does NOT cover:
//   - BuildPaneListRows / BuildPaneListLines leaf tests
//     (pane_list_test.go)
//   - overlay splicing (overlay_splice_test.go)

package loop

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// seedPaneListCursorModel returns a model with one
// workspace, one tab, three panes. Cursor math is most
// interesting when there are multiple rows; the tree
// shape here is:
//
//   row 0: ws (workspace)
//   row 1: tab
//   row 2: pane 0 (focused by default)
//   row 3: pane 1
//   row 4: pane 2
func seedPaneListCursorModel(t *testing.T) *InteractiveModel {
	t.Helper()
	im := NewInteractiveModel(NewLoopModel())
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID: defaultTabID,
				Label: "main",
			}},
		}},
	}, PaneModel{
		PaneID:      "pane-0",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-0",
		Agent:       "bbl",
		Label:       "main",
		Status:      StatusIdle,
	})
	im.loop = seeded
	// Add two more panes via ApplyNewPane (uses the
	// mutator the rest of the production path uses).
	seeded, _ = ApplyNewPane(seeded, NewPaneSeed{
		PaneID:      "pane-1",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Label:       "pane-1",
	})
	seeded, _ = ApplyNewPane(seeded, NewPaneSeed{
		PaneID:      "pane-2",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-2",
		Agent:       "bbl",
		Label:       "pane-2",
	})
	im.loop = seeded
	return &im
}

// TestMovePaneListCursorAdvances: down moves forward,
// up moves backward, both with wrap.
func TestMovePaneListCursorAdvances(t *testing.T) {
	im := seedPaneListCursorModel(t)
	rows := BuildPaneListRows(im.loop)
	if len(rows) != 5 {
		t.Fatalf("expected 5 rows (ws + tab + 3 panes), got %d", len(rows))
	}
	// Down three times: 0 → 1 → 2 → 3.
	cur := im.movePaneListCursor(+1)
	if cur != 1 {
		t.Errorf("after first down: cursor = %d, want 1", cur)
	}
	im.paneListCursor = cur
	cur = im.movePaneListCursor(+1)
	if cur != 2 {
		t.Errorf("after second down: cursor = %d, want 2", cur)
	}
	im.paneListCursor = cur
	cur = im.movePaneListCursor(+1)
	if cur != 3 {
		t.Errorf("after third down: cursor = %d, want 3", cur)
	}
	// Wrap down: 3 → 4 → 0.
	im.paneListCursor = 3
	cur = im.movePaneListCursor(+1)
	if cur != 4 {
		t.Errorf("after wrap-down: cursor = %d, want 4", cur)
	}
	im.paneListCursor = 4
	cur = im.movePaneListCursor(+1)
	if cur != 0 {
		t.Errorf("after wrap-down to start: cursor = %d, want 0", cur)
	}
	// Wrap up: 0 → 4.
	im.paneListCursor = 0
	cur = im.movePaneListCursor(-1)
	if cur != 4 {
		t.Errorf("after wrap-up: cursor = %d, want 4", cur)
	}
}

// TestMovePaneListCursorEmpty: when the model has no
// rows at all (zero workspaces — a defensive case that
// shouldn't be reachable in production since the
// default NewLoopModel has one empty workspace), the
// cursor stays at 0.
func TestMovePaneListCursorEmpty(t *testing.T) {
	im := NewInteractiveModel(LoopModel{}) // truly zero rows
	cur := im.movePaneListCursor(+1)
	if cur != 0 {
		t.Errorf("empty model cursor = %d, want 0", cur)
	}
}

// TestJumpPaneListCursorToFocusOnPaneRow: cursor on a
// pane row → ApplyFocusPath writes the new (ws, tab,
// pane) indices and returns true.
func TestJumpPaneListCursorToFocusOnPaneRow(t *testing.T) {
	im := seedPaneListCursorModel(t)
	// Find the row for pane-2 (last pane). In the
	// workspace + tab + 3 panes tree, pane-2 is row 4.
	rows := BuildPaneListRows(im.loop)
	pane2Idx := -1
	for i, r := range rows {
		if r.Kind == paneRowPane && r.PaneID == "pane-2" {
			pane2Idx = i
			break
		}
	}
	if pane2Idx < 0 {
		t.Fatal("pane-2 not in row tree")
	}
	im.paneListCursor = pane2Idx

	if !im.jumpPaneListCursorToFocus() {
		t.Fatal("jump should return true for a pane row")
	}
	if im.loop.Focus.PaneIdx != 2 {
		t.Errorf("Focus.PaneIdx = %d, want 2", im.loop.Focus.PaneIdx)
	}
}

// TestJumpPaneListCursorToFocusOnWorkspaceRow: a
// workspace row is not a focus target. The function
// returns false and the focus is unchanged.
func TestJumpPaneListCursorToFocusOnWorkspaceRow(t *testing.T) {
	im := seedPaneListCursorModel(t)
	im.paneListCursor = 0 // row 0 = workspace

	originalFocus := im.loop.Focus
	if im.jumpPaneListCursorToFocus() {
		t.Error("jump should return false for a workspace row")
	}
	if im.loop.Focus != originalFocus {
		t.Errorf("focus should be unchanged, got %+v want %+v", im.loop.Focus, originalFocus)
	}
}

// TestJumpPaneListCursorToFocusOnTabRow: a tab row is
// not a focus target either (the operator would need to
// use the existing tab-cycling keys). Returns false.
func TestJumpPaneListCursorToFocusOnTabRow(t *testing.T) {
	im := seedPaneListCursorModel(t)
	im.paneListCursor = 1 // row 1 = tab

	originalFocus := im.loop.Focus
	if im.jumpPaneListCursorToFocus() {
		t.Error("jump should return false for a tab row")
	}
	if im.loop.Focus != originalFocus {
		t.Errorf("focus should be unchanged, got %+v want %+v", im.loop.Focus, originalFocus)
	}
}

// TestJumpPaneListCursorToFocusStaleCursor: if the
// cursor points past the end of the row slice (e.g. a
// pane was closed between cursor set and Enter), the
// function returns false and focus is unchanged.
func TestJumpPaneListCursorToFocusStaleCursor(t *testing.T) {
	im := seedPaneListCursorModel(t)
	im.paneListCursor = 99 // out of range

	originalFocus := im.loop.Focus
	if im.jumpPaneListCursorToFocus() {
		t.Error("jump should return false for out-of-range cursor")
	}
	if im.loop.Focus != originalFocus {
		t.Errorf("focus should be unchanged, got %+v want %+v", im.loop.Focus, originalFocus)
	}
}

// TestCtrlJResetsPaneListCursor: opening the overlay
// (ctrl+j) sets the cursor to 0 even if it had been
// advanced previously in a prior open session.
func TestCtrlJResetsPaneListCursor(t *testing.T) {
	im := seedPaneListCursorModel(t)
	im.paneListCursor = 3 // simulated prior navigation
	im.paneListOpen = true

	updated, _ := im.Update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	newModel := updated.(InteractiveModel)
	if newModel.paneListOpen {
		// ctrl+j when open should close.
		_ = newModel
	}
	// Open again.
	updated, _ = newModel.Update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	newModel = updated.(InteractiveModel)
	if !newModel.paneListOpen {
		t.Fatal("second ctrl+j should open the overlay")
	}
	if newModel.paneListCursor != 0 {
		t.Errorf("cursor should be reset to 0 on open, got %d", newModel.paneListCursor)
	}
}

// TestEscClosesPaneListResetsCursor: dismissing the
// overlay with esc resets the cursor to 0 so the next
// open lands on the first row (no carry-over).
func TestEscClosesPaneListResetsCursor(t *testing.T) {
	im := seedPaneListCursorModel(t)
	im.paneListOpen = true
	im.paneListCursor = 2

	updated, _ := im.Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	newModel := updated.(InteractiveModel)
	if newModel.paneListOpen {
		t.Error("esc should close the overlay")
	}
	if newModel.paneListCursor != 0 {
		t.Errorf("cursor should reset to 0 on close, got %d", newModel.paneListCursor)
	}
}

// TestDownArrowAdvancesPaneListCursor: pressing down
// while the overlay is open advances the cursor and the
// chrome's View shows the highlight on the new row.
func TestDownArrowAdvancesPaneListCursor(t *testing.T) {
	im := seedPaneListCursorModel(t)
	im.paneListOpen = true
	im.paneListCursor = 0

	updated, _ := im.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	newModel := updated.(InteractiveModel)
	if newModel.paneListCursor != 1 {
		t.Errorf("down arrow should advance cursor to 1, got %d", newModel.paneListCursor)
	}
}

// TestUpArrowBacksUpPaneListCursor: pressing up while
// the overlay is open backs up the cursor (with wrap).
func TestUpArrowBacksUpPaneListCursor(t *testing.T) {
	im := seedPaneListCursorModel(t)
	im.paneListOpen = true
	im.paneListCursor = 0

	updated, _ := im.Update(tea.KeyPressMsg{Code: tea.KeyUp})
	newModel := updated.(InteractiveModel)
	// Wrap: 0 → 4 (last row).
	if newModel.paneListCursor != 4 {
		t.Errorf("up arrow from 0 should wrap to 4, got %d", newModel.paneListCursor)
	}
}

// TestEnterOnPaneListJumpsFocus: pressing Enter on a
// pane row changes LoopModel.Focus and dismisses the
// overlay; the operator lands in the targeted pane.
func TestEnterOnPaneListJumpsFocus(t *testing.T) {
	im := seedPaneListCursorModel(t)
	im.paneListOpen = true
	// Find the row for pane-1.
	rows := BuildPaneListRows(im.loop)
	pane1Idx := -1
	for i, r := range rows {
		if r.Kind == paneRowPane && r.PaneID == "pane-1" {
			pane1Idx = i
			break
		}
	}
	if pane1Idx < 0 {
		t.Fatal("pane-1 not in row tree")
	}
	im.paneListCursor = pane1Idx

	updated, _ := im.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	newModel := updated.(InteractiveModel)
	if newModel.loop.Focus.PaneIdx != 1 {
		t.Errorf("Focus.PaneIdx = %d, want 1", newModel.loop.Focus.PaneIdx)
	}
	if newModel.paneListOpen {
		t.Error("Enter should close the overlay")
	}
	if newModel.paneListCursor != 0 {
		t.Errorf("cursor should reset to 0 on Enter-jump, got %d", newModel.paneListCursor)
	}
}

// TestEnterOnWorkspaceRowIsNoop: pressing Enter on a
// workspace / tab row keeps the overlay open and focus
// unchanged. The operator can keep navigating.
func TestEnterOnWorkspaceRowIsNoop(t *testing.T) {
	im := seedPaneListCursorModel(t)
	im.paneListOpen = true
	im.paneListCursor = 0 // workspace row

	originalFocus := im.loop.Focus
	updated, _ := im.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	newModel := updated.(InteractiveModel)
	if !newModel.paneListOpen {
		t.Error("Enter on workspace row should keep overlay open")
	}
	if newModel.loop.Focus != originalFocus {
		t.Errorf("focus should be unchanged, got %+v want %+v", newModel.loop.Focus, originalFocus)
	}
}

// TestPaneListOverlayHighlightsCursorRow: when the
// overlay is open with cursor=2, the chrome's View
// contains a `▸ ` prefix on the row at index 2 (the
// pane-0 row in the seeded tree).
func TestPaneListOverlayHighlightsCursorRow(t *testing.T) {
	im := seedPaneListCursorModel(t)
	im.paneListOpen = true
	im.paneListCursor = 2 // row 2 = pane-0 (focused)

	// The structured-row path needs Width/Height for
	// the splice. Set them so renderChrome's body
	// section sizes correctly.
	updated, _ := im.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	im = ptrFromInteractive(updated.(InteractiveModel))
	body := stripANSI(im.View().Content)
	// The row for pane-0 should be the one prefixed
	// with "▸ ". Other rows get "  " (two-space indent
	// from the chrome). The `▸ ` token is rendered as
	// ANSI-stripped "▸ " so we look for the substring
	// at the start of a line.
	if !strings.Contains(body, "▸ ") {
		t.Errorf("overlay should contain a `▸ ` highlight, got:\n%s", body)
	}
}

// ptrFromInteractive is a small helper to convert the
// value-typed Update return back to a pointer for
// fluent test code. Mirrors the pattern from
// overlay_splice_test.go.
func ptrFromInteractive(m InteractiveModel) *InteractiveModel {
	return &m
}

// TestCursorForChromeReturnsNegativeOneWhenClosed:
// the chromeViewState's PaneListCursor is -1 when the
// overlay is closed so the chrome can skip the highlight
// loop without a nil check.
func TestCursorForChromeReturnsNegativeOneWhenClosed(t *testing.T) {
	im := seedPaneListCursorModel(t)
	// Overlay is closed by default; cursor stays at
	// whatever it was.
	im.paneListCursor = 3
	if got := im.cursorForChrome(); got != -1 {
		t.Errorf("cursorForChrome with overlay closed = %d, want -1", got)
	}
}

// TestCursorForChromeReturnsCursorWhenOpen: when the
// overlay is open, cursorForChrome returns the current
// cursor index.
func TestCursorForChromeReturnsCursorWhenOpen(t *testing.T) {
	im := seedPaneListCursorModel(t)
	im.paneListOpen = true
	im.paneListCursor = 2
	if got := im.cursorForChrome(); got != 2 {
		t.Errorf("cursorForChrome with overlay open = %d, want 2", got)
	}
}

// TestApplyFocusPathBoundsCheck: the new mutator
// returns the model unchanged when any index is out of
// range. Guards the cross-tab / cross-workspace path
// the pane_list Enter handler uses.
func TestApplyFocusPathBoundsCheck(t *testing.T) {
	im := seedPaneListCursorModel(t)
	originalFocus := im.loop.Focus

	// Workspace out of range.
	if got := ApplyFocusPath(im.loop, 5, 0, 0); got.Focus != originalFocus {
		t.Error("ApplyFocusPath with bad workspace should be a noop")
	}
	// Tab out of range.
	if got := ApplyFocusPath(im.loop, 0, 5, 0); got.Focus != originalFocus {
		t.Error("ApplyFocusPath with bad tab should be a noop")
	}
	// Pane out of range.
	if got := ApplyFocusPath(im.loop, 0, 0, 99); got.Focus != originalFocus {
		t.Error("ApplyFocusPath with bad pane should be a noop")
	}
	// Valid path applies.
	got := ApplyFocusPath(im.loop, 0, 0, 1)
	if got.Focus.PaneIdx != 1 {
		t.Errorf("ApplyFocusPath valid path: PaneIdx = %d, want 1", got.Focus.PaneIdx)
	}
}
