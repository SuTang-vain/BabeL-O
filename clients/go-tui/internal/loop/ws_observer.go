// internal/loop/ws_observer.go
//
// PR-17c (B1): Bubble Tea–level observer that wraps
// `api.Client.ObserveWorkingSet` with reconnect + backoff
// and the tea.Cmd / msg plumbing that the InteractiveModel
// can drop into its Update switch. Mirrors the structure
// of `ws_read.go` (the 6d-c'-A per-pane stream reader) so
// a future reader can find the analogue quickly: the
// per-session WS read keeps its own channels + cancel
// funcs; the per-CWD observer here keeps its own too.
//
// Why this file is separate from `ws_read.go`:
//
//   - `ws_read.go` is the per-pane stream read path
//     (one socket per pane, lifetime = pane lifetime). It
//     runs inside the InteractiveModel's per-pane read
//     dispatcher and never reconnects on its own.
//   - The working-set observer is per-CWD: one socket per
//     loop driver, lifetime = program lifetime. It is
//     expected to reconnect with backoff when the server
//     reboots or the network blips — the per-pane path
//     has no such expectation because a closed pane is
//     closed.
//
// Constraints honored (from PR-17c spec):
//
//   - Default-on: no CLI flag, auto-starts on Init after
//     the reconciler is built (see `interactive.go`'s
//     `InteractiveModel.Init` / `ws_observer_msg` case).
//   - Auto-reconnect with bounded backoff: 2s → 5s → 15s
//     cap. Reset to 2s on successful connect.
//   - First connect does NOT call Reconciler.RunOnce —
//     the server's `working_set_snapshot` frame on
//     connect provides the initial state.
//   - Reconnect calls Reconciler.RunOnce once to repair
//     any drift the WS may have missed during the
//     disconnect window. The reconciler is injected via
//     the `ReconcilerRunner` interface seam (defined
//     here) so we don't need to modify
//     `reconcile_worker.go`.
//   - Silent failure on server-not-supporting-WS: a dial
//     error is surfaced via the errs path and re-scheduled
//     with backoff, never as a toast / log spam.
//   - tea.Cmd + msg plumbing — matches `ws_read.go`'s
//     pattern (per spec constraint #9).

package loop

