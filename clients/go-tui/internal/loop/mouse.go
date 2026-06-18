// internal/loop/mouse.go
//
// Phase 3c: MouseEventFilter adapter. Given a LoopModel and a
// RawEvent carrying mouse coordinates, resolve which pane the
// event targets. Falls back to the focused pane when the
// coordinates sit on a pane border (where two panes meet) or
// outside any pane (resize gutter, header). Mirrors herdr's
// `MouseEventFilter` behavior in spirit.

package loop

// ResolveMouseTarget returns the PaneID that should receive a
// mouse event. When `event.Kind != "mouse"` the function
// returns ok=false so the router can keep its noop path.
//
// Coordinates are pane-relative after the Bubble Tea adapter
// resolves them against the current window; this function
// assumes the model.Width / model.Height already reflect the
// rendering surface.
func ResolveMouseTarget(model LoopModel, event RawEvent) (string, bool) {
	if event.Kind != "mouse" {
		return "", false
	}
	layout := ComputeLayout(model)
	if len(layout.Panes) == 0 {
		return "", false
	}
	for _, g := range layout.Panes {
		if pointInPane(event.MouseX, event.MouseY, g) {
			return g.PaneID, true
		}
	}
	// Fallback: focused pane (covers borders + outside).
	focused, ok := model.FocusedPane()
	if !ok {
		return "", false
	}
	return focused.PaneID, true
}

// pointInPane reports whether (x, y) sits inside pane g. The
// half-open interval [X, X+Width) x [Y, Y+Height) keeps
// borders assigned to the right / bottom neighbour; Phase 3c
// falls back to focused pane on borders instead of double
// dispatching, so the half-open vs closed distinction is
// unimportant in practice.
func pointInPane(x, y int, g PaneGeometry) bool {
	if x < g.X || x >= g.X+g.Width {
		return false
	}
	if y < g.Y || y >= g.Y+g.Height {
		return false
	}
	return true
}
