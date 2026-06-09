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

// Phase 2 event renderer parity: each formerly-raw-JSON event must
// produce a stable 8-char label + summary that no longer falls through
// to compactJSON.

func TestFormatNexusEventUserMessage(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type": "user_message",
		"text": "hello world",
	})
	if got != "hello world" {
		t.Fatalf("user_message summary = %q", got)
	}
}

func TestFormatNexusEventUserIntakeGuidance(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":          "user_intake_guidance",
		"intent":        "status",
		"requiresTools": false,
		"reason":        "short greeting",
	})
	if got != "intent=status requiresTools=false reason=short greeting" {
		t.Fatalf("user_intake_guidance summary = %q", got)
	}
}

func TestFormatNexusEventTaskCreated(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":   "task_created",
		"taskId": "task_abcdef1234567890",
		"title":  "Verify smoke workflow",
	})
	if got != "id=task_abc...567890 title=Verify smoke workflow" {
		t.Fatalf("task_created summary = %q", got)
	}
}

func TestFormatNexusEventTaskSessionEvent(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":      "task_session_event",
		"eventType": "subagent_started",
		"phase":     "running",
		"payload": map[string]any{
			"subagent":     "explore",
			"subSessionId": "session_1234567890abcdef",
			"parentTaskId": "1",
			"depth":        int64(1),
		},
	})
	for _, want := range []string{
		"eventType=subagent_started",
		"phase=running",
		"subagent=explore",
		"parentTaskId=1",
		"depth=1",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("task_session_event summary missing %q: %q", want, got)
		}
	}
}

func TestFormatNexusEventAgentJobEvent(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":      "agent_job_event",
		"eventType": "agent_job_started",
		"jobId":     "job_abcdef1234567890",
		"status":    "running",
		"agentType": "implement",
	})
	if got != "eventType=agent_job_started jobId=job_abcd...567890 status=running agentType=implement" {
		t.Fatalf("agent_job_event summary = %q", got)
	}
}

func TestFormatNexusEventCompactBoundary(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":               "compact_boundary",
		"trigger":            "auto",
		"beforeEventCount":   int64(120),
		"afterEventCount":    int64(34),
		"summaryChars":       int64(8000),
		"snippedToolResults": int64(7),
	})
	if got != "trigger=auto before=120 after=34 summary=8000chars snipped=7" {
		t.Fatalf("compact_boundary summary = %q", got)
	}
}

func TestFormatNexusEventCompactFailure(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":         "compact_failure",
		"trigger":      "reactive",
		"failureCount": int64(3),
		"maxFailures":  int64(3),
		"message":      "summary below floor",
	})
	if got != "trigger=reactive failures=3/3: summary below floor" {
		t.Fatalf("compact_failure summary = %q", got)
	}
}

func TestFormatNexusEventSessionMemoryUpdated(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":         "session_memory_updated",
		"trigger":      "auto",
		"reason":       "natural_pause",
		"summaryChars": int64(2400),
		"eventCount":   int64(85),
	})
	if got != "trigger=auto reason=natural_pause chars=2400 events=85" {
		t.Fatalf("session_memory_updated summary = %q", got)
	}
}

func TestFormatNexusEventExecutionMetrics(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":                   "execution_metrics",
		"executeDurationMs":      int64(1234),
		"inputTokens":            int64(800),
		"outputTokens":           int64(200),
		"toolCallCount":          int64(2),
		"providerFirstTokenMs":   int64(120),
	})
	if got != "dur=1234ms input=800 output=200 tools=2 firstToken=120ms" {
		t.Fatalf("execution_metrics summary = %q", got)
	}
}

func TestFormatToolInputExtractsBashCommand(t *testing.T) {
	got := formatToolInput("Bash", map[string]any{"command": "rm -rf /tmp/test"})
	if got != "rm -rf /tmp/test" {
		t.Fatalf("Bash input = %q", got)
	}
}

func TestFormatToolInputExtractsReadPath(t *testing.T) {
	got := formatToolInput("Read", map[string]any{"path": "/workspace/src/main.go"})
	if got != "/workspace/src/main.go" {
		t.Fatalf("Read input = %q", got)
	}
}

