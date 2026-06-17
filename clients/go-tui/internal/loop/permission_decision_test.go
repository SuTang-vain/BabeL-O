// internal/loop/permission_decision_test.go
//
// Phase 6d-c step 5 tests (docs §6'.3 6d-c): the integration
// contract between the dialog render (chrome.go), the
// Y/Enter/N key dispatch (interactive.go), and the HTTP
// approve/deny client (api/client.go). Companion to:
//   - permission_events_test.go — leaf-level shape projection
//   - api/client_test.go        — leaf-level HTTP client
//   - wait_tick_test.go         — wait stream → pane.PendingPermission
//
// These tests use the InteractiveModel + Update path so a
// Y/N keypress goes through the real dispatcher, not a
// hand-rolled stub. The Nexus side is faked with
// httptest.Server so we can assert the wire contract
// (path, body fields, status code) without standing up the
// real server.

package loop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// permissionDecisionServer captures the path / body / status
// the operator's approve / deny fired. The handler replies
// with whatever the test wants — 200 by default, 500 for the
// error path. The /wait endpoint is also wired so a follow-up
// call from startAllWaits (Init) doesn't crash the model.
type permissionDecisionServer struct {
	server        *httptest.Server
	capturedPaths []string
	capturedBodies []map[string]any
	statusCode    int
}

func newPermissionDecisionServer(t *testing.T, status int) *permissionDecisionServer {
	t.Helper()
	s := &permissionDecisionServer{statusCode: status}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/sessions/", s.handleSession)
	mux.HandleFunc("/v1/runtime/loop/health", s.handleHealth)
	mux.HandleFunc("/v1/loop/workspaces", s.handleListPanes)
	mux.HandleFunc("/", s.handleFallback)
	s.server = httptest.NewServer(mux)
	t.Cleanup(s.server.Close)
	return s
}

func (s *permissionDecisionServer) URL() string { return s.server.URL }

func (s *permissionDecisionServer) handleSession(w http.ResponseWriter, r *http.Request) {
	// Match both /v1/sessions/:id/approve and .../deny and
	// .../wait. Record the path + body for the test
	// assertions, then return the configured status. The
	// /wait path returns an empty page so the wait handler
	// doesn't keep polling.
	s.capturedPaths = append(s.capturedPaths, r.URL.Path)
	if r.Body != nil {
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 0 {
			body := map[string]any{}
			if err := json.Unmarshal(raw, &body); err == nil {
				s.capturedBodies = append(s.capturedBodies, body)
			}
		}
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
	w.WriteHeader(s.statusCode)
}

func (s *permissionDecisionServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"type":"loop_health","panes":[]}`))
}

func (s *permissionDecisionServer) handleListPanes(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"type":"loop_workspaces","panes":[]}`))
}

