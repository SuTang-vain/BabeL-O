// internal/loop/api/client_test.go
//
// Phase 2c tests for the Nexus loop API client. httptest.Server
// stands in for the real Nexus so the test surface stays
// hermetic; the contract is verified against the JSON shapes
// produced by src/nexus/app.ts.

package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestClient(t *testing.T, handler http.Handler) (*Client, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return NewClient(server.URL, "test-key"), server
}

func TestClientUpsertPaneSendsBodyAndReturnsServerState(t *testing.T) {
	var capturedPath string
	var capturedBody map[string]any
	var capturedAuth string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &capturedBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"type": "loop_pane",
			"pane": {
				"paneId": "pane-1",
				"workspaceId": "ws-1",
				"tabId": "ws-1:1",
				"sessionId": "session-1",
				"agent": "bbl",
				"cwd": "/tmp",
				"label": "main",
				"lastRev": 5,
				"updatedAt": "2026-06-13T00:00:00.000Z"
			}
		}`))
	})
	c, _ := newTestClient(t, handler)
	pane, err := c.UpsertPane(context.Background(), UpsertPaneParams{
		PaneID:      "pane-1",
		WorkspaceID: "ws-1",
		TabID:       "ws-1:1",
		SessionID:   "session-1",
		Agent:       "bbl",
		Cwd:         "/tmp",
		Label:       "main",
		LastRev:     5,
	})
	if err != nil {
		t.Fatalf("UpsertPane: %v", err)
	}
	if pane.PaneID != "pane-1" || pane.LastRev != 5 || pane.Label != "main" {
		t.Fatalf("UpsertPane returned %+v", pane)
	}
	if capturedPath != "/v1/loop/workspaces/ws-1/panes" {
		t.Fatalf("UpsertPane path = %q", capturedPath)
	}
	if capturedAuth != "Bearer test-key" {
		t.Fatalf("UpsertPane Authorization header = %q", capturedAuth)
	}
	if capturedBody["paneId"] != "pane-1" || capturedBody["workspaceId"] != "ws-1" {
		t.Fatalf("UpsertPane body = %+v", capturedBody)
	}
}

func TestClientListPanesEncodesFilters(t *testing.T) {
	var capturedQuery string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{
			"type": "loop_workspaces",
			"panes": [
				{"paneId":"pane-1","workspaceId":"ws-1","tabId":"ws-1:1","sessionId":"s1","agent":"bbl","cwd":"/tmp","label":"main","lastRev":1,"updatedAt":"2026-06-13T00:00:00.000Z"}
			],
			"filter": {"workspaceId":"ws-1","sessionId":null}
		}`))
	})
	c, _ := newTestClient(t, handler)
	panes, err := c.ListPanes(context.Background(), "ws-1", "")
	if err != nil {
		t.Fatalf("ListPanes: %v", err)
	}
	if len(panes) != 1 || panes[0].PaneID != "pane-1" {
		t.Fatalf("ListPanes returned %+v", panes)
	}
	if !strings.Contains(capturedQuery, "workspaceId=ws-1") {
		t.Fatalf("ListPanes query missing workspaceId: %s", capturedQuery)
	}
}

func TestClientDeletePaneReports404AsFalse(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Fatalf("DeletePane method = %s", r.Method)
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"type":"error","code":"PANE_NOT_FOUND","message":"missing"}`))
	})
	c, _ := newTestClient(t, handler)
	deleted, err := c.DeletePane(context.Background(), "ws-1", "ws-1:1", "pane-missing")
	if err != nil {
		t.Fatalf("DeletePane: %v", err)
	}
	if deleted {
		t.Fatalf("DeletePane should report false on 404")
	}
}

func TestClientFetchLoopHealthDecodesPanes(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/runtime/loop/health" {
			t.Fatalf("FetchLoopHealth path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{
			"type": "loop_health",
			"panes": [
				{
					"sessionId": "session-1",
					"agent": "bbl",
					"status": "drift",
					"pendingPermissions": 0,
					"pendingScopeBoundaries": 1,
					"outOfScopeEvidence": 1,
					"lastEventRev": 42,
					"lastEventAt": "2026-06-13T00:00:01.000Z",
					"taskScope": {
						"cwd": "/workspace",
						"primaryRoot": "/workspace",
						"explicitRoots": [],
						"confirmedExternalRoots": ["/external"],
						"inferredCandidateRoots": [],
						"mode": "multi_root",
						"source": "user_confirmation",
						"latestDeclaredAt": "2026-06-13T00:00:00.000Z"
					}
				}
			],
			"filter": {"workspaceId":null,"paneId":null,"sessionId":"session-1","lastN":200}
		}`))
	})
	c, _ := newTestClient(t, handler)
	resp, err := c.FetchLoopHealth(context.Background(), "", "", "session-1", 200)
	if err != nil {
		t.Fatalf("FetchLoopHealth: %v", err)
	}
	if len(resp.Panes) != 1 {
		t.Fatalf("FetchLoopHealth returned %d panes, want 1", len(resp.Panes))
	}
	pane := resp.Panes[0]
	if pane.Status != "drift" || pane.PendingScopeBoundaries != 1 || pane.LastEventRev != 42 {
		t.Fatalf("FetchLoopHealth pane = %+v", pane)
	}
	if pane.TaskScope.Mode != "multi_root" || len(pane.TaskScope.ConfirmedExternalRoots) != 1 {
		t.Fatalf("FetchLoopHealth taskScope = %+v", pane.TaskScope)
	}
}

