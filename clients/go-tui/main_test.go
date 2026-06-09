package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
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

func TestAPIURL(t *testing.T) {
	tests := []struct {
		name string
		in   string
		path string
		want string
	}{
		{name: "http", in: "http://127.0.0.1:3000", path: "/v1/runtime/config", want: "http://127.0.0.1:3000/v1/runtime/config"},
		{name: "https path", in: "https://example.com/nexus/", path: "v1/runtime/config/profiles", want: "https://example.com/nexus/v1/runtime/config/profiles"},
		{name: "ws maps to http", in: "ws://localhost:3000", path: "/v1/runtime/config", want: "http://localhost:3000/v1/runtime/config"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := apiURL(tt.in, tt.path)
			if err != nil {
				t.Fatalf("apiURL returned error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("apiURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNexusJSONSendsAPIKeyAndDecodes(t *testing.T) {
	var seenMethod string
	var seenPath string
	var seenAPIKey string
	var seenProfile string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenPath = r.URL.Path
		seenAPIKey = r.Header.Get("X-Nexus-API-Key")
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		seenProfile = body["profile"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"runtime_config","modelId":"local/coding-runtime","providerId":"local","activeProfile":"dev","hasApiKey":false}`))
	}))
	defer server.Close()

	var out runtimeConfig
	err := nexusJSON(
		config{baseURL: server.URL, apiKey: "secret-key"},
		http.MethodPost,
		"/v1/runtime/config/select",
		map[string]string{"profile": "dev"},
		&out,
	)
	if err != nil {
		t.Fatalf("nexusJSON returned error: %v", err)
	}
	if seenMethod != http.MethodPost || seenPath != "/v1/runtime/config/select" {
		t.Fatalf("request = %s %s", seenMethod, seenPath)
	}
	if seenAPIKey != "secret-key" {
		t.Fatalf("X-Nexus-API-Key = %q", seenAPIKey)
	}
	if seenProfile != "dev" {
		t.Fatalf("profile payload = %q", seenProfile)
	}
	if out.ModelID != "local/coding-runtime" || out.ActiveProfile != "dev" {
		t.Fatalf("decoded runtime config = %#v", out)
	}
}

func TestFormatRuntimeConfigAndProfiles(t *testing.T) {
	configLine := formatRuntimeConfig(runtimeConfig{
		ModelID:       "openai/gpt-4o",
		Version:       7,
		ProviderID:    "openai",
		ActiveProfile: "dev",
		HasAPIKey:     true,
		APIKeySource:  "profile",
		ContextWindow: 128000,
	})
	for _, want := range []string{"config v=7", "model=openai/gpt-4o", "provider=openai", "profile=dev", "auth=configured(profile)", "context=128000"} {
		if !strings.Contains(configLine, want) {
			t.Fatalf("config summary missing %q: %q", want, configLine)
		}
	}

	profilesLine := formatRuntimeProfiles(runtimeProfilesResponse{
		ActiveProfile: "dev",
		Version:       8,
		Profiles: []runtimeProfile{
			{Name: "dev", Active: true, Model: "openai/gpt-4o"},
			{Name: "local", Model: "local/coding-runtime"},
		},
		Tombstones: map[string]runtimeProfileTombstone{
			"old": {DeletedAt: "2026-06-09T00:00:00Z"},
		},
	})
	for _, want := range []string{"profiles v=8", "*dev=openai/gpt-4o", "local=local/coding-runtime", "tombstones (1)", "old [tombstoned] deletedAt=2026-06-09T00:00:00Z"} {
		if !strings.Contains(profilesLine, want) {
			t.Fatalf("profiles summary missing %q: %q", want, profilesLine)
		}
	}
}

func TestHandleLocalConfigCommandsDoNotStartAgentStream(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:3000", cwd: "/workspace"})
	cmd := m.handleLocalCommand("/profile dev")
	// /profile <name> now gates the HTTP call behind a y/n overlay,
	// so handleLocalCommand itself returns nil and parks the model in
	// modeProfileConfirm with pendingProfileName = "dev".
	if cmd != nil {
		t.Fatalf("/profile dev should not fire HTTP from handleLocalCommand (it gates on a y/n overlay)")
	}
	if m.running {
		t.Fatalf("/profile dev should not start an agent stream")
	}
	if m.inputMode != modeProfileConfirm {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeProfileConfirm)
	}
	if m.pendingProfileName != "dev" {
		t.Fatalf("pendingProfileName = %q, want dev", m.pendingProfileName)
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
		"type":                 "execution_metrics",
		"executeDurationMs":    int64(1234),
		"inputTokens":          int64(800),
		"outputTokens":         int64(200),
		"toolCallCount":        int64(2),
		"providerFirstTokenMs": int64(120),
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
		"task_created":           "task +   ",
		"task_session_event":     "task     ",
		"agent_job_event":        "agent    ",
		"compact_boundary":       "compact+ ",
		"compact_failure":        "compact! ",
		"context_warning":        "ctx warn ",
		"context_blocking":       "ctx stop ",
		"session_memory_updated": "memory   ",
		"execution_metrics":      "metrics  ",
		"user_message":           "you      ",
		"user_intake_guidance":   "intake   ",
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

// === §5 路径 C 阶段 3: Go TUI version polling + tombstone UX ===

func TestFriendlyNexusErrorProducesHumanHints(t *testing.T) {
	cases := []struct {
		code    string
		payload map[string]any
		want    string
	}{
		{"tombstoned_profile", map[string]any{"profile": "work"}, `profile "work" is tombstoned; restore via ` + "`bbl config profile restore work`"},
		{"unknown_profile", map[string]any{"profile": "nope"}, `unknown profile "nope"`},
		{"not_supported", map[string]any{}, "model / role / roleModel switching is not supported via HTTP; use `bbl config use <modelId>` CLI"},
		{"missing_profile", map[string]any{}, "missing profile name in request body"},
		{"unknown_code", map[string]any{}, ""},
	}
	for _, tc := range cases {
		got, ok := friendlyNexusError(tc.code, tc.payload)
		if !ok {
			if tc.want != "" {
				t.Fatalf("friendlyNexusError(%q) returned ok=false, want %q", tc.code, tc.want)
			}
			continue
		}
		if tc.want == "" {
			t.Fatalf("friendlyNexusError(%q) returned ok=true, want ok=false", tc.code)
		}
		if !strings.Contains(got, tc.want) {
			t.Fatalf("friendlyNexusError(%q) = %q, want substring %q", tc.code, got, tc.want)
		}
	}
}

func TestSummarizeHTTPErrorPicksUpFriendlyHints(t *testing.T) {
	body := []byte(`{"error":"tombstoned_profile","profile":"work","tombstone":{"deletedAt":"2026-06-09T00:00:00Z"}}`)
	got := summarizeHTTPError(body)
	if !strings.Contains(got, "tombstoned") {
		t.Fatalf("summarizeHTTPError = %q, want tombstone hint", got)
	}
	if strings.Contains(got, "tombstone=") {
		t.Fatalf("summarizeHTTPError leaked raw field: %q", got)
	}
}

func TestSummarizeHTTPErrorFallsBackToRaw(t *testing.T) {
	body := []byte(`{"message":"something else","extra":1}`)
	got := summarizeHTTPError(body)
	if got != "something else" {
		t.Fatalf("summarizeHTTPError = %q, want %q", got, "something else")
	}
}

func TestFetchRuntimeConfigAppendsSinceQuery(t *testing.T) {
	// Capture the URL that fetchRuntimeConfig would build by running
	// it against a server that always returns 304. Use a custom
	// http.Transport that records the request URL.
	var gotURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURL = r.URL.String()
		w.WriteHeader(http.StatusNotModified)
	}))
	defer srv.Close()

	cfg := config{baseURL: srv.URL, pollIntervalMs: 0}
	_ = fetchRuntimeConfig(cfg, 42)()
	if gotURL != "/v1/runtime/config?since=42" {
		t.Fatalf("fetchRuntimeConfig URL = %q, want %q", gotURL, "/v1/runtime/config?since=42")
	}
}

func TestFetchRuntimeConfigNoSinceWhenZero(t *testing.T) {
	var gotURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURL = r.URL.String()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"type":"runtime_config","version":1}`))
	}))
	defer srv.Close()

	cfg := config{baseURL: srv.URL, pollIntervalMs: 0}
	_ = fetchRuntimeConfig(cfg, 0)()
	if gotURL != "/v1/runtime/config" {
		t.Fatalf("fetchRuntimeConfig URL = %q, want no query", gotURL)
	}
}

