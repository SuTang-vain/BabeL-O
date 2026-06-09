package main

import (
	"strings"
	"testing"
)

func TestStreamURL(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "http", in: "http://127.0.0.1:3000", want: "ws://127.0.0.1:3000/v1/stream"},
		{name: "https path", in: "https://example.com/nexus/", want: "wss://example.com/nexus/v1/stream"},
		{name: "ws", in: "ws://localhost:3000", want: "ws://localhost:3000/v1/stream"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := streamURL(tt.in)
			if err != nil {
				t.Fatalf("streamURL returned error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("streamURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestFormatNexusEvent(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":      "permission_request",
		"name":      "Bash",
		"risk":      "execute",
		"sessionId": "session_123",
		"toolUseId": "tool_123",
	})
	if got != "Bash (execute risk)" {
		t.Fatalf("formatNexusEvent() = %q", got)
	}
}

func TestFormatNexusEventSummarizesToolCompletedOutput(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":    "tool_completed",
		"name":    "Bash",
		"success": true,
		"output": map[string]any{
			"stdout": "go-tui-smoke\n",
			"stderr": "",
		},
	})

	if !strings.Contains(got, `stdout="go-tui-smoke"`) {
		t.Fatalf("formatNexusEvent() = %q, want stdout summary", got)
	}
}

func TestFormatNexusEventSummarizesHookCompletedOutput(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":      "hook_completed",
		"hookName":  "PermissionExplanationHook",
		"hookEvent": "PermissionRequest",
		"toolName":  "Bash",
		"output": map[string]any{
			"summary": "Bash has execute risk and requires an explicit approval decision.",
			"metadata": map[string]any{
				"suggestedScopes": []any{"once", "session"},
			},
		},
	})

	if !strings.Contains(got, "PermissionExplanationHook PermissionRequest Bash") {
		t.Fatalf("formatNexusEvent() = %q, want hook identity", got)
	}
	if !strings.Contains(got, "requires an explicit approval decision") {
		t.Fatalf("formatNexusEvent() = %q, want hook summary", got)
	}
	if strings.Contains(got, "suggestedScopes") {
		t.Fatalf("formatNexusEvent() = %q, should not render raw hook JSON", got)
	}
}

func TestConsumeNexusEventMergesStreamingAssistantDeltas(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:3000", cwd: "/workspace"})
	m.consumeNexusEvent(map[string]any{"type": "assistant_delta", "text": "hello "})
	m.consumeNexusEvent(map[string]any{"type": "assistant_delta", "text": "world"})

	last := m.transcript[len(m.transcript)-1]
	if last.kind != "assistant" {
		t.Fatalf("last kind = %q, want assistant", last.kind)
	}
	if last.text != "hello world" {
		t.Fatalf("last text = %q, want merged assistant text", last.text)
	}
}

func TestConsumeNexusEventUpdatesSessionAndPermissionPanel(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:3000", cwd: "/workspace"})
	m.width = 80
	m.height = 24
	m.resize()

	m.consumeNexusEvent(map[string]any{
		"type":      "session_started",
		"sessionId": "session_1234567890abcdef",
		"model":     "local/test",
	})
	m.consumeNexusEvent(map[string]any{
		"type":      "permission_request",
		"name":      "Bash",
		"risk":      "execute",
		"sessionId": "session_1234567890abcdef",
		"toolUseId": "tool_123",
	})

	if m.sessionID != "session_1234567890abcdef" {
		t.Fatalf("sessionID = %q", m.sessionID)
	}
	if m.modelID != "local/test" {
		t.Fatalf("modelID = %q", m.modelID)
	}
	if m.pending == nil || m.pending.name != "Bash" {
		t.Fatalf("pending permission = %#v, want Bash", m.pending)
	}
	view := m.View()
	if !strings.Contains(view, "BabeL-O Go TUI MVP") {
		t.Fatalf("view does not include title: %q", view)
	}
	if !strings.Contains(view, "Permission: Bash") {
		t.Fatalf("view does not include permission panel: %q", view)
	}
}

func TestRenderTranscriptLabelsLayeredEvents(t *testing.T) {
	rendered := renderTranscript([]transcriptLine{
		{kind: "user", text: "please inspect this project"},
		{kind: "tool_started", text: `Bash running {"command":"ls"}`},
		{kind: "assistant", text: "Done."},
	}, 80)

	for _, want := range []string{"you", "tool >", "assistant"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered transcript missing %q: %q", want, rendered)
		}
	}
}

func TestShortID(t *testing.T) {
	got := shortID("session_1234567890abcdef")
	if got != "session_...abcdef" {
		t.Fatalf("shortID() = %q", got)
	}
}
