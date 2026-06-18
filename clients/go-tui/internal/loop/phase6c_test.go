// internal/loop/phase6c_test.go
//
// Phase 6c tests (docs §6'): per-pane waitForEvent → transcript
// shaping. 6c is render-only at this layer — these tests cover
// the pure EventToTranscriptItem function. The waitTick /
// scheduleWait plumbing is a separate concern (covered by
// integration in wait_tick_test.go when 6c lands the cmd).

package loop

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestEventToTranscriptItemUserPrompt: a user_prompt with text
// becomes a RoleUser row carrying the text.
func TestEventToTranscriptItemUserPrompt(t *testing.T) {
	raw := json.RawMessage(`{"type":"user_prompt","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","text":"explain the diff"}`)
	item, ok := EventToTranscriptItem(raw)
	if !ok {
		t.Fatal("user_prompt should be accepted")
	}
	if item.Role != RoleUser {
		t.Errorf("Role = %d, want RoleUser", item.Role)
	}
	if item.Text != "explain the diff" {
		t.Errorf("Text = %q, want %q", item.Text, "explain the diff")
	}
}

// TestEventToTranscriptItemAssistantText: assistant_text
// becomes a RoleAssistant row.
func TestEventToTranscriptItemAssistantText(t *testing.T) {
	raw := json.RawMessage(`{"type":"assistant_text","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","text":"here is the answer"}`)
	item, ok := EventToTranscriptItem(raw)
	if !ok {
		t.Fatal("assistant_text should be accepted")
	}
	if item.Role != RoleAssistant {
		t.Errorf("Role = %d, want RoleAssistant", item.Role)
	}
	if item.Text != "here is the answer" {
		t.Errorf("Text = %q, want %q", item.Text, "here is the answer")
	}
}

// TestEventToTranscriptItemToolCompletedStringOutput: a
// tool_completed with a string output renders the tool name +
// success marker + first 120 chars of output.
func TestEventToTranscriptItemToolCompletedStringOutput(t *testing.T) {
	raw := json.RawMessage(`{"type":"tool_completed","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","name":"Bash","success":true,"output":"all 12 tests pass"}`)
	item, ok := EventToTranscriptItem(raw)
	if !ok {
		t.Fatal("tool_completed should be accepted")
	}
	if item.Role != RoleTool {
		t.Errorf("Role = %d, want RoleTool", item.Role)
	}
	if !strings.Contains(item.Text, "Bash") {
		t.Errorf("Text should mention tool name, got %q", item.Text)
	}
	if !strings.Contains(item.Text, "[ok]") {
		t.Errorf("Text should carry success marker, got %q", item.Text)
	}
	if !strings.Contains(item.Text, "all 12 tests pass") {
		t.Errorf("Text should carry output, got %q", item.Text)
	}
}

// TestEventToTranscriptItemToolCompletedFailure: when
// success=false, the marker is FAIL not ok.
func TestEventToTranscriptItemToolCompletedFailure(t *testing.T) {
	raw := json.RawMessage(`{"type":"tool_completed","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","name":"Bash","success":false,"output":"exit 1"}`)
	item, ok := EventToTranscriptItem(raw)
	if !ok {
		t.Fatal("tool_completed failure should still be accepted (operator needs to see it)")
	}
	if !strings.Contains(item.Text, "[FAIL]") {
		t.Errorf("Text should carry FAIL marker, got %q", item.Text)
	}
}

// TestEventToTranscriptItemToolCompletedObjectOutput: output
// that is a JSON object (not a string) is dumped compactly.
func TestEventToTranscriptItemToolCompletedObjectOutput(t *testing.T) {
	raw := json.RawMessage(`{"type":"tool_completed","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","name":"Read","success":true,"output":{"path":"/etc/hosts","bytes":312}}`)
	item, ok := EventToTranscriptItem(raw)
	if !ok {
		t.Fatal("tool_completed with object output should be accepted")
	}
	if !strings.Contains(item.Text, "Read") {
		t.Errorf("Text should mention tool name, got %q", item.Text)
	}
	// Compact-JSON fallback should at least include one of
	// the fields.
	if !strings.Contains(item.Text, "path") && !strings.Contains(item.Text, "bytes") {
		t.Errorf("Text should carry some structured output, got %q", item.Text)
	}
}

