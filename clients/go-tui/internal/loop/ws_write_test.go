// internal/loop/ws_write_test.go
//
// Phase 6d-c'-B tests: WS write path dispatcher +
// per-action helpers (DispatchSubmit / DispatchApprove
// / DispatchDeny / DispatchCancel). The dispatcher
// tries WS first when useWsWrite is set, falls back to
// HTTP on any error.
//
// What this file covers:
//   - opt-in flag default off (useWsWritePath)
//   - opt-in flag toggle via SetUseWsWriteForTest
//   - dispatchWrite HTTP path: useWsWrite=false →
//     HTTP fallback always used
//   - dispatchWrite WS success path: useWsWrite=true +
//     server OK → HTTP fallback NOT called
//   - dispatchWrite WS dial failure → falls back to
//     HTTP without operator-facing error
//   - dispatchWrite server-side ok=false → returns
//     wsServerError (no double-execute via HTTP)
//   - DispatchSubmit/Approve/Deny/Cancel wire shape
//
// What this file does NOT cover:
//   - api.Client.SendCommand wire contract
//     (api/ws_stream_test.go)
//   - handleSubmitDone / handlePermissionDecision /
//     handleCancelDone integration (covered by the
//     existing HTTP-path tests; the WS path is the
//     same handler logic, different transport)

package loop

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// TestUseWsWritePathDefaultOff: opt-in is off by default.
// Mirrors the symmetric WS-read contract (6d-c'-A).
func TestUseWsWritePathDefaultOff(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	if im.useWsWritePath() {
		t.Fatal("default useWsWrite should be false")
	}
	im.SetUseWsWriteForTest(true)
	if !im.useWsWritePath() {
		t.Fatal("SetUseWsWriteForTest(true) should flip the flag")
	}
}

// wsWriteTestServer: minimal WS server for the
// dispatcher tests. Accepts
// `/v1/sessions/:id/command?action=<action>` upgrades,
// reads one CommandRequest, replies with the
// configured response, closes. Tracks the request so
// tests can assert the wire shape.
type wsWriteTestServer struct {
	server      *httptest.Server
	upgrader    websocket.Upgrader
	gotRequest  api.CommandRequest
	gotRequests int
	responseOK  bool
	responseErr string
}

