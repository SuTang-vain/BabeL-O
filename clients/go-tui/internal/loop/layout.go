// internal/loop/layout.go
//
// Phase 3b: layout geometry for the multi-pane driver. Pure
// data — given a LoopModel and a window size, `Layout` returns
// one `PaneGeometry` per pane in the focused tab. The Bubble
// Tea adapter (Phase 3c) translates these into viewports.
// Neighbor lookup supports the router's `RouteMoveFocus`
// (Ctrl+H/L/J/K → adjacent pane).

package loop

// PaneGeometry describes where one pane should render.
type PaneGeometry struct {
	PaneID string
	X      int
	Y      int
	Width  int
	Height int
}

// Layout holds the per-window computed geometry.
type Layout struct {
	Width  int
	Height int
	Panes  []PaneGeometry
}

// ComputeLayout returns the layout for `model`'s focused tab.
// All panes in the tab split the window horizontally with
// equal widths. The focused pane keeps the extra column when
// the width doesn't divide evenly.
//
// Future Phase 3b' may add explicit split orientation per
// pane (e.g. Tab.SplitHorizontal vs SplitVertical) and nested
// groups. The current implementation deliberately stays flat
// until the model layer grows the matching representation.
func ComputeLayout(model LoopModel) Layout {
	out := Layout{Width: model.Width, Height: model.Height}
	if model.Width <= 0 || model.Height <= 0 {
		return out
	}
	tab, ok := focusedTab(model)
	if !ok || len(tab.Panes) == 0 {
		return out
	}
	paneCount := len(tab.Panes)
	baseWidth := model.Width / paneCount
	remainder := model.Width % paneCount
	for i, pane := range tab.Panes {
		w := baseWidth
		if i < remainder {
			w++
		}
		out.Panes = append(out.Panes, PaneGeometry{
			PaneID: pane.PaneID,
			X:      i * baseWidth + min(i, remainder),
			Y:      0,
			Width:  w,
			Height: model.Height,
		})
	}
	return out
}

func focusedTab(model LoopModel) (Tab, bool) {
	if model.Focus.WorkspaceIdx < 0 || model.Focus.WorkspaceIdx >= len(model.Workspaces) {
		return Tab{}, false
	}
	ws := model.Workspaces[model.Focus.WorkspaceIdx]
	if model.Focus.TabIdx < 0 || model.Focus.TabIdx >= len(ws.Tabs) {
		return Tab{}, false
	}
	return ws.Tabs[model.Focus.TabIdx], true
}

// NeighborPane returns the pane id that should receive focus
// when the user requests a focus shift in `direction`. The
// convention matches the router:
//   -1  left  (Ctrl+H / Ctrl+Left)
//   +1  right (Ctrl+L / Ctrl+Right)
//   -2  up    (Ctrl+K / Ctrl+Up) — flat for now
//   +2  down  (Ctrl+J / Ctrl+Down) — flat for now
//
// When the move would leave the tab or the model has fewer
// than two panes, the function returns ok=false and the router
// falls back to noop.
func NeighborPane(model LoopModel, direction int) (string, bool) {
	tab, ok := focusedTab(model)
	if !ok || len(tab.Panes) < 2 {
		return "", false
	}
	switch direction {
	case -1:
		next := model.Focus.PaneIdx - 1
		if next < 0 {
			return "", false
		}
		return tab.Panes[next].PaneID, true
	case +1:
		next := model.Focus.PaneIdx + 1
		if next >= len(tab.Panes) {
			return "", false
		}
		return tab.Panes[next].PaneID, true
	default:
		// Up/down against a flat tab layout has no neighbour
		// until Phase 3b' introduces nested splits.
		return "", false
	}
}
