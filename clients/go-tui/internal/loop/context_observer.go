// internal/loop/context_observer.go
//
// R6 (long-running-context-assembly §20 Phase R6):
// loop-level observer that wraps `api.Client.ObserveContext`
// with reconnect + backoff and the tea.Cmd / msg plumbing
// the InteractiveModel can drop into its Update switch.
// Mirrors `ws_observer.go` (the working-set-side observer)
// so a future reader can find the analogue quickly: the
// per-CWD working-set observer keeps its own channels +
// cancel funcs; the per-CWD assembled-context observer
// here keeps its own too.
//
// Why this file is separate from `ws_observer.go`:
//
//   - `ws_observer.go` is the working-set observer
//     (one socket per program, per cwd, snapshot-on-connect
//     drives the working-set state). It is wired into the
//     reconciler so a reconnect can repair drift via
//     RunOnce.
//   - The context observer is per-CWD-and-session: it
//     consumes the redacted assembled context payload and
//     drives the "context: not observed" / "context: N
//     blocks (M cacheable)" state-line indicator. There is
//     no reconciler equivalent for context (the runtime is
//     the source of truth and reconnect simply asks for a
//     fresh `assembled_snapshot`).
//
// Constraints honored (R6 spec, plus R4 default-on
// redaction):
//
//   - Default-on: Init starts the observer when a
//     non-empty cwd is known. No CLI flag.
//   - Auto-reconnect with bounded backoff: 2s → 5s → 15s
//     cap. Reset to 2s on successful connect.
//   - First connect uses the server-emitted
//     `assembled_snapshot` to populate state — no other
//     RPC needed.
//   - Reconnect simply re-dials; the new
//     `assembled_snapshot` repopulates state.
//   - Silent failure on server-not-supporting-WS or no
//     `/v1/context/observe` route: a dial error is
//     surfaced via the errs path and re-scheduled with
//     backoff, never as a toast / log spam.
//   - Loop renderer never mutates context truth — the
//     model only stores what the observer reports.
//
// State-machine guarantees (R6 acceptance):
//
//   - When no observer event has ever arrived, the model's
//     ContextObservation status is "not-observed".
//   - On first `assembled_snapshot` (even with `context:
//     null`), status flips to "connected"; only the
//     redaction summary populated by the SERVER is
//     surfaced — never derived locally.
//   - On read error / clean close, status flips to
//     "disconnected" and a backoff reconnect is scheduled.
//   - On reconnect success the new snapshot replaces the
//     old state and status returns to "connected".
//   - If the server emits `redaction: "full"` (debug),
//     the renderer ignores `systemPrompt` / `messages`
//     and falls back to "context: full mode (debug)".

package loop

import (
	"context"
	"fmt"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// ContextObserverStatus is the observer's connection /
// awareness state, surfaced to the model + the chrome
// renderer. The model never derives this from anything
// other than observer messages — that is the R6 contract.
type ContextObserverStatus int

const (
	// CtxObserverNotObserved is the initial state: no
	// observer event has ever arrived. Used by the chrome
	// renderer to display "context: not observed" rather
	// than invent a summary.
	CtxObserverNotObserved ContextObserverStatus = iota
	// CtxObserverConnected is set after the first
	// snapshot or assembled frame arrives, regardless of
	// whether the snapshot's `context` field was null.
	CtxObserverConnected
	// CtxObserverDisconnected is set after a read error
	// or clean close. A backoff reconnect is in flight;
	// the renderer should display "context: reconnecting"
	// rather than reuse the stale snapshot.
	CtxObserverDisconnected
)

// String makes ContextObserverStatus human-readable for
// tests + logs.
func (s ContextObserverStatus) String() string {
	switch s {
	case CtxObserverNotObserved:
		return "not-observed"
	case CtxObserverConnected:
		return "connected"
	case CtxObserverDisconnected:
		return "disconnected"
	default:
		return "unknown"
	}
}

// ContextObservation is the per-cwd snapshot of the latest
// observer payload + status. The model holds one of these
// per active cwd. All fields are owned by the observer
// pipeline; the renderer is read-only.
type ContextObservation struct {
	Status            ContextObserverStatus
	LastFrameAt       time.Time
	LastTimestamp     string                       // server-emitted timestamp from the most recent `assembled` frame
	Redaction         string                       // "summary" | "full" | "" (no observation yet)
	Summary           *api.ContextRedactionSummary // populated when Redaction == "summary"
	Sections          []api.ContextSection         // bounded; safe to display
	SystemPromptToks  int
	MessagesToks      int
	LastError         string // most recent transient error (cleared on next success)
}

// ContextObserver is the loop-level observer. One instance
// per InteractiveModel. Owns the API client handle, the
// cwd / sessionID filter, the redaction mode, and the
// backoff cursor.
type ContextObserver struct {
	client    *api.Client
	cwd       string
	sessionID string // empty = no filter (all sessions in cwd)
	backoff   BackoffState

	connected bool
	mu        sync.Mutex
}

// NewContextObserver constructs an observer.
func NewContextObserver(client *api.Client, cwd, sessionID string) *ContextObserver {
	return &ContextObserver{
		client:    client,
		cwd:       cwd,
		sessionID: sessionID,
	}
}

// Cwd returns the cwd the observer was constructed with.
func (o *ContextObserver) Cwd() string { return o.cwd }

// SessionID returns the optional sessionID filter.
func (o *ContextObserver) SessionID() string { return o.sessionID }

// MarkConnected stamps the connected flag.
func (o *ContextObserver) MarkConnected() {
	o.mu.Lock()
	o.connected = true
	o.mu.Unlock()
}

// MarkDisconnected clears the connected flag.
func (o *ContextObserver) MarkDisconnected() {
	o.mu.Lock()
	o.connected = false
	o.mu.Unlock()
}

// IsConnected returns the current connection state.
func (o *ContextObserver) IsConnected() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.connected
}

