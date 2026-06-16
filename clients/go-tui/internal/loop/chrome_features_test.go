// internal/loop/chrome_features_test.go
//
// Phase 4 follow-up: tests for the help overlay, transient
// save toast, and last-activity hint added on top of the
// initial chrome pass. Mirrors the "UI patterns should be
// reused" herdr principle: the chrome layer keeps growing
// in the same style as the original header / sidebar /
// footer work.

package loop

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

func TestHelpOverlayTogglesOnQuestionMark(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	model.loop.Width = 120
	model.loop.Height = 40

	// `?` opens the overlay; the chrome should now contain
	// the keybind header.
	updated, _ := model.Update(tea.KeyPressMsg(tea.Key{Code: '?', Text: "?"}))
	im := updated.(InteractiveModel)
	if !im.helpOpen {
		t.Fatal("`?` should open the help overlay")
	}
	if content := im.View().Content; !strings.Contains(content, "keyboard shortcuts") {
		t.Errorf("help overlay should render the keyboard shortcuts header\nfull:\n%s", content)
	}

	// Second `?` closes it again.
	updated, _ = im.Update(tea.KeyPressMsg(tea.Key{Code: '?', Text: "?"}))
	im2 := updated.(InteractiveModel)
	if im2.helpOpen {
		t.Fatal("second `?` should close the help overlay")
	}
	if content := im2.View().Content; strings.Contains(content, "keyboard shortcuts") {
		t.Errorf("help overlay should not be visible after close\nfull:\n%s", content)
	}
}

func TestHelpOverlayBlocksRouterDispatch(t *testing.T) {
	// While the overlay is up, Ctrl+N must NOT spawn a new
	// pane (herdr's overlay-intercept pattern).
	model := NewInteractiveModel(NewLoopModel())
	model.loop.Width = 120
	model.loop.Height = 40
	updated, _ := model.Update(tea.KeyPressMsg(tea.Key{Code: '?', Text: "?"}))
	im := updated.(InteractiveModel)
	if !im.helpOpen {
		t.Fatal("help should be open")
	}
	before := len(im.loop.Workspaces[0].Tabs[0].Panes)
	updated, _ = im.Update(tea.KeyPressMsg(tea.Key{Code: 'n', Mod: tea.ModCtrl, Text: "n"}))
	im2 := updated.(InteractiveModel)
	if got := len(im2.loop.Workspaces[0].Tabs[0].Panes); got != before {
		t.Fatalf("Ctrl+N inside help overlay should not create a pane, panes %d -> %d", before, got)
	}
}

func TestHelpOverlayListsAllKeybinds(t *testing.T) {
	// The help panel content (not the splice-into-chrome
	// variant) is the source of truth for what the operator
	// sees. Cover the full keybind list so a typo in one
	// entry is caught here. Height bumped to 20 to fit the
	// 9-row list (was 7 in the pre-Ctrl+B/Ctrl+Z pass).
	panel := renderHelpPanel(60, 20)
	for _, want := range []string{
		"ctrl+n", "ctrl+w", "ctrl+h", "ctrl+l",
		"ctrl+pgup", "ctrl+pgdn", "ctrl+t",
		"ctrl+b", "ctrl+z",
		"toggle this help",
		"quit bbl loop",
	} {
		if !strings.Contains(panel, want) {
			t.Errorf("help panel missing %q\npanel:\n%s", want, panel)
		}
	}
}

func TestSaveToastAppearsOnPersistSuccess(t *testing.T) {
	// persistSnapshot stamps the toast on success; the
	// chrome renders it inside the toastTTL window.
	storePath := t.TempDir() + "/state.json"
	store, err := NewStore(storePath)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer store.Close()
	im := NewInteractiveModelWithStore(NewLoopModel(), store)
	im.loop.Width = 120
	im.loop.Height = 40
	im.persistSnapshot()
	if im.activeToast() == "" {
		t.Fatal("persistSnapshot should set a toast on success")
	}
	if !strings.Contains(im.activeToast(), "state saved") {
		t.Errorf("toast should mention 'state saved', got %q", im.activeToast())
	}
	content := im.View().Content
	if !strings.Contains(content, "state saved") {
		t.Errorf("View should render the save toast\nfull:\n%s", content)
	}
}