func TestNexusJSONReturnsErrNotModifiedOn304(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotModified)
	}))
	defer srv.Close()

	cfg := config{baseURL: srv.URL}
	var payload runtimeConfig
	err := nexusJSON(cfg, http.MethodGet, "/v1/runtime/config", nil, &payload)
	if !errors.Is(err, errNotModified) {
		t.Fatalf("expected errNotModified, got %v", err)
	}
}

func TestRuntimeConfigMsgHandlerSilentlyReschedulesPollOn304(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", pollIntervalMs: 5})
	m.configVersion = 7

	_, cmd := m.Update(runtimeConfigMsg{err: errNotModified})
	if cmd == nil {
		t.Fatalf("expected a poll reschedule cmd on 304")
	}
}

func TestRuntimeConfigMsgHandlerLogsWhenVersionMoves(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", pollIntervalMs: 5})
	before := len(m.transcript)
	updated, _ := m.Update(runtimeConfigMsg{config: runtimeConfig{Version: 9, ModelID: "x"}})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.configVersion != 9 {
		t.Fatalf("configVersion = %d, want 9", updatedModel.configVersion)
	}
	if len(updatedModel.transcript) <= before {
		t.Fatalf("transcript should grow when version moves, before=%d after=%d", before, len(updatedModel.transcript))
	}
}

func TestSchedulePollTickReturnsNilWhenDisabled(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", pollIntervalMs: 0})
	if cmd := m.schedulePollTick(); cmd != nil {
		t.Fatalf("expected nil cmd when poll disabled, got %T", cmd)
	}
}

func TestSchedulePollTickEmitsPollTickMsg(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", pollIntervalMs: 5})
	cmd := m.schedulePollTick()
	if cmd == nil {
		t.Fatalf("expected a tick cmd")
	}
	msg := cmd()
	if _, ok := msg.(pollTickMsg); !ok {
		t.Fatalf("expected pollTickMsg, got %T", msg)
	}
}

func TestPollTickDeferWhenConfigVersionIsZero(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", pollIntervalMs: 5})
	_, cmd := m.Update(pollTickMsg{})
	if cmd == nil {
		t.Fatalf("expected reschedule cmd when config version is 0")
	}
}

func TestFormatRuntimeProfilesTombstoneOrderingIsStable(t *testing.T) {
	rendered := formatRuntimeProfiles(runtimeProfilesResponse{
		Version:       1,
		ActiveProfile: "a",
		Profiles:      []runtimeProfile{{Name: "a", Active: true, Model: "m1"}},
		Tombstones: map[string]runtimeProfileTombstone{
			"zeta":  {DeletedAt: "2026-06-09T01:00:00Z"},
			"alpha": {DeletedAt: "2026-06-09T02:00:00Z"},
		},
	})
	// alpha should appear before zeta (lexicographic).
	alphaIdx := strings.Index(rendered, "alpha")
	zetaIdx := strings.Index(rendered, "zeta")
	if alphaIdx == -1 || zetaIdx == -1 || alphaIdx > zetaIdx {
		t.Fatalf("tombstones not sorted: %q", rendered)
	}
}

// === Phase 3: single-input-owner state machine ===

func TestInputModeDefaultsToComposing(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if m.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeComposing)
	}
}

func TestSetModeIsIdempotentAndRecordsTransition(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.setMode(modePermission)
	if m.inputMode != modePermission {
		t.Fatalf("after setMode(permission): %q", m.inputMode)
	}
	m.setMode(modePermission)
	if m.inputMode != modePermission {
		t.Fatalf("idempotent setMode should not break state: %q", m.inputMode)
	}
	m.setMode(modeComposing)
	if m.inputMode != modeComposing {
		t.Fatalf("after setMode(composing): %q", m.inputMode)
	}
}

func TestCanEditInputOnlyTrueInComposing(t *testing.T) {
	for mode, want := range map[inputMode]bool{
		modeComposing:   true,
		modePermission:  false,
		modeSlashPick:   false,
		modeHelpOverlay: false,
	} {
		if got := mode.canEditInput(); got != want {
			t.Fatalf("canEditInput(%q) = %v, want %v", mode, got, want)
		}
	}
}

func TestPermissionRequestEntersPermissionMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.consumeNexusEvent(map[string]any{
		"type":      "permission_request",
		"sessionId": "session_1234567890abcdef",
		"toolUseId": "tool_1",
		"name":      "Bash",
		"risk":      "execute",
		"input":     map[string]any{"command": "echo hi"},
	})
	if m.inputMode != modePermission {
		t.Fatalf("inputMode = %q after permission_request, want %q", m.inputMode, modePermission)
	}
	if m.pending == nil {
		t.Fatalf("pending should be set when entering permission mode")
	}
}