// Start returns the first connect tea.Cmd. Called from
// InteractiveModel.Init() once the model is fully
// constructed. Returns nil when the client is nil so
// in-memory / no-Nexus mode can opt out.
func (o *ContextObserver) Start(_ context.Context) tea.Cmd {
	if o == nil || o.client == nil {
		return nil
	}
	return o.ConnectCmd()
}

// ConnectCmd dials the observer's WebSocket and posts a
// ctxObserverConnectMsg with the result. Default-on
// redaction: ContextObserveOpts.RedactionMode is left
// empty so the server stays in "summary" mode.
func (o *ContextObserver) ConnectCmd() tea.Cmd {
	if o == nil || o.client == nil {
		return nil
	}
	client := o.client
	cwd := o.cwd
	sessionID := o.sessionID
	observer := o
	return func() tea.Msg {
		ctx, cancel := context.WithCancel(context.Background())
		events, errs, closeFn, dialErr := client.ObserveContext(ctx, cwd, sessionID, api.ContextObserveOpts{})
		if dialErr != nil {
			cancel()
			_ = closeFn
			return ctxObserverConnectMsg{
				observer:  observer,
				dialErr:   dialErr,
				ctxCancel: cancel,
				connected: observer.IsConnected(),
			}
		}
		return ctxObserverConnectMsg{
			observer:  observer,
			events:    events,
			errs:      errs,
			closeFn:   closeFn,
			ctxCancel: cancel,
			connected: observer.IsConnected(),
		}
	}
}

// ReconnectCmd sleeps for `delay` and then re-dials. Used
// by the errs handler to schedule a backoff retry.
func (o *ContextObserver) ReconnectCmd(delay time.Duration) tea.Cmd {
	if o == nil || o.client == nil {
		return nil
	}
	if delay <= 0 {
		delay = o.backoff.Next()
	} else {
		// Caller supplied an explicit delay (e.g. the
		// first retry). Step the backoff cursor so
		// subsequent failures keep advancing.
		o.backoff.Next()
	}
	observer := o
	return func() tea.Msg {
		time.Sleep(delay)
		return ctxObserverReconnectMsg{observer: observer}
	}
}

// ctxObserverConnectMsg is the "dial finished" message.
// `dialErr != nil` means the connect failed; the model
// schedules a ReconnectCmd in that case. `events` + `errs`
// are nil on dial failure.
type ctxObserverConnectMsg struct {
	observer  *ContextObserver
	events    <-chan api.ContextObserverEvent
	errs      <-chan error
	closeFn   func()
	ctxCancel context.CancelFunc
	dialErr   error
	connected bool
}

// ctxObserverReconnectMsg is dispatched by ReconnectCmd
// when the backoff timer fires. The model dispatches it
// through observer.ConnectCmd() to actually re-dial.
type ctxObserverReconnectMsg struct {
	observer *ContextObserver
}

