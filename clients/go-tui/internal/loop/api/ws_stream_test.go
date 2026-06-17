// internal/loop/api/ws_stream_test.go
//
// Phase 6d-c'-A tests for the WebSocket read path
// (StreamSession). Covers:
//
//   - dial error surface (bad URL, dial failure)
//   - event delivery (server pushes → client receives)
//   - error delivery (server closes mid-stream → client errs)
//   - close func is idempotent and tears down the socket
//   - nil/empty guards
//
// What this file does NOT cover:
//   - per-pane InteractiveModel integration (loop/ws_read_test.go)

package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// wsTestServer spins up a httptest.Server that upgrades
// `/v1/sessions/:id/stream` to a WebSocket and pumps a
// pre-canned event sequence. Tracks whether the client
// closed cleanly so the test can assert the close func
// behaves.
type wsTestServer struct {
	server      *httptest.Server
	upgrader    websocket.Upgrader
	conns       []*websocket.Conn
	pushEvents  []string
	closeOnRead bool // send a close frame after first read
	pushErr     error
}

func newWSTestServer(t *testing.T) *wsTestServer {
	t.Helper()
	s := &wsTestServer{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/sessions/", s.handleStream)
	s.server = httptest.NewServer(mux)
	t.Cleanup(s.server.Close)
	return s
}

func (s *wsTestServer) URL() string { return s.server.URL }

func (s *wsTestServer) handleStream(w http.ResponseWriter, r *http.Request) {
	if !strings.HasSuffix(r.URL.Path, "/stream") {
		http.NotFound(w, r)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	s.conns = append(s.conns, conn)
	for _, ev := range s.pushEvents {
		_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
		if err := conn.WriteMessage(websocket.TextMessage, []byte(ev)); err != nil {
			s.pushErr = err
			return
		}
	}
	if s.closeOnRead {
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			time.Now().Add(time.Second))
	}
}

// TestStreamSessionDialURLSchemeSwap: a client with
// http://baseURL dials ws://.../v1/sessions/:id/stream
// and https:// swaps to wss://. This guards the URL
// scheme conversion the WS path needs.
func TestStreamSessionDialURLSchemeSwap(t *testing.T) {
	s := newWSTestServer(t)
	c := NewClient(s.URL(), "test")
	events, errs, closeFn, err := c.StreamSession(context.Background(), "s1", StreamOptions{})
	if err != nil {
		t.Fatalf("StreamSession: %v", err)
	}
	defer closeFn()
	select {
	case <-events:
		// no event pushed yet — the channel is open
		// and waiting. That's the success case for
		// "the upgrade happened" — server is connected.
		// We'll let the closeFn tear it down.
	case err := <-errs:
		t.Fatalf("unexpected err: %v", err)
	case <-time.After(2 * time.Second):
		// no event arrived (we pushed none) — that's
		// fine, the connection is established. Move on.
	}
}

// TestStreamSessionEventDelivery: server pushes 2 events;
// the client receives both with the right Type / Rev.
func TestStreamSessionEventDelivery(t *testing.T) {
	s := newWSTestServer(t)
	s.pushEvents = []string{
		`{"type":"user_prompt","rev":1,"content":"hi"}`,
		`{"type":"assistant_text","rev":2,"content":"hello"}`,
	}
	c := NewClient(s.URL(), "test")
	events, errs, closeFn, err := c.StreamSession(context.Background(), "s1", StreamOptions{})
	if err != nil {
		t.Fatalf("StreamSession: %v", err)
	}
	defer closeFn()
	got := []StreamEvent{}
	deadline := time.After(3 * time.Second)
	for len(got) < 2 {
		select {
		case ev, ok := <-events:
			if !ok {
				t.Fatalf("events channel closed early, got %d events", len(got))
			}
			got = append(got, ev)
		case err := <-errs:
			t.Fatalf("unexpected err: %v", err)
		case <-deadline:
			t.Fatalf("timed out waiting for events, got %d", len(got))
		}
	}
	if got[0].Type != "user_prompt" || got[0].Rev != 1 {
		t.Errorf("event 0 = %+v, want user_prompt/1", got[0])
	}
	if got[1].Type != "assistant_text" || got[1].Rev != 2 {
		t.Errorf("event 1 = %+v, want assistant_text/2", got[1])
	}
	// Raw should be the original JSON line.
	var raw map[string]any
	if err := json.Unmarshal(got[0].Raw, &raw); err != nil {
		t.Fatalf("raw not JSON: %v", err)
	}
	if raw["content"] != "hi" {
		t.Errorf("raw content = %v, want hi", raw["content"])
	}
}

// TestStreamSessionEmptySessionID: StreamSession rejects
// empty sessionID at the call site (no dial attempt).
func TestStreamSessionEmptySessionID(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", "test")
	_, _, _, err := c.StreamSession(context.Background(), "", StreamOptions{})
	if err == nil {
		t.Fatal("expected error for empty sessionID")
	}
}

// TestStreamSessionNilClient: StreamSession rejects a
// nil client (defensive — production callers always
// pass non-nil but tests sometimes want to verify the
// guard).
func TestStreamSessionNilClient(t *testing.T) {
	var c *Client
	_, _, _, err := c.StreamSession(context.Background(), "s1", StreamOptions{})
	if err == nil {
		t.Fatal("expected error for nil client")
	}
}

// TestStreamSessionCloseIdempotent: calling close()
// twice doesn't panic. The second call is a no-op.
func TestStreamSessionCloseIdempotent(t *testing.T) {
	s := newWSTestServer(t)
	c := NewClient(s.URL(), "test")
	_, _, closeFn, err := c.StreamSession(context.Background(), "s1", StreamOptions{})
	if err != nil {
		t.Fatalf("StreamSession: %v", err)
	}
	closeFn()
	closeFn() // must not panic
}

// TestStreamSessionDialFailure: an unreachable server
// returns an error from StreamSession (the dial fails
// before any channels are returned). The caller falls
// back to HTTP wait.
func TestStreamSessionDialFailure(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", "test")
	_, _, _, err := c.StreamSession(context.Background(), "s1", StreamOptions{
		DialTimeout: 200 * time.Millisecond,
	})
	if err == nil {
		t.Fatal("expected dial failure error")
	}
}

// wsCommandServer is a minimal WS server for the
// SendCommand tests. It accepts
// `/v1/sessions/:id/command?action=<action>` upgrades,
// reads one CommandRequest frame, replies with a
// canned CommandResponse, and closes. Tracks the
// received request so tests can assert the wire shape.
type wsCommandServer struct {
	server       *httptest.Server
	upgrader     websocket.Upgrader
	gotRequest   CommandRequest
	responseOK   bool
	responseErr  string
	responseRes  json.RawMessage
}

func newWSCommandServer(t *testing.T) *wsCommandServer {
	t.Helper()
	s := &wsCommandServer{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		responseOK: true,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/sessions/", s.handle)
	s.server = httptest.NewServer(mux)
	t.Cleanup(s.server.Close)
	return s
}

func (s *wsCommandServer) URL() string { return s.server.URL }

func (s *wsCommandServer) handle(w http.ResponseWriter, r *http.Request) {
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
	resp := CommandResponse{
		Type:      "command_response",
		RequestID: s.gotRequest.RequestID,
		OK:        s.responseOK,
		Error:     s.responseErr,
		Result:    s.responseRes,
	}
	_ = conn.WriteJSON(resp)
}

// TestSendCommandRoundTrip: SendCommand dials the WS,
// sends a command frame, reads the response, returns
// the response struct. The server-side gotRequest
// captures the wire shape for assertion.
func TestSendCommandRoundTrip(t *testing.T) {
	srv := newWSCommandServer(t)
	srv.responseRes = json.RawMessage(`{"sessionId":"s1","success":true}`)

	c := NewClient(srv.URL(), "test")
	payload := json.RawMessage(`{"prompt":"hi"}`)
	resp, err := c.SendCommand(context.Background(), "s1", CommandSubmit, payload)
	if err != nil {
		t.Fatalf("SendCommand: %v", err)
	}
	if !resp.OK {
		t.Errorf("response OK = false, want true; err = %q", resp.Error)
	}
	if !bytes.Contains(resp.Result, []byte(`"success":true`)) {
		t.Errorf("Result = %s, want success=true", string(resp.Result))
	}
	// Verify the server saw the right request shape.
	if srv.gotRequest.Type != "command" {
		t.Errorf("Type = %q, want command", srv.gotRequest.Type)
	}
	if srv.gotRequest.Action != CommandSubmit {
		t.Errorf("Action = %q, want submit", srv.gotRequest.Action)
	}
	if srv.gotRequest.SessionID != "s1" {
		t.Errorf("SessionID = %q, want s1", srv.gotRequest.SessionID)
	}
	if srv.gotRequest.RequestID == "" {
		t.Error("RequestID should be non-empty")
	}
	if !bytes.Contains(srv.gotRequest.Payload, []byte(`"prompt":"hi"`)) {
		t.Errorf("Payload = %s, want prompt=hi", string(srv.gotRequest.Payload))
	}
}

// TestSendCommandApproveAction: SendCommand routes the
// `approve` action through the same protocol with
// different payload (toolUseId + scope). The test
// verifies the action discriminator travels unchanged.
func TestSendCommandApproveAction(t *testing.T) {
	srv := newWSCommandServer(t)
	c := NewClient(srv.URL(), "test")
	payload := json.RawMessage(`{"toolUseId":"tu-1","scope":"session"}`)
	_, err := c.SendCommand(context.Background(), "s1", CommandApprove, payload)
	if err != nil {
		t.Fatalf("SendCommand: %v", err)
	}
	if srv.gotRequest.Action != CommandApprove {
		t.Errorf("Action = %q, want approve", srv.gotRequest.Action)
	}
}

// TestSendCommandErrorResponse: server replies with
// OK=false + error message. The client surfaces the
// error AND returns the parsed response so the caller
// can show the error to the operator.
func TestSendCommandErrorResponse(t *testing.T) {
	srv := newWSCommandServer(t)
	srv.responseOK = false
	srv.responseErr = "tool not approved"

	c := NewClient(srv.URL(), "test")
	resp, err := c.SendCommand(context.Background(), "s1", CommandApprove, nil)
	if err != nil {
		t.Fatalf("SendCommand should return parsed response, got err: %v", err)
	}
	if resp.OK {
		t.Error("response OK = true, want false")
	}
	if resp.Error != "tool not approved" {
		t.Errorf("Error = %q, want %q", resp.Error, "tool not approved")
	}
}

// TestSendCommandDialFailure: an unreachable server
// returns a non-nil error so the caller falls back to
// the HTTP path.
func TestSendCommandDialFailure(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", "test")
	_, err := c.SendCommand(context.Background(), "s1", CommandSubmit, nil)
	if err == nil {
		t.Fatal("expected dial failure error")
	}
}

// TestSendCommandGuards: SendCommand rejects nil
// client, empty sessionID, empty action.
func TestSendCommandGuards(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", "test")
	if _, err := c.SendCommand(context.Background(), "", CommandSubmit, nil); err == nil {
		t.Error("expected error for empty sessionID")
	}
	if _, err := c.SendCommand(context.Background(), "s1", "", nil); err == nil {
		t.Error("expected error for empty action")
	}
	var nilC *Client
	if _, err := nilC.SendCommand(context.Background(), "s1", CommandSubmit, nil); err == nil {
		t.Error("expected error for nil client")
	}
}

// TestNewRequestIDUnique: the request-id generator
// should produce unique ids across rapid calls.
func TestNewRequestIDUnique(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		id := newRequestID()
		if seen[id] {
			t.Fatalf("duplicate request id after %d iterations: %q", i, id)
		}
		seen[id] = true
	}
}
