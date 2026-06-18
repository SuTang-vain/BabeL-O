// internal/loop/ws_read_test.go
//
// Phase 6d-c'-A tests: per-pane WS read path on the
// loop side. Covers the dispatcher (useWsReadPath flag),
// the handler (handleWsReadEvent), the per-event
// append + LastEventRev advance, the heartbeat sentinel,
// the error path, and the close-pane cleanup.
//
// The test model is wired with a real httptest WS server
// (from api/ws_stream_test.go) for the integration-shaped
// tests, and a hand-rolled channels-only path for the
// pure handler tests (no goroutines, deterministic).
//
// What this file does NOT cover:
//   - api.StreamSession wire contract (api/ws_stream_test.go)
//   - handleWaitDone parity (wait_tick_test.go — the WS
//     handler mirrors its structure)

package loop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// wsLoopTestServer is a minimal WS server for the loop
// side tests. It accepts /v1/sessions/:id/stream upgrades
// and lets the test push events by writing to the
// connection directly. This is the simplest possible
// shape: no canned events, the test controls timing.
type wsLoopTestServer struct {
	server   *httptest.Server
	upgrader websocket.Upgrader
	connCh   chan *websocket.Conn
}

func newWSLoopTestServer(t *testing.T) *wsLoopTestServer {
	t.Helper()
	s := &wsLoopTestServer{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		connCh: make(chan *websocket.Conn, 1),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/sessions/", s.handle)
	s.server = httptest.NewServer(mux)
	t.Cleanup(s.server.Close)
	return s
}

func (s *wsLoopTestServer) URL() string { return s.server.URL }

func (s *wsLoopTestServer) handle(w http.ResponseWriter, r *http.Request) {
	if !strings.HasSuffix(r.URL.Path, "/stream") {
		http.NotFound(w, r)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	s.connCh <- conn
}

// TestUseWsReadPathDefaultOff: by default, the read
// dispatcher sends panes to HTTP wait, not WS. The opt-in
// flag must be explicitly flipped via SetUseWsReadForTest
// (or a future CLI flag / env var).
func TestUseWsReadPathDefaultOff(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	if im.useWsReadPath() {
		t.Fatal("default useWsRead should be false")
	}
	im.SetUseWsReadForTest(true)
	if !im.useWsReadPath() {
		t.Fatal("SetUseWsReadForTest(true) should flip the flag")
	}
}

// TestStartReadForPaneDispatchesToWaitByDefault: when
// useWsRead is false (default), startReadForPane uses
// the HTTP wait path. We can't directly observe which
// path was taken (both return tea.Cmd closures), but
// we can verify that startReadForPane DOES return a
// non-nil cmd for a pane with a SessionID — the
// dispatch happens, the choice is encoded in the cmd's
// closure.
func TestStartReadForPaneDispatchesToWaitByDefault(t *testing.T) {
	client := api.NewClient("http://127.0.0.1:1", "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	seeded, _ := seedPane(im.loop, PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Label:       "main",
		Status:      StatusIdle,
	})
	im.loop = seeded
	cmd := im.startReadForPane(PaneModel{
		PaneID: "pane-1", SessionID: "session-1",
	})
	if cmd == nil {
		t.Fatal("startReadForPane should return a cmd for a pane with SessionID")
	}
	// Default path: HTTP wait. wsReadInFlight should
	// NOT be set.
	if im.isWsReadInFlight("pane-1") {
		t.Error("default path should NOT set wsReadInFlight")
	}
	if !im.isWaitInFlight("pane-1") {
		t.Error("default path should set waitInFlight")
	}
}

// TestStartReadForPaneDispatchesToWsWhenOptedIn: when
// useWsRead is true, startReadForPane uses the WS path.
// The waitInFlight map stays untouched; wsReadInFlight
// is set so the next schedule skips double-scheduling.
func TestStartReadForPaneDispatchesToWsWhenOptedIn(t *testing.T) {
	client := api.NewClient("http://127.0.0.1:1", "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	im.SetUseWsReadForTest(true)
	seeded, _ := seedPane(im.loop, PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Label:       "main",
		Status:      StatusIdle,
	})
	im.loop = seeded
	// The cmd tries to dial; without a real server it
	// will fail and stamp a toast. We just verify the
	// dispatch state — wsReadInFlight is set BEFORE
	// the cmd runs (synchronously in scheduleWsRead).
	if !im.useWsReadPath() {
		t.Fatal("opt-in flag not set")
	}
	// We don't actually run the cmd (no server); but
	// we can verify the dispatch is in WS by calling
	// scheduleWsRead directly (which sets the flag
	// without running the cmd).
	cmd := im.scheduleWsRead(PaneModel{
		PaneID: "pane-1", SessionID: "session-1",
	})
	if cmd == nil {
		t.Fatal("scheduleWsRead should return a cmd")
	}
	if !im.isWsReadInFlight("pane-1") {
		t.Error("WS path should set wsReadInFlight")
	}
	if im.isWaitInFlight("pane-1") {
		t.Error("WS path should NOT set waitInFlight")
	}
	_ = cmd // cmd will fail-dial in test env (no server)
}

// TestScheduleWsReadSingleFlight: calling scheduleWsRead
// twice for the same pane returns nil the second time
// (the in-flight guard prevents stacking).
func TestScheduleWsReadSingleFlight(t *testing.T) {
	client := api.NewClient("http://127.0.0.1:1", "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	cmd1 := im.scheduleWsRead(PaneModel{PaneID: "pane-1", SessionID: "session-1"})
	cmd2 := im.scheduleWsRead(PaneModel{PaneID: "pane-1", SessionID: "session-1"})
	if cmd1 == nil {
		t.Fatal("first call should return a cmd")
	}
	if cmd2 != nil {
		t.Fatal("second call should be a noop (single-flight)")
	}
}

// TestHandleWsReadEventAppendsTranscript: a real
// wsEventMsg with a user_prompt payload appends to the
// pane's Transcript and advances LastEventRev. The
// handler returns a follow-up continue cmd.
func TestHandleWsReadEventAppendsTranscript(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	seeded, _ := seedPane(im.loop, PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Label:       "main",
		Status:      StatusIdle,
	})
	im.loop = seeded
	im.setWsReadInFlight("pane-1")

	raw := json.RawMessage(`{"type":"user_prompt","content":"hi","rev":1}`)
	cmd := im.handleWsReadEvent(wsEventMsg{
		PaneID: "pane-1", SessionID: "session-1",
		Raw: raw, Rev: 1,
	})
	if cmd == nil {
		t.Fatal("handleWsReadEvent should return a continue cmd")
	}
	pane, _ := im.loop.PaneAt(0, 0, 0)
	if pane.LastEventRev != 1 {
		t.Errorf("LastEventRev = %d, want 1", pane.LastEventRev)
	}
	if len(pane.Transcript) != 1 {
		t.Errorf("Transcript len = %d, want 1", len(pane.Transcript))
	}
}

// TestHandleWsReadEventHeartbeat: a heartbeat message
// (Rev == wsHeartbeatRev, no error) re-arms the read
// without mutating the model. wsReadInFlight stays set.
func TestHandleWsReadEventHeartbeat(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	seeded, _ := seedPane(im.loop, PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Label:       "main",
		Status:      StatusIdle,
	})
	im.loop = seeded
	im.setWsReadInFlight("pane-1")

	cmd := im.handleWsReadEvent(wsEventMsg{
		PaneID: "pane-1", Rev: wsHeartbeatRev,
	})
	if cmd == nil {
		t.Fatal("heartbeat should return a continue cmd")
	}
	if !im.isWsReadInFlight("pane-1") {
		t.Error("wsReadInFlight should stay set on heartbeat")
	}
	pane, _ := im.loop.PaneAt(0, 0, 0)
	if pane.LastEventRev != 0 {
		t.Errorf("heartbeat should not advance LastEventRev, got %d", pane.LastEventRev)
	}
}