func TestClientWaitForEventsBuildsQuery(t *testing.T) {
	var capturedQuery string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{
			"type": "session_wait",
			"sessionId": "session-1",
			"events": [{"type":"permission_request","sessionId":"session-1"}],
			"nextRevision": "10",
			"matched": true,
			"order": "asc",
			"limit": 100
		}`))
	})
	c, _ := newTestClient(t, handler)
	resp, err := c.WaitForEvents(context.Background(), "session-1", WaitOptions{
		Since:     5,
		Match:     "permission_request",
		Types:     "permission_request,permission_response",
		TimeoutMs: 1000,
		Limit:     100,
	})
	if err != nil {
		t.Fatalf("WaitForEvents: %v", err)
	}
	if !resp.Matched || resp.NextRevision != "10" || len(resp.Events) != 1 {
		t.Fatalf("WaitForEvents returned %+v", resp)
	}
	for _, want := range []string{"since=5", "match=permission_request", "types=permission_request%2Cpermission_response", "timeout=1000", "limit=100"} {
		if !strings.Contains(capturedQuery, want) {
			t.Fatalf("WaitForEvents query missing %q (got %s)", want, capturedQuery)
		}
	}
}

func TestClientExecutePromptPostsExecuteBody(t *testing.T) {
	var capturedPath string
	var capturedBody map[string]any
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &capturedBody)
		_, _ = w.Write([]byte(`{
			"type": "execute_result",
			"sessionId": "session-1",
			"success": true,
			"statusCode": 200,
			"durationMs": 12,
			"events": [
				{"type":"user_prompt","sessionId":"session-1","text":"hello"},
				{"type":"assistant_text","sessionId":"session-1","text":"hi"}
			]
		}`))
	})
	c, _ := newTestClient(t, handler)
	resp, err := c.ExecutePrompt(context.Background(), ExecutePromptRequest{
		Prompt:       "hello",
		SessionID:    "session-1",
		Cwd:          "/workspace",
		TimeoutMs:    180000,
		Policy:       "soft-deny",
		AllowedTools: []string{"Read", "Grep"},
	})
	if err != nil {
		t.Fatalf("ExecutePrompt: %v", err)
	}
	if capturedPath != "/v1/execute" {
		t.Fatalf("ExecutePrompt path = %q", capturedPath)
	}
	if capturedBody["prompt"] != "hello" || capturedBody["sessionId"] != "session-1" || capturedBody["cwd"] != "/workspace" {
		t.Fatalf("ExecutePrompt body = %+v", capturedBody)
	}
	if capturedBody["policy"] != "soft-deny" {
		t.Fatalf("ExecutePrompt policy = %+v", capturedBody["policy"])
	}
	if resp.SessionID != "session-1" || !resp.Success || len(resp.Events) != 2 {
		t.Fatalf("ExecutePrompt response = %+v", resp)
	}
}

func TestClientNewClientDefaultsTimeoutAndAuth(t *testing.T) {
	c := NewClient("http://example.com/", "abc")
	if c.HTTP.Timeout < 10*time.Second {
		t.Fatalf("default timeout = %v, want >= 10s", c.HTTP.Timeout)
	}
	if c.APIKey != "abc" {
		t.Fatalf("APIKey = %q", c.APIKey)
	}
	if c.BaseURL != "http://example.com" {
		t.Fatalf("BaseURL should strip trailing slash, got %q", c.BaseURL)
	}
}

func TestClientNewRequestRequiresBaseURL(t *testing.T) {
	c := &Client{HTTP: http.DefaultClient}
	_, err := c.newRequest(context.Background(), http.MethodGet, "/v1/runtime/loop/health", nil)
	if err == nil {
		t.Fatalf("expected error when BaseURL is empty")
	}
}

// ── 6d-c: permission decision endpoints ──────────────────────

// TestClientApprovePermissionSendsBodyAndPath covers the
// happy path: POST /v1/sessions/:id/approve with toolUseId +
// scope="session" + rule + feedback all flow to the server
// unchanged, and a 2xx response is treated as success.
func TestClientApprovePermissionSendsBodyAndPath(t *testing.T) {
	var capturedPath, capturedMethod, capturedAuth string
	var capturedBody map[string]any
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		capturedAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &capturedBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"type":"permission_resolved","approved":true,"scope":"session"}`))
	})
	c, _ := newTestClient(t, handler)

	err := c.ApprovePermission(context.Background(), "session-1", "toolu_01", ApprovePermissionOptions{
		Scope:    "session",
		Rule:     "Bash(git:*)",
		Feedback: "ok for this session",
	})
	if err != nil {
		t.Fatalf("ApprovePermission: %v", err)
	}
	if capturedMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", capturedMethod)
	}
	if capturedPath != "/v1/sessions/session-1/approve" {
		t.Errorf("path = %q, want /v1/sessions/session-1/approve", capturedPath)
	}
	if capturedAuth != "Bearer test-key" {
		t.Errorf("auth = %q, want Bearer test-key", capturedAuth)
	}
	if capturedBody["toolUseId"] != "toolu_01" {
		t.Errorf("body.toolUseId = %v, want toolu_01", capturedBody["toolUseId"])
	}
	if capturedBody["scope"] != "session" {
		t.Errorf("body.scope = %v, want session", capturedBody["scope"])
	}
	if capturedBody["rule"] != "Bash(git:*)" {
		t.Errorf("body.rule = %v, want Bash(git:*)", capturedBody["rule"])
	}
	if capturedBody["feedback"] != "ok for this session" {
		t.Errorf("body.feedback = %v", capturedBody["feedback"])
	}
}

