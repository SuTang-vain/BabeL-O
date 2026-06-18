// internal/loop/permission_events.go
//
// Phase 6d-c of docs/nexus/reference/go-tui-loop-multipane-plan.md
// (§6'.3 6d-c): event → PanePermission shaping. Companion to
// transcript_events.go, which only produces TranscriptItem
// rows. Permission requests are a different kind of event:
// they're not log lines, they're state — the operator must
// see a dialog and decide yes/no, and the pending decision
// lives on the pane until the operator answers (or the
// runtime auto-times-out).
//
// Scope (per §6'.3 6d-c): only `permission_request` produces
// a *PanePermission. `permission_response` is also a
// permission-related event but it's the *resolution*, not a
// pending request — it lands via the wait tick handler and
// clears the pane's PendingPermission. It does NOT flow
// through this function.
//
// Wire shape (mirroring src/runtime/runtimeToolLoop.ts:155
// and src/runtime/LocalCodingRuntime.ts:412 — both emit
// the same field set; we tolerate either):
//
//	{
//	  type: "permission_request",
//	  toolUseId: "toolu_...",
//	  name: "Bash",
//	  risk: "write" | "execute" | ...,
//	  message: "Tool Bash requires user permission to run. Reason: ...",
//	  suggestedRule?: "Bash(git:*)",
//	  scopeRisk?: "external_repo" | ...,
//	  targetRoot?: "/tmp/external",
//	  taskPrimaryRoot?: "/Users/me/repo",
//	}
//
// Fields PanePermission doesn't model (input, scopeReason,
// source) are intentionally dropped — the dialog renderer
// just needs to show name + risk + message + a one-line
// rule suggestion. Tool input can be 100KB+ and would
// blow out the body column.

package loop

import (
	"encoding/json"
)

// EventToPermission shapes a permission_request event
// payload into a *PanePermission. Returns (nil, false)
// when the event is empty, malformed, or not a
// permission_request. Callers should treat the bool as
// "should this pane's PendingPermission be replaced?".
//
// Pure function: same input → same output, no side
// effects. The wait tick handler in wait_tick.go owns
// the "set vs clear" decision; this function is the
// pure shape projection.
//
// `ok` semantics follow the rest of the 6c family: a
// successful shape means "one event was consumed, advance
// your cursor". A failure (ok=false) does not mean the
// event is invalid — it just means permission_events.go
// doesn't care about it; the caller is still responsible
// for advancing the cursor (and may fall through to
// EventToTranscriptItem if the type is also a transcript
// candidate).
func EventToPermission(raw json.RawMessage) (*PanePermission, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	// Peek at type — same fast-path pattern as
	// EventToTranscriptItem: avoid decoding the full
	// payload when the type isn't permission_request.
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &head); err != nil || head.Type != "permission_request" {
		return nil, false
	}
	var p struct {
		ToolUseID       string `json:"toolUseId"`
		Name            string `json:"name"`
		Risk            string `json:"risk"`
		Message         string `json:"message"`
		SuggestedRule   string `json:"suggestedRule"`
		ScopeRisk       string `json:"scopeRisk"`
		TargetRoot      string `json:"targetRoot"`
		TaskPrimaryRoot string `json:"taskPrimaryRoot"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, false
	}
	if p.ToolUseID == "" || p.Name == "" {
		// A permission_request without a toolUseId is
		// unaddressable — the operator's decision would
		// have nothing to bind to. Drop it; the operator
		// will see a stale pending state and the runtime
		// will time out the request server-side.
		return nil, false
	}
	return &PanePermission{
		ToolUseID:       p.ToolUseID,
		Name:            p.Name,
		Risk:            p.Risk,
		Message:         p.Message,
		SuggestedRule:   p.SuggestedRule,
		ScopeRisk:       p.ScopeRisk,
		TargetRoot:      p.TargetRoot,
		TaskPrimaryRoot: p.TaskPrimaryRoot,
	}, true
}