func newWSWriteTestServer(t *testing.T, ok bool) *wsWriteTestServer {
	t.Helper()
	s := &wsWriteTestServer{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		responseOK: ok,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/sessions/", s.handle)
	s.server = httptest.NewServer(mux)
	t.Cleanup(s.server.Close)
	return s
}

func (s *wsWriteTestServer) URL() string { return s.server.URL }

func (s *wsWriteTestServer) handle(w http.ResponseWriter, r *http.Request) {
	if !strings.HasSuffix(r.URL.Path, "/command") {
		http.NotFound(w, r)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	_, raw, err := conn.ReadMessage()
	if err != nil {
		return
	}
	_ = json.Unmarshal(raw, &s.gotRequest)
	s.gotRequests++
	resp := api.CommandResponse{
		Type:      "command_response",
		RequestID: s.gotRequest.RequestID,
		OK:        s.responseOK,
		Error:     s.responseErr,
	}
	_ = conn.WriteJSON(resp)
}

// TestDispatchWriteHttpPathDefault: when useWsWrite is
// false (default), the dispatcher uses the HTTP
// fallback and never touches the WS path.
func TestDispatchWriteHttpPathDefault(t *testing.T) {
	srv := newWSWriteTestServer(t, true)
	client := api.NewClient(srv.URL(), "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	// useWsWrite = false (default).
	httpCalled := false
	usedWS, err := im.dispatchWrite(
		context.Background(), client, "session-1",
		api.CommandSubmit, nil,
		func(_ context.Context) error {
			httpCalled = true
			return nil
		},
	)
	if err != nil {
		t.Fatalf("dispatchWrite: %v", err)
	}
	if usedWS {
		t.Error("useWsWrite=false should NOT use WS path")
	}
	if !httpCalled {
		t.Error("HTTP fallback should have been called")
	}
	if srv.gotRequests != 0 {
		t.Errorf("WS server should not have been hit, got %d requests", srv.gotRequests)
	}
}

// TestDispatchWriteWsSuccess: when useWsWrite is true
// AND the server replies OK, the dispatcher uses WS
// and does NOT call the HTTP fallback.
func TestDispatchWriteWsSuccess(t *testing.T) {
	srv := newWSWriteTestServer(t, true)
	client := api.NewClient(srv.URL(), "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	im.SetUseWsWriteForTest(true)
	httpCalled := false
	usedWS, err := im.dispatchWrite(
		context.Background(), client, "session-1",
		api.CommandSubmit, nil,
		func(_ context.Context) error {
			httpCalled = true
			return nil
		},
	)
	if err != nil {
		t.Fatalf("dispatchWrite: %v", err)
	}
	if !usedWS {
		t.Error("useWsWrite=true + WS success should use WS path")
	}
	if httpCalled {
		t.Error("HTTP fallback should NOT have been called on WS success")
	}
	if srv.gotRequests != 1 {
		t.Errorf("WS server should have been hit once, got %d", srv.gotRequests)
	}
}

// TestDispatchWriteWsDialFailureFallsBackToHttp: a
// failed WS dial (unreachable server) causes a silent
// fallback to the HTTP path. The operator never sees a
// "WS write failed" toast.
func TestDispatchWriteWsDialFailureFallsBackToHttp(t *testing.T) {
	// Unreachable client.
	client := api.NewClient("http://127.0.0.1:1", "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	im.SetUseWsWriteForTest(true)
	httpCalled := false
	httpErr := errors.New("http fallback called")
	usedWS, err := im.dispatchWrite(
		context.Background(), client, "session-1",
		api.CommandSubmit, nil,
		func(_ context.Context) error {
			httpCalled = true
			return httpErr
		},
	)
	if usedWS {
		t.Error("dial failure should NOT report usedWS=true")
	}
	if !httpCalled {
		t.Error("dial failure should fall back to HTTP")
	}
	if err != httpErr {
		t.Errorf("err = %v, want %v", err, httpErr)
	}
}

// TestDispatchWriteServerSideErrorNoFallback: when the
// WS server responds with ok=false + error message,
// the dispatcher returns the synthetic wsServerError
// and does NOT call the HTTP fallback (the operator
// already saw a server response; running the HTTP
// route would double-execute the action).
func TestDispatchWriteServerSideErrorNoFallback(t *testing.T) {
	srv := newWSWriteTestServer(t, false)
	srv.responseErr = "permission denied"
	client := api.NewClient(srv.URL(), "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	im.SetUseWsWriteForTest(true)
	httpCalled := false
	usedWS, err := im.dispatchWrite(
		context.Background(), client, "session-1",
		api.CommandApprove, nil,
		func(_ context.Context) error {
			httpCalled = true
			return nil
		},
	)
	if !usedWS {
		t.Error("server responded (usedWS should be true) even though ok=false")
	}
	if httpCalled {
		t.Error("server-side error should NOT call HTTP fallback (no double-execute)")
	}
	if err == nil {
		t.Fatal("expected wsServerError on ok=false")
	}
	if !strings.Contains(err.Error(), "permission denied") {
		t.Errorf("err = %v, want 'permission denied'", err)
	}
	var wsErr *wsServerError
	if !errors.As(err, &wsErr) {
		t.Errorf("err should be *wsServerError, got %T", err)
	}
}

// TestDispatchSubmitWireShape: DispatchSubmit builds
// the right CommandAction + payload + emits a
// submitDoneMsg.
func TestDispatchSubmitWireShape(t *testing.T) {
	srv := newWSWriteTestServer(t, true)
	client := api.NewClient(srv.URL(), "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	im.SetUseWsWriteForTest(true)
	cmd := im.DispatchSubmit(context.Background(), client, "session-1", "hello")
	if cmd == nil {
		t.Fatal("DispatchSubmit should return a cmd")
	}
	msg := cmd()
	sub, ok := msg.(submitDoneMsg)
	if !ok {
		t.Fatalf("DispatchSubmit cmd returned %T, want submitDoneMsg", msg)
	}
	if sub.PaneID != "session-1" {
		t.Errorf("PaneID = %q, want session-1", sub.PaneID)
	}
	if sub.Err != nil {
		t.Errorf("Err = %v, want nil", sub.Err)
	}
	// The server should have seen the submit action +
	// the prompt payload.
	if srv.gotRequest.Action != api.CommandSubmit {
		t.Errorf("Action = %q, want submit", srv.gotRequest.Action)
	}
	if !strings.Contains(string(srv.gotRequest.Payload), `"prompt":"hello"`) {
		t.Errorf("Payload = %s, want prompt=hello", string(srv.gotRequest.Payload))
	}
}

// TestDispatchApproveWireShape: DispatchApprove emits
// permissionDecisionMsg{Kind:"approve"} with the
// toolUseId + rule in the payload.
func TestDispatchApproveWireShape(t *testing.T) {
	srv := newWSWriteTestServer(t, true)
	client := api.NewClient(srv.URL(), "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	im.SetUseWsWriteForTest(true)
	cmd := im.DispatchApprove(context.Background(), client, "session-1", "tu-1", "rule-x")
	if cmd == nil {
		t.Fatal("DispatchApprove should return a cmd")
	}
	msg := cmd()
	dec, ok := msg.(permissionDecisionMsg)
	if !ok {
		t.Fatalf("DispatchApprove cmd returned %T, want permissionDecisionMsg", msg)
	}
	if dec.Kind != "approve" {
		t.Errorf("Kind = %q, want approve", dec.Kind)
	}
	if dec.Err != nil {
		t.Errorf("Err = %v, want nil", dec.Err)
	}
	if srv.gotRequest.Action != api.CommandApprove {
		t.Errorf("Action = %q, want approve", srv.gotRequest.Action)
	}
	if !strings.Contains(string(srv.gotRequest.Payload), `"toolUseId":"tu-1"`) {
		t.Errorf("Payload missing toolUseId: %s", string(srv.gotRequest.Payload))
	}
	if !strings.Contains(string(srv.gotRequest.Payload), `"rule":"rule-x"`) {
		t.Errorf("Payload missing rule: %s", string(srv.gotRequest.Payload))
	}
}

// TestDispatchDenyWireShape: DispatchDeny emits
// permissionDecisionMsg{Kind:"deny"} with reason +
// feedback in the payload.
func TestDispatchDenyWireShape(t *testing.T) {
	srv := newWSWriteTestServer(t, true)
	client := api.NewClient(srv.URL(), "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	im.SetUseWsWriteForTest(true)
	cmd := im.DispatchDeny(context.Background(), client, "session-1", "tu-1", "no", "explain")
	if cmd == nil {
		t.Fatal("DispatchDeny should return a cmd")
	}
	msg := cmd()
	dec, ok := msg.(permissionDecisionMsg)
	if !ok {
		t.Fatalf("DispatchDeny cmd returned %T, want permissionDecisionMsg", msg)
	}
	if dec.Kind != "deny" {
		t.Errorf("Kind = %q, want deny", dec.Kind)
	}
	if !strings.Contains(string(srv.gotRequest.Payload), `"reason":"no"`) {
		t.Errorf("Payload missing reason: %s", string(srv.gotRequest.Payload))
	}
	if !strings.Contains(string(srv.gotRequest.Payload), `"feedback":"explain"`) {
		t.Errorf("Payload missing feedback: %s", string(srv.gotRequest.Payload))
	}
}

// TestDispatchCancelWireShape: DispatchCancel emits
// cancelDoneMsg with ActiveExecutionCancelled=true.
func TestDispatchCancelWireShape(t *testing.T) {
	srv := newWSWriteTestServer(t, true)
	client := api.NewClient(srv.URL(), "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	im.SetUseWsWriteForTest(true)
	cmd := im.DispatchCancel(context.Background(), client, "session-1", "operator interrupt")
	if cmd == nil {
		t.Fatal("DispatchCancel should return a cmd")
	}
	msg := cmd()
	cancel, ok := msg.(cancelDoneMsg)
	if !ok {
		t.Fatalf("DispatchCancel cmd returned %T, want cancelDoneMsg", msg)
	}
	if cancel.Err != nil {
		t.Errorf("Err = %v, want nil", cancel.Err)
	}
	if !cancel.ActiveExecutionCancelled {
		t.Error("ActiveExecutionCancelled should be true on success")
	}
	if srv.gotRequest.Action != api.CommandCancel {
		t.Errorf("Action = %q, want cancel", srv.gotRequest.Action)
	}
	if !strings.Contains(string(srv.gotRequest.Payload), `"reason":"operator interrupt"`) {
		t.Errorf("Payload missing reason: %s", string(srv.gotRequest.Payload))
	}
}

// TestDispatchWriteGuards: dispatchWrite with nil
// client OR empty sessionID falls back to HTTP. The
// WS path requires both.
func TestDispatchWriteGuards(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	im.SetUseWsWriteForTest(true)
	// Empty sessionID with non-nil client → guard
	// fires, fall back to HTTP.
	called := false
	_, err := im.dispatchWrite(
		context.Background(), nil, "",
		api.CommandSubmit, nil,
		func(_ context.Context) error {
			called = true
			return nil
		},
	)
	if err != nil {
		t.Errorf("empty sessionID should fall back to HTTP, got err: %v", err)
	}
	if !called {
		t.Error("empty sessionID should fall back to HTTP")
	}
}

// TestDispatchWriteWSTimeoutFallsBack: an extremely
// short ctx deadline + an unreachable server forces a
// dial failure + fallback to HTTP. Verifies the
// context-budget handshake works.
func TestDispatchWriteWSTimeoutFallsBack(t *testing.T) {
	client := api.NewClient("http://127.0.0.1:1", "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, client, 0, nil, nil,
	)
	im.SetUseWsWriteForTest(true)
	httpCalled := false
	httpErr := errors.New("http called")
	// Very short ctx so the WS dial times out fast.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	usedWS, err := im.dispatchWrite(
		ctx, client, "session-1",
		api.CommandSubmit, nil,
		func(c context.Context) error {
			httpCalled = true
			return httpErr
		},
	)
	if usedWS {
		t.Error("WS path should fail / fall back")
	}
	if !httpCalled {
		t.Error("HTTP fallback should have run")
	}
	if err != httpErr {
		t.Errorf("err = %v, want %v", err, httpErr)
	}
}