func TestSendPermissionDecisionReturnsToComposing(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.consumeNexusEvent(map[string]any{
		"type":      "permission_request",
		"sessionId": "session_1",
		"toolUseId": "tool_1",
		"name":      "Bash",
		"risk":      "execute",
	})
	// Fake the decision channel so sendPermissionDecision can write.
	m.decisions = make(chan permissionDecision, 1)
	if m.inputMode != modePermission {
		t.Fatalf("precondition: inputMode = %q, want %q", m.inputMode, modePermission)
	}
	m.sendPermissionDecision(true, "Approved from test")
	if m.inputMode != modeComposing {
		t.Fatalf("inputMode = %q after send, want %q", m.inputMode, modeComposing)
	}
	if m.pending != nil {
		t.Fatalf("pending should be nil after send")
	}
}

func TestKeyDoesNotReachTextinputInPermissionMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.consumeNexusEvent(map[string]any{
		"type":      "permission_request",
		"sessionId": "session_1",
		"toolUseId": "tool_1",
		"name":      "Bash",
		"risk":      "execute",
	})
	m.decisions = make(chan permissionDecision, 1)
	before := m.input.Value()

	// Pressing a random letter while in permission mode must not
	// insert into m.input. (Phase 3 single-input-owner invariant.)
	_, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}})
	if m.input.Value() != before {
		t.Fatalf("textinput received key while in permission mode: %q -> %q", before, m.input.Value())
	}
}

func TestHelpOverlayOpensOnQuestionMark(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.width = 80
	m.height = 24
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'?'}})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeHelpOverlay {
		t.Fatalf("inputMode = %q, want %q", updatedModel.inputMode, modeHelpOverlay)
	}
	if !strings.Contains(updatedModel.View(), "Help") {
		t.Fatalf("help view should mention 'Help' header: %q", updatedModel.View())
	}
}

func TestHelpOverlayClosesOnEsc(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.width = 80
	m.height = 24
	m.setMode(modeHelpOverlay)
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want %q after Esc", updatedModel.inputMode, modeComposing)
	}
}

func TestHelpOverlayScrollMovesHelpScroll(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.width = 80
	m.height = 24
	m.setMode(modeHelpOverlay)
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyDown})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.helpScroll != 1 {
		t.Fatalf("helpScroll = %d, want 1", updatedModel.helpScroll)
	}
	updated, _ = updatedModel.Update(tea.KeyMsg{Type: tea.KeyUp})
	updatedModel, _ = updated.(model)
	if updatedModel.helpScroll != 0 {
		t.Fatalf("helpScroll = %d, want 0 after up", updatedModel.helpScroll)
	}
}

func TestQuestionMarkIgnoredWhenInputNonEmpty(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.input.SetValue("abc")
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'?'}})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode == modeHelpOverlay {
		t.Fatalf("help must not open when input is non-empty")
	}
	if !strings.Contains(updatedModel.input.Value(), "abc?") {
		t.Fatalf("input should have '?' appended, got %q", updatedModel.input.Value())
	}
}

func TestCtrlCAlwaysQuitsEvenFromOverlay(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.setMode(modeHelpOverlay)
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatalf("ctrl+c from help overlay should still return a quit cmd")
	}
	// The returned cmd is tea.Quit; we don't invoke it here.
}

func TestQDoesNotQuitWhenInOverlay(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.setMode(modeHelpOverlay)
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	if cmd != nil {
		t.Fatalf("q from help overlay must not quit, got %T", cmd)
	}
	// q inside help should be handled by the help handler (close
	// overlay) and route the model back to composing.
	if m.inputMode != modeHelpOverlay {
		t.Fatalf("help should still be open after q key arrival, got %q", m.inputMode)
	}
}

func TestTextinputInstanceNotReplacedAcrossModes(t *testing.T) {
	// Phase 3 invariant: the textinput instance is created once in
	// newModel and must never be replaced by mode transitions; only its
	// value / cursor are mutated. We assert this by checking that a
	// value the user typed survives a full mode round-trip.
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.input.SetValue("in-progress draft")

	m.setMode(modePermission)
	if m.input.Value() != "in-progress draft" {
		t.Fatalf("input Value reset when entering permission mode: %q", m.input.Value())
	}
	m.setMode(modeHelpOverlay)
	if m.input.Value() != "in-progress draft" {
		t.Fatalf("input Value reset when entering help mode: %q", m.input.Value())
	}
	m.setMode(modeComposing)
	if m.input.Value() != "in-progress draft" {
		t.Fatalf("input Value reset when returning to composing: %q", m.input.Value())
	}
}

func TestRenderHelpHiddenInComposing(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.width = 80
	m.height = 24
	if got := m.renderHelp(80); got != "" {
		t.Fatalf("renderHelp should be empty in composing, got %q", got)
	}
}

func TestRenderHelpVisibleInHelpMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.width = 80
	m.height = 24
	m.setMode(modeHelpOverlay)
	if got := m.renderHelp(80); !strings.Contains(got, "Help") {
		t.Fatalf("renderHelp should mention 'Help', got %q", got)
	}
}

// === Phase 4: slash command registry + live-filter palette + tool palette ===

func TestSlashCommandRegistryIsComplete(t *testing.T) {
	if len(slashCommands) < 8 {
		t.Fatalf("expected at least 8 slash commands, got %d", len(slashCommands))
	}
	// Names must be unique and start with '/'.
	seen := make(map[string]bool, len(slashCommands))
	for _, c := range slashCommands {
		if !strings.HasPrefix(c.name, "/") {
			t.Fatalf("command name must start with '/': %q", c.name)
		}
		if seen[c.name] {
			t.Fatalf("duplicate slash command: %q", c.name)
		}
		seen[c.name] = true
		for _, a := range c.aliases {
			if seen[a] {
				t.Fatalf("alias collides with another command name: %q", a)
			}
			seen[a] = true
		}
	}
	// The minimum required by the rewrite plan.
	for _, want := range []string{"/help", "/config", "/profile", "/clear", "/exit", "/bash", "/read", "/grep"} {
		if !seen[want] {
			t.Fatalf("required slash command %q missing from registry", want)
		}
	}
}

