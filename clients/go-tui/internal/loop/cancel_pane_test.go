// internal/loop/cancel_pane_test.go
//
// Phase 6d-d tests (docs §6'.3 6d-d): Esc-on-working-pane
// cancel + queued-next prompt auto-submit. The cancel
// path is mirrored on submit_prompt.go (HTTP-driven
// tea.Cmd) and the queued-next path is a 4-line addition
// to handleSubmitDone. Together they close the
// "operator can stop a runaway /v1/execute AND queue a
// follow-up before the current one resolves" gap.
//
// What this file does NOT cover (covered elsewhere):
//   - api/client.go CancelSession wire contract
//     (api/client_test.go)
//   - ApplyPaneInputEvent Enter→QueuedPrompt promotion
//     (pane_input_test.go)

package loop

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// cancelServer captures the /cancel call and replies
// with the configured envelope. /v1/execute is wired so
// the submit helper can fire a real cmd during the
// queued-next test. /wait returns an empty page so the
// wait poll doesn't keep firing.
type cancelServer struct {
	server           *httptest.Server
	cancelHits       int
	cancelPaths      []string
	cancelBodies     []map[string]any
	activeCancelled  bool
}

func newCancelServer(t *testing.T, activeCancelled bool) *cancelServer {
	t.Helper()
	s := &cancelServer{activeCancelled: activeCancelled}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/sessions/", s.handleSession)
	mux.HandleFunc("/v1/runtime/loop/health", s.handleHealth)
	mux.HandleFunc("/v1/loop/workspaces", s.handleListPanes)
	mux.HandleFunc("/v1/execute", s.handleExecute)
	mux.HandleFunc("/", s.handleFallback)
	s.server = httptest.NewServer(mux)
	t.Cleanup(s.server.Close)
	return s
}

func (s *cancelServer) URL() string { return s.server.URL }

func (s *cancelServer) handleSession(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/cancel") {
		s.cancelHits++
		s.cancelPaths = append(s.cancelPaths, r.URL.Path)
		if r.Body != nil {
			raw := readAllRaw(r)
			body := map[string]any{}
			if err := json.Unmarshal(raw, &body); err == nil {
				s.cancelBodies = append(s.cancelBodies, body)
			}
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":                     "session_cancelled",
			"sessionId":                "s1",
			"phase":                    "cancelled",
			"activeExecutionCancelled": s.activeCancelled,
		})
		return
	}
	if strings.HasSuffix(r.URL.Path, "/wait") {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":         "wait",
			"events":       []json.RawMessage{},
			"nextRevision": "0",
		})
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{}`))
}

func (s *cancelServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"type":"loop_health","panes":[]}`))
}

func (s *cancelServer) handleListPanes(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"type":"loop_workspaces","panes":[]}`))
}

func (s *cancelServer) handleExecute(w http.ResponseWriter, r *http.Request) {
	// Return an empty success envelope. The submit-prompt
	// path doesn't actually need events to land; we just
	// want a quick 200 so handleSubmitDone doesn't fail.
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type":       "execute",
		"sessionId":  "s1",
		"success":    true,
		"statusCode": 200,
		"events":     []json.RawMessage{},
	})
}

func (s *cancelServer) handleFallback(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{}`))
}

func readAllRaw(r *http.Request) []byte {
	if r.Body == nil {
		return nil
	}
	buf := make([]byte, 0, 256)
	tmp := make([]byte, 256)
	for {
		n, err := r.Body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			break
		}
	}
	return buf
}

// newCancelTestModel returns a model with a single pane
// whose SessionID is set, mirroring the runtime state a
// pane has *after* a successful /v1/execute. The
// submitInFlight flag is the operator's intent: "I'm
// mid-submit, send Esc to cancel".
func newCancelTestModel(t *testing.T, serverURL string) *InteractiveModel {
	t.Helper()
	pane := PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Cwd:         "/repo",
		Label:       "main",
		Status:      StatusWorking,
	}
	client := api.NewClient(serverURL, "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(),
		nil, nil, 0, client, 0, nil, nil,
	)
	seeded, _ := seedPane(im.loop, pane)
	im.loop = seeded
	return &im
}