// TestHandleWsReadEventErrorClearsInFlight: an error
// message stamps a toast and clears wsReadInFlight so
// the next reconcile can start a fresh read.
func TestHandleWsReadEventErrorClearsInFlight(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	im.setWsReadInFlight("pane-1")
	cmd := im.handleWsReadEvent(wsEventMsg{
		PaneID: "pane-1",
		Err:    &wsStreamClosedError{},
	})
	if cmd != nil {
		t.Error("error path should not return a follow-up cmd")
	}
	if im.isWsReadInFlight("pane-1") {
		t.Error("wsReadInFlight should be cleared on error")
	}
	if !strings.Contains(im.toastMessage, "✗") {
		t.Errorf("toast should be prefixed with ✗, got %q", im.toastMessage)
	}
}

// TestHandleWsReadEventStalePaneClearsInFlight: a result
// for a pane that no longer exists (closed between
// schedule and result) clears wsReadInFlight silently.
func TestHandleWsReadEventStalePaneClearsInFlight(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	im.setWsReadInFlight("pane-gone")
	cmd := im.handleWsReadEvent(wsEventMsg{
		PaneID: "pane-gone",
		Raw:    json.RawMessage(`{"type":"user_prompt","rev":1}`),
		Rev:    1,
	})
	if cmd != nil {
		t.Error("stale pane should not return a cmd")
	}
	if im.isWsReadInFlight("pane-gone") {
		t.Error("wsReadInFlight should be cleared for stale pane")
	}
}