// TestClientApprovePermissionOmitsEmptyOptionals: when
// the operator picks "approve once" (the default), the
// body has only toolUseId — scope/rule/feedback are
// dropped from the JSON so the server uses its own
// defaults rather than over-specifying.
func TestClientApprovePermissionOmitsEmptyOptionals(t *testing.T) {
	var capturedBody map[string]any
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &capturedBody)
		w.WriteHeader(http.StatusOK)
	})
	c, _ := newTestClient(t, handler)

	if err := c.ApprovePermission(context.Background(), "s1", "toolu_02", ApprovePermissionOptions{}); err != nil {
		t.Fatalf("ApprovePermission: %v", err)
	}
	if _, ok := capturedBody["scope"]; ok {
		t.Errorf("scope should be omitted when zero, got %v", capturedBody["scope"])
	}
	if _, ok := capturedBody["rule"]; ok {
		t.Errorf("rule should be omitted when zero, got %v", capturedBody["rule"])
	}
	if _, ok := capturedBody["feedback"]; ok {
		t.Errorf("feedback should be omitted when zero, got %v", capturedBody["feedback"])
	}
	if capturedBody["toolUseId"] != "toolu_02" {
		t.Errorf("toolUseId = %v, want toolu_02", capturedBody["toolUseId"])
	}
}

// TestClientApprovePermissionRejectsEmptyIDs is the
// defensive path: missing sessionID or toolUseID is a
// programmer error (the PanePermission always carries
// both — see EventToPermission which rejects empty
// toolUseId). The client surfaces a clear error rather
// than POSTing /v1/sessions//approve.
func TestClientApprovePermissionRejectsEmptyIDs(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("server should not be called for empty IDs")
	}))
	if err := c.ApprovePermission(context.Background(), "", "toolu_x", ApprovePermissionOptions{}); err == nil {
		t.Fatal("empty sessionID should error")
	}
	if err := c.ApprovePermission(context.Background(), "s1", "", ApprovePermissionOptions{}); err == nil {
		t.Fatal("empty toolUseID should error")
	}
}