// TestEscOnWorkingPaneCancels: when submitInFlight is
// true (i.e. the pane is mid-/v1/execute), Esc dispatches
// /cancel instead of quitting. PendingPermission is left
// alone (the cancel is a separate decision stream), the
// cancel cmd hits the server, and InterruptionActive is
// set so the chrome can show a "cancelling..." hint.
func TestEscOnWorkingPaneCancels(t *testing.T) {
	srv := newCancelServer(t, true)
	im := newCancelTestModel(t, srv.URL())

	// Mark the pane as in-flight so Esc takes the cancel
	// branch (otherwise Esc would quit the program).
	pane, _ := im.loop.PaneAt(0, 0, 0)
	pane.Status = StatusWorking
	im.setSubmitInFlight(pane.PaneID)
	im.loop = im.loop.withPane(pane)

	_, cmd := im.Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	if cmd == nil {
		t.Fatal("Esc on working pane should produce a cancel cmd")
	}
	// The cmd posts the cancelDoneMsg back through Update;
	// run it to confirm the server saw a /cancel hit and
	// the success path sets Status=waiting.
	msg := cmd()
	cancel, ok := msg.(cancelDoneMsg)
	if !ok {
		t.Fatalf("cancel cmd returned %T, want cancelDoneMsg", msg)
	}
	if !cancel.ActiveExecutionCancelled {
		t.Error("ActiveExecutionCancelled = false, want true")
	}

	updated, _ := im.Update(cancel)
	*im = updated.(InteractiveModel)
	if srv.cancelHits != 1 {
		t.Errorf("cancelHits = %d, want 1", srv.cancelHits)
	}
	foundPath := false
	for _, p := range srv.cancelPaths {
		if strings.HasSuffix(p, "/cancel") {
			foundPath = true
		}
	}
	if !foundPath {
		t.Errorf("server did not see /cancel, paths = %v", srv.cancelPaths)
	}

	pane, _ = im.loop.PaneAt(0, 0, 0)
	if pane.InterruptionActive {
		t.Error("InterruptionActive should be cleared after handleCancelDone")
	}
	if pane.Status != StatusWaiting {
		t.Errorf("pane.Status = %v, want StatusWaiting after cancel", pane.Status)
	}
}

// TestEscOnIdlePaneQuits: when the pane is NOT
// mid-submit, Esc falls through to the existing quit
// path. This is the back-pressure that keeps the "Esc
// to cancel" affordance from blocking the standard
// quit-Esc muscle memory when nothing is running.
func TestEscOnIdlePaneQuits(t *testing.T) {
	srv := newCancelServer(t, true)
	im := newCancelTestModel(t, srv.URL())

	// Pane is idle (Status=StatusIdle or working but
	// submitInFlight NOT set) — the default test model
	// has Status=StatusWorking but submitInFlight is
	// empty here. Esc should quit the program.
	updated, cmd := im.Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	*im = updated.(InteractiveModel)
	if cmd == nil {
		t.Fatal("Esc on idle pane should produce a cmd (Quit)")
	}
	// tea.Quit isn't directly comparable here, so just
	// verify it's not a permissionDecisionCmd / cancel
	// cmd by type.
	if _, isPerm := cmd().(permissionDecisionMsg); isPerm {
		t.Error("idle Esc should not produce permissionDecisionMsg")
	}
	if msg := cmd(); msg != nil {
		if _, isCancel := msg.(cancelDoneMsg); isCancel {
			t.Error("idle Esc should not produce cancelDoneMsg")
		}
	}
	if !im.quitting {
		t.Error("im.quitting should be true after idle Esc")
	}
	if srv.cancelHits != 0 {
		t.Errorf("server should not have seen /cancel, got %d hits", srv.cancelHits)
	}
}

