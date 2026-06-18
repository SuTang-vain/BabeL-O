// internal/loop/layout_test.go
//
// Phase 3b layout tests: pure-data geometry + neighbor lookup.

package loop

import "testing"

func seedPaneModel(width, height, paneCount int) LoopModel {
	model := NewLoopModel()
	model.Width = width
	model.Height = height
	tab := model.Workspaces[0].Tabs[0]
	for i := 0; i < paneCount; i++ {
		updated, err := tab.AddPane(PaneModel{
			PaneID:      paneID(i),
			WorkspaceID: model.Workspaces[0].ID,
			TabID:       tab.ID,
			SessionID:   paneID(i) + "-session",
			Cwd:         "/tmp",
		})
		if err != nil {
			panic(err)
		}
		tab = updated
	}
	model.Workspaces[0].Tabs[0] = tab
	return model
}

func paneID(i int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz"
	if i >= len(alphabet) {
		return "pane-" + string(rune('0'+i))
	}
	return "pane-" + string(alphabet[i])
}

func TestComputeLayoutEmptyTabReturnsEmptyPanes(t *testing.T) {
	model := NewLoopModel()
	model.Width = 100
	model.Height = 50
	layout := ComputeLayout(model)
	if len(layout.Panes) != 0 {
		t.Fatalf("empty tab should produce no geometries, got %+v", layout.Panes)
	}
}

func TestComputeLayoutZeroWindowReturnsEmpty(t *testing.T) {
	model := NewLoopModel()
	layout := ComputeLayout(model)
	if len(layout.Panes) != 0 {
		t.Fatalf("zero window should produce no geometries, got %+v", layout.Panes)
	}
}

func TestComputeLayoutSinglePaneFillsWindow(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	layout := ComputeLayout(model)
	if len(layout.Panes) != 1 {
		t.Fatalf("expected 1 geometry, got %d", len(layout.Panes))
	}
	if layout.Panes[0].X != 0 || layout.Panes[0].Y != 0 {
		t.Fatalf("pane should start at origin, got %+v", layout.Panes[0])
	}
	if layout.Panes[0].Width != 80 || layout.Panes[0].Height != 24 {
		t.Fatalf("pane should fill window, got %+v", layout.Panes[0])
	}
}

func TestComputeLayoutEvenSplit(t *testing.T) {
	model := seedPaneModel(80, 24, 4)
	layout := ComputeLayout(model)
	if len(layout.Panes) != 4 {
		t.Fatalf("expected 4 geometries, got %d", len(layout.Panes))
	}
	for i, g := range layout.Panes {
		if g.Width != 20 {
			t.Fatalf("pane[%d] width = %d, want 20", i, g.Width)
		}
		if g.X != i*20 {
			t.Fatalf("pane[%d] x = %d, want %d", i, g.X, i*20)
		}
		if g.Height != 24 || g.Y != 0 {
			t.Fatalf("pane[%d] height/y = %d/%d, want 24/0", i, g.Height, g.Y)
		}
	}
}

func TestComputeLayoutUnevenSplitDistributesRemainder(t *testing.T) {
	model := seedPaneModel(81, 20, 4)
	layout := ComputeLayout(model)
	if len(layout.Panes) != 4 {
		t.Fatalf("expected 4 geometries, got %d", len(layout.Panes))
	}
	widths := []int{g(layout.Panes[0].Width), g(layout.Panes[1].Width), g(layout.Panes[2].Width), g(layout.Panes[3].Width)}
	xs := []int{g(layout.Panes[0].X), g(layout.Panes[1].X), g(layout.Panes[2].X), g(layout.Panes[3].X)}
	// 81 / 4 = 20 remainder 1; the first pane gets the extra column.
	wantWidths := []int{21, 20, 20, 20}
	wantXs := []int{0, 21, 41, 61}
	for i := range widths {
		if widths[i] != wantWidths[i] {
			t.Errorf("pane[%d] width = %d, want %d", i, widths[i], wantWidths[i])
		}
		if xs[i] != wantXs[i] {
			t.Errorf("pane[%d] x = %d, want %d", i, xs[i], wantXs[i])
		}
	}
}

func g(v int) int { return v }

func TestNeighborPaneLeftRight(t *testing.T) {
	model := seedPaneModel(80, 24, 3)
	model.Focus.PaneIdx = 1
	left, ok := NeighborPane(model, -1)
	if !ok || left != "pane-a" {
		t.Fatalf("left neighbor = %q, want pane-a", left)
	}
	right, ok := NeighborPane(model, +1)
	if !ok || right != "pane-c" {
		t.Fatalf("right neighbor = %q, want pane-c", right)
	}
}

func TestNeighborPaneAtEdgesReturnsFalse(t *testing.T) {
	model := seedPaneModel(80, 24, 3)
	model.Focus.PaneIdx = 0
	if _, ok := NeighborPane(model, -1); ok {
		t.Fatalf("left of first pane should not have a neighbour")
	}
	model.Focus.PaneIdx = 2
	if _, ok := NeighborPane(model, +1); ok {
		t.Fatalf("right of last pane should not have a neighbour")
	}
}

func TestNeighborPaneSinglePaneReturnsFalse(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	if _, ok := NeighborPane(model, -1); ok {
		t.Fatalf("single-pane tab should not have left neighbour")
	}
	if _, ok := NeighborPane(model, +1); ok {
		t.Fatalf("single-pane tab should not have right neighbour")
	}
}

func TestNeighborPaneUpDownReturnsFalseForFlatTabs(t *testing.T) {
	model := seedPaneModel(80, 24, 3)
	if _, ok := NeighborPane(model, -2); ok {
		t.Fatalf("up should not have neighbour in flat tab")
	}
	if _, ok := NeighborPane(model, +2); ok {
		t.Fatalf("down should not have neighbour in flat tab")
	}
}