// TestClearWsReadOnCloseStopsRead: closing a pane
// cancels the in-flight WS read + closes the socket
// + drops the channel registry entry.
func TestClearWsReadOnCloseStopsRead(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	im.setWsReadInFlight("pane-1")
	// Register a fake cancel + close + channels so we
	// can verify they're torn down.
	cancelled := false
	closed := false
	im.registerWsReadCancel("pane-1", func() { cancelled = true }, func() { closed = true })
	events := make(chan api.StreamEvent)
	errs := make(chan error)
	im.registerWsReadChannels("pane-1", events, errs)
	im.clearWsReadOnClose("pane-1")
	if !cancelled {
		t.Error("cancel func should have been called")
	}
	if !closed {
		t.Error("close func should have been called")
	}
	if im.isWsReadInFlight("pane-1") {
		t.Error("wsReadInFlight should be cleared after close")
	}
	if _, _, ok := lookupWsReadChannels("pane-1"); ok {
		t.Error("channels should be removed from registry after close")
	}
}

// TestHandleWsReadStartedStoresAndSchedules: when a
// wsReadBatchMsg arrives (the WS dial succeeded), the
// handler stores cancel/close + channels and schedules
// a continue cmd. We verify the post-state without
// running the cmd.
func TestHandleWsReadStartedStoresAndSchedules(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	events := make(chan api.StreamEvent, 1)
	errs := make(chan error, 1)
	// We need a real cancel func; the model stores
	// whatever we pass.
	cancel := func() {}
	closeF := func() {}
	im.setWsReadInFlight("pane-1")
	cmd := im.handleWsReadStarted(wsReadBatchMsg{
		PaneID: "pane-1", SessionID: "session-1",
		Cancel: cancel, Close: closeF,
		Events: events, Errs: errs,
	})
	if cmd == nil {
		t.Fatal("handleWsReadStarted should return a continue cmd")
	}
	if _, _, ok := lookupWsReadChannels("pane-1"); !ok {
		t.Error("channels should be registered after handleWsReadStarted")
	}
	if cancel, _, ok := im.popWsReadCancel("pane-1"); !ok || cancel == nil {
		t.Error("cancel func should be registered")
	}
	// push one event into the channel and ensure the
	// continue cmd picks it up — sanity check that
	// the channel plumbing works end-to-end.
	events <- api.StreamEvent{
		Type: "user_prompt", Rev: 1,
		Raw: json.RawMessage(`{"type":"user_prompt","rev":1,"content":"hi"}`),
	}
	// Run the continue cmd (simulating the bubbletea
	// worker); should produce a wsEventMsg.
	msg := cmd()
	ev, ok := msg.(wsEventMsg)
	if !ok {
		t.Fatalf("cmd returned %T, want wsEventMsg", msg)
	}
	if ev.Rev != 1 || ev.PaneID != "pane-1" {
		t.Errorf("event = %+v, want pane-1/1", ev)
	}
}

