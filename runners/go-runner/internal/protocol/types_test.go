package protocol

import "testing"

func TestRequestKeyMatchesTypeScriptProtocol(t *testing.T) {
	got := RequestKey("session-1", "request-1", "tool-1")
	want := "session-1:request-1:tool-1"
	if got != want {
		t.Fatalf("RequestKey() = %q, want %q", got, want)
	}
}

func TestErrorResultShape(t *testing.T) {
	result := ErrorResult("CODE", "message", map[string]string{"detail": "value"})
	if result.Kind != "error" || result.Code != "CODE" || result.Message != "message" {
		t.Fatalf("unexpected error result: %#v", result)
	}
}