func TestFilterSlashCommandsMatchesByNameAndAlias(t *testing.T) {
	// By name
	got := filterSlashCommands("/prof")
	if len(got) != 1 || got[0].name != "/profile" {
		t.Fatalf("filterSlashCommands(/prof) = %v, want [/profile]", got)
	}
	// By alias
	got = filterSlashCommands("/pro")
	if len(got) != 1 || got[0].name != "/profile" {
		t.Fatalf("filterSlashCommands(/pro) = %v, want [/profile]", got)
	}
	// Case insensitive
	got = filterSlashCommands("/PR")
	if len(got) != 1 || got[0].name != "/profile" {
		t.Fatalf("filterSlashCommands(/PR) = %v, want [/profile]", got)
	}
	// No match
	got = filterSlashCommands("/xyz")
	if len(got) != 0 {
		t.Fatalf("filterSlashCommands(/xyz) = %v, want []", got)
	}
	// Empty filter returns the entire registry
	got = filterSlashCommands("")
	if len(got) != len(slashCommands) {
		t.Fatalf("filterSlashCommands(\"\") = %d entries, want %d", len(got), len(slashCommands))
	}
}

func TestFindSlashCommandResolvesAlias(t *testing.T) {
	got := findSlashCommand("/profiles")
	if got == nil {
		t.Fatalf("findSlashCommand(/profiles) returned nil")
	}
	if got.name != "/profile" {
		t.Fatalf("findSlashCommand(/profiles).name = %q, want /profile", got.name)
	}
}

func TestSlashPaletteOpensOnSlashFromEmptyInput(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeSlashPick {
		t.Fatalf("inputMode = %q, want %q after '/'", updatedModel.inputMode, modeSlashPick)
	}
	if updatedModel.paletteFilter != "" {
		t.Fatalf("paletteFilter = %q, want empty", updatedModel.paletteFilter)
	}
}

func TestSlashPaletteDoesNotOpenOnSlashWhenInputNonEmpty(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.input.SetValue("abc")
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode == modeSlashPick {
		t.Fatalf("palette must not open when input is non-empty")
	}
	if !strings.Contains(updatedModel.input.Value(), "abc/") {
		t.Fatalf("input should have '/' appended, got %q", updatedModel.input.Value())
	}
}

func TestSlashPaletteLiveFilterAppendsToFilter(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.setMode(modeSlashPick)
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'p'}})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.paletteFilter != "p" {
		t.Fatalf("paletteFilter = %q, want %q", updatedModel.paletteFilter, "p")
	}
	updated, _ = updatedModel.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'r'}})
	updatedModel, _ = updated.(model)
	if updatedModel.paletteFilter != "pr" {
		t.Fatalf("paletteFilter = %q, want %q", updatedModel.paletteFilter, "pr")
	}
}

func TestSlashPaletteBackspaceEditsFilter(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.setMode(modeSlashPick)
	m.paletteFilter = "abc"
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	updatedModel, _ := updated.(model)
	if updatedModel.paletteFilter != "ab" {
		t.Fatalf("paletteFilter = %q, want %q", updatedModel.paletteFilter, "ab")
	}
}

func TestSlashPaletteBackspaceOnEmptyFilterClosesPalette(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.setMode(modeSlashPick)
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	updatedModel, _ := updated.(model)
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want composing after backspace on empty filter", updatedModel.inputMode)
	}
}

func TestSlashPaletteEscClosesAndClearsInput(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.setMode(modeSlashPick)
	m.paletteFilter = "pro"
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	updatedModel, _ := updated.(model)
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want composing", updatedModel.inputMode)
	}
	if updatedModel.input.Value() != "" {
		t.Fatalf("input.Value = %q, want empty", updatedModel.input.Value())
	}
	if updatedModel.paletteFilter != "" {
		t.Fatalf("paletteFilter = %q, want empty", updatedModel.paletteFilter)
	}
}

func TestSlashPaletteUpDownNavigatesSelection(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.setMode(modeSlashPick)
	// Filter matches multiple commands ("/h" -> /help + /h-prefixed entries)
	// Actually only /help starts with "h" in our registry. Use "/b" -> /bash.
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'b'}})
	updatedModel, _ := updated.(model)
	if updatedModel.paletteSelected != 0 {
		t.Fatalf("paletteSelected should start at 0, got %d", updatedModel.paletteSelected)
	}
	updated, _ = updatedModel.Update(tea.KeyMsg{Type: tea.KeyDown})
	updatedModel, _ = updated.(model)
	// /b matches /bash only — but navigating down should stay at 0 (clamped).
	if updatedModel.paletteSelected != 0 {
		t.Fatalf("paletteSelected = %d, want 0 (clamped at single match)", updatedModel.paletteSelected)
	}
}

func TestSlashPaletteEnterRunsZeroArgCommand(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.setMode(modeSlashPick)
	m.paletteFilter = "help"
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	updatedModel, _ := updated.(model)
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want composing", updatedModel.inputMode)
	}
	// The /help runner should have appended a status line listing commands.
	rendered := updatedModel.View()
	if !strings.Contains(rendered, "local commands:") {
		t.Fatalf("view should mention 'local commands:', got %q", rendered)
	}
}

func TestSlashPaletteEnterOnPrefixCommandInsertsPrefix(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.setMode(modeSlashPick)
	m.paletteFilter = "bash"
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	updatedModel, _ := updated.(model)
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want composing", updatedModel.inputMode)
	}
	if got := updatedModel.input.Value(); got != "/bash " {
		t.Fatalf("input.Value = %q, want %q", got, "/bash ")
	}
}

func TestSlashPaletteRenderShowsFilterAndCandidates(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.width = 100
	m.height = 24
	m.setMode(modeSlashPick)
	m.paletteFilter = "p"
	rendered := m.renderSlashPalette(100)
	if !strings.Contains(rendered, "Slash") {
		t.Fatalf("palette should mention 'Slash' header, got %q", rendered)
	}
	if !strings.Contains(rendered, "/p") {
		t.Fatalf("palette should show the current filter '/p', got %q", rendered)
	}
	// The matched command /profile should be in the rendered list.
	if !strings.Contains(rendered, "/profile") {
		t.Fatalf("palette should show /profile, got %q", rendered)
	}
}

func TestSlashPaletteRenderHiddenInOtherModes(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.width = 100
	m.height = 24
	if got := m.renderSlashPalette(100); got != "" {
		t.Fatalf("renderSlashPalette should be empty in composing, got %q", got)
	}
}