// TestHandleWsReadEventAdvanceRev: when Rev is higher
// than the pane's LastEventRev, the handler advances
// LastEventRev and stamps LastEventAt. Lower or equal
// revs are ignored (cursor monotonicity).
func TestHandleWsReadEventAdvanceRev(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	seeded, _ := seedPane(im.loop, PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Label:       "main",
		Status:      StatusIdle,
	})
	im.loop = seeded
	im.setWsReadInFlight("pane-1")

	// First event rev=5 → cursor advances to 5.
	im.handleWsReadEvent(wsEventMsg{
		PaneID: "pane-1", Rev: 5,
		Raw: json.RawMessage(`{"type":"user_prompt","rev":5}`),
	})
	pane, _ := im.loop.PaneAt(0, 0, 0)
	if pane.LastEventRev != 5 {
		t.Errorf("LastEventRev = %d, want 5", pane.LastEventRev)
	}
	// Stale event rev=3 → cursor stays at 5.
	im.handleWsReadEvent(wsEventMsg{
		PaneID: "pane-1", Rev: 3,
		Raw: json.RawMessage(`{"type":"user_prompt","rev":3}`),
	})
	pane, _ = im.loop.PaneAt(0, 0, 0)
	if pane.LastEventRev != 5 {
		t.Errorf("stale rev should not rewind cursor, got %d", pane.LastEventRev)
	}
}

// TestHandleWsReadEventEndToEnd: integration test with
// a real WS server. The full flow: dial → push event →
// handle → transcript appends. This is the regression
// guard for "WS read path works end-to-end on the loop
// side".
func TestHandleWsReadEventEndToEnd(t *testing.T) {
	srv := newWSLoopTestServer(t)
	client := api.NewClient(srv.URL(), "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	seeded, _ := seedPane(im.loop, PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Label:       "main",
		Status:      StatusIdle,
	})
	im.loop = seeded
	im.SetUseWsReadForTest(true)

	// Wait for the server to be ready, then start a
	// read cmd.
	readCmd := im.scheduleWsRead(PaneModel{PaneID: "pane-1", SessionID: "session-1"})
	if readCmd == nil {
		t.Fatal("scheduleWsRead should return a cmd")
	}
	// Run the cmd → dials → returns wsReadBatchMsg.
	msg := readCmd()
	batch, ok := msg.(wsReadBatchMsg)
	if !ok {
		t.Fatalf("dial cmd returned %T, want wsReadBatchMsg", msg)
	}
	// Wait for the server-side conn to be available.
	var conn *websocket.Conn
	select {
	case conn = <-srv.connCh:
	case <-time.After(2 * time.Second):
		t.Fatal("server didn't accept the WS connection")
	}
	// First register the channels + cancel/close on the
	// model — this is what handleWsReadStarted does in
	// production. We do it manually here so we can call
	// wsReadContinueCmd directly.
	im.registerWsReadCancel("pane-1", batch.Cancel, batch.Close)
	im.registerWsReadChannels("pane-1", batch.Events, batch.Errs)
	// Server pushes one event.
	if err := conn.WriteMessage(websocket.TextMessage,
		[]byte(`{"type":"user_prompt","rev":1,"content":"hi"}`)); err != nil {
		t.Fatalf("server push: %v", err)
	}
	// Run the continue cmd to drain the first event.
	continueCmd := im.wsReadContinueCmd("pane-1")
	evMsg := continueCmd()
	ev, ok := evMsg.(wsEventMsg)
	if !ok {
		t.Fatalf("continue cmd returned %T, want wsEventMsg", evMsg)
	}
	if ev.Rev != 1 || ev.PaneID != "pane-1" {
		t.Errorf("event = %+v, want pane-1/1", ev)
	}
	// Handler appends + advances rev.
	im.handleWsReadEvent(ev)
	pane, _ := im.loop.PaneAt(0, 0, 0)
	if pane.LastEventRev != 1 {
		t.Errorf("LastEventRev = %d, want 1", pane.LastEventRev)
	}
	if len(pane.Transcript) != 1 {
		t.Errorf("Transcript len = %d, want 1", len(pane.Transcript))
	}
	// Cleanup: cancel the in-flight read.
	im.clearWsReadOnClose("pane-1")
}

// silenceContextDeadline is a small helper used by the
// end-to-end test to ensure the server-side conn is
// closed before the test ends (so the httptest teardown
// doesn't race the connection).
var _ = context.Background
