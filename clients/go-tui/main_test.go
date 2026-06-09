package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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
	if cmd == nil {
		t.Fatalf("/profile dev should return an HTTP config command")
	}
	if m.running {
		t.Fatalf("/profile dev should not start an agent stream")
	}
	rendered := renderTranscript(m.transcript, 100)
	if !strings.Contains(rendered, "selecting shared Nexus profile: dev") {
		t.Fatalf("transcript missing local command status: %q", rendered)
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