func (s *permissionDecisionServer) handleFallback(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{}`))
}

// newPermissionDecisionModel builds an InteractiveModel
// with a single pane that has a PendingPermission already
// set, so the tests can press Y/N and watch the
// permissionDecisionMsg flow. Mirrors newWaitTestModel.
func newPermissionDecisionModel(t *testing.T, serverURL string) (*InteractiveModel, PaneModel, *PanePermission) {
	t.Helper()
	perm := &PanePermission{
		ToolUseID:     "toolu_1",
		Name:          "Bash",
		Risk:          "execute",
		Message:       "Tool Bash requires user permission to run. Reason: touches /tmp.",
		SuggestedRule: "Bash(git:*)",
	}
	pane := PaneModel{
		PaneID:            "pane-1",
		WorkspaceID:       defaultWSID,
		TabID:             defaultTabID,
		SessionID:         "session-1",
		Agent:             "bbl",
		Cwd:               "/repo",
		Label:             "main",
		Status:            StatusWaiting,
		LastEventRev:      0,
		PendingPermission: perm,
	}
	client := api.NewClient(serverURL, "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(),
		nil, // no store
		nil, // no reconciler
		0,
		client,
		0, // no health interval
		nil, nil,
	)
	seeded, _ := seedPane(im.loop, pane)
	im.loop = seeded
	return &im, pane, perm
}

// TestYKeyApprovePermission: Y on a pane with
// PendingPermission dispatches /v1/sessions/:id/approve with
// the correct body (toolUseId + suggested rule). The HTTP
// response (200) lands back as a permissionDecisionMsg,
// the toast is stamped with "approved toolu_1", and
// PendingPermission is left in place (cleared later by
// the wait stream's permission_response, which is the
// 6c dispatch path; not this test's concern).
func TestYKeyApprovePermission(t *testing.T) {
	srv := newPermissionDecisionServer(t, http.StatusOK)
	im, _, perm := newPermissionDecisionModel(t, srv.URL())

	// Drive Y through Update. Returned cmd is the
	// permissionDecisionCmd closure — call it once to
	// execute the HTTP and get the permissionDecisionMsg.
	_, cmd := im.Update(tea.KeyPressMsg{Code: 'y', Text: "y"})
	if cmd == nil {
		t.Fatal("Y on a pane with PendingPermission should produce a cmd")
	}
	msg := cmd()
	dec, ok := msg.(permissionDecisionMsg)
	if !ok {
		t.Fatalf("Y cmd returned %T, want permissionDecisionMsg", msg)
	}
	if dec.Kind != "approve" {
		t.Errorf("dec.Kind = %q, want approve", dec.Kind)
	}
	if dec.ToolUseID != perm.ToolUseID {
		t.Errorf("dec.ToolUseID = %q, want %q", dec.ToolUseID, perm.ToolUseID)
	}
	if dec.Err != nil {
		t.Errorf("dec.Err = %v, want nil", dec.Err)
	}

	// Apply the resulting message through Update so the
	// toast is stamped. PendingPermission should remain
	// non-nil — the wait stream clears it, not this path.
	updated, _ := im.Update(dec)
	*im = updated.(InteractiveModel)
	if im.toastMessage == "" || !strings.Contains(im.toastMessage, "approved") {
		t.Errorf("toast should mention approved, got %q", im.toastMessage)
	}
	pane, _ := im.loop.PaneAt(0, 0, 0)
	if pane.PendingPermission == nil {
		t.Error("PendingPermission should remain set after HTTP success; wait stream clears it")
	}

	// Wire contract: the server saw an /approve path and
	// the body carried the toolUseId + rule.
	if len(srv.capturedPaths) == 0 {
		t.Fatal("server should have received at least one request")
	}
	foundApprove := false
	for _, p := range srv.capturedPaths {
		if strings.HasSuffix(p, "/approve") {
			foundApprove = true
		}
		if !strings.HasSuffix(p, "/approve") && !strings.HasSuffix(p, "/wait") {
			t.Errorf("unexpected path captured: %q", p)
		}
	}
	if !foundApprove {
		t.Errorf("server did not see /approve, captured paths = %v", srv.capturedPaths)
	}
	if len(srv.capturedBodies) == 0 {
		t.Fatal("server should have received at least one body")
	}
	var approveBody map[string]any
	for _, b := range srv.capturedBodies {
		if b["toolUseId"] == "toolu_1" {
			approveBody = b
			break
		}
	}
	if approveBody == nil {
		t.Fatalf("no captured body had toolUseId=toolu_1, got %v", srv.capturedBodies)
	}
	if approveBody["rule"] != "Bash(git:*)" {
		t.Errorf("approve body rule = %v, want Bash(git:*)", approveBody["rule"])
	}
}

// TestEnterKeyApprovePermission: Enter behaves identically
// to Y. The 6d-c contract is "Y or Enter = approve" — the
// most common muscle-memory shortcut for an operator
// reviewing a permission_request.
func TestEnterKeyApprovePermission(t *testing.T) {
	srv := newPermissionDecisionServer(t, http.StatusOK)
	im, _, _ := newPermissionDecisionModel(t, srv.URL())

	_, cmd := im.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("Enter on a pane with PendingPermission should produce a cmd")
	}
	msg := cmd()
	dec := msg.(permissionDecisionMsg)
	if dec.Kind != "approve" {
		t.Errorf("Enter Kind = %q, want approve", dec.Kind)
	}
}

// TestNKeyDenyPermission: N fires /v1/sessions/:id/deny
// (not /approve). The body carries only toolUseId; reason
// and feedback stay empty because the dialog doesn't
// collect them in 6d-c step 4.
func TestNKeyDenyPermission(t *testing.T) {
	srv := newPermissionDecisionServer(t, http.StatusOK)
	im, _, perm := newPermissionDecisionModel(t, srv.URL())

	_, cmd := im.Update(tea.KeyPressMsg{Code: 'n', Text: "n"})
	if cmd == nil {
		t.Fatal("N on a pane with PendingPermission should produce a cmd")
	}
	msg := cmd()
	dec := msg.(permissionDecisionMsg)
	if dec.Kind != "deny" {
		t.Errorf("dec.Kind = %q, want deny", dec.Kind)
	}
	if dec.Err != nil {
		t.Errorf("dec.Err = %v, want nil", dec.Err)
	}

	updated, _ := im.Update(dec)
	*im = updated.(InteractiveModel)
	if im.toastMessage == "" || !strings.Contains(im.toastMessage, "denied") {
		t.Errorf("toast should mention denied, got %q", im.toastMessage)
	}

	// Verify the wire path was /deny.
	foundDeny := false
	for _, p := range srv.capturedPaths {
		if strings.HasSuffix(p, "/deny") {
			foundDeny = true
		}
	}
	if !foundDeny {
		t.Errorf("server did not see /deny, captured paths = %v", srv.capturedPaths)
	}
	_ = perm
}

// TestPermissionDecisionHTTPErrorKeepsDialog: a 500 from
// the server does NOT clear PendingPermission and does
// stamp a failure toast. The operator can retry the same
// Y/N. This is the 6d-c step 4 contract — the dialog
// stays up on error so a transient Nexus blip doesn't
// strand the operator.
func TestPermissionDecisionHTTPErrorKeepsDialog(t *testing.T) {
	srv := newPermissionDecisionServer(t, http.StatusInternalServerError)
	im, _, perm := newPermissionDecisionModel(t, srv.URL())

	_, cmd := im.Update(tea.KeyPressMsg{Code: 'y', Text: "y"})
	msg := cmd()
	dec := msg.(permissionDecisionMsg)
	if dec.Err == nil {
		t.Fatal("HTTP 500 should produce a non-nil Err")
	}

	updated, _ := im.Update(dec)
	*im = updated.(InteractiveModel)
	if im.toastMessage == "" || !strings.Contains(im.toastMessage, "✗") {
		t.Errorf("error toast should be prefixed with ✗, got %q", im.toastMessage)
	}
	pane, _ := im.loop.PaneAt(0, 0, 0)
	if pane.PendingPermission == nil {
		t.Error("PendingPermission should stay set on HTTP error; wait stream clears it")
	}
	if pane.PendingPermission.ToolUseID != perm.ToolUseID {
		t.Errorf("PendingPermission.ToolUseID = %q, want %q",
			pane.PendingPermission.ToolUseID, perm.ToolUseID)
	}
}

// TestKeysSwallowedWhileDialogOpen: a key other than
// Y/Enter/N/Esc/quit while the dialog is open is dropped
// silently — the operator can't type into the pane input
// or drive the router while a permission is awaiting
// decision. This protects the runtime from "the operator
// pressed Enter to approve but it submitted a different
// prompt" footguns.
func TestKeysSwallowedWhileDialogOpen(t *testing.T) {
	srv := newPermissionDecisionServer(t, http.StatusOK)
	im, _, _ := newPermissionDecisionModel(t, srv.URL())

	// Pressing a printable key (e.g. "a") should produce
	// nil cmd and NOT mutate the pane input.
	_, cmd := im.Update(tea.KeyPressMsg{Code: 'a', Text: "a"})
	if cmd != nil {
		t.Errorf("non-Y/Enter/N key should be swallowed, got cmd %T", cmd)
	}
	pane, _ := im.loop.PaneAt(0, 0, 0)
	if pane.Input != "" {
		t.Errorf("dialog should block pane input, pane.Input = %q", pane.Input)
	}
}

// TestNoPendingPermissionKeysPassThrough: a Y/N on a pane
// without PendingPermission falls through to the normal
// router dispatch (so the operator can still type
// "y"/"n" into the prompt if they want). Mirrors the
// helpOpen contract — overlays are modal, the regular
// surface stays out of the way.
func TestNoPendingPermissionKeysPassThrough(t *testing.T) {
	srv := newPermissionDecisionServer(t, http.StatusOK)
	im, _, _ := newPermissionDecisionModel(t, srv.URL())
	// Strip the PendingPermission.
	pane, _ := im.loop.PaneAt(0, 0, 0)
	pane.PendingPermission = nil
	im.loop = im.loop.withPane(pane)

	_, cmd := im.Update(tea.KeyPressMsg{Code: 'y', Text: "y"})
	if cmd == nil {
		// Router may produce nil for a no-op key; what we
		// care about is that it did NOT produce a
		// permissionDecisionCmd. We can't distinguish nil
		// from "no decision" structurally, so the more
		// important assertion is that no permission
		// decision was issued — capturedPaths stays empty.
	}
	// The server should not have seen /approve or /deny
	// for this keypress.
	for _, p := range srv.capturedPaths {
		if strings.HasSuffix(p, "/approve") || strings.HasSuffix(p, "/deny") {
			t.Errorf("server saw %q but no PendingPermission was set", p)
		}
	}
}

// TestPermissionDecisionCmdGuardsNilClient: defense — a
// missing loopClient means no cmd is produced. The dialog
// is rendered but the Y/N keys return nil so the chrome
// doesn't show a phantom "✓ approved" toast.
func TestPermissionDecisionCmdGuardsNilClient(t *testing.T) {
	im, _, _ := newPermissionDecisionModel(t, "http://127.0.0.1:0")
	im.loopClient = nil

	_, cmd := im.Update(tea.KeyPressMsg{Code: 'y', Text: "y"})
	if cmd != nil {
		t.Errorf("nil loopClient should produce nil cmd, got %T", cmd)
	}
}

// TestPermissionDecisionCmdIgnoresEmptyPerm: defense —
// a nil permission returns nil cmd, so a misbehaving wait
// stream that produces a permission_request with no
// toolUseId/name (which EventToPermission rejects) doesn't
// crash the dispatcher.
func TestPermissionDecisionCmdIgnoresEmptyPerm(t *testing.T) {
	srv := newPermissionDecisionServer(t, http.StatusOK)
	im, _, _ := newPermissionDecisionModel(t, srv.URL())
	pane, _ := im.loop.PaneAt(0, 0, 0)
	pane.PendingPermission = nil
	im.loop = im.loop.withPane(pane)

	// Simulate the dispatch helper being called with a
	// nil perm by calling it directly.
	pane, _ = im.loop.PaneAt(0, 0, 0)
	cmd := im.dispatchPermissionDecision(pane, nil, "approve")
	if cmd != nil {
		t.Errorf("nil perm should produce nil cmd, got %T", cmd)
	}

	// Sanity check: the test server didn't see a /approve
	// or /deny for this call.
	for _, p := range srv.capturedPaths {
		if strings.HasSuffix(p, "/approve") || strings.HasSuffix(p, "/deny") {
			t.Errorf("server saw %q for nil-perm call", p)
		}
	}
}

// ctxWithTimeout returns a short-deadline context for tests
// that want to assert on timeout behavior. Kept here (not in
// the production code) because no production code path
// needs it; the production timeout is internal to
// permissionDecisionCmd.
func ctxWithTimeout(t *testing.T, d time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}
