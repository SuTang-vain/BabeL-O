// internal/loop/mutate_test.go
//
// Phase 3d mutator tests: verify the loop driver's pan-close /
// pan-add / focus-shift / tab-cycle helpers against a seeded
// LoopModel.

package loop

import "testing"

func TestApplyClosePaneRemovesFocused(t *testing.T) {
	model := seedPaneModel(80, 24, 3)
	model.Focus.PaneIdx = 1
	updated := ApplyClosePane(model)
	tab := updated.Workspaces[0].Tabs[0]
	if len(tab.Panes) != 2 {
		t.Fatalf("expected 2 panes after close, got %d", len(tab.Panes))
	}
	for _, p := range tab.Panes {
		if p.PaneID == "pane-b" {
			t.Fatalf("pane-b should be closed, still present")
		}
	}
	if updated.Focus.PaneIdx != 1 {
		t.Fatalf("focus should shift to index 1 after closing index 1, got %d", updated.Focus.PaneIdx)
	}
}

func TestApplyClosePaneCollapsesFocusWhenTabBecomesEmpty(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	updated := ApplyClosePane(model)
	if updated.Focus.PaneIdx != -1 {
		t.Fatalf("focus should collapse to -1 when tab empty, got %d", updated.Focus.PaneIdx)
	}
}

func TestApplyClosePaneIsNoopWhenNoFocus(t *testing.T) {
	model := NewLoopModel()
	model.Focus = FocusPath{WorkspaceIdx: -1, TabIdx: -1, PaneIdx: -1}
	updated := ApplyClosePane(model)
	if updated.Focus != model.Focus {
		t.Fatalf("no-focus close should not mutate")
	}
}

func TestApplyNewPaneAppendsAndFocuses(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	seed := NewPaneSeed{
		PaneID:      "pane-new",
		SessionID:   "session-new",
		Agent:       "bbl",
		Cwd:         "/tmp",
		Label:       "new",
		WorkspaceID: model.Workspaces[0].ID,
		TabID:       model.Workspaces[0].Tabs[0].ID,
	}
	updated, err := ApplyNewPane(model, seed)
	if err != nil {
		t.Fatalf("ApplyNewPane: %v", err)
	}
	tab := updated.Workspaces[0].Tabs[0]
	if len(tab.Panes) != 2 {
		t.Fatalf("expected 2 panes after add, got %d", len(tab.Panes))
	}
	if tab.Panes[1].PaneID != "pane-new" {
		t.Fatalf("new pane should be appended at index 1, got %+v", tab.Panes[1])
	}
	if updated.Focus.PaneIdx != 1 {
		t.Fatalf("focus should jump to new pane, got %d", updated.Focus.PaneIdx)
	}
}

func TestApplyNewPaneRejectsMissingMetadata(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	if _, err := ApplyNewPane(model, NewPaneSeed{SessionID: "session-1"}); err == nil {
		t.Fatalf("missing PaneID should error")
	}
	if _, err := ApplyNewPane(model, NewPaneSeed{PaneID: "pane-x"}); err == nil {
		t.Fatalf("missing SessionID should error")
	}
}

func TestApplyNewPaneSeedsFirstWorkspaceAndTab(t *testing.T) {
	model := NewLoopModel()
	model.Focus = FocusPath{WorkspaceIdx: -1, TabIdx: -1, PaneIdx: -1}
	seed := NewPaneSeed{
		PaneID:      "pane-1",
		SessionID:   "session-1",
		WorkspaceID: "ws-1",
		TabID:       "ws-1:1",
	}
	updated, err := ApplyNewPane(model, seed)
	if err != nil {
		t.Fatalf("ApplyNewPane: %v", err)
	}
	if updated.Focus.WorkspaceIdx != 0 || updated.Focus.TabIdx != 0 || updated.Focus.PaneIdx != 0 {
		t.Fatalf("first workspace/tab/pane should be focused, got %+v", updated.Focus)
	}
	if updated.Workspaces[0].ID != "ws-1" {
		t.Fatalf("first workspace id = %q, want ws-1", updated.Workspaces[0].ID)
	}
}

func TestApplyMoveFocusLeftRight(t *testing.T) {
	model := seedPaneModel(80, 24, 3)
	model.Focus.PaneIdx = 1
	left := ApplyMoveFocus(model, -1)
	if left.Focus.PaneIdx != 0 {
		t.Fatalf("left move from index 1 should land at 0, got %d", left.Focus.PaneIdx)
	}
	right := ApplyMoveFocus(model, +1)
	if right.Focus.PaneIdx != 2 {
		t.Fatalf("right move from index 1 should land at 2, got %d", right.Focus.PaneIdx)
	}
}

func TestApplyMoveFocusAtEdgeIsNoop(t *testing.T) {
	model := seedPaneModel(80, 24, 3)
	model.Focus.PaneIdx = 0
	if updated := ApplyMoveFocus(model, -1); updated.Focus.PaneIdx != 0 {
		t.Fatalf("left edge should noop, got %d", updated.Focus.PaneIdx)
	}
	model.Focus.PaneIdx = 2
	if updated := ApplyMoveFocus(model, +1); updated.Focus.PaneIdx != 2 {
		t.Fatalf("right edge should noop, got %d", updated.Focus.PaneIdx)
	}
}

func TestApplyNextPrevTabWraps(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	ws := model.Workspaces[0]
	ws = ws.AddTab("logs")
	ws = ws.AddTab("settings")
	model.Workspaces[0] = ws
	model.Focus.TabIdx = 0
	// 3 tabs; next moves 0->1, 1->2, 2->0 (wrap)
	next := ApplyNextTab(model)
	if next.Focus.TabIdx != 1 {
		t.Fatalf("next from 0 should be 1, got %d", next.Focus.TabIdx)
	}
	next = ApplyNextTab(next)
	if next.Focus.TabIdx != 2 {
		t.Fatalf("next from 1 should be 2, got %d", next.Focus.TabIdx)
	}
	next = ApplyNextTab(next)
	if next.Focus.TabIdx != 0 {
		t.Fatalf("next from 2 should wrap to 0, got %d", next.Focus.TabIdx)
	}
	prev := ApplyPrevTab(model)
	if prev.Focus.TabIdx != 2 {
		t.Fatalf("prev from 0 should wrap to 2, got %d", prev.Focus.TabIdx)
	}
}

func TestApplyNextTabOnSingleTabNoops(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	if updated := ApplyNextTab(model); updated.Focus != model.Focus {
		t.Fatalf("single tab should noop")
	}
}