import (
	"context"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// ReconcilerRunner is the interface seam between the
// working-set observer and the Phase-5b Reconciler. We
// define it here (not in `reconcile_worker.go`) so the
// observer can call `RunOnce` on reconnect without
// modifying the frozen Reconciler file. The concrete
// `*Reconciler` satisfies this implicitly.
//
// PR-17c (B1) spec: "the interface seam for Reconciler
// (so we don't modify reconcile_worker.go): if the
// observer needs to call RunOnce on reconnect, define a
// tiny interface in ws_observer.go like
// `type ReconcilerRunner interface { RunOnce(ctx
// context.Context) error }` and have the observer accept
// that interface. The concrete *Reconciler satisfies it
// implicitly."
type ReconcilerRunner interface {
	RunOnce(ctx context.Context) (RunOnceResult, error)
}

// BackoffState is the per-observer backoff cursor. The
// sequence is 2s → 5s → 15s (cap). Reset() returns to
// the initial 2s step. We model it as a small value
// type so the observer's struct is copy-cheap and tests
// can seed the cursor directly.
type BackoffState struct {
	current time.Duration
}

// observeBackoffSteps is the table the Next() method
// walks through. Adding a new tier is a one-line change.
var observeBackoffSteps = []time.Duration{
	2 * time.Second,
	5 * time.Second,
	15 * time.Second,
}

// Next returns the next backoff delay. Always returns
// at least the first tier (2s) on a fresh BackoffState.
// The cap is the last tier in the table; once we reach
// it, Next() keeps returning the cap until Reset().
func (b *BackoffState) Next() time.Duration {
	if len(observeBackoffSteps) == 0 {
		return 2 * time.Second
	}
	// current is the index into the steps table; a zero
	// value picks the first tier. We only advance when
	// Next() is called, not when Reset() runs, so a
	// successful connect (which calls Reset) doesn't
	// over-jump.
	idx := int(b.current)
	if idx < 0 {
		idx = 0
	}
	if idx >= len(observeBackoffSteps) {
		idx = len(observeBackoffSteps) - 1
	}
	delay := observeBackoffSteps[idx]
	b.current = time.Duration(idx + 1)
	return delay
}

// Reset returns the cursor to the initial state (the
// next Next() call returns the first tier, 2s). Called
// from the observer after a successful connect.
func (b *BackoffState) Reset() {
	b.current = 0
}

// WorkingSetObserver is the loop-level observer. One
// instance per InteractiveModel. Owns the API client
// handle, the reconciler seam, the cwd / sessionID
// filter, and the backoff cursor.
type WorkingSetObserver struct {
	client     *api.Client
	reconciler ReconcilerRunner
	cwd        string
	sessionID  string // empty = no filter
	backoff    BackoffState

	// connected flips to true on the first successful
	// working_set_snapshot frame and back to false on
	// any read error. It drives the "first connect
	// doesn't call RunOnce, reconnect does" branch.
	connected bool
	mu        sync.Mutex
}

// NewWorkingSetObserver constructs an observer. The
// reconciler may be nil (e.g. in-memory test mode); in
// that case reconnect-time RunOnce is skipped silently.
func NewWorkingSetObserver(client *api.Client, reconciler ReconcilerRunner, cwd, sessionID string) *WorkingSetObserver {
	return &WorkingSetObserver{
		client:     client,
		reconciler: reconciler,
		cwd:        cwd,
		sessionID:  sessionID,
	}
}

// Cwd returns the cwd the observer was constructed with.
// Used by tests + the per-CWD lookup registry the
// InteractiveModel can build when multiple observers are
// ever in flight (none today; reserved for the future).
func (o *WorkingSetObserver) Cwd() string { return o.cwd }

// SessionID returns the optional sessionID filter.
func (o *WorkingSetObserver) SessionID() string { return o.sessionID }

// MarkConnected stamps the connected flag. Called by
// the event handler when a working_set_snapshot frame
// arrives; the reconnect path checks the flag to decide
// whether this is the first connect (skip RunOnce) or a
// reconnect (call RunOnce).
func (o *WorkingSetObserver) MarkConnected() {
	o.mu.Lock()
	o.connected = true
	o.mu.Unlock()
}

// MarkDisconnected clears the connected flag.
func (o *WorkingSetObserver) MarkDisconnected() {
	o.mu.Lock()
	o.connected = false
	o.mu.Unlock()
}

// IsConnected returns the current connection state.
func (o *WorkingSetObserver) IsConnected() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.connected
}

// Start returns the first connect tea.Cmd. Called from
// InteractiveModel.Init() once the model is fully
// constructed. Returns nil when the client is nil so
// in-memory / no-Nexus mode can opt out.
func (o *WorkingSetObserver) Start(_ context.Context) tea.Cmd {
	if o == nil || o.client == nil {
		return nil
	}
	return o.ConnectCmd()
}

// ConnectCmd returns a tea.Cmd that dials the observer's
// WebSocket and returns the first connect handle. The
// returned handle is the events-channel + errs-channel
// + close fn; the wrapping tea.Cmd posts a
// `wsObserverConnectMsg` to the model.
func (o *WorkingSetObserver) ConnectCmd() tea.Cmd {
	if o == nil || o.client == nil {
		return nil
	}
	client := o.client
	cwd := o.cwd
	sessionID := o.sessionID
	reconciler := o.reconciler
	observer := o
	return func() tea.Msg {
		ctx, cancel := context.WithCancel(context.Background())
		events, errs, closeFn, dialErr := client.ObserveWorkingSet(ctx, cwd, sessionID, api.ObserveOpts{})
		if dialErr != nil {
			cancel()
			// No channels — return a connect-failed msg
			// so the model schedules a backoff reconnect.
			_ = closeFn
			return wsObserverConnectMsg{
				observer:    observer,
				reconciler:  reconciler,
				dialErr:     dialErr,
				ctxCancel:   cancel,
				connected:   observer.IsConnected(),
			}
		}
		return wsObserverConnectMsg{
			observer:   observer,
			reconciler: reconciler,
			events:     events,
			errs:       errs,
			closeFn:    closeFn,
			ctxCancel:  cancel,
			connected:  observer.IsConnected(),
		}
	}
}

