// internal/loop/router.go
//
// Phase 3: pure-data router for the multi-pane driver. The
// router takes a `RawEvent` (an opaque payload produced by the
// Bubble Tea adapter) plus the current LoopModel and returns a
// `Route` describing what the runtime should do: forward to the
// focused pane, mutate focus, close a pane, or noop. No
// Bubble Tea imports yet so the logic stays unit-testable.

package loop

// RawEvent is the minimal projection of an input / lifecycle
// event that the router understands. The Bubble Tea adapter
// (Phase 3b) translates tea.KeyMsg / tea.WindowSizeMsg /
// tea.MouseMsg into this shape; tests can drive the router
// directly without touching Bubble Tea.
type RawEvent struct {
	// Kind is one of: "key", "resize", "mouse", "tick".
	Kind string

	// Key is the canonical key name when Kind == "key". The
	// adapter normalises tea.KeyMsg into one of: "ctrl+n",
	// "ctrl+w", "ctrl+h", "ctrl+l", "ctrl+k", "ctrl+j",
	// "ctrl+t", "tab", "enter", "esc", "backspace", or
	// the printable rune itself. Lowercase ASCII.
	Key string

	// Width / Height accompany Kind == "resize".
	Width  int
	Height int

	// MouseX / MouseY are pane-relative coordinates when
	// Kind == "mouse". The adapter is responsible for
	// resolving global coordinates into the focused pane.
	MouseX int
	MouseY int

	// Rune is the printable character when Kind == "key"
	// and Key is a single rune.
	Rune rune
}

// RouteAction enumerates what the runtime should do after
// receiving a RawEvent. The runtime dispatches accordingly.
type RouteAction int

const (
	// RouteNone is the no-op default; the adapter drops the
	// event without forwarding it.
	RouteNone RouteAction = iota

	// RouteFocusPane forwards the event to the focused pane's
	// own input handler.
	RouteFocusPane

	// RouteClosePane asks the runtime to remove the focused
	// pane from the LoopModel. The adapter is expected to
	// delete the pane from loop_state as well.
	RouteClosePane

	// RouteNewPane asks the runtime to spawn a fresh pane.
	// The adapter is expected to allocate a sessionId.
	RouteNewPane

	// RouteMoveFocus shifts focus to an adjacent pane or tab.
	// Direction is encoded in Route.Direction (-1 left/up,
	// +1 right/down, 0 same).
	RouteMoveFocus

	// RouteNextTab / RoutePrevTab cycle tabs within the
	// current workspace.
	RouteNextTab
	RoutePrevTab

	// RouteNewWorkspace / RouteCloseWorkspace manage
	// workspaces at the top level.
	RouteNewWorkspace
	RouteCloseWorkspace

	// RouteResize propagates the new dimensions into every
	// pane's viewport.
	RouteResize
)

// Route is the router's verdict. `Action` is what to do;
// `Direction` only matters for RouteMoveFocus; `Payload` is
// passed through to the receiving pane verbatim.
type Route struct {
	Action    RouteAction
	Direction int
	Payload   RawEvent
}

// Router is the dispatcher. It does NOT mutate LoopModel
// directly; instead it returns a Route plus, when the action
// requires a model mutation (close / move / new), the new
// LoopModel value. The runtime applies the new value and
// re-renders. This keeps the router pure and testable.
type Router struct{}

// NewRouter returns a router with default key bindings.
func NewRouter() *Router { return &Router{} }

// Dispatch classifies `event` against `model` and returns the
// Route plus, when applicable, the updated LoopModel. The
// second return value is `model` unchanged when no mutation is
// needed.
func (r *Router) Dispatch(event RawEvent, model LoopModel) (Route, LoopModel) {
	switch event.Kind {
	case "resize":
		return Route{Action: RouteResize, Payload: event}, model

	case "key":
		return r.dispatchKey(event, model)

	case "mouse":
		// Mouse events always go to the focused pane until
		// Phase 3b grows a pane-targeted click handler.
		return Route{Action: RouteFocusPane, Payload: event}, model

	case "tick":
		// Background ticks (heartbeat / health poll) are
		// consumed by the runtime, not the pane.
		return Route{Action: RouteNone}, model

	default:
		return Route{Action: RouteNone}, model
	}
}

func (r *Router) dispatchKey(event RawEvent, model LoopModel) (Route, LoopModel) {
	switch event.Key {
	case "ctrl+n":
		return Route{Action: RouteNewPane, Payload: event}, model
	case "ctrl+w":
		return Route{Action: RouteClosePane, Payload: event}, model
	case "ctrl+t":
		return Route{Action: RouteNewWorkspace, Payload: event}, model
	case "ctrl+shift+t":
		return Route{Action: RouteCloseWorkspace, Payload: event}, model
	case "ctrl+pgdn":
		return Route{Action: RouteNextTab, Payload: event}, model
	case "ctrl+pgup":
		return Route{Action: RoutePrevTab, Payload: event}, model
	case "ctrl+h", "ctrl+left":
		return Route{Action: RouteMoveFocus, Direction: -1, Payload: event}, model
	case "ctrl+l", "ctrl+right":
		return Route{Action: RouteMoveFocus, Direction: +1, Payload: event}, model
	case "ctrl+k", "ctrl+up":
		return Route{Action: RouteMoveFocus, Direction: -2, Payload: event}, model
	case "ctrl+j", "ctrl+down":
		return Route{Action: RouteMoveFocus, Direction: +2, Payload: event}, model
	case "tab":
		return Route{Action: RouteFocusPane, Payload: event}, model
	default:
		if isPrintableKey(event.Key) {
			return Route{Action: RouteFocusPane, Payload: event}, model
		}
		return Route{Action: RouteNone}, model
	}
}

func isPrintableKey(key string) bool {
	if len(key) == 0 {
		return false
	}
	if len(key) > 1 {
		return false
	}
	return key[0] >= 0x20 && key[0] != 0x7f
}