// TestEventToTranscriptItemScopeBoundaryDetected: detected
// scope boundary becomes a system row marked (unconfirmed).
func TestEventToTranscriptItemScopeBoundaryDetected(t *testing.T) {
	raw := json.RawMessage(`{"type":"scope_boundary_detected","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","boundaryKind":"external_repo","path":"/tmp/external"}`)
	item, ok := EventToTranscriptItem(raw)
	if !ok {
		t.Fatal("scope_boundary_detected should be accepted")
	}
	if item.Role != RoleSystem {
		t.Errorf("Role = %d, want RoleSystem", item.Role)
	}
	if !strings.Contains(item.Text, "external_repo") {
		t.Errorf("Text should mention boundary kind, got %q", item.Text)
	}
	if !strings.Contains(item.Text, "(unconfirmed)") {
		t.Errorf("detected boundary should be marked (unconfirmed), got %q", item.Text)
	}
	if !strings.Contains(item.Text, "/tmp/external") {
		t.Errorf("Text should mention path, got %q", item.Text)
	}
}

// TestEventToTranscriptItemScopeBoundaryConfirmed: confirmed
// boundary is accepted with a (confirmed) marker.
func TestEventToTranscriptItemScopeBoundaryConfirmed(t *testing.T) {
	raw := json.RawMessage(`{"type":"scope_boundary_confirmed","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","boundaryKind":"external_repo","path":"/tmp/external"}`)
	item, ok := EventToTranscriptItem(raw)
	if !ok {
		t.Fatal("scope_boundary_confirmed should be accepted")
	}
	if !strings.Contains(item.Text, "(confirmed)") {
		t.Errorf("confirmed boundary should be marked (confirmed), got %q", item.Text)
	}
}

// TestEventToTranscriptItemUnknownTypeReturnsFalse: events
// the transcript doesn't care about (e.g. raw progress ticks,
// turn markers) come back ok=false so the wait handler
// advances its rev cursor without painting the body.
func TestEventToTranscriptItemUnknownTypeReturnsFalse(t *testing.T) {
	raw := json.RawMessage(`{"type":"some_random_event","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z"}`)
	item, ok := EventToTranscriptItem(raw)
	if ok {
		t.Fatalf("unknown event type should return ok=false, got %+v", item)
	}
	if item.Text != "" {
		t.Fatalf("zero-value item should have empty text, got %q", item.Text)
	}
}

// TestEventToTranscriptItemEmptyRawReturnsFalse: defensive —
// a nil / empty raw message must not panic.
func TestEventToTranscriptItemEmptyRawReturnsFalse(t *testing.T) {
	if _, ok := EventToTranscriptItem(nil); ok {
		t.Fatal("nil raw should return ok=false")
	}
	if _, ok := EventToTranscriptItem(json.RawMessage("")); ok {
		t.Fatal("empty raw should return ok=false")
	}
}

// TestEventToTranscriptItemMalformedJSONReturnsFalse: an event
// that doesn't even decode the type field is dropped.
func TestEventToTranscriptItemMalformedJSONReturnsFalse(t *testing.T) {
	raw := json.RawMessage(`{not valid json`)
	if _, ok := EventToTranscriptItem(raw); ok {
		t.Fatal("malformed JSON should return ok=false, not panic")
	}
}

// TestEventToTranscriptItemUserPromptLongTextIsClipped: a
// 5000-char user_prompt text becomes a 200-rune row (with
// ellipsis) so it doesn't dominate the body column.
func TestEventToTranscriptItemUserPromptLongTextIsClipped(t *testing.T) {
	long := strings.Repeat("a", 5000)
	payload := `{"type":"user_prompt","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","text":"` + long + `"}`
	raw := json.RawMessage(payload)
	item, ok := EventToTranscriptItem(raw)
	if !ok {
		t.Fatal("user_prompt with long text should still be accepted")
	}
	// Rune count, not byte count — 200 ASCII runes + 1
	// ellipsis rune.
	count := 0
	for range item.Text {
		count++
	}
	if count != 201 {
		t.Errorf("clipped text should be 201 runes (200 + ellipsis), got %d", count)
	}
}

// TestEventToTranscriptItemCJKRuneAware: clip() counts runes,
// not bytes. A 100-rune CJK string should NOT be truncated
// at the byte boundary (which would split a CJK char in
// half). This guards against a footgun if clip() is ever
// rewritten to use len() / slicing.
func TestEventToTranscriptItemCJKRuneAware(t *testing.T) {
	cjk := strings.Repeat("你", 100) // 100 CJK chars, 300 bytes in UTF-8
	payload := `{"type":"user_prompt","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","text":"` + cjk + `"}`
	raw := json.RawMessage(payload)
	item, ok := EventToTranscriptItem(raw)
	if !ok {
		t.Fatal("CJK user_prompt should be accepted")
	}
	count := 0
	for range item.Text {
		count++
	}
	if count != 100 {
		t.Errorf("CJK text should be counted by runes (100 in / 100 out), got %d", count)
	}
}
