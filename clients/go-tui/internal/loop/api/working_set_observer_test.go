// internal/loop/api/working_set_observer_test.go
//
// PR-17c (B1) tests for the /v1/working-set/observe
// WebSocket subscriber. Mirrors the structure of
// `api/ws_stream_test.go` (httptest.Server + manual
// `gorilla/websocket.Upgrader`) so the surface is
// verified against the actual server frame shapes
// documented in `src/nexus/app.ts:3913-3986`.
//
// Test matrix:
//
//   T1 — Snapshot → Updated → Reset sequence reaches the
//        events channel in order and the discriminator
//        populates the right pointer field on each event.
//   T2 — Error frame `{type:'error', code:'MISSING_CWD'}`
//        is parsed into WorkingSetObserverEvent.Err.
//   T3 — Close fn is idempotent (call 3 times, no panic).
//   T4 — Server-initiated close (1011) → caller sees the
//        errs channel emit a read error.
//   T5 — Context cancellation during dial → returns dial
//        error.
//   T6 — sessionID empty → URL has no `sessionId` param.
//   T7 — sessionID non-empty → URL has `sessionId` param.

package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// wsObserverTestServer is the test harness for
// ObserveWorkingSet. It upgrades the request, then
// replays a scripted sequence of frame payloads.
type wsObserverTestServer struct {
	server   *httptest.Server
	upgrader websocket.Upgrader
	conns    []*websocket.Conn
	mu       sync.Mutex
}

func newWSObserverTestServer(t *testing.T) *wsObserverTestServer {
	t.Helper()
	s := &wsObserverTestServer{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/working-set/observe", s.handleObserve)
	s.server = httptest.NewServer(mux)
	t.Cleanup(s.server.Close)
	return s
}

func (s *wsObserverTestServer) URL() string { return s.server.URL }

// handleObserve upgrades the request, then sends the
// script of frames recorded on the server. When the
// script is empty the connection stays open until the
// caller closes it — matches the StreamSession test
// pattern.
func (s *wsObserverTestServer) handleObserve(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	s.mu.Lock()
	s.conns = append(s.conns, conn)
	s.mu.Unlock()
}

func (s *wsObserverTestServer) sendFrames(t *testing.T, payloads ...string) {
	t.Helper()
	s.mu.Lock()
	conns := append([]*websocket.Conn(nil), s.conns...)
	s.mu.Unlock()
	if len(conns) == 0 {
		t.Fatalf("no connection recorded; did the client dial?")
	}
	conn := conns[len(conns)-1]
	for _, p := range payloads {
		_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
		if err := conn.WriteMessage(websocket.TextMessage, []byte(p)); err != nil {
			t.Fatalf("send frame: %v", err)
		}
	}
}

func (s *wsObserverTestServer) closeWith(status int, reason string) {
	s.mu.Lock()
	conns := append([]*websocket.Conn(nil), s.conns...)
	s.mu.Unlock()
	if len(conns) == 0 {
		return
	}
	conn := conns[len(conns)-1]
	_ = conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(status, reason),
		time.Now().Add(time.Second))
	_ = conn.Close()
}

