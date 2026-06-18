// internal/loop/pane_list_test.go
//
// Phase 3e pane list overlay tests.

package loop

import (
	"strings"
	"testing"
)

func TestBuildPaneListLinesEmptyModel(t *testing.T) {
	model := NewLoopModel()
	lines := BuildPaneListLines(model)
	// NewLoopModel seeds a default workspace + tab but no panes;
	// expect one workspace header + one tab header and nothing else.
	if len(lines) != 2 {
		t.Fatalf("empty model should produce ws+tab headers, got %d lines: %+v", len(lines), lines)
	}
	if !anyLineContains(lines, "ws ws-default") {
		t.Fatalf("missing workspace header in %+v", lines)
	}
}

func TestBuildPaneListLinesMarksFocusedPane(t *testing.T) {
	model := seedPaneModel(80, 24, 2)
	model.Focus.PaneIdx = 1
	lines := BuildPaneListLines(model)
	count := 0
	for _, line := range lines {
		if strings.Contains(line, "> pane pane-b") {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one focused pane line, got %d in %+v", count, lines)
	}
}

func TestBuildPaneListLinesIncludesAllPanes(t *testing.T) {
	model := seedPaneModel(80, 24, 3)
	lines := BuildPaneListLines(model)
	// 1 workspace + 1 tab + 3 panes
	if len(lines) != 5 {
		t.Fatalf("expected 5 lines, got %d: %+v", len(lines), lines)
	}
	for _, id := range []string{"pane-a", "pane-b", "pane-c"} {
		if !anyLineContains(lines, "pane "+id) {
			t.Fatalf("missing pane %s in %+v", id, lines)
		}
	}
}

func TestBuildPaneListLinesIncludesStatusIndicator(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	tab := model.Workspaces[0].Tabs[0]
	updated, err := tab.AddPane(PaneModel{
		PaneID:      "pane-status",
		WorkspaceID: model.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   "session-status",
		Status:      StatusDrift,
	})
	if err != nil {
		t.Fatalf("AddPane: %v", err)
	}
	model.Workspaces[0].Tabs[0] = updated
	lines := BuildPaneListLines(model)
	found := false
	for _, line := range lines {
		if strings.Contains(line, "pane-status") {
			found = true
			if !strings.Contains(line, "drift") {
				t.Fatalf("pane-status line should show drift status: %q", line)
			}
		}
	}
	if !found {
		t.Fatalf("pane-status missing from %+v", lines)
	}
}

func TestBuildPaneListLinesWalksMultipleWorkspaces(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	// Append a second workspace by hand: in real driver this goes
	// through ApplyNewWorkspace (Phase 3d did not add that yet).
	ws := NewWorkspace("ws-extra", "ops")
	ws.Tabs[0] = Tab{ID: ws.ID + ":1", Label: "logs", Panes: []PaneModel{
		{PaneID: "pane-x", WorkspaceID: ws.ID, TabID: ws.ID + ":1", SessionID: "session-x", Status: StatusBlocked},
	}}
	model.Workspaces = append(model.Workspaces, ws)
	lines := BuildPaneListLines(model)
	if !anyLineContains(lines, "ws "+model.Workspaces[0].ID) {
		t.Fatalf("missing first workspace header: %+v", lines)
	}
	if !anyLineContains(lines, "ws "+ws.ID) {
		t.Fatalf("missing second workspace header: %+v", lines)
	}
	if !anyLineContains(lines, "pane-x") {
		t.Fatalf("missing nested pane-x: %+v", lines)
	}
}

func TestSummarizePaneListCountsByStatus(t *testing.T) {
	model := seedPaneModel(80, 24, 0)
	tab := model.Workspaces[0].Tabs[0]
	for _, s := range []PaneStatus{StatusWorking, StatusBlocked, StatusDrift, StatusDrift, StatusDone} {
		updated, err := tab.AddPane(PaneModel{
			PaneID:      "pane-" + s.String(),
			WorkspaceID: model.Workspaces[0].ID,
			TabID:       tab.ID,
			SessionID:   "session-" + s.String(),
			Status:      s,
		})
		if err != nil {
			t.Fatalf("AddPane: %v", err)
		}
		tab = updated
	}
	model.Workspaces[0].Tabs[0] = tab
	summary := SummarizePaneList(model)
	if summary.TotalPanes != 5 {
		t.Fatalf("expected 5 panes, got %d", summary.TotalPanes)
	}
	if summary.ByStatus[StatusWorking] != 1 || summary.ByStatus[StatusBlocked] != 1 {
		t.Fatalf("working/blocked counts wrong: %+v", summary.ByStatus)
	}
	if summary.ByStatus[StatusDrift] != 2 {
		t.Fatalf("drift count = %d, want 2", summary.ByStatus[StatusDrift])
	}
	if !summary.HasDrift || summary.PendingBoundary != 2 {
		t.Fatalf("drift flag / pending boundary wrong: has=%v pending=%d", summary.HasDrift, summary.PendingBoundary)
	}
}

func TestSummarizePaneListEmptyModel(t *testing.T) {
	model := NewLoopModel()
	summary := SummarizePaneList(model)
	if summary.TotalPanes != 0 || summary.HasDrift {
		t.Fatalf("empty model should have no panes / no drift, got %+v", summary)
	}
}

func anyLineContains(lines []string, needle string) bool {
	for _, line := range lines {
		if strings.Contains(line, needle) {
			return true
		}
	}
	return false
}