// ReconnectCmd returns a tea.Cmd that sleeps for `delay`
// and then dials again. Used by the errs handler to
// schedule a backoff retry after a read error.
func (o *WorkingSetObserver) ReconnectCmd(delay time.Duration) tea.Cmd {
	if o == nil || o.client == nil {
		return nil
	}
	if delay <= 0 {
		delay = o.backoff.Next()
	} else {
		// Caller supplied an explicit delay (e.g. the
		// first retry after the initial dial). Step the
		// backoff cursor to the next tier so subsequent
		// failures keep advancing.
		o.backoff.Next()
	}
	observer := o
	return func() tea.Msg {
		time.Sleep(delay)
		return wsObserverReconnectMsg{observer: observer}
	}
}

// OnEvent processes one WorkingSetObserverEvent and
// returns the next tea.Cmd. Currently a thin dispatcher
// that posts a `wsObserverEventMsg` to the model; the
// real routing / model mutation lives in the model's
// Update handler (mirroring `ws_read.go`'s split).
//
// Returning nil from OnEvent means "no follow-up cmd";
// the model's Update is the one place that schedules
// subsequent reads.
func (o *WorkingSetObserver) OnEvent(ev api.WorkingSetObserverEvent) tea.Cmd {
	if o == nil {
		return nil
	}
	observer := o
	return func() tea.Msg {
		return wsObserverEventMsg{observer: observer, ev: ev}
	}
}

// wsObserverConnectMsg is the "dial finished" message
// the ConnectCmd returns. `dialErr != nil` means the
// connect failed; the model schedules a ReconnectCmd in
// that case. `events` + `errs` are nil on dial failure.
type wsObserverConnectMsg struct {
	observer   *WorkingSetObserver
	reconciler ReconcilerRunner
	events     <-chan api.WorkingSetObserverEvent
	errs       <-chan error
	closeFn    func()
	ctxCancel  context.CancelFunc
	dialErr    error
	connected  bool
}

// wsObserverReconnectMsg is dispatched by the
// ReconnectCmd when the backoff timer fires. The model
// dispatches it through observer.ConnectCmd() to actually
// re-dial.
type wsObserverReconnectMsg struct {
	observer *WorkingSetObserver
}

// wsObserverEventMsg is dispatched by the observer's
// read loop for each server-pushed frame. Carries the
// fully decoded event so the model's Update handler can
// switch on Type without re-decoding.
type wsObserverEventMsg struct {
	observer *WorkingSetObserver
	ev       api.WorkingSetObserverEvent
}

