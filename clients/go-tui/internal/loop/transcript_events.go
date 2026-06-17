// internal/loop/transcript_events.go
//
// Phase 6c of docs/nexus/reference/go-tui-loop-multipane-plan.md
// (§6'): the per-pane wait handler turns each raw event from
// /v1/sessions/:id/wait into a TranscriptItem. This file owns
// the pure data-shaping — no tea.Cmd, no I/O.
//
// Scope (per §6'.3 6c design point 5): 4 core event types
// shape into transcript rows; everything else returns ok=false
// and is silently skipped so the wait handler can advance its
// revision cursor without painting the body. This keeps 6c
// small and testable; new event types can be added without
// touching the wait plumbing.
//
// Revision accounting: event payload itself does NOT carry a
// per-event rev (the server's `event_seq` lives at the envelope
// level, exposed via WaitResponse.nextRevision). The wait
// handler in wait_tick.go walks the events slice and increments
// a local counter starting from `lastRev`; the *item's* Rev
// field is set to that local counter. Callers should treat
// `ok=true` as "one event was consumed" and bump their cursor
// by 1, regardless of which field of the item they read.

package loop

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Core event types the transcript cares about (per §6'.3 6c
// design point 5). Anything outside this set returns
// ok=false from EventToTranscriptItem and the wait handler
// drops it on the floor (it still counts for revision
// advancement, so the cursor still moves forward).
const (
	eventTypeUserPrompt        = "user_prompt"
	eventTypeUserMessage       = "user_message"
	eventTypeAssistantText     = "assistant_text"
	eventTypeAssistantDelta    = "assistant_delta"
	eventTypeToolCompleted     = "tool_completed"
	eventTypeScopeBoundaryAny  = "scope_boundary" // prefix; both detected/confirmed carry context
	eventTypeScopeBoundaryDet  = "scope_boundary_detected"
	eventTypeScopeBoundaryConf = "scope_boundary_confirmed"
)

// EventToTranscriptItem shapes a single raw event payload
// from the /v1/sessions/:id/wait response into a TranscriptItem.
// The returned ok is true when the event type is one the
// transcript cares about; false means "skip — don't paint,
// but the caller should still advance its revision cursor
// by 1".
//
// Pure function: same input → same output, no side effects.
// Tested in phase6c_test.go.
func EventToTranscriptItem(raw json.RawMessage) (TranscriptItem, bool) {
	if len(raw) == 0 {
		return TranscriptItem{}, false
	}
	// Peek at the "type" field only. We don't decode the
	// whole payload until we know we want it — this keeps
	// unknown events cheap (one map lookup) and avoids
	// surfacing partial-decoding errors that would still
	// count as "ok=false" downstream.
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &head); err != nil || head.Type == "" {
		return TranscriptItem{}, false
	}
	switch head.Type {
	case eventTypeUserPrompt, eventTypeUserMessage:
		return shapeUserPrompt(raw)
	case eventTypeAssistantText, eventTypeAssistantDelta:
		return shapeAssistantText(raw)
	case eventTypeToolCompleted:
		return shapeToolCompleted(raw)
	case eventTypeScopeBoundaryDet, eventTypeScopeBoundaryConf, eventTypeScopeBoundaryAny:
		return shapeScopeBoundary(raw, head.Type)
	default:
		return TranscriptItem{}, false
	}
}

// shapeUserPrompt flattens a user_prompt event into a single
// transcript line. Real user prompts are usually 1-2
// sentences; longer ones get truncated to 200 chars here so
// the body column doesn't get dominated by one row.
func shapeUserPrompt(raw json.RawMessage) (TranscriptItem, bool) {
	var p struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return TranscriptItem{}, false
	}
	return TranscriptItem{Role: RoleUser, Text: clip(p.Text, 200)}, true
}

// shapeAssistantText flattens an assistant_text event. Same
// 200-char cap as user_prompt; BuildTranscriptLines truncates
// further at render time using the body column width.
func shapeAssistantText(raw json.RawMessage) (TranscriptItem, bool) {
	var p struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return TranscriptItem{}, false
	}
	return TranscriptItem{Role: RoleAssistant, Text: clip(p.Text, 200)}, true
}

// shapeToolCompleted renders a tool_completed event as
// "<name>: <output preview>". We don't try to JSON-dump
// the `output` field (which is `unknown` in the schema — could
// be a string, a structured object, anything). When output
// is a string, we use the first 120 chars. When it's a
// non-string scalar we render its JSON form, also capped.
func shapeToolCompleted(raw json.RawMessage) (TranscriptItem, bool) {
	var p struct {
		Name    string          `json:"name"`
		Success bool            `json:"success"`
		Output  json.RawMessage `json:"output"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.Name == "" {
		return TranscriptItem{}, false
	}
	out := renderToolOutput(p.Output, 120)
	status := "ok"
	if !p.Success {
		status = "FAIL"
	}
	text := fmt.Sprintf("%s [%s] %s", p.Name, status, out)
	return TranscriptItem{Role: RoleTool, Text: clip(text, 200)}, true
}

// shapeScopeBoundary collapses scope_boundary_detected /
// confirmed / any into a single system row. We don't try to
// dump the boundary payload — the row just signals "scope
// change happened" so the operator notices the context shift
// in the body. The status pill (drift) is the actual signal
// source for action; this row is for the transcript timeline.
func shapeScopeBoundary(raw json.RawMessage, eventType string) (TranscriptItem, bool) {
	var p struct {
		BoundaryKind string `json:"boundaryKind"`
		Path         string `json:"path"`
	}
	_ = json.Unmarshal(raw, &p)
	text := "scope boundary"
	if p.BoundaryKind != "" {
		text = text + " " + p.BoundaryKind
	}
	if p.Path != "" {
		text = text + ": " + p.Path
	}
	if eventType == eventTypeScopeBoundaryConf {
		text = text + " (confirmed)"
	} else {
		text = text + " (unconfirmed)"
	}
	return TranscriptItem{Role: RoleSystem, Text: clip(text, 200)}, true
}

// renderToolOutput flattens a tool_completed `output` field
// into a single line preview. The schema declares it as
// `unknown`, so we accept whatever JSON the server sends and
// produce a best-effort text view. String outputs are used
// verbatim; everything else is re-marshalled to compact JSON
// and trimmed to maxLen.
func renderToolOutput(raw json.RawMessage, maxLen int) string {
	if len(raw) == 0 {
		return ""
	}
	// Try as plain string first.
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return clip(s, maxLen)
	}
	// Fall back to compact JSON. Trim whitespace the
	// decoder inserted; if the JSON dump itself exceeds
	// maxLen, truncate with an ellipsis marker so the
	// operator can tell it was a real payload, not just
	// a string.
	compacted := strings.Join(strings.Fields(string(raw)), " ")
	return clip(compacted, maxLen)
}

// clip returns s truncated to at most maxLen runes, with an
// ellipsis suffix when truncation happened. Empty / shorter
// inputs are returned unchanged. Used to keep individual
// transcript rows from dominating the body column before
// BuildTranscriptLines applies the width-based cut.
func clip(s string, maxLen int) string {
	if maxLen <= 0 {
		return ""
	}
	// Use rune count, not byte count — tool outputs and
	// user prompts are UTF-8 in practice. A few extra
	// cols on a CJK-heavy transcript is acceptable; the
	// alternative (byte cap) would split a CJK char and
	// break the chrome.
	count := 0
	for i := range s {
		if count == maxLen {
			return s[:i] + "…"
		}
		count++
	}
	return s
}
