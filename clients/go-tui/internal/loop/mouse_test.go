// internal/loop/mouse_test.go
//
// Phase 3c MouseEventFilter adapter tests.

package loop

import "testing"

func TestResolveMouseTargetRoutesToContainingPane(t *testing.T) {
	model := seedPaneModel(80, 24, 3)
	target, ok := ResolveMouseTarget(model, RawEvent{Kind: "mouse", MouseX: 5, MouseY: 10})
	if !ok {
		t.Fatalf("mouse inside left pane should resolve")
	}
	if target != "pane-a" {
		t.Fatalf("left-pane click = %q, want pane-a", target)
	}
}

func TestResolveMouseTargetRoutesToRightPane(t *testing.T) {
	model := seedPaneModel(80, 24, 3)
	target, ok := ResolveMouseTarget(model, RawEvent{Kind: "mouse", MouseX: 60, MouseY: 10})
	if !ok {
		t.Fatalf("mouse inside right pane should resolve")
	}
	if target != "pane-c" {
		t.Fatalf("right-pane click = %q, want pane-c", target)
	}
}

func TestResolveMouseTargetFallsBackOnBorder(t *testing.T) {
	model := seedPaneModel(80, 24, 3)
	model.Focus.PaneIdx = 1
	// x=27 sits exactly on the border between pane-a and pane-b
	// under even split. Either neighbour could claim it; the
	// filter should fall back to the focused pane instead.
	target, ok := ResolveMouseTarget(model, RawEvent{Kind: "mouse", MouseX: 27, MouseY: 10})
	if !ok {
		t.Fatalf("border click should fall back, not noop")
	}
	if target != "pane-b" {
		t.Fatalf("border click = %q, want focused pane-b", target)
	}
}

func TestResolveMouseTargetFallsBackOutsideAnyPane(t *testing.T) {
	model := seedPaneModel(80, 24, 3)
	model.Focus.PaneIdx = 0
	target, ok := ResolveMouseTarget(model, RawEvent{Kind: "mouse", MouseX: -5, MouseY: -5})
	if !ok {
		t.Fatalf("outside click should fall back to focused pane")
	}
	if target != "pane-a" {
		t.Fatalf("outside click = %q, want focused pane-a", target)
	}
}

func TestResolveMouseTargetRejectsNonMouseEvents(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	if _, ok := ResolveMouseTarget(model, RawEvent{Kind: "key", Key: "tab"}); ok {
		t.Fatalf("non-mouse event should return ok=false")
	}
}

func TestResolveMouseTargetEmptyModelReturnsFalse(t *testing.T) {
	model := NewLoopModel()
	model.Width = 80
	model.Height = 24
	if _, ok := ResolveMouseTarget(model, RawEvent{Kind: "mouse", MouseX: 10, MouseY: 5}); ok {
		t.Fatalf("empty model should return ok=false")
	}
}

func TestResolveMouseTargetFocusedPaneWithoutGeometry(t *testing.T) {
	model := seedPaneModel(80, 24, 0)
	if _, ok := ResolveMouseTarget(model, RawEvent{Kind: "mouse", MouseX: 10, MouseY: 5}); ok {
		t.Fatalf("no panes should return ok=false")
	}
}
