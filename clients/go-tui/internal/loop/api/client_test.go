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