func TestToolPaletteRendersRiskSourceApproval(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.renderToolPalette([]toolDescriptor{
		{name: "Bash", risk: "execute", source: "builtin", approval: true, summary: "run a shell command"},
		{name: "Read", risk: "read", source: "builtin", approval: false, summary: "read a file"},
	})
	rendered := m.View()
	if !strings.Contains(rendered, "tools (2, read-only):") {
		t.Fatalf("tools palette should show count, got %q", rendered)
	}
	if !strings.Contains(rendered, "Bash") {
		t.Fatalf("tools palette should list Bash, got %q", rendered)
	}
	if !strings.Contains(rendered, "risk=execute") {
		t.Fatalf("tools palette should show Bash risk=execute, got %q", rendered)
	}
	if !strings.Contains(rendered, "approval-required") {
		t.Fatalf("tools palette should show approval-required for Bash, got %q", rendered)
	}
	if !strings.Contains(rendered, "no-approval") {
		t.Fatalf("tools palette should show no-approval for Read, got %q", rendered)
	}
}

func TestHandleLocalCommandRegistersKnownCommands(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	// /config is a real Nexus HTTP call; it should not error in
	// handleLocalCommand itself, even though the URL is unreachable.
	// The error (if any) will come from the network call.
	m.handleLocalCommand("/config")
	// /unknown must surface an error line.
	before := len(m.transcript)
	m.handleLocalCommand("/unknown-command")
	if len(m.transcript) <= before {
		t.Fatalf("unknown command should append an error line")
	}
	rendered := m.View()
	if !strings.Contains(rendered, "unknown local command") {
		t.Fatalf("view should mention 'unknown local command', got %q", rendered)
	}
}

// --- Profile confirm overlay (§5 path C phase 3 polish continuation) ---

func TestProfileAlreadyActiveShortCircuitsConfirmOverlay(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.activeProfile = "dev"
	before := len(m.transcript)
	cmd := m.handleLocalCommand("/profile dev")
	if cmd != nil {
		t.Fatalf("/profile <active> should return nil (no HTTP, no overlay)")
	}
	if m.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want %q (already-active must not open overlay)", m.inputMode, modeComposing)
	}
	if m.pendingProfileName != "" {
		t.Fatalf("pendingProfileName = %q, want empty", m.pendingProfileName)
	}
	rendered := renderTranscript(m.transcript[before:], 100)
	if !strings.Contains(rendered, "profile already active: dev") {
		t.Fatalf("transcript should mention 'profile already active: dev', got %q", rendered)
	}
}

func TestProfileConfirmYKeyFiresHTTPCommand(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.activeProfile = "dev"
	if cmd := m.handleLocalCommand("/profile staging"); cmd != nil {
		t.Fatalf("/profile staging should return nil (parked in confirm)")
	}
	if m.inputMode != modeProfileConfirm {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeProfileConfirm)
	}
	updated, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	if cmd == nil {
		t.Fatalf("y in profile-confirm should return the selectRuntimeProfile HTTP command")
	}
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode after y = %q, want %q", updatedModel.inputMode, modeComposing)
	}
	if updatedModel.pendingProfileName != "" {
		t.Fatalf("pendingProfileName after y = %q, want empty", updatedModel.pendingProfileName)
	}
	rendered := renderTranscript(updatedModel.transcript, 200)
	if !strings.Contains(rendered, "selecting shared Nexus profile: staging") {
		t.Fatalf("transcript should mention 'selecting shared Nexus profile: staging', got %q", rendered)
	}
}

func TestProfileConfirmEnterKeyFiresHTTPCommand(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if cmd := m.handleLocalCommand("/profile prod"); cmd != nil {
		t.Fatalf("/profile prod should return nil (parked in confirm)")
	}
	updated, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatalf("enter in profile-confirm should fire the HTTP command")
	}
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode after enter = %q, want %q", updatedModel.inputMode, modeComposing)
	}
	if updatedModel.pendingProfileName != "" {
		t.Fatalf("pendingProfileName after enter = %q, want empty", updatedModel.pendingProfileName)
	}
}

func TestProfileConfirmNKeyCancelsWithoutHTTP(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if cmd := m.handleLocalCommand("/profile prod"); cmd != nil {
		t.Fatalf("/profile prod should return nil (parked in confirm)")
	}
	updated, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
	if cmd != nil {
		t.Fatalf("n in profile-confirm should NOT fire any HTTP command, got %v", cmd)
	}
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode after n = %q, want %q", updatedModel.inputMode, modeComposing)
	}
	if updatedModel.pendingProfileName != "" {
		t.Fatalf("pendingProfileName after n = %q, want empty", updatedModel.pendingProfileName)
	}
	rendered := renderTranscript(updatedModel.transcript, 200)
	if !strings.Contains(rendered, "profile switch cancelled: prod") {
		t.Fatalf("transcript should mention 'profile switch cancelled: prod', got %q", rendered)
	}
}

func TestProfileConfirmEscKeyCancels(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if cmd := m.handleLocalCommand("/profile prod"); cmd != nil {
		t.Fatalf("/profile prod should return nil (parked in confirm)")
	}
	updated, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd != nil {
		t.Fatalf("esc in profile-confirm should NOT fire any HTTP command, got %v", cmd)
	}
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode after esc = %q, want %q", updatedModel.inputMode, modeComposing)
	}
	if updatedModel.pendingProfileName != "" {
		t.Fatalf("pendingProfileName after esc = %q, want empty", updatedModel.pendingProfileName)
	}
	rendered := renderTranscript(updatedModel.transcript, 200)
	if !strings.Contains(rendered, "profile switch cancelled: prod") {
		t.Fatalf("transcript should mention 'profile switch cancelled: prod', got %q", rendered)
	}
}

func TestProfileConfirmStrayKeyDoesNotReachTextinput(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if cmd := m.handleLocalCommand("/profile prod"); cmd != nil {
		t.Fatalf("/profile prod should return nil (parked in confirm)")
	}
	before := m.input.Value()
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'z'}})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeProfileConfirm {
		t.Fatalf("stray key should NOT exit profile-confirm mode")
	}
	if updatedModel.input.Value() != before {
		t.Fatalf("stray key should NOT reach textinput (was %q, now %q)", before, updatedModel.input.Value())
	}
	if updatedModel.pendingProfileName != "prod" {
		t.Fatalf("pendingProfileName = %q, want prod (stray key must not clear pending)", updatedModel.pendingProfileName)
	}
}

func TestRenderProfileConfirmEmptyOutsideMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.activeProfile = "dev"
	if got := m.renderProfileConfirm(100); got != "" {
		t.Fatalf("renderProfileConfirm in composing mode should return empty, got %q", got)
	}
}

func TestRenderProfileConfirmShowsHeaderInMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.activeProfile = "dev"
	if cmd := m.handleLocalCommand("/profile prod"); cmd != nil {
		t.Fatalf("/profile prod should return nil (parked in confirm)")
	}
	rendered := m.renderProfileConfirm(120)
	if rendered == "" {
		t.Fatalf("renderProfileConfirm in profile-confirm mode should be non-empty")
	}
	for _, want := range []string{"Confirm profile switch", "current: dev", "→ new:   prod", "y / enter", "n / esc"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered profile-confirm missing %q\nfull: %q", want, rendered)
		}
	}
}