// TestCancelHTTPErrorKeepsInterruptionClear: when
// /cancel returns 500, the handler stamps a failure
// toast and clears InterruptionActive (so the operator
// can retry). The pane status stays as it was — we
// don't pretend the cancel succeeded.
func TestCancelHTTPErrorKeepsInterruptionClear(t *testing.T) {
	// Build a server that always 500s on /cancel.
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/sessions/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/cancel") {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"type":"error","code":"INTERNAL","message":"boom"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	im := newCancelTestModel(t, server.URL)
	pane, _ := im.loop.PaneAt(0, 0, 0)
	im.setSubmitInFlight(pane.PaneID)
	im.loop = im.loop.withPane(pane)

	_, cmd := im.Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	if cmd == nil {
		t.Fatal("Esc on working pane should produce a cmd")
	}
	dec := cmd().(cancelDoneMsg)
	if dec.Err == nil {
		t.Fatal("HTTP 500 should produce a non-nil Err")
	}

	updated, _ := im.Update(dec)
	*im = updated.(InteractiveModel)
	if im.toastMessage == "" || !strings.Contains(im.toastMessage, "✗") {
		t.Errorf("error toast should be prefixed with ✗, got %q", im.toastMessage)
	}
	pane, _ = im.loop.PaneAt(0, 0, 0)
	if pane.InterruptionActive {
		t.Error("InterruptionActive should be cleared even on HTTP error")
	}
	if pane.Status != StatusWorking {
		t.Errorf("pane.Status = %v, want StatusWorking (unchanged on error)", pane.Status)
	}
}

// TestCancelSingleFlight: pressing Esc twice in a row
// before the first cancel resolves fires only one
// /cancel. The second is dropped because
// InterruptionActive is set after the first request.
// (We can't test the "request the same pane twice" path
// directly because the second cmd is gated by
// InterruptionActive on the *pane*, which only the
// first request has stamped.)
func TestCancelSingleFlight(t *testing.T) {
	srv := newCancelServer(t, true)
	im := newCancelTestModel(t, srv.URL())
	pane, _ := im.loop.PaneAt(0, 0, 0)
	im.setSubmitInFlight(pane.PaneID)
	im.loop = im.loop.withPane(pane)

	// First Esc: dispatches the cancel cmd, sets
	// InterruptionActive on the pane.
	updated, cmd1 := im.Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	*im = updated.(InteractiveModel)
	if cmd1 == nil {
		t.Fatal("first Esc should produce a cmd")
	}
	pane, _ = im.loop.PaneAt(0, 0, 0)
	if !pane.InterruptionActive {
		t.Fatal("InterruptionActive should be set after first cancel request")
	}

	// Second Esc: InterruptionActive is set, but the
	// dispatch short-circuits in Update *only* if
	// submitInFlight OR InterruptionActive. Let's check
	// that path — second Esc should still be intercepted
	// by the cancel branch (we don't want it to quit
	// the program). The dispatch returns nil because
	// requestCancelForPane's InterruptionActive guard
	// fires.
	updated, cmd2 := im.Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	*im = updated.(InteractiveModel)
	if cmd2 != nil {
		t.Errorf("second Esc should produce nil cmd (single-flight), got %T", cmd2)
	}
}

// TestRequestCancelGuardsNoSession: a pane without a
// SessionID can't be cancelled — there's nothing on the
// server side to abort. The dispatch returns nil so
// the chrome doesn't show a phantom "cancelling..."
// state.
func TestRequestCancelGuardsNoSession(t *testing.T) {
	srv := newCancelServer(t, true)
	im := newCancelTestModel(t, srv.URL())
	pane, _ := im.loop.PaneAt(0, 0, 0)
	pane.SessionID = ""
	im.loop = im.loop.withPane(pane)

	cmd := im.requestCancelForPane(pane)
	if cmd != nil {
		t.Errorf("requestCancelForPane with no session should return nil, got %T", cmd)
	}
}