// handleWsObserverConnect is the model's Update-side
// handler for `wsObserverConnectMsg`. On a successful
// connect it (a) stamps the connected flag, (b) resets
// the backoff cursor, (c) remembers the close fn + ctx
// cancel for shutdown, and (d) returns a tea.Cmd that
// drains the events channel. On dial failure it
// schedules a backoff reconnect — silently, per spec
// constraint #3.
//
// The drain cmd follows the same pattern as the 6d-c'-A
// ws_read continue cmd: a closure that selects on the
// channels and posts a `wsObserverEventMsg` to the
// model. The handle re-queues itself on every event so
// the same channel keeps flowing until the server
// closes the socket.
func (m *InteractiveModel) handleWsObserverConnect(msg wsObserverConnectMsg) tea.Cmd {
	if m == nil || msg.observer == nil {
		return nil
	}
	if msg.dialErr != nil {
		// Silent failure (spec constraint #3): no
		// toast, no log spam. Just step the backoff
		// and reschedule.
		return msg.observer.ReconnectCmd(0)
	}
	// Stash the close fn + ctx cancel + channels so
	// shutdown can tear the socket down cleanly and
	// the drain closure can find the channels. Held
	// in a package-level registry keyed by the
	// observer so the drain closure can find them.
	observer := msg.observer
	registerObserverHandles(observer, msg.closeFn, msg.ctxCancel, msg.events, msg.errs)
	// First connect: server's working_set_snapshot
	// frame on connect provides the initial state, so
	// do NOT call Reconciler.RunOnce here. (Spec
	// constraint #4.) We still stamp the connected
	// flag so the next reconnect knows the difference.
	if !observer.IsConnected() {
		observer.MarkConnected()
		observer.backoff.Reset()
	}
	events := msg.events
	errs := msg.errs
	return func() tea.Msg {
		// We can't `select` on all three (events, errs,
		// timer) without a heartbeat, but unlike the
		// per-pane read path the observer's working-set
		// stream is mostly idle — the server only
		// pushes on mutation. A simple two-arm select
		// matches the StreamSession pattern and
		// surfaces errs promptly on close.
		select {
		case ev, ok := <-events:
			if !ok {
				return wsObserverErrMsg{observer: observer, err: errObserverStreamClosed}
			}
			return wsObserverEventMsg{observer: observer, ev: ev}
		case err, ok := <-errs:
			if !ok {
				return wsObserverErrMsg{observer: observer, err: errObserverStreamClosed}
			}
			return wsObserverErrMsg{observer: observer, err: err}
		}
	}
}

// wsObserverErrMsg is dispatched when the observer's
// read channel emits a non-event signal: a read error
// from the server, or a clean close. The handler
// schedules a backoff reconnect — the spec's "silent
// failure on server-not-supporting-WS" path. A separate
// message type (vs embedding the error on a regular
// event) keeps the success path's dispatcher simple.
type wsObserverErrMsg struct {
	observer *WorkingSetObserver
	err      error
}

// errObserverStreamClosed is the sentinel for a clean
// observer-stream close. Distinct from network errors
// so the handler can log differently (we currently
// don't, but the seam is here for it).
var errObserverStreamClosed = &observerStreamClosedError{}

type observerStreamClosedError struct{}

func (e *observerStreamClosedError) Error() string { return "ws observer stream closed" }

// handleWsObserverErr clears the connected flag and
// schedules a backoff reconnect. If the observer was
// previously connected (i.e. this is a reconnect, not
// the first ever connect), it also calls
// ReconcilerRunner.RunOnce once to repair any drift
// the WS may have missed during the disconnect window.
// Returns a tea.Batch that runs the reconciler pass in
// parallel with the backoff timer so the operator
// doesn't see a UI freeze.
func (m *InteractiveModel) handleWsObserverErr(msg wsObserverErrMsg) tea.Cmd {
	if m == nil || msg.observer == nil {
		return nil
	}
	observer := msg.observer
	wasConnected := observer.IsConnected()
	observer.MarkDisconnected()
	// Tear down the old close fn so a reconnect can
	// open a fresh socket.
	if closeFn, cancel, ok := popObserverHandles(observer); ok {
		if cancel != nil {
			cancel()
		}
		if closeFn != nil {
			closeFn()
		}
	}
	delay := observer.backoff.Next()
	reconnectCmd := observer.ReconnectCmd(delay)
	if !wasConnected {
		// First-connect dial failed — no need to
		// reconcile, the server never had a chance to
		// drift. Just retry.
		return reconnectCmd
	}
	if observer.reconciler == nil {
		// No reconciler attached (e.g. in-memory test
		// mode). Skip the drift repair; just schedule
		// the reconnect.
		return reconnectCmd
	}
	// Reconnect: call ReconcilerRunner.RunOnce once
	// to repair any drift the WS may have missed.
	rec := observer.reconciler
	runOnceCmd := func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := rec.RunOnce(ctx)
		return wsObserverReconcileDoneMsg{observer: observer, err: err}
	}
	return tea.Batch(reconnectCmd, runOnceCmd)
}