func TestProfileConfirmWithEmptyActiveShowsNoCurrent(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if cmd := m.handleLocalCommand("/profile prod"); cmd != nil {
		t.Fatalf("/profile prod should return nil (parked in confirm)")
	}
	rendered := m.renderProfileConfirm(120)
	if !strings.Contains(rendered, "→ Switch active profile to: prod") {
		t.Fatalf("empty activeProfile should render the single-line variant, got %q", rendered)
	}
}

// --- Phase 5: /context + /compact wire to real Nexus endpoints ---

func TestContextWithEmptySessionShortCircuits(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	before := len(m.transcript)
	cmd := m.handleLocalCommand("/context")
	if cmd != nil {
		t.Fatalf("/context with no session should return nil (no HTTP call)")
	}
	if m.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeComposing)
	}
	rendered := renderTranscript(m.transcript[before:], 200)
	if !strings.Contains(rendered, "context: no active session yet") {
		t.Fatalf("transcript should mention 'context: no active session yet', got %q", rendered)
	}
}

func TestCompactWithEmptySessionShortCircuits(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	before := len(m.transcript)
	cmd := m.handleLocalCommand("/compact")
	if cmd != nil {
		t.Fatalf("/compact with no session should return nil (no HTTP call)")
	}
	rendered := renderTranscript(m.transcript[before:], 200)
	if !strings.Contains(rendered, "compact: no active session yet") {
		t.Fatalf("transcript should mention 'compact: no active session yet', got %q", rendered)
	}
}

func TestContextWithActiveSessionFiresHTTP(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "session_phase5_test"
	before := len(m.transcript)
	cmd := m.handleLocalCommand("/context")
	if cmd == nil {
		t.Fatalf("/context with active session should fire an HTTP command")
	}
	rendered := renderTranscript(m.transcript[before:], 200)
	if !strings.Contains(rendered, "analyzing shared Nexus context") {
		t.Fatalf("transcript should mention 'analyzing shared Nexus context', got %q", rendered)
	}
}

func TestCompactWithActiveSessionFiresHTTP(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "session_phase5_test"
	before := len(m.transcript)
	cmd := m.handleLocalCommand("/compact")
	if cmd == nil {
		t.Fatalf("/compact with active session should fire an HTTP command")
	}
	rendered := renderTranscript(m.transcript[before:], 200)
	if !strings.Contains(rendered, "compacting shared Nexus context") {
		t.Fatalf("transcript should mention 'compacting shared Nexus context', got %q", rendered)
	}
}

func TestFormatContextAnalysisExtractsTopLevelEnvelope(t *testing.T) {
	raw := []byte(`{
		"type": "context_analysis",
		"sessionId": "session_abc",
		"modelId": "local/coding-runtime",
		"compact": {"hasBoundary": true},
		"diagnostic": {
			"name": "context_analysis",
			"status": "warning",
			"summary": "context 6500/8192 tokens; 1692 remaining",
			"signals": [
				{"level": "warning", "code": "WARN_LARGE_TOOL_RESULT", "message": "Bash output exceeded 4k chars"},
				{"level": "warning", "code": "WARN_MEMORY_PRESSURE", "message": "long-term memory truncated"},
				{"level": "info", "code": "INFO_REPEATED_TOOL_INPUT", "message": "Grep called 5x with same pattern"}
			],
			"recommendations": [
				"Run /compact to reclaim space",
				"Switch to a larger context model",
				"Reduce tool output before retrying"
			]
		}
	}`)
	got := formatContextAnalysis(raw)
	for _, want := range []string{
		"context_analysis model=local/coding-runtime",
		"context 6500/8192 tokens; 1692 remaining",
		"status: warning",
		"compact: boundary present",
		"[warning] WARN_LARGE_TOOL_RESULT Bash output exceeded 4k chars",
		"[info] INFO_REPEATED_TOOL_INPUT Grep called 5x with same pattern",
		"- Run /compact to reclaim space",
		"- Switch to a larger context model",
		"- Reduce tool output before retrying",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatContextAnalysis missing %q\nfull:\n%s", want, got)
		}
	}
}

func TestFormatContextAnalysisTruncatesLongSignalsAndRecommendations(t *testing.T) {
	signals := make([]string, 0, 6)
	for i := 0; i < 6; i++ {
		signals = append(signals, fmt.Sprintf(`{"level":"info","code":"S%d","message":"m%d"}`, i, i))
	}
	recs := make([]string, 0, 5)
	for i := 0; i < 5; i++ {
		recs = append(recs, fmt.Sprintf(`"rec %d"`, i))
	}
	raw := []byte(`{
		"type": "context_analysis",
		"modelId": "local/coding-runtime",
		"compact": {"hasBoundary": false},
		"diagnostic": {
			"name": "context_analysis",
			"status": "ok",
			"summary": "context 0/8192 tokens; 8192 remaining",
			"signals": [` + strings.Join(signals, ",") + `],
			"recommendations": [` + strings.Join(recs, ",") + `]
		}
	}`)
	got := formatContextAnalysis(raw)
	if !strings.Contains(got, "S0") || !strings.Contains(got, "S2") {
		t.Fatalf("first 3 signals should appear, got:\n%s", got)
	}
	if strings.Contains(got, "S5") {
		t.Fatalf("S5 (4th signal) should be truncated, got:\n%s", got)
	}
	if !strings.Contains(got, "+3 more") {
		t.Fatalf("expected '+3 more' for signals truncation, got:\n%s", got)
	}
	if !strings.Contains(got, "rec 0") || strings.Contains(got, "rec 4") {
		t.Fatalf("first 3 recommendations should appear, rec 4 should be truncated, got:\n%s", got)
	}
	if !strings.Contains(got, "+2 more") {
		t.Fatalf("expected '+2 more' for recommendations truncation, got:\n%s", got)
	}
}

func TestFormatContextAnalysisReportsDecodeErrorOnInvalidJSON(t *testing.T) {
	got := formatContextAnalysis([]byte(`{not json`))
	if !strings.Contains(got, "context: decode failed") {
		t.Fatalf("formatContextAnalysis should report decode error, got %q", got)
	}
}

