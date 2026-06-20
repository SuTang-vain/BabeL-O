// internal/loop/api/context_observer_test.go
//
// R6 transport-layer tests for the /v1/context/observe
// WebSocket subscriber. Mirrors the structure of
// `working_set_observer_test.go` (httptest.Server +
// `gorilla/websocket.Upgrader`) so the surface is verified
// against the actual server frame shapes documented in
// `src/nexus/routers/contextObserveRouter.ts` and
// `src/nexus/contextBroadcaster.ts`.
//
// Test matrix:
//
//   T1 — Snapshot → Assembled sequence reaches the events
//        channel in order; redaction summary populates.
//   T2 — Error frame `{type:'error', code:'MISSING_CWD'}`
//        is parsed into ContextObserverEvent.Err.
//   T3 — Close fn is idempotent (call 3 times, no panic).
//   T4 — Snapshot with `context: null` is allowed and
//        decodes cleanly with Snapshot.Context == nil.
//   T5 — sessionID empty → URL has no `sessionId` param;
//        non-empty → URL has `sessionId`.
//   T6 — RedactionMode "full" → URL includes `full=1`.
//   T7 — Unknown frame type emits an err but keeps reading.

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

// ctxObserverTestServer is the test harness for
// ObserveContext. Mirrors wsObserverTestServer.
type ctxObserverTestServer struct {
	server   *httptest.Server
	upgrader websocket.Upgrader
	conns    []*websocket.Conn
	requests []*http.Request
	mu       sync.Mutex
}

func newCtxObserverTestServer(t *testing.T) *ctxObserverTestServer {
	t.Helper()
	s := &ctxObserverTestServer{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/context/observe", s.handleObserve)
	s.server = httptest.NewServer(mux)
	t.Cleanup(s.server.Close)
	return s
}

func (s *ctxObserverTestServer) URL() string { return s.server.URL }

func (s *ctxObserverTestServer) handleObserve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.requests = append(s.requests, r.Clone(r.Context()))
	s.mu.Unlock()
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	s.mu.Lock()
	s.conns = append(s.conns, conn)
	s.mu.Unlock()
}