func TestFormatToolInputExtractsGrepPattern(t *testing.T) {
	got := formatToolInput("Grep", map[string]any{"pattern": "needle", "path": "/workspace"})
	if got != "pattern=needle" {
		t.Fatalf("Grep input = %q", got)
	}
}

func TestRenderPermissionIncludesInputAndMessage(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:3000", cwd: "/workspace"})
	m.width = 100
	m.height = 24
	m.resize()
	m.consumeNexusEvent(map[string]any{
		"type":      "permission_request",
		"toolUseId": "tool_1",
		"sessionId": "session_xyz",
		"name":      "Bash",
		"risk":      "execute",
		"input": map[string]any{
			"command": "node -e \"console.log('go-tui-smoke')\"",
		},
		"message": "Tool Bash requires user permission to run. Reason: write outside workspace",
	})

	view := m.View()
	if !strings.Contains(view, "Permission: Bash") {
		t.Fatalf("permission panel missing tool name: %q", view)
	}
	if !strings.Contains(view, "execute risk") {
		t.Fatalf("permission panel missing risk: %q", view)
	}
	if !strings.Contains(view, "input:") {
		t.Fatalf("permission panel missing input line: %q", view)
	}
	if !strings.Contains(view, "node -e") {
		t.Fatalf("permission panel missing command preview: %q", view)
	}
	if !strings.Contains(view, "reason:") {
		t.Fatalf("permission panel missing reason line: %q", view)
	}
	if !strings.Contains(view, "write outside workspace") {
		t.Fatalf("permission panel missing reason text: %q", view)
	}
}

func TestLinePresentationHasStableLabelsForPhase2Events(t *testing.T) {
	wantLabels := map[string]string{
		"task_created":            "task +   ",
		"task_session_event":      "task     ",
		"agent_job_event":         "agent    ",
		"compact_boundary":        "compact+ ",
		"compact_failure":         "compact! ",
		"context_warning":         "ctx warn ",
		"context_blocking":        "ctx stop ",
		"session_memory_updated":  "memory   ",
		"execution_metrics":       "metrics  ",
		"user_message":            "you      ",
		"user_intake_guidance":    "intake   ",
	}
	for kind, want := range wantLabels {
		got, _ := linePresentation(kind)
		if got != want {
			t.Fatalf("linePresentation(%q) = %q, want %q", kind, got, want)
		}
	}
}

func TestConsumeNexusEventPhase2NoLongerFallsToRawJSON(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:3000", cwd: "/workspace"})
	events := []map[string]any{
		{"type": "user_message", "text": "hi"},
		{"type": "user_intake_guidance", "intent": "status", "requiresTools": false, "reason": "greeting"},
		{"type": "task_created", "taskId": "task_1", "title": "t"},
		{"type": "task_session_event", "eventType": "subagent_started", "phase": "running"},
		{"type": "agent_job_event", "eventType": "agent_job_started", "jobId": "job_1", "status": "running", "agentType": "explore"},
		{"type": "compact_boundary", "trigger": "auto", "beforeEventCount": int64(10), "afterEventCount": int64(4), "summaryChars": int64(500), "snippedToolResults": int64(1)},
		{"type": "compact_failure", "trigger": "auto", "failureCount": int64(2), "maxFailures": int64(3), "message": "err"},
		{"type": "session_memory_updated", "trigger": "auto", "summaryChars": int64(100), "eventCount": int64(20)},
		{"type": "execution_metrics", "executeDurationMs": int64(500), "inputTokens": int64(10), "outputTokens": int64(5), "toolCallCount": int64(1), "providerFirstTokenMs": int64(50)},
	}
	for _, ev := range events {
		m.consumeNexusEvent(ev)
	}
	view := m.View()
	for _, line := range m.transcript {
		text := line.text
		// Raw-JSON sentinel: an unrendered compactJSON starts with `{` or `[`.
		// Allow it only if the line is a streaming assistant/thinking text.
		if line.kind == "assistant" || line.kind == "thinking" {
			continue
		}
		if strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
			t.Fatalf("event %q still falls through to compactJSON: %q", line.kind, text)
		}
	}
	if !strings.Contains(view, "task +") && !strings.Contains(view, "task   ") {
		t.Fatalf("transcript should include task labels, got view:\n%s", view)
	}
}