// ctxObserverEventMsg carries one server frame.
type ctxObserverEventMsg struct {
	observer *ContextObserver
	ev       api.ContextObserverEvent
}

// ctxObserverErrMsg is dispatched on read error / close.
type ctxObserverErrMsg struct {
	observer *ContextObserver
	err      error
}

// ctxObserverStreamClosedErr is the sentinel for a clean
// observer-stream close.
var ctxObserverStreamClosedErr = &ctxObserverStreamClosedError{}

type ctxObserverStreamClosedError struct{}

func (e *ctxObserverStreamClosedError) Error() string { return "ws context observer stream closed" }

// --- handle registry ---
//
// Same pattern as ws_observer.go: the drain cmd lives
// inside a closure that doesn't have access to
// *InteractiveModel, so the per-observer channels +
// close fn + ctx cancel are stashed in a package-level
// map keyed by the observer pointer.

var (
	ctxObserverHandlesMu sync.Mutex
	ctxObserverHandles   = make(map[*ContextObserver]ctxObserverHandle)
)

type ctxObserverHandle struct {
	closeFn   func()
	ctxCancel context.CancelFunc
	events    <-chan api.ContextObserverEvent
	errs      <-chan error
}

func registerCtxObserverHandles(o *ContextObserver, closeFn func(), cancel context.CancelFunc, events <-chan api.ContextObserverEvent, errs <-chan error) {
	ctxObserverHandlesMu.Lock()
	defer ctxObserverHandlesMu.Unlock()
	ctxObserverHandles[o] = ctxObserverHandle{closeFn: closeFn, ctxCancel: cancel, events: events, errs: errs}
}

func popCtxObserverHandles(o *ContextObserver) (func(), context.CancelFunc, bool) {
	ctxObserverHandlesMu.Lock()
	defer ctxObserverHandlesMu.Unlock()
	h, ok := ctxObserverHandles[o]
	if !ok {
		return nil, nil, false
	}
	delete(ctxObserverHandles, o)
	return h.closeFn, h.ctxCancel, true
}

func lookupCtxObserverChannels(o *ContextObserver) (<-chan api.ContextObserverEvent, <-chan error, bool) {
	ctxObserverHandlesMu.Lock()
	defer ctxObserverHandlesMu.Unlock()
	h, ok := ctxObserverHandles[o]
	if !ok {
		return nil, nil, false
	}
	return h.events, h.errs, true
}

// --- model handlers ---
//
// These three handlers are exported on InteractiveModel so
// the existing Update switch can dispatch them by type.
// They are intentionally small — the reasoning lives in
// the handler bodies, not in the Update switch.

// handleCtxObserverConnect processes a dial result. On
// success it stamps the channels into the registry,
// resets the backoff, and returns a drain cmd. On failure
// it schedules a backoff reconnect.
func (m *InteractiveModel) handleCtxObserverConnect(msg ctxObserverConnectMsg) tea.Cmd {
	if m == nil || msg.observer == nil {
		return nil
	}
	if msg.dialErr != nil {
		// Silent failure: no toast, no log spam.
		// Update the observation to the disconnected
		// state so the chrome can render "context:
		// reconnecting" instead of pretending nothing
		// happened.
		m.markCtxObservationDisconnected(msg.observer, msg.dialErr.Error())
		return msg.observer.ReconnectCmd(0)
	}
	observer := msg.observer
	registerCtxObserverHandles(observer, msg.closeFn, msg.ctxCancel, msg.events, msg.errs)
	if !observer.IsConnected() {
		observer.MarkConnected()
		observer.backoff.Reset()
	}
	events := msg.events
	errs := msg.errs
	return func() tea.Msg {
		select {
		case ev, ok := <-events:
			if !ok {
				return ctxObserverErrMsg{observer: observer, err: ctxObserverStreamClosedErr}
			}
			return ctxObserverEventMsg{observer: observer, ev: ev}
		case err, ok := <-errs:
			if !ok {
				return ctxObserverErrMsg{observer: observer, err: ctxObserverStreamClosedErr}
			}
			return ctxObserverErrMsg{observer: observer, err: err}
		}
	}
}

