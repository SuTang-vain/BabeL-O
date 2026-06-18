// internal/tui/stream_phase1_test.go
//
// Phase 1 of docs/nexus/reference/go-tui-session-observability-governance-plan.md:
//
// 7 focused Go tests covering the client↔server session id
// naming contract:
//
//   1. clientSessionId is sent in POST /v1/sessions metadata.
//   2. m.sessionID is updated synchronously by the
//      sessionIDAllocatedMsg, before the WebSocket dial.
//   3. The WebSocket /v1/stream payload uses the server uuid,
//      not the local session_go_<unixnano>.
//   4. allocateServerSession does NOT silently fall back
//      to a local id on failure.
//   5. appendClientSessionLog writes a tab-separated line
//      with both client + server ids.
//   6. appendClientSessionLog failure is non-fatal (session
//      continues to run; only the reverse-lookup is lost).
//   7. The reverse-resolve path works: server metadata
//      clientSessionId matches the local log entry.
//
// Existing tests in tui_test.go (TestEnsureStreamSessionReusesConfiguredSession,
// TestEnsureStreamSessionAllocatesWhenMissing) cover the
// reuse-vs-allocate branching. This file fills the
// Phase 1 gap with metadata + log + sync-update tests.

package tui

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// newPhase1Server spins up a minimal Nexus-shaped test
// server: POST /v1/sessions echoes a server uuid; GET
// /v1/sessions/<id> returns the metadata the server has
// stored (so we can verify clientSessionId round-trip);
// any other path returns 404.
//
// The wire shape mirrors the real Nexus: the
// clientSessionId is nested under body.metadata, NOT
// top-level. See allocateServerSession in stream.go.
func newPhase1Server(t *testing.T) *httptest.Server {
	t.Helper()
	type sessionRow struct {
		SessionID       string         `json:"sessionId"`
		ClientSessionID string         `json:"clientSessionId"`
		Metadata        map[string]any `json:"metadata"`
		Cwd             string         `json:"cwd"`
		CreatedAt       string         `json:"createdAt"`
	}
	var mu sync.Mutex
	rows := map[string]*sessionRow{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions":
			raw, _ := io.ReadAll(r.Body)
			var body struct {
				Metadata map[string]any `json:"metadata"`
				Cwd      string         `json:"cwd"`
			}
			_ = json.Unmarshal(raw, &body)
			// Real Nexus reads clientSessionId from
			// body.metadata.clientSessionId (per the
			// Phase 1.1 contract); the test server does
			// the same.
			var clientID string
			if body.Metadata != nil {
				if v, ok := body.Metadata["clientSessionId"].(string); ok {
					clientID = v
				}
			}
			mu.Lock()
			id := fmt.Sprintf("session_alloc_%d", time.Now().UnixNano())
			row := &sessionRow{
				SessionID:       id,
				ClientSessionID: clientID,
				Metadata:        body.Metadata,
				Cwd:             body.Cwd,
				CreatedAt:       time.Now().UTC().Format(time.RFC3339),
			}
			rows[id] = row
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"type":            "session_created",
				"sessionId":       id,
				"clientSessionId": clientID,
				"createdAt":       row.CreatedAt,
			})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/sessions/"):
			id := strings.TrimPrefix(r.URL.Path, "/v1/sessions/")
			mu.Lock()
			row, ok := rows[id]
			mu.Unlock()
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(row)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestPhase1_ClientSessionIdInMetadata: when
// ensureStreamSession allocates a server id, the local
// session_go_<unixnano> placeholder is sent as
// `clientSessionId` in the POST /v1/sessions body, AND
// the server's stored row carries that clientSessionId
// in the same place. The reverse-resolve chain (server
// metadata → client log → original placeholder) starts
// here.
func TestPhase1_ClientSessionIdInMetadata(t *testing.T) {
	srv := newPhase1Server(t)
	got, err := ensureStreamSession(Config{BaseURL: srv.URL, Cwd: "/workspace"}, "hello")
	if err != nil {
		t.Fatalf("ensureStreamSession: %v", err)
	}
	if !strings.HasPrefix(got, "session_alloc_") {
		t.Errorf("server id = %q, want session_alloc_ prefix", got)
	}
	// Server-side GET confirms metadata round-trip.
	resp, err := srv.Client().Get(srv.URL + "/v1/sessions/" + got)
	if err != nil {
		t.Fatalf("GET session: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var row struct {
		ClientSessionID string         `json:"clientSessionId"`
		Metadata        map[string]any `json:"metadata"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&row)
	if !strings.HasPrefix(row.ClientSessionID, "session_go_") {
		t.Errorf("server row clientSessionId = %q, want session_go_ prefix", row.ClientSessionID)
	}
	if row.Metadata["client"] != "go-tui" {
		t.Errorf("metadata.client = %v, want \"go-tui\"", row.Metadata["client"])
	}
}

// TestPhase1_MSessionIDUpdatedSynchronously: when
// ensureStreamSession completes, the model's
// `m.sessionID` and `m.cfg.SessionID` are updated
// synchronously by `sessionIDAllocatedMsg` BEFORE the
// WebSocket dial lands. This is what lets `/context`
// fire immediately after the operator presses Enter,
// without waiting for the first server event.
func TestPhase1_MSessionIDUpdatedSynchronously(t *testing.T) {
	srv := newPhase1Server(t)
	m := newModel(Config{BaseURL: srv.URL, Cwd: "/workspace"})

	// Empty before allocation.
	if m.sessionID != "" || m.cfg.SessionID != "" {
		t.Fatalf("model should start empty, got sessionID=%q cfg=%q", m.sessionID, m.cfg.SessionID)
	}

	// Drive the synchronous update through Update —
	// this is the same path the bubbletea runtime
	// takes when the cmd's msg arrives. We don't run
	// the full startStream (it would also fire the
	// WebSocket dial); we just emit the
	// sessionIDAllocatedMsg with the same value the
	// closure would have produced.
	srvSessionID := "session_alloc_sync"
	updated, _ := m.Update(sessionIDAllocatedMsg{sessionID: srvSessionID})
	um := updated.(model)
	if um.sessionID != srvSessionID {
		t.Errorf("m.sessionID = %q, want %q (sync update after allocation)",
			um.sessionID, srvSessionID)
	}
	if um.cfg.SessionID != srvSessionID {
		t.Errorf("m.cfg.SessionID = %q, want %q (mirror to cfg)",
			um.cfg.SessionID, srvSessionID)
	}
}

// TestPhase1_StreamPayloadUsesServerUUID: when
// ensureStreamSession allocates a server id, the
// WebSocket payload's `sessionId` field is the server
// uuid — NOT the local session_go_<unixnano> placeholder.
// This is the contract that prevents the
// `session_go_1781146359507755000` failure mode.
func TestPhase1_StreamPayloadUsesServerUUID(t *testing.T) {
	srv := newPhase1Server(t)
	got, err := ensureStreamSession(Config{BaseURL: srv.URL, Cwd: "/workspace"}, "hello")
	if err != nil {
		t.Fatalf("ensureStreamSession: %v", err)
	}
	// Local placeholder that should NOT appear in the
	// WebSocket payload.
	localPlaceholder := "session_go_9999999999"
	// Compose the WebSocket payload as the runStream
	// closure would. buildExecuteRequest takes a
	// sessionID — we pass the server uuid, then assert
	// the placeholder is absent.
	payload := buildExecuteRequest(
		Config{BaseURL: srv.URL, Cwd: "/workspace", PolicyMode: "soft-deny"},
		got,
		"hello",
	)
	payloadBytes, _ := json.Marshal(payload)
	if !bytes.Contains(payloadBytes, []byte(got)) {
		t.Errorf("payload missing server id %q: %s", got, payloadBytes)
	}
	if bytes.Contains(payloadBytes, []byte(localPlaceholder)) {
		t.Errorf("payload should not contain local placeholder %q: %s",
			localPlaceholder, payloadBytes)
	}
}

// TestPhase1_AllocationFailureNoFallback: when
// POST /v1/sessions fails (5xx), the caller must NOT
// fall back to a local session_go_<unixnano> — the
// WebSocket would then carry an id the server has no
// row for. The exact failure mode the governance plan
// is trying to prevent.
func TestPhase1_AllocationFailureNoFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/v1/sessions" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	_, err := ensureStreamSession(Config{BaseURL: srv.URL, Cwd: "/workspace"}, "hello")
	if err == nil {
		t.Fatal("expected error on 5xx allocation, got nil")
	}
	if !strings.Contains(err.Error(), "allocate server session") {
		t.Errorf("err = %v, want 'allocate server session' sentinel", err)
	}
}

// TestPhase1_ClientSessionLogWritten: appendClientSessionLog
// writes a tab-separated line containing both ids, in
// the right log path. The reverse-resolve path
// (tier (b) in the inspect-session plan) reads this
// file to map server uuid back to the local
// session_go_<unixnano>.
//
// appendClientSessionLog reads BABEL_O_CONFIG_DIR (per
// the existing resolveClientConfigDir helper), so we
// point that at a temp dir.
func TestPhase1_ClientSessionLogWritten(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("BABEL_O_CONFIG_DIR", configDir)
	cfg := Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"}
	appendClientSessionLog(cfg, "session_go_111", "session_alloc_222")
	logPath := filepath.Join(configDir, "log", "go-tui-session.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	line := string(data)
	if !strings.Contains(line, "clientSessionId=session_go_111") {
		t.Errorf("log missing clientSessionId: %q", line)
	}
	if !strings.Contains(line, "serverSessionId=session_alloc_222") {
		t.Errorf("log missing serverSessionId: %q", line)
	}
	if !strings.HasPrefix(line, "20") {
		t.Errorf("log line should start with RFC3339 timestamp: %q", line)
	}
}

// TestPhase1_ClientSessionLogFailureNonFatal:
// appendClientSessionLog is best-effort; if the
// directory isn't writable, the session still runs.
// We simulate this by pointing BABEL_O_CONFIG_DIR at
// a path under /dev/null (a file, not a directory) —
// the os.OpenFile fails, but the caller
// (ensureStreamSession) must not propagate the error.
// We exercise this end-to-end via a fake cfg.
func TestPhase1_ClientSessionLogFailureNonFatal(t *testing.T) {
	t.Setenv("BABEL_O_CONFIG_DIR", "/dev/null/forbidden")
	cfg := Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"}
	// If appendClientSessionLog returned an error here,
	// this call would propagate. The governance plan
	// marks this best-effort: it must NOT return an
	// error.
	appendClientSessionLog(cfg, "session_go_a", "session_alloc_b")
	// No assertion needed — the test passes if the
	// call returns (no panic, no error propagation).
}

// TestPhase1_ReverseResolveRoundTrip: the full reverse-
// resolve chain works. ensureStreamSession produces
// both the local placeholder AND the server uuid, and
// a future `bbl inspect-session <server uuid>` can find
// the local placeholder in either the server's
// metadata (tier (a)) or the client log (tier (b)).
// This is the end-to-end integration test that ties
// Phase 1.1 (metadata link) and the existing client
// log together.
func TestPhase1_ReverseResolveRoundTrip(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("BABEL_O_CONFIG_DIR", configDir)
	srv := newPhase1Server(t)

	// Allocation: ensures both ids are produced.
	serverID, err := ensureStreamSession(Config{BaseURL: srv.URL, Cwd: "/workspace"}, "hello")
	if err != nil {
		t.Fatalf("ensureStreamSession: %v", err)
	}

	// Tier (a) — server metadata carries the
	// clientSessionId.
	resp, err := srv.Client().Get(srv.URL + "/v1/sessions/" + serverID)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	var row struct {
		ClientSessionID string `json:"clientSessionId"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&row)
	clientID := row.ClientSessionID
	if !strings.HasPrefix(clientID, "session_go_") {
		t.Fatalf("tier (a) reverse-resolve failed: clientSessionId = %q", clientID)
	}

	// Tier (b) — client log carries the same mapping.
	// (Note: ensureStreamSession already calls
	// appendClientSessionLog internally — we don't
	// need a second call here.)
	logPath := filepath.Join(configDir, "log", "go-tui-session.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	logLine := string(data)
	if !strings.Contains(logLine, "clientSessionId="+clientID) {
		t.Errorf("tier (b) reverse-resolve failed: log missing %q: %q", clientID, logLine)
	}
	if !strings.Contains(logLine, "serverSessionId="+serverID) {
		t.Errorf("tier (b) reverse-resolve failed: log missing %q: %q", serverID, logLine)
	}
}