// TestHandleSubmitDoneDrainsQueuedNext: a pane whose
// QueuedPrompt was set during the in-flight submit gets
// the new prompt auto-submitted when the previous one
// resolves. This is the operator's "type a follow-up
// while the assistant is working" flow.
func TestHandleSubmitDoneDrainsQueuedNext(t *testing.T) {
	srv := newCancelServer(t, true)
	im := newCancelTestModel(t, srv.URL())
	pane, _ := im.loop.PaneAt(0, 0, 0)
	pane.QueuedPrompt = "follow-up prompt"
	im.setSubmitInFlight(pane.PaneID)
	im.loop = im.loop.withPane(pane)

	// Land a submitDoneMsg. The handler should clear
	// submitInFlight AND fire a new submit cmd because
	// QueuedPrompt is non-empty.
	cmd := im.handleSubmitDone(submitDoneMsg{
		PaneID: pane.PaneID,
		Resp: api.ExecuteResponse{
			SessionID: "session-1",
			Success:   true,
			Events:    []json.RawMessage{},
		},
	})
	if cmd == nil {
		t.Fatal("drain path should return a cmd")
	}
	// The cmd is a submitPromptCmd closure. We don't run
	// it (the test server only catches /cancel; the
	// submit would 404). The assertion is that a submit
	// cmd was produced and submitInFlight was re-set for
	// the queued-next submit.
	if !im.isSubmitInFlight(pane.PaneID) {
		t.Error("submitInFlight should be re-set for the queued-next submit")
	}
	pane, _ = im.loop.PaneAt(0, 0, 0)
	// QueuedPrompt is cleared by startSubmitForPane
	// (6d-d) when it issues the new submit cmd — the
	// prompt is consumed at the moment of dispatch so
	// a second drain can't see it and re-fire. The
	// handleSubmitDone level preserves it across the
	// "in-flight" window; startSubmitForPane takes
	// ownership of clearing when the submit starts.
	if pane.QueuedPrompt != "" {
		t.Errorf("QueuedPrompt should be cleared after drain issued submit, got %q", pane.QueuedPrompt)
	}
	// Don't actually run cmd() — the test server only
	// catches /cancel; the submit would 404. The point
	// is the cmd was produced, not its result.
	_ = time.Now
}

// TestHandleSubmitDoneNoQueuedNextGoesToWait: when the
// submit resolves and no follow-up was queued, the
// handler returns the wait cmd (not a new submit).
// This is the regression guard: the queued-next path
// must not change the no-queued-next behavior.
func TestHandleSubmitDoneNoQueuedNextGoesToWait(t *testing.T) {
	srv := newCancelServer(t, true)
	im := newCancelTestModel(t, srv.URL())
	pane, _ := im.loop.PaneAt(0, 0, 0)
	im.setSubmitInFlight(pane.PaneID)
	im.loop = im.loop.withPane(pane)

	cmd := im.handleSubmitDone(submitDoneMsg{
		PaneID: pane.PaneID,
		Resp: api.ExecuteResponse{
			SessionID: "session-1",
			Success:   true,
			Events:    []json.RawMessage{},
		},
	})
	if cmd == nil {
		t.Fatal("no-queued-next should still return a cmd (the wait poll)")
	}
	if im.isSubmitInFlight(pane.PaneID) {
		t.Error("submitInFlight should be cleared when no queued-next")
	}
}

// TestHandleSubmitDoneErrorDoesNotDrain: an error result
// preserves pane.QueuedPrompt (the operator can retry
// the submit later) and stamps a failure toast. We
// deliberately don't auto-submit on error — the
// assistant's last failure may have been transient, and
// the operator should be in the loop.
func TestHandleSubmitDoneErrorDoesNotDrain(t *testing.T) {
	srv := newCancelServer(t, true)
	im := newCancelTestModel(t, srv.URL())
	pane, _ := im.loop.PaneAt(0, 0, 0)
	pane.QueuedPrompt = "follow-up"
	im.setSubmitInFlight(pane.PaneID)
	im.loop = im.loop.withPane(pane)

	cmd := im.handleSubmitDone(submitDoneMsg{
		PaneID: pane.PaneID,
		Err:    errSentinel("test submit failure"),
	})
	if cmd != nil {
		t.Errorf("error path should not return a cmd (no auto-drain), got %T", cmd)
	}
	pane, _ = im.loop.PaneAt(0, 0, 0)
	if pane.QueuedPrompt != "follow-up" {
		t.Errorf("QueuedPrompt should be preserved on error, got %q", pane.QueuedPrompt)
	}
	if im.toastMessage == "" || !strings.Contains(im.toastMessage, "✗") {
		t.Errorf("error toast should be prefixed with ✗, got %q", im.toastMessage)
	}
}