// handleCtxObserverErr processes a read error / clean
// close: clears the connected flag, schedules a backoff
// reconnect, updates the model's observation to the
// disconnected state.
func (m *InteractiveModel) handleCtxObserverErr(msg ctxObserverErrMsg) tea.Cmd {
	if m == nil || msg.observer == nil {
		return nil
	}
	observer := msg.observer
	observer.MarkDisconnected()
	if closeFn, cancel, ok := popCtxObserverHandles(observer); ok {
		if cancel != nil {
			cancel()
		}
		if closeFn != nil {
			closeFn()
		}
	}
	errMsg := ""
	if msg.err != nil {
		errMsg = msg.err.Error()
	}
	m.markCtxObservationDisconnected(observer, errMsg)
	delay := observer.backoff.Next()
	return observer.ReconnectCmd(delay)
}

// handleCtxObserverEvent processes one server frame. The
// model state mutation is wrapped in a small helper
// (`applyCtxObservationFrame`) so it can be unit-tested
// without spinning up a Bubble Tea program.
func (m *InteractiveModel) handleCtxObserverEvent(msg ctxObserverEventMsg) tea.Cmd {
	if m == nil || msg.observer == nil {
		return nil
	}
	m.applyCtxObservationFrame(msg.observer, msg.ev)
	observer := msg.observer
	return func() tea.Msg {
		events, errs, ok := lookupCtxObserverChannels(observer)
		if !ok {
			return ctxObserverErrMsg{observer: observer, err: ctxObserverStreamClosedErr}
		}
		select {
		case ev, ok := <-events:
			if !ok {
				return ctxObserverErrMsg{observer: observer, err: ctxObserverStreamClosedErr}
			}
			return ctxObserverEventMsg{observer: observer, ev: ev}
		case err, ok := <-errs:
			if !ok {
				return ctxObserverErrMsg{observer: observer, err: ctxObserverStreamClosedErr}
			}
			return ctxObserverErrMsg{observer: observer, err: err}
		}
	}
}

// --- model state helpers (R6 acceptance) ---
//
// These four helpers are the entire surface the model uses
// to interact with ContextObservation state. The renderer
// only ever calls GetCtxObservation; mutation is
// observer-driven exclusively.

// observationKey is the per-cwd-and-session key used to
// index ContextObservation entries. Empty sessionID means
// "all sessions for this cwd" — a single key per cwd.
func observationKey(cwd, sessionID string) string {
	return cwd + "|" + sessionID
}

// applyCtxObservationFrame is the only place where the
// renderer-visible context observation state is mutated.
// All four frame types (snapshot / assembled / error /
// unknown) flow through here so the renderer's state
// transitions are 100 % observer-driven (R6 acceptance).
//
// The function is intentionally a method on
// *InteractiveModel rather than a pure helper because the
// observation map is per-model. Tests can construct a
// minimal *InteractiveModel and exercise the helper
// directly without touching tea.Cmd plumbing.
func (m *InteractiveModel) applyCtxObservationFrame(observer *ContextObserver, ev api.ContextObserverEvent) {
	if m == nil || observer == nil {
		return
	}
	m.ctxObservationMu.Lock()
	defer m.ctxObservationMu.Unlock()
	if m.ctxObservation == nil {
		m.ctxObservation = make(map[string]ContextObservation)
	}
	key := observationKey(observer.cwd, observer.sessionID)
	now := time.Now()
	switch ev.Type {
	case "assembled_snapshot":
		obs := ContextObservation{
			Status:      CtxObserverConnected,
			LastFrameAt: now,
		}
		if ev.Snapshot != nil {
			obs.Redaction = ev.Snapshot.Redaction
			if ev.Snapshot.Context != nil {
				obs.Summary = ev.Snapshot.Context.Redaction
				obs.Sections = ev.Snapshot.Context.SystemPromptBlocks
				obs.SystemPromptToks = ev.Snapshot.Context.SystemPromptTokenEstimate
				obs.MessagesToks = ev.Snapshot.Context.MessagesTokenEstimate
			}
		}
		m.ctxObservation[key] = obs
	case "assembled":
		obs := ContextObservation{
			Status:      CtxObserverConnected,
			LastFrameAt: now,
		}
		if ev.Assembled != nil {
			obs.Redaction = ev.Assembled.Redaction
			obs.LastTimestamp = ev.Assembled.Timestamp
			if ev.Assembled.Context != nil {
				obs.Summary = ev.Assembled.Context.Redaction
				obs.Sections = ev.Assembled.Context.SystemPromptBlocks
				obs.SystemPromptToks = ev.Assembled.Context.SystemPromptTokenEstimate
				obs.MessagesToks = ev.Assembled.Context.MessagesTokenEstimate
			}
		}
		m.ctxObservation[key] = obs
	case "error":
		// Server-side error frame: keep the previous
		// summary for diagnostic purposes but mark the
		// status as disconnected so the renderer falls
		// back to "not observed". The server will close
		// the socket immediately after; the errs handler
		// will schedule a reconnect.
		prev := m.ctxObservation[key]
		prev.Status = CtxObserverDisconnected
		prev.LastFrameAt = now
		if ev.Err != nil {
			prev.LastError = ev.Err.Code + ": " + ev.Err.Message
		}
		m.ctxObservation[key] = prev
	default:
		// Unknown / forward-compat frame type: do not
		// mutate the snapshot but stamp LastFrameAt so
		// liveness checks see the observer is alive.
		prev := m.ctxObservation[key]
		if prev.Status == CtxObserverNotObserved {
			prev.Status = CtxObserverConnected
		}
		prev.LastFrameAt = now
		m.ctxObservation[key] = prev
	}
}