func (s *ctxObserverTestServer) sendFrames(t *testing.T, payloads ...string) {
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

// T1: Snapshot → Assembled sequence with redaction summary.
func TestObserveContextSnapshotAssembledSequence(t *testing.T) {
	s := newCtxObserverTestServer(t)
	c := NewClient(s.URL(), "test-key")

	events, errs, closeFn, err := c.ObserveContext(context.Background(), "/workspace", "", ContextObserveOpts{})
	if err != nil {
		t.Fatalf("ObserveContext: %v", err)
	}
	defer closeFn()

	s.sendFrames(t,
		`{"type":"assembled_snapshot","cwd":"/workspace","filter":{"sessionId":null},"redaction":"summary","context":{"redaction":{"systemPromptChars":1024,"messageCount":3,"messageChars":48,"blockCount":4,"cacheableBlockCount":3},"systemPromptBlocks":[{"id":"identity","cacheable":true},{"id":"working-set","cacheable":false}],"systemPromptTokenEstimate":256,"messagesTokenEstimate":12}}`,
		`{"type":"assembled","cwd":"/workspace","sessionId":"s1","redaction":"summary","context":{"redaction":{"systemPromptChars":2048,"messageCount":5,"messageChars":120,"blockCount":4,"cacheableBlockCount":3}},"timestamp":"2026-06-20T01:00:00Z"}`,
	)

	got := make([]ContextObserverEvent, 0, 2)
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

	if got[0].Type != "assembled_snapshot" || got[0].Snapshot == nil {
		t.Fatalf("event 0 = %+v, want assembled_snapshot with Snapshot set", got[0])
	}
	if got[0].Snapshot.Cwd != "/workspace" || got[0].Snapshot.Redaction != "summary" {
		t.Errorf("event 0 cwd/redaction = %+v", got[0].Snapshot)
	}
	if got[0].Snapshot.Context == nil {
		t.Fatalf("event 0 context must be populated")
	}
	if got[0].Snapshot.Context.Redaction.SystemPromptChars != 1024 ||
		got[0].Snapshot.Context.Redaction.BlockCount != 4 ||
		got[0].Snapshot.Context.Redaction.CacheableBlockCount != 3 {
		t.Errorf("event 0 redaction = %+v", got[0].Snapshot.Context.Redaction)
	}
	if len(got[0].Snapshot.Context.SystemPromptBlocks) != 2 {
		t.Errorf("event 0 blocks = %d, want 2", len(got[0].Snapshot.Context.SystemPromptBlocks))
	}

	if got[1].Type != "assembled" || got[1].Assembled == nil {
		t.Fatalf("event 1 = %+v, want assembled with Assembled set", got[1])
	}
	if got[1].Assembled.SessionID != "s1" || got[1].Assembled.Timestamp != "2026-06-20T01:00:00Z" {
		t.Errorf("event 1 sid/ts = %+v", got[1].Assembled)
	}
	if got[1].Assembled.Context == nil || got[1].Assembled.Context.Redaction.MessageCount != 5 {
		t.Errorf("event 1 redaction = %+v", got[1].Assembled.Context)
	}
}

// T2: Error frame parses into ContextObserverEvent.Err.
func TestObserveContextErrorFrame(t *testing.T) {
	s := newCtxObserverTestServer(t)
	c := NewClient(s.URL(), "")

	events, errs, closeFn, err := c.ObserveContext(context.Background(), "/workspace", "", ContextObserveOpts{})
	if err != nil {
		t.Fatalf("ObserveContext: %v", err)
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

// T3: Close fn is idempotent.
func TestObserveContextCloseIdempotent(t *testing.T) {
	s := newCtxObserverTestServer(t)
	c := NewClient(s.URL(), "")

	_, _, closeFn, err := c.ObserveContext(context.Background(), "/workspace", "", ContextObserveOpts{})
	if err != nil {
		t.Fatalf("ObserveContext: %v", err)
	}
	closeFn()
	closeFn() // must not panic
	closeFn() // must not panic
}

// T4: Snapshot with `context: null` decodes cleanly.
func TestObserveContextNullContextSnapshot(t *testing.T) {
	s := newCtxObserverTestServer(t)
	c := NewClient(s.URL(), "")

	events, _, closeFn, err := c.ObserveContext(context.Background(), "/workspace", "s2", ContextObserveOpts{})
	if err != nil {
		t.Fatalf("ObserveContext: %v", err)
	}
	defer closeFn()

	s.sendFrames(t,
		`{"type":"assembled_snapshot","cwd":"/workspace","filter":{"sessionId":"s2"},"redaction":"summary","context":null}`,
	)

	select {
	case ev, ok := <-events:
		if !ok {
			t.Fatal("events channel closed early")
		}
		if ev.Type != "assembled_snapshot" || ev.Snapshot == nil {
			t.Fatalf("event = %+v", ev)
		}
		if ev.Snapshot.Context != nil {
			t.Errorf("snapshot context = %+v, want nil", ev.Snapshot.Context)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for null-context snapshot")
	}
}

// T5: sessionID empty/non-empty controls the URL query
// param.
func TestObserveContextSessionIDQueryParam(t *testing.T) {
	t.Run("empty sessionID has no param", func(t *testing.T) {
		s := newCtxObserverTestServer(t)
		c := NewClient(s.URL(), "")
		_, _, closeFn, err := c.ObserveContext(context.Background(), "/workspace", "", ContextObserveOpts{})
		if err != nil {
			t.Fatalf("ObserveContext: %v", err)
		}
		defer closeFn()
		// Wait briefly for the request to land.
		time.Sleep(50 * time.Millisecond)
		s.mu.Lock()
		defer s.mu.Unlock()
		if len(s.requests) == 0 {
			t.Fatal("no request recorded")
		}
		if got := s.requests[0].URL.Query().Get("sessionId"); got != "" {
			t.Errorf("sessionId = %q, want empty", got)
		}
		if got := s.requests[0].URL.Query().Get("cwd"); got != "/workspace" {
			t.Errorf("cwd = %q, want /workspace", got)
		}
	})
	t.Run("non-empty sessionID is encoded", func(t *testing.T) {
		s := newCtxObserverTestServer(t)
		c := NewClient(s.URL(), "")
		_, _, closeFn, err := c.ObserveContext(context.Background(), "/workspace", "session-123", ContextObserveOpts{})
		if err != nil {
			t.Fatalf("ObserveContext: %v", err)
		}
		defer closeFn()
		time.Sleep(50 * time.Millisecond)
		s.mu.Lock()
		defer s.mu.Unlock()
		if len(s.requests) == 0 {
			t.Fatal("no request recorded")
		}
		if got := s.requests[0].URL.Query().Get("sessionId"); got != "session-123" {
			t.Errorf("sessionId = %q, want session-123", got)
		}
	})
}

// T6: RedactionMode "full" sets ?full=1.
func TestObserveContextFullModeQueryParam(t *testing.T) {
	s := newCtxObserverTestServer(t)
	c := NewClient(s.URL(), "")
	_, _, closeFn, err := c.ObserveContext(context.Background(), "/workspace", "", ContextObserveOpts{RedactionMode: "full"})
	if err != nil {
		t.Fatalf("ObserveContext: %v", err)
	}
	defer closeFn()
	time.Sleep(50 * time.Millisecond)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.requests) == 0 {
		t.Fatal("no request recorded")
	}
	if got := s.requests[0].URL.Query().Get("full"); got != "1" {
		t.Errorf("full = %q, want 1", got)
	}
}

// T7: Unknown frame type emits an err but keeps reading.
func TestObserveContextUnknownFrameType(t *testing.T) {
	s := newCtxObserverTestServer(t)
	c := NewClient(s.URL(), "")
	events, errs, closeFn, err := c.ObserveContext(context.Background(), "/workspace", "", ContextObserveOpts{})
	if err != nil {
		t.Fatalf("ObserveContext: %v", err)
	}
	defer closeFn()

	s.sendFrames(t,
		`{"type":"future_event_type","payload":"ignored"}`,
		`{"type":"assembled_snapshot","cwd":"/workspace","filter":{"sessionId":null},"redaction":"summary","context":null}`,
	)

	// First we expect an err (unknown type) — non-fatal.
	select {
	case e := <-errs:
		if !strings.Contains(e.Error(), "unknown frame type") {
			t.Errorf("err = %v, want 'unknown frame type'", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for unknown-frame err")
	}
	// Then the second frame should still arrive — proving
	// the reader did not abort.
	select {
	case ev, ok := <-events:
		if !ok {
			t.Fatal("events channel closed after unknown frame")
		}
		if ev.Type != "assembled_snapshot" {
			t.Errorf("ev = %+v, want assembled_snapshot", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for next valid frame")
	}
}