// TestClientDenyPermissionSendsReasonAndFeedback: the
// deny body carries reason + feedback separately per
// the server's schema (src/nexus/app.ts deny handler).
func TestClientDenyPermissionSendsReasonAndFeedback(t *testing.T) {
	var capturedPath string
	var capturedBody map[string]any
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &capturedBody)
		w.WriteHeader(http.StatusOK)
	})
	c, _ := newTestClient(t, handler)

	if err := c.DenyPermission(context.Background(), "session-1", "toolu_03", "writes outside scope", "stick to the repo"); err != nil {
		t.Fatalf("DenyPermission: %v", err)
	}
	if capturedPath != "/v1/sessions/session-1/deny" {
		t.Errorf("path = %q, want /v1/sessions/session-1/deny", capturedPath)
	}
	if capturedBody["toolUseId"] != "toolu_03" {
		t.Errorf("body.toolUseId = %v, want toolu_03", capturedBody["toolUseId"])
	}
	if capturedBody["reason"] != "writes outside scope" {
		t.Errorf("body.reason = %v", capturedBody["reason"])
	}
	if capturedBody["feedback"] != "stick to the repo" {
		t.Errorf("body.feedback = %v", capturedBody["feedback"])
	}
}

// TestClientDenyPermissionOmitsEmptyFields: same as
// approve — reason / feedback are dropped when zero so
// the server gets a minimal body for the "deny once,
// no comment" path.
func TestClientDenyPermissionOmitsEmptyFields(t *testing.T) {
	var capturedBody map[string]any
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &capturedBody)
		w.WriteHeader(http.StatusOK)
	})
	c, _ := newTestClient(t, handler)

	if err := c.DenyPermission(context.Background(), "s1", "toolu_04", "", ""); err != nil {
		t.Fatalf("DenyPermission: %v", err)
	}
	if _, ok := capturedBody["reason"]; ok {
		t.Errorf("reason should be omitted when empty")
	}
	if _, ok := capturedBody["feedback"]; ok {
		t.Errorf("feedback should be omitted when empty")
	}
}

// TestClientDenyPermissionRejectsEmptyIDs mirrors the
// approve guard — same reasoning, same expectation.
func TestClientDenyPermissionRejectsEmptyIDs(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("server should not be called for empty IDs")
	}))
	if err := c.DenyPermission(context.Background(), "", "toolu_x", "", ""); err == nil {
		t.Fatal("empty sessionID should error")
	}
	if err := c.DenyPermission(context.Background(), "s1", "", "", ""); err == nil {
		t.Fatal("empty toolUseID should error")
	}
}

func TestClientCancelSessionSendsPathAndReason(t *testing.T) {
	var capturedPath string
	var capturedBody map[string]any
	var capturedAuth string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &capturedBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"type": "session_cancelled",
			"sessionId": "s1",
			"phase": "cancelled",
			"activeExecutionCancelled": true,
			"requestId": "req-99",
			"transport": "stream",
			"permissionsResolved": 1,
			"childSessionsCancelled": 0
		}`))
	})
	c, _ := newTestClient(t, handler)
	resp, err := c.CancelSession(context.Background(), "s1", "operator hit Esc")
	if err != nil {
		t.Fatalf("CancelSession: %v", err)
	}
	if capturedPath != "/v1/sessions/s1/cancel" {
		t.Errorf("path = %q, want /v1/sessions/s1/cancel", capturedPath)
	}
	if capturedAuth != "Bearer test-key" {
		t.Errorf("auth = %q, want Bearer test-key", capturedAuth)
	}
	if capturedBody["reason"] != "operator hit Esc" {
		t.Errorf("body reason = %v, want operator hit Esc", capturedBody["reason"])
	}
	if !resp.ActiveExecutionCancelled {
		t.Error("ActiveExecutionCancelled = false, want true")
	}
	if resp.Phase != "cancelled" {
		t.Errorf("Phase = %q, want cancelled", resp.Phase)
	}
	if resp.RequestID != "req-99" {
		t.Errorf("RequestID = %q, want req-99", resp.RequestID)
	}
}

func TestClientCancelSessionOmitsEmptyReason(t *testing.T) {
	var capturedBody map[string]any
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &capturedBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"session_cancelled","sessionId":"s1","phase":"cancelled","activeExecutionCancelled":false}`))
	})
	c, _ := newTestClient(t, handler)
	if _, err := c.CancelSession(context.Background(), "s1", ""); err != nil {
		t.Fatalf("CancelSession: %v", err)
	}
	if _, ok := capturedBody["reason"]; ok {
		t.Errorf("empty reason should be omitted from body, got %v", capturedBody["reason"])
	}
}

func TestClientCancelSessionRejectsEmptySessionID(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("server should not be called for empty sessionID")
	}))
	if _, err := c.CancelSession(context.Background(), "", "x"); err == nil {
		t.Fatal("empty sessionID should error")
	}
}