func TestFormatCompactResultExtractsEventCounts(t *testing.T) {
	raw := []byte(`{
		"type": "compact_result",
		"sessionId": "session_abc",
		"beforeEventCount": 47,
		"afterEventCount": 12,
		"event": {"type": "compact_boundary", "code": ""}
	}`)
	got := formatCompactResult(raw)
	for _, want := range []string{
		"compact_result events: 47 → 12",
		"boundary: compact_boundary",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatCompactResult missing %q\nfull:\n%s", want, got)
		}
	}
}

func TestFormatCompactResultIncludesCodeWhenPresent(t *testing.T) {
	raw := []byte(`{
		"type": "compact_result",
		"sessionId": "session_abc",
		"beforeEventCount": 3,
		"afterEventCount": 1,
		"event": {"type": "compact_boundary", "code": "RETAINED_TAIL"}
	}`)
	got := formatCompactResult(raw)
	if !strings.Contains(got, "boundary: compact_boundary RETAINED_TAIL") {
		t.Fatalf("formatCompactResult should include boundary code, got %q", got)
	}
}

func TestFormatCompactResultReportsDecodeErrorOnInvalidJSON(t *testing.T) {
	got := formatCompactResult([]byte(`{not json`))
	if !strings.Contains(got, "compact: decode failed") {
		t.Fatalf("formatCompactResult should report decode error, got %q", got)
	}
}

func TestContextAnalysisMsgErrorAppendsFriendlyLine(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	before := len(m.transcript)
	updated, _ := m.Update(contextAnalysisMsg{err: fmt.Errorf("upstream 503")})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	rendered := renderTranscript(updatedModel.transcript[before:], 200)
	if !strings.Contains(rendered, "context: upstream 503") {
		t.Fatalf("transcript should mention 'context: upstream 503', got %q", rendered)
	}
}

func TestCompactResultMsgErrorAppendsFriendlyLine(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	before := len(m.transcript)
	updated, _ := m.Update(compactResultMsg{err: fmt.Errorf("session not found")})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	rendered := renderTranscript(updatedModel.transcript[before:], 200)
	if !strings.Contains(rendered, "compact: session not found") {
		t.Fatalf("transcript should mention 'compact: session not found', got %q", rendered)
	}
}

// --- Phase 5 续: /context full overlay + /compact post-compact details ---

// fullContextPayload is a representative /v1/sessions/:id/context
// payload used by the overlay + post-compact tests below. It covers
// every section buildContextOverlayLines knows about, so each test
// can assert on its slice without rebuilding the JSON.
func fullContextPayload() []byte {
	return []byte(`{
		"type": "context_analysis",
		"sessionId": "session_phase5_overlay",
		"cwd": "/workspace",
		"modelId": "local/coding-runtime",
		"budget": {
			"maxTokens": 8192,
			"layerBudgets": {"system": 2048, "summary": 1024, "history": 4096, "memory": 512, "reservedOutput": 512}
		},
		"window": {"maxTokens": 8192, "tokenEstimate": 1234},
		"sections": {
			"systemPromptChars": 1500, "projectMemoryChars": 200, "sessionSummaryChars": 80,
			"activeSkillsChars": 0, "messageCount": 5, "selectedEventCount": 7,
			"omittedEventCount": 0, "snippedEventCount": 0, "microcompactedEventCount": 1,
			"memoryTruncated": false, "toolDefinitionCount": 4
		},
		"compact": {
			"hasBoundary": true, "trigger": "manual", "summaryChars": 256,
			"retainedEventCount": 3, "retainedSegmentValid": true, "retainedSegmentWarning": "",
			"beforeEventCount": 47, "afterEventCount": 12
		},
		"diagnostics": {
			"remainingTokens": 6958, "remainingPercent": 85,
			"autoCompact": {"shouldCompact": false, "thresholdPercent": 80, "fuseOpen": false, "failureCount": 0, "failureLimit": 3},
			"longTermMemory": {
				"provider": "evercore", "enabled": true, "hitCount": 2, "injectedChars": 240,
				"budgetChars": 1200, "truncated": false, "scope": "project",
				"namespaceId": "ws-phase5", "searchLatencyMs": 18.5
			},
			"scopedMemory": [
				{"scope": "project", "provider": "evercore", "enabled": true, "hitCount": 2, "injectedChars": 240, "budgetChars": 1200, "namespaceId": "ws-phase5"}
			],
			"sessionMemoryLite": {
				"enabled": true,
				"lastUpdate": {"trigger": "compact", "reason": "summary", "summaryChars": 256, "eventCount": 47},
				"nextDecision": {"shouldUpdate": false, "reason": "below threshold"},
				"costPolicy": {"summaryMode": "extractive-only", "maxSummaryChars": 1024}
			},
			"compactRetention": {"hasBoundary": true, "retainedEventCount": 3, "retainedSegmentValid": true, "retainedSegmentWarning": "", "fallbackToFullHistory": false},
			"compactTokenDelta": {"hasBoundary": true, "beforeEventCount": 47, "afterEventCount": 12, "estimatedTokensSaved": 1820},
			"resumeRecovery": {"active": false, "code": "", "message": "", "timestamp": ""},
			"workingSetPaths": [
				{"path": "/workspace/src/runtime/compact.ts", "touches": 4},
				{"path": "/workspace/src/cli/contextView.ts", "touches": 2}
			],
			"repeatedToolInputs": [
				{"name": "Grep", "count": 5, "inputPreview": "context"},
				{"name": "Read", "count": 2, "inputPreview": "/workspace/src/runtime/compact.ts"}
			],
			"largeToolResults": [
				{"name": "Bash", "outputChars": 4820, "inputPreview": "cat src/cli/contextView.ts"}
			]
		},
		"diagnostic": {
			"name": "context_analysis", "status": "ok",
			"summary": "context 1234/8192 tokens; 6958 remaining",
			"signals": [
				{"level": "info", "code": "INFO_OK", "message": "no warnings"}
			],
			"recommendations": [
				"Continue without changes"
			]
		},
		"recommendations": ["Continue without changes"]
	}`)
}

func TestBuildContextOverlayLinesExtractsTopLevelEnvelope(t *testing.T) {
	lines := buildContextOverlayLines(fullContextPayload())
	joined := strings.Join(lines, "\n")
	for _, want := range []string{
		"Context · session_",
		"· local/coding-runtime",
		"context 1234/8192 tokens; 6958 remaining",
		"status: ok",
		"sections:",
		"messages: 5 (selected=7",
		"tools visible: 4",
		"budget layers (tokens):",
		"system=2048 summary=1024",
		"compact retention: valid · events=3",
		"compact delta: events 47→12 · saved≈1820 tokens",
		"long-term memory: evercore scope=project",
		"hits=2 injected=240/1.2k",
		"working set paths: /workspace/src/runtime/compact.ts×4",
		"repeated tool input: Grep ×5 · context",
		"large tool result: Bash 4.8k",
		"session memory lite: enabled=true last=compact/summary",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("buildContextOverlayLines missing %q\nfull:\n%s", want, joined)
		}
	}
}