func TestSaveToastExpiresAfterTTL(t *testing.T) {
	im := NewInteractiveModel(NewLoopModel())
	im.toastMessage = "✓ state saved"
	im.toastShownAt = time.Now().Add(-3 * time.Second) // older than toastTTL
	if got := im.activeToast(); got != "" {
		t.Errorf("stale toast should not surface, got %q", got)
	}
}

func TestSaveToastEmptyWhenMessageBlank(t *testing.T) {
	im := NewInteractiveModel(NewLoopModel())
	im.toastMessage = "   "
	im.toastShownAt = time.Now()
	if got := im.activeToast(); got != "" {
		t.Errorf("blank toast should not surface, got %q", got)
	}
}

func TestFormatActivityBoundaries(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name string
		in   time.Time
		want string
	}{
		{"zero time", time.Time{}, ""},
		{"just now", now, "just now"}, // sub-second
		{"30s ago", now.Add(-30 * time.Second), "30s ago"},
		{"5m ago", now.Add(-5 * time.Minute), "5m ago"},
		{"2h ago", now.Add(-2 * time.Hour), "2h ago"},
		{"3d ago", now.Add(-72 * time.Hour), "3d ago"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := formatActivity(c.in); got != c.want {
				t.Errorf("formatActivity(%v) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestSidebarRowShowsActivityHint(t *testing.T) {
	// A pane with a non-zero LastEventAt should surface the
	// "Ns ago" hint in the sidebar row (after stripping
	// ANSI).
	model := NewLoopModel()
	model.Width = 160
	model.Height = 32
	tab := model.Workspaces[0].Tabs[0]
	updated, err := tab.AddPane(PaneModel{
		PaneID:      "pane-active",
		WorkspaceID: model.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   "session-active",
		Agent:       "bbl",
		Status:      StatusWorking,
		LastEventAt: time.Now().Add(-12 * time.Second),
	})
	if err != nil {
		t.Fatalf("AddPane: %v", err)
	}
	model.Workspaces[0].Tabs[0] = updated
	rows := BuildPaneListRows(model)
	// Find the pane row (BuildPaneListRows prepends a
	// workspace + tab row before the first pane).
	var paneRow *paneRow
	for i := range rows {
		if rows[i].Kind == paneRowPane {
			paneRow = &rows[i]
			break
		}
	}
	if paneRow == nil {
		t.Fatal("expected at least one pane row")
	}
	row := renderSidebarRow(*paneRow, model, 60)
	if !strings.Contains(stripANSI(row), "12s ago") {
		t.Errorf("sidebar row missing activity hint\nrow:\n%s", stripANSI(row))
	}
}

func TestSidebarRowHidesActivityWhenZero(t *testing.T) {
	model := NewLoopModel()
	tab := model.Workspaces[0].Tabs[0]
	updated, _ := tab.AddPane(PaneModel{
		PaneID:      "pane-fresh",
		WorkspaceID: model.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   "session-fresh",
		Agent:       "bbl",
		// LastEventAt deliberately left zero.
	})
	model.Workspaces[0].Tabs[0] = updated
	rows := BuildPaneListRows(model)
	var found *paneRow
	for i := range rows {
		if rows[i].Kind == paneRowPane {
			found = &rows[i]
			break
		}
	}
	if found == nil {
		t.Fatal("expected at least one pane row")
	}
	row := renderSidebarRow(*found, model, 60)
	if strings.Contains(row, "ago") {
		t.Errorf("zero LastEventAt should not render an activity hint\nrow:\n%s", stripANSI(row))
	}
}

func TestRenderChromeAcceptsStateBundle(t *testing.T) {
	// Backward contract: a zero-value state bundle
	// (no help, no toast) renders exactly the same as the
	// pre-state-bundle shape did.
	model := NewLoopModel()
	model.Width = 120
	model.Height = 24
	out := stripANSI(renderChrome(model, chromeViewState{}))
	for _, want := range []string{"bbl loop", "spaces", "no pane focused", "ctrl+n", "quit"} {
		if !strings.Contains(out, want) {
			t.Errorf("renderChrome with empty state missing %q\nfull:\n%s", want, out)
		}
	}
}

func TestRenderChromeToastVisibleInStateBundle(t *testing.T) {
	model := NewLoopModel()
	model.Width = 120
	model.Height = 24
	out := stripANSI(renderChrome(model, chromeViewState{Toast: "✓ state saved"}))
	if !strings.Contains(out, "state saved") {
		t.Errorf("renderChrome should surface toast from state\nfull:\n%s", out)
	}
}
