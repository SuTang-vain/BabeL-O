// internal/loop/permission_events_test.go
//
// Phase 6d-c tests (docs §6'.3 6d-c): EventToPermission pure
// function. Event-to-state projection is the leaf of the
// permission routing path; the wait tick handler in
// wait_tick.go will call it (next slice) and decide whether
// to replace pane.PendingPermission.
//
// These tests cover the shape projection only. The dialog
// render and HTTP decision plumbing are 6d-c step 4 / 5.

package loop

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestEventToPermissionFullPayload: a permission_request
// carrying every field the runtime emits is shaped into a
// fully-populated PanePermission.
func TestEventToPermissionFullPayload(t *testing.T) {
	raw := json.RawMessage(`{
		"type":"permission_request",
		"toolUseId":"toolu_01",
		"name":"Bash",
		"risk":"execute",
		"message":"Tool Bash requires user permission to run. Reason: touches /tmp.",
		"suggestedRule":"Bash(git:*)",
		"scopeRisk":"external_repo",
		"targetRoot":"/tmp/external",
		"taskPrimaryRoot":"/Users/me/repo"
	}`)
	perm, ok := EventToPermission(raw)
	if !ok {
		t.Fatal("full payload should shape successfully")
	}
	if perm.ToolUseID != "toolu_01" {
		t.Errorf("ToolUseID = %q, want toolu_01", perm.ToolUseID)
	}
	if perm.Name != "Bash" {
		t.Errorf("Name = %q, want Bash", perm.Name)
	}
	if perm.Risk != "execute" {
		t.Errorf("Risk = %q, want execute", perm.Risk)
	}
	if !strings.Contains(perm.Message, "touches /tmp") {
		t.Errorf("Message = %q, want it to contain the reason", perm.Message)
	}
	if perm.SuggestedRule != "Bash(git:*)" {
		t.Errorf("SuggestedRule = %q, want Bash(git:*)", perm.SuggestedRule)
	}
	if perm.ScopeRisk != "external_repo" {
		t.Errorf("ScopeRisk = %q, want external_repo", perm.ScopeRisk)
	}
	if perm.TargetRoot != "/tmp/external" {
		t.Errorf("TargetRoot = %q, want /tmp/external", perm.TargetRoot)
	}
	if perm.TaskPrimaryRoot != "/Users/me/repo" {
		t.Errorf("TaskPrimaryRoot = %q, want /Users/me/repo", perm.TaskPrimaryRoot)
	}
}

// TestEventToPermissionMinimalPayload: a permission_request
// with only the required fields (toolUseId, name) still
// shapes — the optional rule / scope fields stay empty
// rather than blocking the shape.
func TestEventToPermissionMinimalPayload(t *testing.T) {
	raw := json.RawMessage(`{"type":"permission_request","toolUseId":"toolu_02","name":"Read"}`)
	perm, ok := EventToPermission(raw)
	if !ok {
		t.Fatal("minimal payload should shape successfully")
	}
	if perm.Name != "Read" {
		t.Errorf("Name = %q, want Read", perm.Name)
	}
	if perm.Risk != "" || perm.SuggestedRule != "" {
		t.Errorf("optional fields should be empty, got Risk=%q Rule=%q",
			perm.Risk, perm.SuggestedRule)
	}
}

// TestEventToPermissionIgnoresOtherTypes: events that are
// not permission_request (e.g. permission_response, user_prompt)
// return ok=false so the wait handler leaves PendingPermission
// alone and falls through to the transcript path.
func TestEventToPermissionIgnoresOtherTypes(t *testing.T) {
	cases := []string{
		`{"type":"permission_response","toolUseId":"toolu_01","approved":true}`,
		`{"type":"user_prompt","text":"hi"}`,
		`{"type":"assistant_text","text":"hi"}`,
		`{"type":"tool_completed","name":"Bash","success":true,"output":"ok"}`,
		`{"type":"some_other_event"}`,
	}
	for _, c := range cases {
		perm, ok := EventToPermission(json.RawMessage(c))
		if ok {
			t.Errorf("non-permission_request %q should return ok=false, got %+v", c, perm)
		}
		if perm != nil {
			t.Errorf("non-permission_request %q should return nil, got %+v", c, perm)
		}
	}
}

// TestEventToPermissionRejectsMissingToolUseID: a
// permission_request without toolUseId is unaddressable —
// the operator's decision would have nothing to bind to at
// the server-side PendingPermissionRegistry. Drop it.
func TestEventToPermissionRejectsMissingToolUseID(t *testing.T) {
	raw := json.RawMessage(`{"type":"permission_request","name":"Bash","risk":"execute","message":"x"}`)
	if perm, ok := EventToPermission(raw); ok {
		t.Errorf("missing toolUseId should return ok=false, got %+v", perm)
	}
}

// TestEventToPermissionRejectsMissingName: similarly a
// permission_request without a tool name is shapeless —
// the dialog needs a name to render. Drop it.
func TestEventToPermissionRejectsMissingName(t *testing.T) {
	raw := json.RawMessage(`{"type":"permission_request","toolUseId":"toolu_03","risk":"execute","message":"x"}`)
	if perm, ok := EventToPermission(raw); ok {
		t.Errorf("missing name should return ok=false, got %+v", perm)
	}
}

// TestEventToPermissionEmptyAndMalformed: defensive —
// nil / empty / malformed JSON must not panic.
func TestEventToPermissionEmptyAndMalformed(t *testing.T) {
	if perm, ok := EventToPermission(nil); ok || perm != nil {
		t.Errorf("nil raw should return (nil, false), got (%+v, %v)", perm, ok)
	}
	if perm, ok := EventToPermission(json.RawMessage("")); ok || perm != nil {
		t.Errorf("empty raw should return (nil, false), got (%+v, %v)", perm, ok)
	}
	if perm, ok := EventToPermission(json.RawMessage("{not valid json")); ok || perm != nil {
		t.Errorf("malformed JSON should return (nil, false), got (%+v, %v)", perm, ok)
	}
}