// T1: Snapshot → Updated → Reset reaches the events
// channel in order with the right pointer field
// populated on each event.
func TestObserveWorkingSetSnapshotUpdatedResetSequence(t *testing.T) {
	s := newWSObserverTestServer(t)
	c := NewClient(s.URL(), "test-key")

	events, errs, closeFn, err := c.ObserveWorkingSet(context.Background(), "/workspace", "", ObserveOpts{})
	if err != nil {
		t.Fatalf("ObserveWorkingSet: %v", err)
	}
	defer closeFn()

	s.sendFrames(t,
		`{"type":"working_set_snapshot","cwd":"/workspace","filter":{"sessionId":null},"sessions":[{"sessionId":"s1","workspaceId":"w1","entries":[{"key":"role","value":"bbl","updatedAt":"2026-06-17T00:00:00Z","confidence":0.9}],"version":3,"updatedAt":"2026-06-17T00:00:00Z"}]}`,
		`{"type":"working_set_updated","sessionId":"s1","workspaceId":"w1","ws":{"sessionId":"s1","workspaceId":"w1","entries":[{"key":"role","value":"bbl","updatedAt":"2026-06-17T00:00:01Z","confidence":0.95}],"version":4,"updatedAt":"2026-06-17T00:00:01Z"},"timestamp":"2026-06-17T00:00:01Z"}`,
		`{"type":"working_set_reset","sessionId":"s1","workspaceId":"w1","timestamp":"2026-06-17T00:00:02Z"}`,
	)

	got := make([]WorkingSetObserverEvent, 0, 3)
	deadline := time.After(3 * time.Second)
	for len(got) < 3 {
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

	if got[0].Type != "working_set_snapshot" || got[0].Snapshot == nil {
		t.Fatalf("event 0 = %+v, want working_set_snapshot with Snapshot set", got[0])
	}
	if got[0].Snapshot.Cwd != "/workspace" || len(got[0].Snapshot.Sessions) != 1 {
		t.Errorf("event 0 payload = %+v", got[0].Snapshot)
	}
	if got[0].Snapshot.Sessions[0].Entries[0].Key != "role" {
		t.Errorf("event 0 entry key = %q, want role", got[0].Snapshot.Sessions[0].Entries[0].Key)
	}

	if got[1].Type != "working_set_updated" || got[1].Updated == nil {
		t.Fatalf("event 1 = %+v, want working_set_updated with Updated set", got[1])
	}
	if got[1].Updated.SessionID != "s1" || got[1].Updated.WorkingSet.Version != 4 {
		t.Errorf("event 1 payload = %+v", got[1].Updated)
	}

	if got[2].Type != "working_set_reset" || got[2].Reset == nil {
		t.Fatalf("event 2 = %+v, want working_set_reset with Reset set", got[2])
	}
	if got[2].Reset.SessionID != "s1" {
		t.Errorf("event 2 payload = %+v", got[2].Reset)
	}
}

// T2: Error frame is parsed into WorkingSetObserverEvent.Err.
func TestObserveWorkingSetErrorFrame(t *testing.T) {
	s := newWSObserverTestServer(t)
	c := NewClient(s.URL(), "")

	events, errs, closeFn, err := c.ObserveWorkingSet(context.Background(), "/workspace", "", ObserveOpts{})
	if err != nil {
		t.Fatalf("ObserveWorkingSet: %v", err)
	}
	defer closeFn()

	s.sendFrames(t, `{"type":"error","code":"MISSING_CWD","message":"cwd query param is required"}`)

	select {
	case ev, ok := <-events:
		if !ok {
			t.Fatal("events channel closed before error frame arrived")
		}
		if ev.Type != "error" || ev.Err == nil {
			t.Fatalf("event = %+v, want error with Err set", ev)
		}
		if ev.Err.Code != "MISSING_CWD" {
			t.Errorf("error code = %q, want MISSING_CWD", ev.Err.Code)
		}
	case err := <-errs:
		t.Fatalf("unexpected err before error frame: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for error frame")
	}
}

// T3: Close fn is idempotent (call 3 times, no panic).
func TestObserveWorkingSetCloseIdempotent(t *testing.T) {
	s := newWSObserverTestServer(t)
	c := NewClient(s.URL(), "")

	_, _, closeFn, err := c.ObserveWorkingSet(context.Background(), "/workspace", "", ObserveOpts{})
	if err != nil {
		t.Fatalf("ObserveWorkingSet: %v", err)
	}
	closeFn()
	closeFn() // must not panic
	closeFn() // must not panic
}

// T4: Server-initiated close (1011) → caller sees the
// errs channel emit a read error.
func TestObserveWorkingSetServerCloseSurfacesError(t *testing.T) {
	s := newWSObserverTestServer(t)
	c := NewClient(s.URL(), "")

	events, errs, closeFn, err := c.ObserveWorkingSet(context.Background(), "/workspace", "", ObserveOpts{})
	if err != nil {
		t.Fatalf("ObserveWorkingSet: %v", err)
	}
	defer closeFn()

	// Brief delay so the client reader goroutine is
	// definitely parked on ReadMessage before we close.
	time.Sleep(50 * time.Millisecond)
	s.closeWith(websocket.CloseInternalServerErr, "load failed")

	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("expected non-nil err on server-initiated close")
		}
		// closeInternalServerErr surfaces as a *websocket.CloseError
		// carrying the server's status. We don't pin the
		// concrete error type — only that the errs
		// channel got a read error.
		_ = err
	case ev, ok := <-events:
		t.Fatalf("unexpected event on close: %+v (ok=%v)", ev, ok)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for read error after server close")
	}
}

// T5: Context cancellation during dial → returns dial error.
func TestObserveWorkingSetContextCancelDuringDial(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", "")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, _, _, err := c.ObserveWorkingSet(ctx, "/workspace", "", ObserveOpts{
		DialTimeout: 1 * time.Second,
	})
	if err == nil {
		t.Fatal("expected dial failure when context is cancelled")
	}
}

// T6: sessionID empty → URL has no sessionId param.
func TestObserveWorkingSetEmptySessionIDOmittedFromURL(t *testing.T) {
	var capturedQuery string
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/working-set/observe", func(w http.ResponseWriter, r *http.Request) {
		capturedQuery = r.URL.RawQuery
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		_ = conn.Close()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := NewClient(srv.URL, "")
	if _, _, closeFn, err := c.ObserveWorkingSet(context.Background(), "/workspace", "", ObserveOpts{}); err != nil {
		t.Fatalf("ObserveWorkingSet: %v", err)
	} else {
		_ = closeFn
	}
	if !strings.Contains(capturedQuery, "cwd=%2Fworkspace") {
		t.Errorf("query missing cwd: %s", capturedQuery)
	}
	if strings.Contains(capturedQuery, "sessionId=") {
		t.Errorf("query should not include sessionId when empty: %s", capturedQuery)
	}
}

// T7: sessionID non-empty → URL has sessionId param.
func TestObserveWorkingSetSessionIDInURL(t *testing.T) {
	var capturedQuery string
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/working-set/observe", func(w http.ResponseWriter, r *http.Request) {
		capturedQuery = r.URL.RawQuery
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		_ = conn.Close()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := NewClient(srv.URL, "")
	if _, _, closeFn, err := c.ObserveWorkingSet(context.Background(), "/workspace", "s-42", ObserveOpts{}); err != nil {
		t.Fatalf("ObserveWorkingSet: %v", err)
	} else {
		_ = closeFn
	}
	if !strings.Contains(capturedQuery, "sessionId=s-42") {
		t.Errorf("query missing sessionId: %s", capturedQuery)
	}
	if !strings.Contains(capturedQuery, "cwd=%2Fworkspace") {
		t.Errorf("query missing cwd: %s", capturedQuery)
	}
}
