// internal/loop/router_test.go
//
// Phase 3 router tests. The router is pure (no Bubble Tea
// dependency) so every dispatch path is unit-testable from a
// fixture LoopModel.

package loop

import "testing"

func TestRouterResizePropagatesToRoute(t *testing.T) {
	r := NewRouter()
	model := NewLoopModel()
	route, next := r.Dispatch(RawEvent{Kind: "resize", Width: 200, Height: 50}, model)
	if route.Action != RouteResize {
		t.Fatalf("expected RouteResize, got %v", route.Action)
	}
	if route.Payload.Width != 200 || route.Payload.Height != 50 {
		t.Fatalf("expected resize payload to pass through, got %+v", route.Payload)
	}
	if next.Workspaces != nil && len(next.Workspaces) != len(model.Workspaces) {
		t.Fatalf("resize should not mutate model")
	}
}

func TestRouterRoutesGlobalCommands(t *testing.T) {
	r := NewRouter()
	model := NewLoopModel()

	cases := []struct {
		key  string
		want RouteAction
	}{
		{"ctrl+n", RouteNewPane},
		{"ctrl+w", RouteClosePane},
		{"ctrl+t", RouteNewWorkspace},
		{"ctrl+shift+t", RouteCloseWorkspace},
		{"ctrl+pgdn", RouteNextTab},
		{"ctrl+pgup", RoutePrevTab},
	}
	for _, c := range cases {
		route, _ := r.Dispatch(RawEvent{Kind: "key", Key: c.key}, model)
		if route.Action != c.want {
			t.Errorf("key %q: got action %v, want %v", c.key, route.Action, c.want)
		}
	}
}

func TestRouterRoutesFocusMovement(t *testing.T) {
	r := NewRouter()
	model := NewLoopModel()
	cases := []struct {
		key       string
		direction int
	}{
		{"ctrl+h", -1},
		{"ctrl+left", -1},
		{"ctrl+l", +1},
		{"ctrl+right", +1},
		{"ctrl+k", -2},
		{"ctrl+j", +2},
	}
	for _, c := range cases {
		route, _ := r.Dispatch(RawEvent{Kind: "key", Key: c.key}, model)
		if route.Action != RouteMoveFocus {
			t.Errorf("key %q: got %v, want RouteMoveFocus", c.key, route.Action)
		}
		if route.Direction != c.direction {
			t.Errorf("key %q: got direction %d, want %d", c.key, route.Direction, c.direction)
		}
	}
}

func TestRouterForwardsPrintableKeysToFocus(t *testing.T) {
	r := NewRouter()
	model := NewLoopModel()
	cases := []string{"a", "Z", "1", "/", ".", "?", "tab"}
	for _, key := range cases {
		route, _ := r.Dispatch(RawEvent{Kind: "key", Key: key}, model)
		if route.Action != RouteFocusPane {
			t.Errorf("key %q: got %v, want RouteFocusPane", key, route.Action)
		}
	}
}

func TestRouterUnrecognisedKeyNoops(t *testing.T) {
	r := NewRouter()
	model := NewLoopModel()
	cases := []string{"ctrl+q", "f1", "", "ctrl+alt+del"}
	for _, key := range cases {
		route, _ := r.Dispatch(RawEvent{Kind: "key", Key: key}, model)
		if route.Action != RouteNone {
			t.Errorf("key %q: got %v, want RouteNone", key, route.Action)
		}
	}
}

func TestRouterMouseRoutesToFocus(t *testing.T) {
	r := NewRouter()
	model := NewLoopModel()
	route, _ := r.Dispatch(RawEvent{Kind: "mouse", MouseX: 10, MouseY: 5}, model)
	if route.Action != RouteFocusPane {
		t.Fatalf("mouse should route to focus pane, got %v", route.Action)
	}
	if route.Payload.MouseX != 10 || route.Payload.MouseY != 5 {
		t.Fatalf("mouse coordinates lost: %+v", route.Payload)
	}
}

func TestRouterTickIsNoop(t *testing.T) {
	r := NewRouter()
	model := NewLoopModel()
	route, _ := r.Dispatch(RawEvent{Kind: "tick"}, model)
	if route.Action != RouteNone {
		t.Fatalf("tick should not produce a route, got %v", route.Action)
	}
}

func TestRouterUnknownKindIsNoop(t *testing.T) {
	r := NewRouter()
	model := NewLoopModel()
	route, _ := r.Dispatch(RawEvent{Kind: "unsupported"}, model)
	if route.Action != RouteNone {
		t.Fatalf("unknown kind should noop, got %v", route.Action)
	}
}

func TestRouterDispatchDoesNotMutateModel(t *testing.T) {
	r := NewRouter()
	before := NewLoopModel()
	after := before
	// Trigger every action and ensure model isn't mutated by
	// the pure router call.
	for _, key := range []string{"ctrl+n", "ctrl+w", "ctrl+h", "tab", "x"} {
		_, returned := r.Dispatch(RawEvent{Kind: "key", Key: key}, after)
		if returned.Workspaces != nil && len(returned.Workspaces) != len(before.Workspaces) {
			t.Errorf("router mutated Workspaces on key %q", key)
		}
	}
}
