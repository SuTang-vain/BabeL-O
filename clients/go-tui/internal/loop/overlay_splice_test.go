// internal/loop/overlay_splice_test.go
//
// Phase 6d-overlay tests (docs §6'.4 6d 末尾): the
// pane_list (ctrl+j) and scope_review (ctrl+r) overlays.
// These are stackable focusable surfaces — they sit on
// top of the existing chrome and dismiss on the same
// keys as the help overlay (esc / q / ctrl+c / the
// toggle key itself).
//
// What this file covers:
//   - toggle keys flip the flag (and View() returns
//     overlay content in the chrome)
//   - the dismiss keys close the overlay
//   - BuildPaneListLines output appears in the chrome
//     when ctrl+j is held
//   - BuildScopeReviewLines output appears when ctrl+r
//     is held (and the placeholder shows up when no
//     ScopeReviewInput has been injected)
//   - the overlay absorbs random keypresses (mirrors
//     helpOpen's contract)
//
// What this file does NOT cover:
//   - BuildPaneListLines / BuildScopeReviewLines leaf
//     tests (pane_list_test.go / scope_review_test.go)
//   - chrome frame placement math (overlayHelp test
//     is the closest analog; we don't duplicate it
//     here — the splicePanel helper is the same one).

package loop

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// TestCtrlJOpensPaneListOverlay: pressing ctrl+j flips
// paneListOpen; the resulting View chrome contains the
// pane list panel header.
func TestCtrlJOpensPaneListOverlay(t *testing.T) {
	im := newOverlayTestModel(t)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	if !im.paneListOpen {
		t.Fatal("ctrl+j should set paneListOpen")
	}
	body := im.View().Content
	if !strings.Contains(stripANSI(body), "bbl loop · panes") {
		t.Errorf("View should contain pane list header, got:\n%s", stripANSI(body))
	}
}

// TestCtrlJAgainClosesPaneListOverlay: pressing ctrl+j a
// second time closes the overlay (mirrors helpOpen's
// behavior — the toggle key is also the dismiss key).
func TestCtrlJAgainClosesPaneListOverlay(t *testing.T) {
	im := newOverlayTestModel(t)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	if !im.paneListOpen {
		t.Fatal("first ctrl+j should open")
	}
	updated, _ = im.Update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	if im.paneListOpen {
		t.Fatal("second ctrl+j should close")
	}
}

// TestEscClosesPaneListOverlay: the standard dismiss
// key for the help overlay works for the pane list too.
func TestEscClosesPaneListOverlay(t *testing.T) {
	im := newOverlayTestModel(t)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	updated, _ = im.Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	*im = updated.(InteractiveModel)
	if im.paneListOpen {
		t.Fatal("esc should close pane list overlay")
	}
}

// TestRandomKeysAbsorbedWhilePaneListOpen: any non-dismiss
// key while the overlay is up is swallowed (mirrors
// helpOpen). The operator can't drive the router or type
// into a pane input while the overlay is shown.
func TestRandomKeysAbsorbedWhilePaneListOpen(t *testing.T) {
	im := newOverlayTestModel(t)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	// Press a printable key — should NOT route to a pane
	// input (no mutation, no error).
	updated, cmd := im.Update(tea.KeyPressMsg{Code: 'a', Text: "a"})
	*im = updated.(InteractiveModel)
	if cmd != nil {
		t.Errorf("random key during overlay should be swallowed, got cmd %T", cmd)
	}
	pane, ok := im.loop.FocusedPane()
	if !ok {
		t.Fatal("no focused pane")
	}
	if pane.Input != "" {
		t.Errorf("pane.Input should stay empty, got %q", pane.Input)
	}
}

// TestPaneListOverlayShowsPanesFromModel: when the
// model has at least one pane, opening the overlay
// shows the pane's id/label/status in the chrome.
func TestPaneListOverlayShowsPanesFromModel(t *testing.T) {
	im := newOverlayTestModel(t)
	// Seed a single pane into the focused tab.
	pane := PaneModel{
		PaneID:      "pane-ovl-1",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-ovl-1",
		Agent:       "bbl",
		Label:       "main",
		Status:      StatusIdle,
	}
	seeded, _ := seedPane(im.loop, pane)
	im.loop = seeded
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	body := stripANSI(im.View().Content)
	if !strings.Contains(body, "pane-ovl-1") {
		t.Errorf("overlay should show pane id, got:\n%s", body)
	}
}

// TestCtrlROpensScopeReviewOverlay: pressing ctrl+r
// flips scopeReviewOpen and the chrome shows the
// scope_review panel header.
func TestCtrlROpensScopeReviewOverlay(t *testing.T) {
	im := newOverlayTestModel(t)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	if !im.scopeReviewOpen {
		t.Fatal("ctrl+r should set scopeReviewOpen")
	}
	body := im.View().Content
	if !strings.Contains(stripANSI(body), "bbl loop · scope review") {
		t.Errorf("View should contain scope review header, got:\n%s", stripANSI(body))
	}
}