// markCtxObservationDisconnected flips the observation to
// the disconnected state and records the transient error
// message. Called by the connect / errs handlers.
func (m *InteractiveModel) markCtxObservationDisconnected(observer *ContextObserver, errMsg string) {
	if m == nil || observer == nil {
		return
	}
	m.ctxObservationMu.Lock()
	defer m.ctxObservationMu.Unlock()
	if m.ctxObservation == nil {
		m.ctxObservation = make(map[string]ContextObservation)
	}
	key := observationKey(observer.cwd, observer.sessionID)
	prev := m.ctxObservation[key]
	prev.Status = CtxObserverDisconnected
	prev.LastFrameAt = time.Now()
	prev.LastError = errMsg
	m.ctxObservation[key] = prev
}

// GetCtxObservation returns the most recent observation
// for the given (cwd, sessionID) pair. The second return
// value is false when no observer event has ever arrived
// — the renderer should display "context: not observed"
// in that case.
func (m *InteractiveModel) GetCtxObservation(cwd, sessionID string) (ContextObservation, bool) {
	if m == nil {
		return ContextObservation{}, false
	}
	m.ctxObservationMu.Lock()
	defer m.ctxObservationMu.Unlock()
	if m.ctxObservation == nil {
		return ContextObservation{}, false
	}
	obs, ok := m.ctxObservation[observationKey(cwd, sessionID)]
	return obs, ok
}

// FormatCtxObservationLine returns the runtime-owned
// status line for a single observation. The output is
// pure text (no ANSI) so tests can assert directly. The
// Bubble Tea adapter applies styling on top.
//
// Output examples:
//
//	"context: not observed"                    // no event ever
//	"context: connected · 14k chars · 23 msgs · 12 blocks (8 cacheable)"
//	"context: reconnecting (read tcp ...)"     // disconnected with err
//	"context: full mode (debug)"               // server emits ?full=1
func FormatCtxObservationLine(obs ContextObservation, observed bool) string {
	if !observed || obs.Status == CtxObserverNotObserved {
		return "context: not observed"
	}
	if obs.Status == CtxObserverDisconnected {
		if obs.LastError != "" {
			return "context: reconnecting (" + obs.LastError + ")"
		}
		return "context: reconnecting"
	}
	if obs.Redaction == "full" {
		// R6 contract: even if the server sends `full`
		// payload, the loop renderer never displays
		// verbatim text. Fall back to a debug indicator.
		return "context: full mode (debug)"
	}
	if obs.Summary == nil {
		// Snapshot with `context: null` — observer is
		// connected but no assembled frame yet.
		return "context: connected (no frame yet)"
	}
	return fmt.Sprintf(
		"context: connected · %s chars · %d msgs · %d blocks (%d cacheable)",
		formatThousands(obs.Summary.SystemPromptChars+obs.Summary.MessageChars),
		obs.Summary.MessageCount,
		obs.Summary.BlockCount,
		obs.Summary.CacheableBlockCount,
	)
}

// formatThousands renders an int with k/m suffix for
// terminals where space is tight. 14000 → "14k",
// 1_500_000 → "1.5m".
func formatThousands(n int) string {
	if n < 1000 {
		return fmt.Sprintf("%d", n)
	}
	if n < 1_000_000 {
		// Round down to 1k granularity for non-wobbly
		// chars counts.
		return fmt.Sprintf("%dk", n/1000)
	}
	return fmt.Sprintf("%.1fm", float64(n)/1_000_000)
}