// wsObserverReconcileDoneMsg is dispatched after the
// reconnect-time RunOnce finishes. The model currently
// just discards the result; the reconciler has already
// updated the store + (via handleReconcileDone) the
// model. The message type exists so future slices can
// surface "reconciled after reconnect" toasts without
// adding another dispatch point.
type wsObserverReconcileDoneMsg struct {
	observer *WorkingSetObserver
	err      error
}

// handleWsObserverEvent is the per-frame handler.
// Returns a tea.Cmd that continues draining the events
// channel (the handle re-queues itself by returning the
// drain cmd). The current dispatch is a thin pass-through
// — the model's LoopModel update is intentionally not
// wired here because Phase 1 of PR-17c focuses on the
// transport plumbing; the renderer-side integration
// lands in a follow-up slice.
func (m *InteractiveModel) handleWsObserverEvent(msg wsObserverEventMsg) tea.Cmd {
	if m == nil || msg.observer == nil {
		return nil
	}
	// First snapshot marks the observer as connected
	// so the reconnect path knows to call RunOnce on
	// subsequent drops. Backoff is reset on success.
	if msg.ev.Snapshot != nil && !msg.observer.IsConnected() {
		msg.observer.MarkConnected()
		msg.observer.backoff.Reset()
	}
	// Schedule the next read so the channel keeps
	// flowing.
	observer := msg.observer
	return func() tea.Msg {
		events, errs, ok := lookupObserverChannels(observer)
		if !ok {
			return wsObserverErrMsg{observer: observer, err: errObserverStreamClosed}
		}
		select {
		case ev, ok := <-events:
			if !ok {
				return wsObserverErrMsg{observer: observer, err: errObserverStreamClosed}
			}
			return wsObserverEventMsg{observer: observer, ev: ev}
		case err, ok := <-errs:
			if !ok {
				return wsObserverErrMsg{observer: observer, err: errObserverStreamClosed}
			}
			return wsObserverErrMsg{observer: observer, err: err}
		}
	}
}

// --- handle registry ---
//
// The drain cmd lives inside a closure that doesn't
// have access to *InteractiveModel, so the per-observer
// channels + close fn + ctx cancel are stashed in a
// package-level map keyed by the observer pointer.
// The map is guarded by a mutex; the InteractiveModel
// is unique per bubbletea program, so a single observer
// pointer is unique per program too.

var (
	observerHandlesMu sync.Mutex
	observerHandles   = make(map[*WorkingSetObserver]observerHandle)
)

type observerHandle struct {
	closeFn   func()
	ctxCancel context.CancelFunc
	events    <-chan api.WorkingSetObserverEvent
	errs      <-chan error
}

func registerObserverHandles(o *WorkingSetObserver, closeFn func(), cancel context.CancelFunc, events <-chan api.WorkingSetObserverEvent, errs <-chan error) {
	observerHandlesMu.Lock()
	defer observerHandlesMu.Unlock()
	observerHandles[o] = observerHandle{closeFn: closeFn, ctxCancel: cancel, events: events, errs: errs}
}

func popObserverHandles(o *WorkingSetObserver) (func(), context.CancelFunc, bool) {
	observerHandlesMu.Lock()
	defer observerHandlesMu.Unlock()
	h, ok := observerHandles[o]
	if !ok {
		return nil, nil, false
	}
	delete(observerHandles, o)
	return h.closeFn, h.ctxCancel, true
}

func lookupObserverChannels(o *WorkingSetObserver) (<-chan api.WorkingSetObserverEvent, <-chan error, bool) {
	observerHandlesMu.Lock()
	defer observerHandlesMu.Unlock()
	h, ok := observerHandles[o]
	if !ok {
		return nil, nil, false
	}
	return h.events, h.errs, true
}