func TestBuildContextOverlayLinesReportsDecodeErrorOnInvalidJSON(t *testing.T) {
	lines := buildContextOverlayLines([]byte(`{not json`))
	if len(lines) != 1 || !strings.Contains(lines[0], "context overlay: decode failed") {
		t.Fatalf("expected single decode-error line, got %v", lines)
	}
}

func TestContextOverlayOpensOnMsgAndClearsOnClose(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(contextAnalysisMsg{raw: fullContextPayload()})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeContextOverlay {
		t.Fatalf("inputMode = %q, want %q", updatedModel.inputMode, modeContextOverlay)
	}
	if len(updatedModel.contextOverlayLines) == 0 {
		t.Fatalf("contextOverlayLines should be populated")
	}
	if updatedModel.contextOverlayScroll != 0 {
		t.Fatalf("contextOverlayScroll = %d, want 0 on open", updatedModel.contextOverlayScroll)
	}
	// esc closes and clears.
	closed, _ := updatedModel.Update(tea.KeyMsg{Type: tea.KeyEsc})
	closedModel, ok := closed.(model)
	if !ok {
		t.Fatalf("expected model, got %T", closed)
	}
	if closedModel.inputMode != modeComposing {
		t.Fatalf("inputMode after esc = %q, want %q", closedModel.inputMode, modeComposing)
	}
	if closedModel.contextOverlayLines != nil {
		t.Fatalf("contextOverlayLines should be nil after close, got %d lines", len(closedModel.contextOverlayLines))
	}
}

func TestContextOverlayScrollClamps(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(contextAnalysisMsg{raw: fullContextPayload()})
	updatedModel := updated.(model)
	// Up at 0 should stay at 0.
	up, _ := updatedModel.Update(tea.KeyMsg{Type: tea.KeyUp})
	upModel := up.(model)
	if upModel.contextOverlayScroll != 0 {
		t.Fatalf("up at 0 should stay at 0, got %d", upModel.contextOverlayScroll)
	}
	// Down should advance and clamp at len-1.
	cur := upModel
	for i := 0; i < 200; i++ {
		next, _ := cur.Update(tea.KeyMsg{Type: tea.KeyDown})
		cur = next.(model)
	}
	maxScroll := len(cur.contextOverlayLines) - 1
	if cur.contextOverlayScroll != maxScroll {
		t.Fatalf("scroll should clamp at %d, got %d", maxScroll, cur.contextOverlayScroll)
	}
	// One more down should stay clamped.
	more, _ := cur.Update(tea.KeyMsg{Type: tea.KeyDown})
	moreModel := more.(model)
	if moreModel.contextOverlayScroll != maxScroll {
		t.Fatalf("scroll should remain at %d, got %d", maxScroll, moreModel.contextOverlayScroll)
	}
}

func TestRenderContextOverlayEmptyOutsideMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if got := m.renderContextOverlay(120); got != "" {
		t.Fatalf("renderContextOverlay in composing mode should be empty, got %q", got)
	}
}

func TestRenderContextOverlayShowsHeaderInMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(contextAnalysisMsg{raw: fullContextPayload()})
	updatedModel := updated.(model)
	// Force a small height so the overlay has a finite window.
	updatedModel.height = 30
	rendered := updatedModel.renderContextOverlay(120)
	if rendered == "" {
		t.Fatalf("renderContextOverlay in modeContextOverlay should be non-empty")
	}
	for _, want := range []string{"Context · Phase 5 overlay", "· local/coding-runtime", "scroll"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered context overlay missing %q\nfull:\n%s", want, rendered)
		}
	}
}

func TestFormatCompactResultExtendedDetails(t *testing.T) {
	raw := []byte(`{
		"type": "compact_result",
		"sessionId": "session_abc",
		"beforeEventCount": 47,
		"afterEventCount": 12,
		"event": {
			"type": "compact_boundary",
			"code": "BOUNDARY_OK",
			"trigger": "manual",
			"summary": "Compacted 47 events to 12 retained + 1 boundary; saved 1820 tokens",
			"summaryChars": 256,
			"snippedToolResults": 3,
			"retainedSegment": {"status": "valid", "retainedEventCount": 12, "warning": ""},
			"budget": {"layerBudgets": {"system": 2048, "summary": 1024, "history": 4096, "memory": 512}}
		}
	}`)
	got := formatCompactResult(raw)
	for _, want := range []string{
		"compact_result events: 47 → 12",
		"boundary: compact_boundary BOUNDARY_OK trigger=manual",
		"summary: Compacted 47 events to 12 retained + 1 boundary",
		"summaryChars: 256",
		"snippedToolResults: 3",
		"budget layers: system=2048 summary=1024 history=4096 memory=512",
		"retained segment: valid · events=12",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatCompactResult missing %q\nfull:\n%s", want, got)
		}
	}
}

func TestFormatCompactResultSummaryTruncatedToFirstLine(t *testing.T) {
	raw := []byte(`{
		"type": "compact_result",
		"beforeEventCount": 3, "afterEventCount": 1,
		"event": {
			"type": "compact_boundary",
			"summary": "line one of summary\nline two that should be dropped"
		}
	}`)
	got := formatCompactResult(raw)
	if !strings.Contains(got, "summary: line one of summary") {
		t.Fatalf("expected first-line summary preview, got %q", got)
	}
	if strings.Contains(got, "line two that should be dropped") {
		t.Fatalf("second line of summary should be dropped, got %q", got)
	}
}

func TestFormatCharCountHumanFriendly(t *testing.T) {
	cases := map[int]string{
		0:   "0",
		12:  "12",
		999: "999",
		1234: "1.2k",
		9999: "10.0k",
		12345: "12k",
		1234567: "1.2M",
	}
	for n, want := range cases {
		if got := formatCharCount(n); got != want {
			t.Fatalf("formatCharCount(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestFirstLineBoundsAndStripsTrailingNewlines(t *testing.T) {
	if got := firstLine("hello", 100); got != "hello" {
		t.Fatalf("firstLine(hello) = %q, want hello", got)
	}
	if got := firstLine("hello world", 5); got != "hello…" {
		t.Fatalf("firstLine bounded should add ellipsis, got %q", got)
	}
	if got := firstLine("line1\nline2", 100); got != "line1" {
		t.Fatalf("firstLine should stop at first newline, got %q", got)
	}
}