// TestScopeReviewOverlayPlaceholderWhenNoData: opening
// ctrl+r without an injected ScopeReviewInput shows the
// "no scope data" placeholder so the operator knows the
// overlay is wired but the runtime hasn't reported. We
// assert on a short token that's robust to the
// center-splice artifact (the splice overwrites from
// startX onward, so the leading few chars of any panel
// line can be chopped by the underlying chrome).
func TestScopeReviewOverlayPlaceholderWhenNoData(t *testing.T) {
	im := newOverlayTestModel(t)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	body := stripANSI(im.View().Content)
	if !strings.Contains(body, "scope data") {
		t.Errorf("placeholder text missing, got:\n%s", body)
	}
}

// TestScopeReviewOverlayShowsInjectedData: when an
// injected ScopeReviewInput has a task scope, the
// overlay renders the mode + primary root from
// BuildScopeReviewLines.
func TestScopeReviewOverlayShowsInjectedData(t *testing.T) {
	im := newOverlayTestModel(t)
	in := &ScopeReviewInput{
		Model: im.loop,
		TaskScope: &LoopTaskScope{
			Mode:        "single_root",
			PrimaryRoot: "/workspace/test",
		},
	}
	im.SetScopeReviewInputForTest(in)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	body := stripANSI(im.View().Content)
	if !strings.Contains(body, "single_root") {
		t.Errorf("mode should appear, got:\n%s", body)
	}
	if !strings.Contains(body, "/workspace/test") {
		t.Errorf("primary root should appear, got:\n%s", body)
	}
}

// TestEscClosesScopeReviewOverlay: esc dismisses.
func TestEscClosesScopeReviewOverlay(t *testing.T) {
	im := newOverlayTestModel(t)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	updated, _ = im.Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	*im = updated.(InteractiveModel)
	if im.scopeReviewOpen {
		t.Fatal("esc should close scope review overlay")
	}
}

// TestOverlaysAreIndependent: ctrl+j and ctrl+r toggle
// their respective flags independently. Opening one
// doesn't open the other, and closing one doesn't close
// the other.
func TestOverlaysAreIndependent(t *testing.T) {
	im := newOverlayTestModel(t)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	updated, _ = im.Update(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	if !im.paneListOpen || !im.scopeReviewOpen {
		t.Fatalf("both overlays should be open, got paneListOpen=%v scopeReviewOpen=%v",
			im.paneListOpen, im.scopeReviewOpen)
	}
	// Close pane_list; scope_review should stay.
	updated, _ = im.Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	*im = updated.(InteractiveModel)
	if im.paneListOpen {
		t.Error("esc should close pane_list")
	}
	if !im.scopeReviewOpen {
		t.Error("esc should NOT close scope_review")
	}
}

// TestHelpOverlayAndDataOverlaysAreIndependent: the
// help overlay (`?`) and the data overlays (ctrl+j /
// ctrl+r) don't share state. `?` opens help; ctrl+j
// opens pane_list. Closing one doesn't close the other.
func TestHelpOverlayAndDataOverlaysAreIndependent(t *testing.T) {
	im := newOverlayTestModel(t)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	*im = updated.(InteractiveModel)
	// `?` opens help on top of pane_list.
	updated, _ = im.Update(tea.KeyPressMsg{Code: '?'})
	*im = updated.(InteractiveModel)
	if !im.helpOpen {
		t.Fatal("? should open help overlay")
	}
	if !im.paneListOpen {
		t.Fatal("pane_list should stay open after ?")
	}
	// Close help; pane_list should still be open.
	updated, _ = im.Update(tea.KeyPressMsg{Code: '?'})
	*im = updated.(InteractiveModel)
	if im.helpOpen {
		t.Error("? should close help")
	}
	if !im.paneListOpen {
		t.Error("pane_list should stay open after closing help")
	}
}

// newOverlayTestModel returns a model with one default
// workspace + tab + pane seeded (so the focused-pane
// helpers return ok=true) and no overlays open. Mirrors
// the pattern from permission_decision_test.go.
func newOverlayTestModel(t *testing.T) *InteractiveModel {
	t.Helper()
	im := NewInteractiveModel(NewLoopModel())
	// Seed a workspace + tab + single pane so
	// FocusedPane returns ok=true. The pane id is what
	// TestPaneListOverlayShowsPanesFromModel will look
	// for in the chrome output.
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID:    defaultTabID,
				Label: "main",
			}},
		}},
	}, PaneModel{
		PaneID:      "pane-overlay-test",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-overlay-test",
		Agent:       "bbl",
		Label:       "main",
		Status:      StatusIdle,
	})
	im.loop = seeded
	return &im
}
