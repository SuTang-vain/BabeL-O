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

// fullInboxPayload returns a representative inbox response with
// three messages covering the high-priority, acknowledged and
// memory_candidate governance paths. Used by the inbox overlay /
// footer / event-card tests below.
func fullInboxPayload() []byte {
	return []byte(`{
		"type": "session_inbox",
		"sessionId": "sess_inbox_smoke_abc123",
		"limit": 50,
		"includeAcknowledged": false,
		"messages": [
			{
				"messageId": "msg_handoff_1",
				"channelId": "chan_parent_child_1",
				"fromSessionId": "sess_child_xyz789",
				"toSessionId": "sess_inbox_smoke_abc123",
				"type": "handoff",
				"content": "Picking up the auth refactor; see attached diff.",
				"evidence": [{"type": "tool_trace", "ref": "trace_001", "label": "edit run"}],
				"priority": "high",
				"createdAt": "2026-06-09T10:00:00Z",
				"status": "delivered"
			},
			{
				"messageId": "msg_finding_low_2",
				"channelId": "chan_workspace_pair_1",
				"fromSessionId": "sess_peer_aaa111",
				"broadcast": true,
				"type": "finding",
				"content": "low-priority finding - not a key event",
				"priority": "low",
				"createdAt": "2026-06-09T10:05:00Z",
				"status": "delivered"
			},
			{
				"messageId": "msg_memory_rejected_3",
				"channelId": "chan_direct_1",
				"fromSessionId": "sess_peer_bbb222",
				"toSessionId": "sess_inbox_smoke_abc123",
				"type": "memory_candidate",
				"content": "auto-write attempt blocked",
				"priority": "normal",
				"createdAt": "2026-06-09T10:10:00Z",
				"status": "delivered",
				"metadata": {
					"memoryCandidateGovernance": {
						"decision": "rejected",
						"scope": "long_term",
						"approval": {"status": "rejected", "requiredBy": "user"},
						"autoWrite": false
					}
				}
			}
		]
	}`)
}

func TestIsKeyInboxMessageFlagsHighPriorityAndGovernance(t *testing.T) {
	messages := []sessionMessage{
		{Type: messageTypeHandoff, Priority: priorityNormal},
		{Type: messageTypeBlocked, Priority: priorityLow},
		{Type: messageTypeRequestReview, Priority: priorityNormal},
		{Type: messageTypeRequestValidation, Priority: priorityNormal},
		{Type: messageTypeFinding, Priority: priorityHigh},
		{Type: messageTypeFinding, Priority: priorityLow}, // not key
		{Type: messageTypeMemoryCandidate, Metadata: map[string]any{
			"memoryCandidateGovernance": map[string]any{"decision": "rejected"},
		}},
		{Type: messageTypeMemoryCandidate, Metadata: map[string]any{
			"memoryCandidateGovernance": map[string]any{"decision": "approved", "approval": map[string]any{"status": "approved"}},
		}},
		{Type: messageTypeQuestion, Priority: priorityHigh}, // not key
	}
	want := []bool{true, true, true, true, true, false, true, false, false}
	for i, m := range messages {
		if got := isKeyInboxMessage(m); got != want[i] {
			t.Fatalf("isKeyInboxMessage[%d] type=%s = %v, want %v", i, m.Type, got, want[i])
		}
	}
}

func TestFormatInboxFooterStatusRendersUnreadAndLinkedAndHigh(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := formatInboxFooterStatus("sess_inbox_smoke_abc123", envelope.Messages, nil)
	// Three unread (handoff + finding-low + memory_candidate_rejected),
	// three linked sessions (one per message FromSessionId, since the
	// channels parameter is nil and the helper falls back to that),
	// and the "high" segment picks up the handoff first.
	for _, want := range []string{
		"inbox: 3 unread",
		"high: handoff",
		"linked sessions: 3",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatInboxFooterStatus missing %q\nfull:\n%s", want, got)
		}
	}
}

func TestFormatInboxFooterStatusEmptyWhenNothingToSurface(t *testing.T) {
	if got := formatInboxFooterStatus("sess_xyz", nil, nil); got != "" {
		t.Fatalf("empty inbox should produce empty footer status, got %q", got)
	}
}

func TestBuildInboxOverlayLinesRendersMessagesWithSelectedMarker(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	lines := buildInboxOverlayLines(envelope.Messages, nil, 0, false)
	if len(lines) == 0 {
		t.Fatalf("expected non-empty overlay lines")
	}
	// The first message (handoff) is selected → its header row must
	// carry the `›` marker.
	if !strings.Contains(lines[0], "›") {
		t.Fatalf("selected marker missing from first row:\n%s", lines[0])
	}
	// The second message (finding-low) is unselected → its header
	// row should use a space marker.
	var secondHeader string
	for _, line := range lines {
		if strings.HasPrefix(line, "  msg_finding_low_2 ") {
			secondHeader = line
			break
		}
	}
	if secondHeader == "" {
		t.Fatalf("could not find second-message header in overlay lines")
	}
	if strings.HasPrefix(secondHeader, "›") {
		t.Fatalf("unselected message should not carry `›` marker:\n%s", secondHeader)
	}
}

func TestBuildInboxOverlayLinesPlaceholderWhenEmpty(t *testing.T) {
	lines := buildInboxOverlayLines(nil, nil, 0, false)
	if len(lines) != 1 || lines[0] != "No unread inbox messages." {
		t.Fatalf("expected single unread-only placeholder, got %v", lines)
	}
	all := buildInboxOverlayLines(nil, nil, 0, true)
	if len(all) != 1 || all[0] != "No inbox messages." {
		t.Fatalf("expected single include-ack placeholder, got %v", all)
	}
}

func TestRenderInboxOverlayEmptyOutsideMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if got := m.renderInboxOverlay(120); got != "" {
		t.Fatalf("renderInboxOverlay outside modeInboxOverlay should be empty, got %q", got)
	}
}

func TestRenderInboxOverlayShowsHeaderInMode(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	m.inboxMessages = envelope.Messages
	m.inputMode = modeInboxOverlay
	m.height = 30
	rendered := m.renderInboxOverlay(120)
	if rendered == "" {
		t.Fatalf("renderInboxOverlay in modeInboxOverlay should be non-empty")
	}
	for _, want := range []string{"Inbox · Phase 6 overlay", "sess_inbox_smoke_abc123", "move", "ack", "close"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered inbox overlay missing %q\nfull:\n%s", want, rendered)
		}
	}
}

func TestRenderInboxOverlayAllVariantSwitchesBanner(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	m.inboxMessages = envelope.Messages
	m.inboxOverlayIncludeAck = true
	m.inputMode = modeInboxOverlay
	m.height = 30
	rendered := m.renderInboxOverlay(120)
	if !strings.Contains(rendered, "Inbox · all · Phase 6 overlay") {
		t.Fatalf("includeAck should switch the banner, got %q", rendered)
	}
}

func TestInboxOverlayOpensOnMsgAndClearsOnClose(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeInboxOverlay {
		t.Fatalf("inputMode = %q, want %q", updatedModel.inputMode, modeInboxOverlay)
	}
	if len(updatedModel.inboxMessages) != 3 {
		t.Fatalf("inboxMessages = %d, want 3", len(updatedModel.inboxMessages))
	}
	if updatedModel.inboxOverlaySelected != 0 {
		t.Fatalf("inboxOverlaySelected = %d, want 0 on open", updatedModel.inboxOverlaySelected)
	}
	// Esc closes.
	closed, _ := updatedModel.Update(tea.KeyMsg{Type: tea.KeyEsc})
	closedModel := closed.(model)
	if closedModel.inputMode != modeComposing {
		t.Fatalf("inputMode after esc = %q, want %q", closedModel.inputMode, modeComposing)
	}
}

func TestInboxOverlaySelectionClampsAtBounds(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	m = updated.(model)
	// Up at 0 stays at 0.
	up, _ := m.Update(tea.KeyMsg{Type: tea.KeyUp})
	m = up.(model)
	if m.inboxOverlaySelected != 0 {
		t.Fatalf("up at 0 should stay at 0, got %d", m.inboxOverlaySelected)
	}
	// Down advances and clamps at len-1.
	cur := m
	for i := 0; i < 10; i++ {
		next, _ := cur.Update(tea.KeyMsg{Type: tea.KeyDown})
		cur = next.(model)
	}
	if cur.inboxOverlaySelected != len(cur.inboxMessages)-1 {
		t.Fatalf("down should clamp at %d, got %d", len(cur.inboxMessages)-1, cur.inboxOverlaySelected)
	}
	// One more down stays clamped.
	more, _ := cur.Update(tea.KeyMsg{Type: tea.KeyDown})
	moreModel := more.(model)
	if moreModel.inboxOverlaySelected != len(m.inboxMessages)-1 {
		t.Fatalf("down past end should stay clamped, got %d", moreModel.inboxOverlaySelected)
	}
}

func TestInboxOverlayEscapeCloses(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	m = updated.(model)
	// esc / enter still close the overlay.
	for _, keyType := range []tea.KeyType{tea.KeyEsc, tea.KeyEnter} {
		m.inputMode = modeInboxOverlay
		closed, _ := m.Update(tea.KeyMsg{Type: keyType})
		cm := closed.(model)
		if cm.inputMode != modeComposing {
			t.Fatalf("key %v should close the overlay, got %q", keyType, cm.inputMode)
		}
	}
	// Phase 6 PR2: 'q' now QUOTES the selected message into the
	// textinput (not closes). Verify the close path still doesn't
	// fire for 'q' — the overlay should drop back to composing
	// because quoteSelectedInboxMessage sets mode=composing after
	// the prefill, but the "inbox closed" status line must NOT
	// appear (it would mean we accidentally took the close path).
	m.inputMode = modeInboxOverlay
	closed, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	cm := closed.(model)
	if cm.inputMode != modeComposing {
		t.Fatalf("'q' should land in composing after quote, got %q", cm.inputMode)
	}
	last := cm.transcript[len(cm.transcript)-1]
	if !strings.Contains(last.text, "quoted inbox message") {
		t.Fatalf("'q' should surface the quote status, got %q", last.text)
	}
}

func TestInboxOverlayStrayKeyDoesNotReachTextinput(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	m = updated.(model)
	m.input.SetValue("untouched")
	// Press 'z' (a non-overlay key). The textinput must not change.
	updated, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'z'}})
	um := updated.(model)
	if um.input.Value() != "untouched" {
		t.Fatalf("stray key reached textinput, got %q", um.input.Value())
	}
	if um.inputMode != modeInboxOverlay {
		t.Fatalf("stray key should leave mode unchanged, got %q", um.inputMode)
	}
}

func TestInboxMsgErrorAppendsFriendlyLine(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(inboxMsg{err: errors.New("dial tcp: connection refused")})
	um := updated.(model)
	last := um.transcript[len(um.transcript)-1]
	if last.kind != "error" || !strings.Contains(last.text, "inbox: dial tcp") {
		t.Fatalf("expected friendly error line, got %+v", last)
	}
}

func TestInboxAckMsgSuccessUpdatesLocalSnapshot(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	m.inboxMessages = envelope.Messages
	updated, _ := m.Update(inboxAckMsg{sessionID: "sess_inbox_smoke_abc123", messageID: "msg_handoff_1"})
	um := updated.(model)
	for _, msg := range um.inboxMessages {
		if msg.MessageID == "msg_handoff_1" {
			if msg.Status != messageStatusAcknowledged {
				t.Fatalf("acked message status = %q, want acknowledged", msg.Status)
			}
			if msg.AcknowledgedAt != "now" {
				t.Fatalf("acked message acknowledgedAt = %q, want now", msg.AcknowledgedAt)
			}
			return
		}
	}
	t.Fatalf("acked message disappeared from snapshot")
}

func TestInboxSlashCommandEmptySessionShortCircuits(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	cmd := m.handleLocalCommand("/inbox")
	if cmd != nil {
		t.Fatalf("expected nil cmd when no session, got %T", cmd)
	}
	last := m.transcript[len(m.transcript)-1]
	if !strings.Contains(last.text, "no active session yet") {
		t.Fatalf("expected friendly short-circuit status, got %q", last.text)
	}
}

func TestInboxSlashCommandAllRequiresSession(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	cmd := m.handleLocalCommand("/inbox all")
	if cmd != nil {
		t.Fatalf("expected nil cmd when no session, got %T", cmd)
	}
}

func TestInboxSlashCommandAckMissingArgShortCircuits(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_xyz"
	cmd := m.handleLocalCommand("/inbox ack")
	if cmd != nil {
		t.Fatalf("expected nil cmd for /inbox ack without id, got %T", cmd)
	}
	last := m.transcript[len(m.transcript)-1]
	if !strings.Contains(last.text, "requires a message id") {
		t.Fatalf("expected helpful /inbox ack error, got %q", last.text)
	}
}

func TestRenderInboxEventCardEmptyForNonKeyMessage(t *testing.T) {
	m := sessionMessage{Type: messageTypeFinding, Priority: priorityLow}
	if got := renderInboxEventCard(m, sessionChannel{}); got != "" {
		t.Fatalf("low-priority finding should not produce an event card, got %q", got)
	}
}

func TestRenderInboxEventCardShowsGovernanceForMemoryCandidate(t *testing.T) {
	m := sessionMessage{
		MessageID: "msg_mc_1",
		ChannelID: "chan_direct_1",
		Type:      messageTypeMemoryCandidate,
		Priority:  priorityNormal,
		FromSessionID: "sess_peer_1",
		ToSessionID:   "sess_self",
		Content:   "blocked auto-write",
		Metadata: map[string]any{
			"memoryCandidateGovernance": map[string]any{
				"decision": "rejected",
				"scope":    "long_term",
				"approval": map[string]any{"status": "rejected", "requiredBy": "user"},
				"autoWrite": false,
			},
		},
	}
	card := renderInboxEventCard(m, sessionChannel{ChannelID: "chan_direct_1", Kind: channelKindDirect})
	for _, want := range []string{
		"SessionChannel memory_candidate",
		"channel=chan_direct_1",
		"kind=direct",
		"collaboration context only",
		"[open inbox: /inbox]",
		"[ack: /inbox ack msg_mc_1]",
	} {
		if !strings.Contains(card, want) {
			t.Fatalf("event card missing %q\nfull:\n%s", want, card)
		}
	}
}

func TestRenderNewInboxEventCardsSkipsAlreadySeen(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	m.inboxMessages = envelope.Messages
	baseline := len(m.transcript)
	m.renderNewInboxEventCards()
	afterFirst := len(m.transcript)
	if afterFirst <= baseline {
		t.Fatalf("first renderNewInboxEventCards should append cards, baseline=%d after=%d", baseline, afterFirst)
	}
	// Re-running must not re-emit the same card.
	m.renderNewInboxEventCards()
	afterSecond := len(m.transcript)
	if afterSecond != afterFirst {
		t.Fatalf("re-running renderNewInboxEventCards should be a no-op, afterFirst=%d afterSecond=%d", afterFirst, afterSecond)
	}
}

func TestFetchInboxHTTPCmdSendsIncludeAckQuery(t *testing.T) {
	var seenPath string
	var seenQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"session_inbox","sessionId":"sess_xyz","messages":[],"limit":50,"includeAcknowledged":true}`))
	}))
	defer server.Close()
	m := newModel(config{baseURL: server.URL, cwd: "/workspace"})
	cmd := fetchInbox(m.cfg, "sess_xyz", true, "user")
	msg := cmd()
	inbox, ok := msg.(inboxMsg)
	if !ok {
		t.Fatalf("expected inboxMsg, got %T", msg)
	}
	if inbox.err != nil {
		t.Fatalf("fetchInbox returned err: %v", inbox.err)
	}
	if seenPath != "/v1/sessions/sess_xyz/inbox" {
		t.Fatalf("seenPath = %q", seenPath)
	}
	if !strings.Contains(seenQuery, "includeAcknowledged=true") {
		t.Fatalf("includeAcknowledged=true missing from query, got %q", seenQuery)
	}
	if !inbox.includeAck {
		t.Fatalf("inbox.includeAck should be true")
	}
}

func TestAckInboxMessageHTTPCmdPostsToCorrectPath(t *testing.T) {
	var seenMethod string
	var seenPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"session_message_acknowledged","sessionId":"sess_xyz","message":null}`))
	}))
	defer server.Close()
	m := newModel(config{baseURL: server.URL, cwd: "/workspace"})
	cmd := ackInboxMessage(m.cfg, "sess_xyz", "msg_ack_target_1")
	msg := cmd()
	ack, ok := msg.(inboxAckMsg)
	if !ok {
		t.Fatalf("expected inboxAckMsg, got %T", msg)
	}
	if ack.err != nil {
		t.Fatalf("ackInboxMessage returned err: %v", ack.err)
	}
	if seenMethod != http.MethodPost {
		t.Fatalf("seenMethod = %q, want POST", seenMethod)
	}
	if seenPath != "/v1/sessions/sess_xyz/inbox/msg_ack_target_1/ack" {
		t.Fatalf("seenPath = %q", seenPath)
	}
}

func TestQuoteInboxMessageRendersFormattedBlock(t *testing.T) {
	message := sessionMessage{
		MessageID:     "msg_quote_1",
		Type:          messageTypeHandoff,
		Priority:      priorityHigh,
		FromSessionID: "sess_peer_quote_1",
		ChannelID:     "chan_quote_1",
		Content:       "Picking up the refactor — see attached diff.",
	}
	got := quoteInboxMessageContent(message)
	for _, want := range []string{
		"Use this SessionChannel inbox context only after verifying evidence:",
		"message=msg_quote_1",
		"type=handoff",
		"priority=high",
		"from=sess_peer_quote_1",
		"channel=chan_quote_1",
		"content: Picking up the refactor",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("quoteInboxMessageContent missing %q\nfull:\n%s", want, got)
		}
	}
}

func TestQuoteInboxMessageFallsBackToUnknownForMissingFields(t *testing.T) {
	message := sessionMessage{} // zero value, no fields set
	got := quoteInboxMessageContent(message)
	for _, want := range []string{
		"message=unknown",
		"type=unknown",
		"priority=unknown",
		"from=unknown",
		"channel=unknown",
		"content: unknown",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("quoteInboxMessageContent fallback missing %q\nfull:\n%s", want, got)
		}
	}
}

func TestQuoteInboxMessageIncludesGovernanceForMemoryCandidate(t *testing.T) {
	message := sessionMessage{
		MessageID:     "msg_mc_quote_1",
		Type:          messageTypeMemoryCandidate,
		Priority:      priorityNormal,
		FromSessionID: "sess_peer_mc",
		ChannelID:     "chan_direct_mc",
		Content:       "blocked auto-write",
		Metadata: map[string]any{
			"memoryCandidateGovernance": map[string]any{
				"decision": "rejected",
				"scope":    "long_term",
				"approval": map[string]any{"status": "rejected", "requiredBy": "user"},
				"autoWrite": false,
			},
		},
	}
	got := quoteInboxMessageContent(message)
	if !strings.Contains(got, "memory_candidate decision=rejected") {
		t.Fatalf("quote should include memory_candidate governance header, got %q", got)
	}
	if !strings.Contains(got, "approval=rejected:user") {
		t.Fatalf("quote should include approval status, got %q", got)
	}
}

func TestInboxOverlayQuoteKeyFillsTextinput(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	m = updated.(model)
	// 'q' quotes the first (selected) message into the textinput.
	updated, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	um := updated.(model)
	if !strings.Contains(um.input.Value(), "Use this SessionChannel inbox context only after verifying evidence:") {
		t.Fatalf("'q' should prefill the textinput with the quote, got %q", um.input.Value())
	}
	if !strings.Contains(um.input.Value(), "message=msg_handoff_1") {
		t.Fatalf("'q' quote should reference the selected message id, got %q", um.input.Value())
	}
	if um.inputMode != modeComposing {
		t.Fatalf("'q' should land in composing mode, got %q", um.inputMode)
	}
}

func TestInboxOverlayQuoteKeyCAlsoFillsTextinput(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	m = updated.(model)
	updated, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'c'}})
	um := updated.(model)
	if !strings.Contains(um.input.Value(), "message=msg_handoff_1") {
		t.Fatalf("'c' should prefill just like 'q', got %q", um.input.Value())
	}
}

func TestInboxOverlayQuoteKeyEmptyListIsNoop(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_xyz"
	m.input.SetValue("preserved")
	m.inputMode = modeInboxOverlay
	m.inboxMessages = nil
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	um := updated.(model)
	if um.input.Value() != "preserved" {
		t.Fatalf("'q' on empty list should NOT clobber textinput, got %q", um.input.Value())
	}
	// The mode stays in modeInboxOverlay (the user must close
	// explicitly), not auto-drop back to composing.
	if um.inputMode != modeInboxOverlay {
		t.Fatalf("'q' on empty list should leave mode unchanged, got %q", um.inputMode)
	}
}

func TestInboxAutoRefreshOnResultEventFiresFetchInbox(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_ar_1"
	cmd := m.consumeNexusEvent(map[string]any{"type": "result"})
	if cmd == nil {
		t.Fatalf("consumeNexusEvent on result should fire auto-refresh cmd when session is set")
	}
	// Phase 6 PR3: auto-refresh now fires a tea.Batch of
	// fetchInbox + fetchSessionAgents. The cmd() may unwrap to
	// either a BatchMsg (when Bubble Tea flattens both) or a
	// single leaf cmd (inboxMsg / agentJobsMsg). Accept any.
	msg := cmd()
	switch typed := msg.(type) {
	case tea.BatchMsg:
		if len(typed) < 3 {
			t.Fatalf("Phase 6 PR4: auto-refresh BatchMsg should have at least 3 cmds (inbox + agents + tasks), got %d", len(typed))
		}
	default:
		_, okInbox := msg.(inboxMsg)
		_, okAgents := msg.(agentJobsMsg)
		_, okTasks := msg.(tasksListMsg)
		if !okInbox && !okAgents && !okTasks {
			t.Fatalf("auto-refresh cmd should produce inboxMsg / agentJobsMsg / tasksListMsg / tea.BatchMsg, got %T", msg)
		}
	}
}

func TestInboxAutoRefreshSkippedWhenNoSession(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	// sessionID is empty.
	cmd := m.consumeNexusEvent(map[string]any{"type": "result"})
	if cmd != nil {
		t.Fatalf("auto-refresh should be skipped when no session, got %T", cmd)
	}
}

func TestInboxAutoRefreshTriggerDoesNotOpenOverlay(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	// Compose a turn so we're not in modeInboxOverlay.
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	um := updated.(model)
	// Close the overlay first.
	closed, _ := um.Update(tea.KeyMsg{Type: tea.KeyEsc})
	um = closed.(model)
	if um.inputMode != modeComposing {
		t.Fatalf("precondition: should be in composing, got %q", um.inputMode)
	}
	// Now fire an auto-refresh inboxMsg and verify the overlay does
	// NOT reopen (the user is mid-composition, not asking for it).
	updated, _ = um.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "auto"})
	um2 := updated.(model)
	if um2.inputMode != modeComposing {
		t.Fatalf("'auto' trigger must NOT open the overlay, got %q", um2.inputMode)
	}
	if len(um2.inboxMessages) != 3 {
		t.Fatalf("'auto' trigger should still update the snapshot, got %d messages", len(um2.inboxMessages))
	}
}

func TestInboxAutoRefreshRendersEventCardsForNewMessages(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	baseline := len(m.transcript)
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "auto"})
	um := updated.(model)
	if len(um.transcript) <= baseline {
		t.Fatalf("'auto' trigger should still render event cards for unseen key messages, baseline=%d after=%d", baseline, len(um.transcript))
	}
}

func TestInboxAutoRefreshDedupesAcrossTurns(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	// First auto-refresh: cards render.
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "auto"})
	um := updated.(model)
	afterFirst := len(um.transcript)
	// Second auto-refresh (same payload): no new cards.
	updated, _ = um.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "auto"})
	um2 := updated.(model)
	if len(um2.transcript) != afterFirst {
		t.Fatalf("second auto-refresh should not re-render same cards, afterFirst=%d afterSecond=%d", afterFirst, len(um2.transcript))
	}
}

// fullAgentJobsPayload returns a representative agent jobs
// response with three jobs covering the running / completed /
// failed terminal states plus a sub-agent depth>0 to exercise
// the governance row rendering. Used by the agent overlay /
// auto-refresh tests below.
func fullAgentJobsPayload() []byte {
	return []byte(`{
		"type": "agent_jobs",
		"sessionId": "sess_agents_smoke_xyz",
		"jobs": [
			{
				"jobId": "job_explore_1",
				"parentSessionId": "sess_agents_smoke_xyz",
				"childSessionId": "sess_child_explore_1",
				"parentTaskId": "task_abc_1",
				"agentType": "explore",
				"status": "running",
				"prompt": "find the auth middleware and explain it",
				"contextForkMode": "working-set",
				"isolation": "worktree",
				"createdAt": "2026-06-09T11:00:00Z",
				"updatedAt": "2026-06-09T11:01:30Z",
				"startedAt": "2026-06-09T11:00:05Z",
				"governance": {
					"maxConcurrentAgents": 4,
					"activeAgents": 2,
					"maxDepth": 3,
					"depth": 1,
					"maxRuntimeMs": 600000
				}
			},
			{
				"jobId": "job_review_1",
				"parentSessionId": "sess_agents_smoke_xyz",
				"childSessionId": "sess_child_review_1",
				"agentType": "review",
				"status": "completed",
				"prompt": "review the auth refactor PR",
				"contextForkMode": "minimal",
				"isolation": "none",
				"createdAt": "2026-06-09T10:30:00Z",
				"updatedAt": "2026-06-09T10:45:00Z",
				"startedAt": "2026-06-09T10:30:05Z",
				"completedAt": "2026-06-09T10:45:00Z"
			},
			{
				"jobId": "job_debug_1",
				"parentSessionId": "sess_agents_smoke_xyz",
				"childSessionId": "sess_child_debug_1",
				"agentType": "debug",
				"status": "failed",
				"prompt": "reproduce the compile error",
				"contextForkMode": "debug-replay",
				"isolation": "none",
				"createdAt": "2026-06-09T10:00:00Z",
				"updatedAt": "2026-06-09T10:20:00Z",
				"startedAt": "2026-06-09T10:00:05Z",
				"completedAt": "2026-06-09T10:20:00Z"
			}
		]
	}`)
}

func TestFormatAgentStatusIconAllValues(t *testing.T) {
	cases := map[agentJobStatus]string{
		agentStatusQueued:            "[queue]",
		agentStatusRunning:           "[run]",
		agentStatusWaitingPermission: "[perm]",
		agentStatusCompleted:         "[done]",
		agentStatusFailed:            "[fail]",
		agentStatusCancelled:         "[cancel]",
	}
	for status, want := range cases {
		if got := formatAgentStatusIcon(status); got != want {
			t.Fatalf("formatAgentStatusIcon(%s) = %q, want %q", status, got, want)
		}
	}
	// Unknown status falls through to the raw text inside brackets.
	got := formatAgentStatusIcon(agentJobStatus("weird_status"))
	if got != "[weird_status]" {
		t.Fatalf("unknown status should fall through to bracketed raw text, got %q", got)
	}
}

func TestBuildAgentOverlayLinesRendersJobs(t *testing.T) {
	envelope := sessionAgentJobsResponse{}
	if err := json.Unmarshal(fullAgentJobsPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	lines := buildAgentOverlayLines(envelope.Jobs)
	if len(lines) == 0 {
		t.Fatalf("expected non-empty overlay lines")
	}
	// The first job (explore, running) has depth=1 and
	// governance active 2/4 + task#abc_1 — the row should
	// contain all of those markers.
	combined := strings.Join(lines, "\n")
	for _, want := range []string{
		"[run]", "job", "explore", "d1",
		"active 2/4", "depth 1/3", "task=#task_abc_1",
		"prompt: find the auth middleware",
	} {
		if !strings.Contains(combined, want) {
			t.Fatalf("buildAgentOverlayLines missing %q\nfull:\n%s", want, combined)
		}
	}
}

func TestBuildAgentOverlayLinesEmptyPlaceholder(t *testing.T) {
	lines := buildAgentOverlayLines(nil)
	if len(lines) != 1 || lines[0] != "No agent jobs for this session." {
		t.Fatalf("expected single empty placeholder, got %v", lines)
	}
}

func TestSummarizeAgentJobsRendersStatusCounts(t *testing.T) {
	envelope := sessionAgentJobsResponse{}
	if err := json.Unmarshal(fullAgentJobsPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := summarizeAgentJobs(envelope.Jobs)
	// 1 running + 1 completed + 1 failed (no queued / permission / cancelled)
	for _, want := range []string{"running 1", "completed 1", "failed 1"} {
		if !strings.Contains(got, want) {
			t.Fatalf("summarizeAgentJobs missing %q\nfull:\n%s", want, got)
		}
	}
}

func TestSummarizeAgentJobsEmpty(t *testing.T) {
	if got := summarizeAgentJobs(nil); got != "no agent jobs" {
		t.Fatalf("empty summarize should report no agent jobs, got %q", got)
	}
}

func TestRenderAgentOverlayEmptyOutsideMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if got := m.renderAgentOverlay(120); got != "" {
		t.Fatalf("renderAgentOverlay outside modeAgentOverlay should be empty, got %q", got)
	}
}

func TestRenderAgentOverlayShowsHeaderInMode(t *testing.T) {
	envelope := sessionAgentJobsResponse{}
	if err := json.Unmarshal(fullAgentJobsPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_agents_smoke_xyz"
	m.agentJobs = envelope.Jobs
	m.inputMode = modeAgentOverlay
	m.height = 30
	rendered := m.renderAgentOverlay(120)
	if rendered == "" {
		t.Fatalf("renderAgentOverlay in modeAgentOverlay should be non-empty")
	}
	for _, want := range []string{
		"Agent status · Phase 6 PR3+PR6 overlay",
		"sess_age", // shortID of "sess_agents_smoke_xyz"
		"running 1", "completed 1", "failed 1",
		"scroll", "close",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered agent overlay missing %q\nfull:\n%s", want, rendered)
		}
	}
}

func TestAgentOverlayOpensOnMsgAndClearsOnClose(t *testing.T) {
	envelope := sessionAgentJobsResponse{}
	if err := json.Unmarshal(fullAgentJobsPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_agents_smoke_xyz"
	updated, _ := m.Update(agentJobsMsg{raw: fullAgentJobsPayload(), envelope: envelope, sessionID: "sess_agents_smoke_xyz", trigger: "user"})
	um, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if um.inputMode != modeAgentOverlay {
		t.Fatalf("inputMode = %q, want %q", um.inputMode, modeAgentOverlay)
	}
	if len(um.agentJobs) != 3 {
		t.Fatalf("agentJobs = %d, want 3", len(um.agentJobs))
	}
	// Esc closes.
	closed, _ := um.Update(tea.KeyMsg{Type: tea.KeyEsc})
	cm := closed.(model)
	if cm.inputMode != modeComposing {
		t.Fatalf("inputMode after esc = %q, want %q", cm.inputMode, modeComposing)
	}
}

func TestAgentOverlayEscapeEnterQAllClose(t *testing.T) {
	envelope := sessionAgentJobsResponse{}
	if err := json.Unmarshal(fullAgentJobsPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_agents_smoke_xyz"
	updated, _ := m.Update(agentJobsMsg{raw: fullAgentJobsPayload(), envelope: envelope, sessionID: "sess_agents_smoke_xyz", trigger: "user"})
	um := updated.(model)
	// esc/enter close.
	for _, keyType := range []tea.KeyType{tea.KeyEsc, tea.KeyEnter} {
		um.inputMode = modeAgentOverlay
		closed, _ := um.Update(tea.KeyMsg{Type: keyType})
		cm := closed.(model)
		if cm.inputMode != modeComposing {
			t.Fatalf("key %v should close the overlay, got %q", keyType, cm.inputMode)
		}
	}
	// 'q' rune also closes (no quote path for agents).
	um.inputMode = modeAgentOverlay
	closed, _ := um.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	cm := closed.(model)
	if cm.inputMode != modeComposing {
		t.Fatalf("'q' should close the overlay, got %q", cm.inputMode)
	}
}

func TestAgentOverlayScrollClamps(t *testing.T) {
	envelope := sessionAgentJobsResponse{}
	if err := json.Unmarshal(fullAgentJobsPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_agents_smoke_xyz"
	updated, _ := m.Update(agentJobsMsg{raw: fullAgentJobsPayload(), envelope: envelope, sessionID: "sess_agents_smoke_xyz", trigger: "user"})
	um := updated.(model)
	// Up at 0 stays at 0.
	up, _ := um.Update(tea.KeyMsg{Type: tea.KeyUp})
	u := up.(model)
	if u.agentOverlayScroll != 0 {
		t.Fatalf("up at 0 should stay at 0, got %d", u.agentOverlayScroll)
	}
	// Down should advance and clamp at len-1.
	cur := u
	for i := 0; i < 200; i++ {
		next, _ := cur.Update(tea.KeyMsg{Type: tea.KeyDown})
		cur = next.(model)
	}
	allLines := buildAgentOverlayLines(cur.agentJobs)
	maxScroll := len(allLines) - 1
	if cur.agentOverlayScroll != maxScroll {
		t.Fatalf("scroll should clamp at %d, got %d", maxScroll, cur.agentOverlayScroll)
	}
	// One more down should stay clamped.
	more, _ := cur.Update(tea.KeyMsg{Type: tea.KeyDown})
	mm := more.(model)
	if mm.agentOverlayScroll != maxScroll {
		t.Fatalf("scroll should remain at %d, got %d", maxScroll, mm.agentOverlayScroll)
	}
}

func TestAgentOverlayStrayKeyDoesNotReachTextinput(t *testing.T) {
	envelope := sessionAgentJobsResponse{}
	if err := json.Unmarshal(fullAgentJobsPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_agents_smoke_xyz"
	updated, _ := m.Update(agentJobsMsg{raw: fullAgentJobsPayload(), envelope: envelope, sessionID: "sess_agents_smoke_xyz", trigger: "user"})
	m = updated.(model)
	m.input.SetValue("untouched")
	// Press 'z' (a non-overlay key). The textinput must not change.
	updated, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'z'}})
	um := updated.(model)
	if um.input.Value() != "untouched" {
		t.Fatalf("stray key reached textinput, got %q", um.input.Value())
	}
	if um.inputMode != modeAgentOverlay {
		t.Fatalf("stray key should leave mode unchanged, got %q", um.inputMode)
	}
}

func TestAgentSlashCommandEmptySessionShortCircuits(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	cmd := m.handleLocalCommand("/agents")
	if cmd != nil {
		t.Fatalf("expected nil cmd when no session, got %T", cmd)
	}
	last := m.transcript[len(m.transcript)-1]
	if !strings.Contains(last.text, "no active session yet") {
		t.Fatalf("expected friendly short-circuit status, got %q", last.text)
	}
}

func TestAgentJobsMsgErrorAppendsFriendlyLine(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(agentJobsMsg{err: errors.New("dial tcp: connection refused")})
	um := updated.(model)
	last := um.transcript[len(um.transcript)-1]
	if last.kind != "error" || !strings.Contains(last.text, "agents: dial tcp") {
		t.Fatalf("expected friendly error line, got %+v", last)
	}
}

func TestFetchSessionAgentsHTTPCmdSendsCorrectPath(t *testing.T) {
	var seenPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"agent_jobs","sessionId":"sess_xyz","jobs":[]}`))
	}))
	defer server.Close()
	m := newModel(config{baseURL: server.URL, cwd: "/workspace"})
	cmd := fetchSessionAgents(m.cfg, "sess_xyz", "user")
	msg := cmd()
	agents, ok := msg.(agentJobsMsg)
	if !ok {
		t.Fatalf("expected agentJobsMsg, got %T", msg)
	}
	if agents.err != nil {
		t.Fatalf("fetchSessionAgents returned err: %v", agents.err)
	}
	if seenPath != "/v1/sessions/sess_xyz/agents" {
		t.Fatalf("seenPath = %q", seenPath)
	}
	if agents.trigger != "user" {
		t.Fatalf("trigger = %q, want user", agents.trigger)
	}
}

func TestAgentAutoRefreshOnResultEventFiresBatchCmd(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_ar_agents_1"
	cmd := m.consumeNexusEvent(map[string]any{"type": "result"})
	if cmd == nil {
		t.Fatalf("consumeNexusEvent on result should fire auto-refresh cmd when session is set")
	}
	// Phase 6 PR3: result-event auto-refresh now fires a
	// tea.Batch of fetchInbox + fetchSessionAgents.
	msg := cmd()
	switch typed := msg.(type) {
	case tea.BatchMsg:
		if len(typed) < 3 {
			t.Fatalf("Phase 6 PR4: BatchMsg should have at least 3 cmds (inbox + agents + tasks), got %d", len(typed))
		}
	default:
		t.Fatalf("auto-refresh cmd should unwrap to tea.BatchMsg, got %T", msg)
	}
}

func TestAgentAutoRefreshSkippedWhenNoSession(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	cmd := m.consumeNexusEvent(map[string]any{"type": "result"})
	if cmd != nil {
		t.Fatalf("auto-refresh should be skipped when no session, got %T", cmd)
	}
}

func TestAgentAutoRefreshTriggerDoesNotOpenOverlay(t *testing.T) {
	envelope := sessionAgentJobsResponse{}
	if err := json.Unmarshal(fullAgentJobsPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_agents_smoke_xyz"
	// Open the overlay once and close it.
	updated, _ := m.Update(agentJobsMsg{raw: fullAgentJobsPayload(), envelope: envelope, sessionID: "sess_agents_smoke_xyz", trigger: "user"})
	um := updated.(model)
	closed, _ := um.Update(tea.KeyMsg{Type: tea.KeyEsc})
	um = closed.(model)
	if um.inputMode != modeComposing {
		t.Fatalf("precondition: should be in composing, got %q", um.inputMode)
	}
	// Now fire an auto-refresh and verify the overlay does NOT
	// reopen (the user is mid-composition).
	updated, _ = um.Update(agentJobsMsg{raw: fullAgentJobsPayload(), envelope: envelope, sessionID: "sess_agents_smoke_xyz", trigger: "auto"})
	um2 := updated.(model)
	if um2.inputMode == modeAgentOverlay {
		t.Fatalf("'auto' trigger must NOT open the overlay, got %q", um2.inputMode)
	}
	if len(um2.agentJobs) != 3 {
		t.Fatalf("'auto' trigger should still update the snapshot, got %d jobs", len(um2.agentJobs))
	}
}

// fullTasksListPayload returns a representative tasks list
// response with three tasks covering in_progress / blocked /
// completed terminal states plus a worktree recovery hint on
// one task. Used by the task board tests below.
func fullTasksListPayload() []byte {
	return []byte(`{
		"type": "tasks_list",
		"sessionId": "sess_tasks_smoke_xyz",
		"tasks": [
			{
				"taskId": "task_in_progress_1",
				"sessionId": "sess_tasks_smoke_xyz",
				"title": "implement auth middleware",
				"status": "in_progress",
				"ownerAgentId": "agent_impl_1",
				"source": "planner",
				"dependsOn": [],
				"blocks": ["task_review_1"],
				"retryCount": 0,
				"createdAt": "2026-06-10T09:00:00Z",
				"updatedAt": "2026-06-10T09:30:00Z"
			},
			{
				"taskId": "task_blocked_1",
				"sessionId": "sess_tasks_smoke_xyz",
				"title": "review auth refactor",
				"status": "blocked",
				"source": "executor",
				"dependsOn": ["task_in_progress_1"],
				"blocks": [],
				"retryCount": 2,
				"review": {"status": "pending", "reason": "waiting for human"},
				"createdAt": "2026-06-10T08:00:00Z",
				"updatedAt": "2026-06-10T09:15:00Z"
			},
			{
				"taskId": "task_completed_1",
				"sessionId": "sess_tasks_smoke_xyz",
				"title": "investigate compile error",
				"status": "completed",
				"source": "user",
				"dependsOn": [],
				"blocks": [],
				"retryCount": 0,
				"review": {"status": "approved"},
				"createdAt": "2026-06-10T07:00:00Z",
				"updatedAt": "2026-06-10T07:30:00Z",
				"result": "compile error was a missing import",
				"metadata": {
					"worktreeRecovery": {
						"action": "continue",
						"preservePath": "sess_tasks_smoke_xyz_worktree_continue"
					}
				}
			}
		]
	}`)
}

func TestFormatTaskStatusIconAllValues(t *testing.T) {
	cases := map[taskStatus]string{
		taskStatusPending:    "[pend]",
		taskStatusInProgress: "[run]",
		taskStatusBlocked:    "[block]",
		taskStatusCompleted:  "[done]",
		taskStatusFailed:     "[fail]",
		taskStatusCancelled:  "[cancel]",
	}
	for status, want := range cases {
		if got := formatTaskStatusIcon(status); got != want {
			t.Fatalf("formatTaskStatusIcon(%s) = %q, want %q", status, got, want)
		}
	}
	// Unknown status falls through to the bracketed raw text.
	if got := formatTaskStatusIcon(taskStatus("paused")); got != "[paused]" {
		t.Fatalf("unknown status should bracket raw text, got %q", got)
	}
}

func TestBuildTaskBoardLinesRendersTasks(t *testing.T) {
	envelope := tasksListResponse{}
	if err := json.Unmarshal(fullTasksListPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	lines := buildTaskBoardLines(envelope.Tasks)
	combined := strings.Join(lines, "\n")
	for _, want := range []string{
		"[run]", "#task_in_progress_1", "implement auth middleware",
		"[block]", "#task_blocked_1", "retry=2", "review=pending",
		"[done]", "#task_completed_1", "review=approved",
		"recovery=continue",
	} {
		if !strings.Contains(combined, want) {
			t.Fatalf("buildTaskBoardLines missing %q\nfull:\n%s", want, combined)
		}
	}
}

func TestBuildTaskBoardLinesEmptyPlaceholder(t *testing.T) {
	lines := buildTaskBoardLines(nil)
	if len(lines) != 1 || lines[0] != "No tasks for this session." {
		t.Fatalf("expected single empty placeholder, got %v", lines)
	}
}

func TestSummarizeTaskBoardRendersStatusCounts(t *testing.T) {
	envelope := tasksListResponse{}
	if err := json.Unmarshal(fullTasksListPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := summarizeTaskBoard(envelope.Tasks)
	for _, want := range []string{"in_progress 1", "blocked 1", "completed 1"} {
		if !strings.Contains(got, want) {
			t.Fatalf("summarizeTaskBoard missing %q\nfull:\n%s", want, got)
		}
	}
}

func TestRenderTaskBoardEmptyOutsideMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if got := m.renderTaskBoard(120); got != "" {
		t.Fatalf("renderTaskBoard outside modeTaskBoard should be empty, got %q", got)
	}
}

func TestRenderTaskBoardShowsHeaderInMode(t *testing.T) {
	envelope := tasksListResponse{}
	if err := json.Unmarshal(fullTasksListPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_tasks_smoke_xyz"
	m.taskBoard = envelope.Tasks
	m.inputMode = modeTaskBoard
	m.height = 30
	rendered := m.renderTaskBoard(120)
	if rendered == "" {
		t.Fatalf("renderTaskBoard in modeTaskBoard should be non-empty")
	}
	for _, want := range []string{
		"Task board · Phase 6 PR4 overlay",
		"sess_tas", // shortID of "sess_tasks_smoke_xyz"
		"in_progress 1", "blocked 1", "completed 1",
		"scroll", "close",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered task board missing %q\nfull:\n%s", want, rendered)
		}
	}
}

func TestTaskBoardOpensOnMsgAndClearsOnClose(t *testing.T) {
	envelope := tasksListResponse{}
	if err := json.Unmarshal(fullTasksListPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_tasks_smoke_xyz"
	updated, _ := m.Update(tasksListMsg{raw: fullTasksListPayload(), envelope: envelope, sessionID: "sess_tasks_smoke_xyz", trigger: "user"})
	um, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if um.inputMode != modeTaskBoard {
		t.Fatalf("inputMode = %q, want %q", um.inputMode, modeTaskBoard)
	}
	if len(um.taskBoard) != 3 {
		t.Fatalf("taskBoard = %d, want 3", len(um.taskBoard))
	}
	// Esc closes.
	closed, _ := um.Update(tea.KeyMsg{Type: tea.KeyEsc})
	cm := closed.(model)
	if cm.inputMode != modeComposing {
		t.Fatalf("inputMode after esc = %q, want %q", cm.inputMode, modeComposing)
	}
}

func TestTaskBoardScrollClamps(t *testing.T) {
	envelope := tasksListResponse{}
	if err := json.Unmarshal(fullTasksListPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_tasks_smoke_xyz"
	updated, _ := m.Update(tasksListMsg{raw: fullTasksListPayload(), envelope: envelope, sessionID: "sess_tasks_smoke_xyz", trigger: "user"})
	um := updated.(model)
	// Up at 0 stays at 0.
	up, _ := um.Update(tea.KeyMsg{Type: tea.KeyUp})
	u := up.(model)
	if u.taskBoardScroll != 0 {
		t.Fatalf("up at 0 should stay at 0, got %d", u.taskBoardScroll)
	}
	// Down should advance and clamp at len-1.
	cur := u
	for i := 0; i < 200; i++ {
		next, _ := cur.Update(tea.KeyMsg{Type: tea.KeyDown})
		cur = next.(model)
	}
	allLines := buildTaskBoardLines(cur.taskBoard)
	maxScroll := len(allLines) - 1
	if cur.taskBoardScroll != maxScroll {
		t.Fatalf("scroll should clamp at %d, got %d", maxScroll, cur.taskBoardScroll)
	}
}

func TestTaskSlashCommandEmptySessionShortCircuits(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	cmd := m.handleLocalCommand("/tasks")
	if cmd != nil {
		t.Fatalf("expected nil cmd when no session, got %T", cmd)
	}
	last := m.transcript[len(m.transcript)-1]
	if !strings.Contains(last.text, "no active session yet") {
		t.Fatalf("expected friendly short-circuit status, got %q", last.text)
	}
}

func TestTasksListMsgErrorAppendsFriendlyLine(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(tasksListMsg{err: errors.New("dial tcp: connection refused")})
	um := updated.(model)
	last := um.transcript[len(um.transcript)-1]
	if last.kind != "error" || !strings.Contains(last.text, "tasks: dial tcp") {
		t.Fatalf("expected friendly error line, got %+v", last)
	}
}

func TestTasksListAutoRefreshTriggerDoesNotOpenOverlay(t *testing.T) {
	envelope := tasksListResponse{}
	if err := json.Unmarshal(fullTasksListPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_tasks_smoke_xyz"
	// Open then close.
	updated, _ := m.Update(tasksListMsg{raw: fullTasksListPayload(), envelope: envelope, sessionID: "sess_tasks_smoke_xyz", trigger: "user"})
	um := updated.(model)
	closed, _ := um.Update(tea.KeyMsg{Type: tea.KeyEsc})
	um = closed.(model)
	if um.inputMode != modeComposing {
		t.Fatalf("precondition: should be in composing, got %q", um.inputMode)
	}
	// Auto-refresh should NOT reopen.
	updated, _ = um.Update(tasksListMsg{raw: fullTasksListPayload(), envelope: envelope, sessionID: "sess_tasks_smoke_xyz", trigger: "auto"})
	um2 := updated.(model)
	if um2.inputMode == modeTaskBoard {
		t.Fatalf("'auto' trigger must NOT open the overlay, got %q", um2.inputMode)
	}
	if len(um2.taskBoard) != 3 {
		t.Fatalf("'auto' trigger should still update the snapshot, got %d tasks", len(um2.taskBoard))
	}
}

func TestFetchSessionTasksHTTPCmdSendsCorrectPath(t *testing.T) {
	var seenPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"tasks_list","sessionId":"sess_xyz","tasks":[]}`))
	}))
	defer server.Close()
	m := newModel(config{baseURL: server.URL, cwd: "/workspace"})
	cmd := fetchSessionTasks(m.cfg, "sess_xyz", "user")
	msg := cmd()
	tasks, ok := msg.(tasksListMsg)
	if !ok {
		t.Fatalf("expected tasksListMsg, got %T", msg)
	}
	if tasks.err != nil {
		t.Fatalf("fetchSessionTasks returned err: %v", tasks.err)
	}
	if seenPath != "/v1/sessions/sess_xyz/tasks" {
		t.Fatalf("seenPath = %q", seenPath)
	}
	if tasks.trigger != "user" {
		t.Fatalf("trigger = %q, want user", tasks.trigger)
	}
}

func TestFormatActivityKindIconAllValues(t *testing.T) {
	cases := map[activityEventKind]string{
		activityKindToolStarted:     "[tool>]",
		activityKindToolCompleted:   "[toolok]",
		activityKindPermission:      "[perm]",
		activityKindAgentJob:        "[agent]",
		activityKindContextWarning:  "[ctx-warn]",
		activityKindContextBlocking: "[ctx-stop]",
	}
	for kind, want := range cases {
		if got := formatActivityKindIcon(kind); got != want {
			t.Fatalf("formatActivityKindIcon(%s) = %q, want %q", kind, got, want)
		}
	}
	// Unknown kind falls through to bracketed raw text.
	if got := formatActivityKindIcon(activityEventKind("weird_event")); got != "[weird_event]" {
		t.Fatalf("unknown kind should bracket raw text, got %q", got)
	}
}

func TestRecordActivityEventAppendsAndCapsAtBuffer(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if got := len(m.activityEvents); got != 0 {
		t.Fatalf("fresh model should have empty activity buffer, got %d", got)
	}
	// Push past the cap to verify the oldest entries are dropped.
	for i := 0; i < activityBufferCap+5; i++ {
		m.recordActivityEvent(activityKindToolStarted, fmt.Sprintf("tool-call-%d", i), "ts")
	}
	if got := len(m.activityEvents); got != activityBufferCap {
		t.Fatalf("activity buffer should cap at %d, got %d", activityBufferCap, got)
	}
	// The oldest entries should have been dropped, so the
	// first remaining entry is tool-call-5 (the first 5 were
	// dropped).
	if got := m.activityEvents[0].Summary; got != "tool-call-5" {
		t.Fatalf("first surviving entry should be tool-call-5, got %q", got)
	}
	if got := m.activityEvents[activityBufferCap-1].Summary; got != fmt.Sprintf("tool-call-%d", activityBufferCap+4) {
		t.Fatalf("last entry should be tool-call-%d, got %q", activityBufferCap+4, got)
	}
}

func TestRecordActivityEventFallsBackToKindWhenSummaryEmpty(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.recordActivityEvent(activityKindToolStarted, "", "")
	if got := m.activityEvents[0].Summary; got != "[tool_started]" {
		t.Fatalf("empty summary should fall back to bracketed kind, got %q", got)
	}
}

func TestBuildActivityOverlayLinesRendersNewestFirst(t *testing.T) {
	entries := []activityEventEntry{
		{Kind: activityKindToolStarted, Summary: "first", Timestamp: "ts1"},
		{Kind: activityKindToolCompleted, Summary: "second", Timestamp: "ts2"},
		{Kind: activityKindPermission, Summary: "third", Timestamp: "ts3"},
	}
	lines := buildActivityOverlayLines(entries)
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	// Newest first → first line should reference "third".
	if !strings.Contains(lines[0], "third") {
		t.Fatalf("first line should be newest (third), got %q", lines[0])
	}
	if !strings.Contains(lines[len(lines)-1], "first") {
		t.Fatalf("last line should be oldest (first), got %q", lines[len(lines)-1])
	}
}

func TestBuildActivityOverlayLinesEmptyPlaceholder(t *testing.T) {
	lines := buildActivityOverlayLines(nil)
	if len(lines) != 1 || lines[0] != "No recent activity recorded yet." {
		t.Fatalf("expected single empty placeholder, got %v", lines)
	}
}

func TestSummarizeActivityEventsRendersPerKindCounts(t *testing.T) {
	entries := []activityEventEntry{
		{Kind: activityKindToolStarted},
		{Kind: activityKindToolStarted},
		{Kind: activityKindToolCompleted},
		{Kind: activityKindPermission},
		{Kind: activityKindContextWarning},
	}
	got := summarizeActivityEvents(entries)
	for _, want := range []string{"tool_started 2", "tool_completed 1", "permission 1", "context_warning 1"} {
		if !strings.Contains(got, want) {
			t.Fatalf("summarizeActivityEvents missing %q\nfull:\n%s", want, got)
		}
	}
}

func TestSummarizeActivityEventsEmpty(t *testing.T) {
	if got := summarizeActivityEvents(nil); got != "no recent activity" {
		t.Fatalf("empty summary should report no recent activity, got %q", got)
	}
}

func TestRenderActivityOverlayEmptyOutsideMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if got := m.renderActivityOverlay(120); got != "" {
		t.Fatalf("renderActivityOverlay outside modeActivityOverlay should be empty, got %q", got)
	}
}

func TestRenderActivityOverlayShowsHeaderInMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.inputMode = modeActivityOverlay
	m.height = 30
	m.activityEvents = []activityEventEntry{
		{Kind: activityKindToolStarted, Summary: "Bash echo hi", Timestamp: "2026-06-10T10:00:00Z"},
		{Kind: activityKindPermission, Summary: "permit approved=true", Timestamp: "2026-06-10T10:00:01Z"},
	}
	rendered := m.renderActivityOverlay(120)
	if rendered == "" {
		t.Fatalf("renderActivityOverlay in modeActivityOverlay should be non-empty")
	}
	for _, want := range []string{
		"Recent activity · Phase 6 PR5 overlay",
		"tool_started 1", "permission 1",
		"Bash echo hi", "permit approved=true",
		"scroll", "close",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered activity overlay missing %q\nfull:\n%s", want, rendered)
		}
	}
}

func TestConsumeNexusEventRecordsActivityForToolEvents(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_activity_1"
	// Fire a tool_started event with a Bash toolUseId + name +
	// input so formatToolInput produces a useful summary.
	_ = m.consumeNexusEvent(map[string]any{
		"type":      "tool_started",
		"name":      "Bash",
		"input":     map[string]any{"command": "echo go-tui-activity"},
		"timestamp": "2026-06-10T10:00:00Z",
	})
	if got := len(m.activityEvents); got != 1 {
		t.Fatalf("tool_started should record one activity event, got %d", got)
	}
	entry := m.activityEvents[0]
	if entry.Kind != activityKindToolStarted {
		t.Fatalf("recorded kind = %s, want tool_started", entry.Kind)
	}
	if !strings.Contains(entry.Summary, "echo go-tui-activity") {
		t.Fatalf("recorded summary should include the Bash command, got %q", entry.Summary)
	}
}

func TestConsumeNexusEventSkipsActivityForIrrelevantEvents(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_activity_2"
	// tool_denied, usage, hook_* are intentionally NOT recorded.
	for _, eventType := range []string{"tool_denied", "usage", "hook_started", "hook_completed", "hook_failed"} {
		_ = m.consumeNexusEvent(map[string]any{"type": eventType})
	}
	if got := len(m.activityEvents); got != 0 {
		t.Fatalf("only tool_started / tool_completed / permission_response / context_warning / context_blocking / agent_job_event should record; got %d entries", got)
	}
}

func TestActivityOverlayOpensAndCloses(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	// /activity should open the overlay even with an empty buffer.
	cmd := m.handleLocalCommand("/activity")
	if cmd != nil {
		t.Fatalf("expected nil cmd (no HTTP round-trip), got %T", cmd)
	}
	if m.inputMode != modeActivityOverlay {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeActivityOverlay)
	}
	// Esc closes.
	updated, _ := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	um := updated.(model)
	if um.inputMode != modeComposing {
		t.Fatalf("inputMode after esc = %q, want %q", um.inputMode, modeComposing)
	}
}

func TestSubAgentStatusFromTaskSessionEventMapsLifecycleTypes(t *testing.T) {
	cases := map[string]subAgentStatus{
		"subagent_started":            subAgentStatusRunning,
		"sub_agent_session_started":   subAgentStatusRunning,
		"subagent_completed":          subAgentStatusCompleted,
		"sub_agent_session_completed": subAgentStatusCompleted,
		"subagent_failed":             subAgentStatusFailed,
		"sub_agent_session_failed":    subAgentStatusFailed,
		"sub_agent_session_error":     subAgentStatusFailed,
		"subagent_cancelled":          subAgentStatusCancelled,
	}
	for eventType, want := range cases {
		event := map[string]any{"type": "task_session_event", "eventType": eventType}
		got, ok := subAgentStatusFromTaskSessionEvent(event)
		if !ok {
			t.Fatalf("subAgentStatusFromTaskSessionEvent(%s) should map", eventType)
		}
		if got != want {
			t.Fatalf("subAgentStatusFromTaskSessionEvent(%s) = %s, want %s", eventType, got, want)
		}
	}
	// Unrelated event types return ("", false) so the caller
	// can no-op.
	got, ok := subAgentStatusFromTaskSessionEvent(map[string]any{"type": "task_session_event", "eventType": "task_progressed"})
	if ok {
		t.Fatalf("unrelated eventType should not map, got %s", got)
	}
}

func TestRecordSubAgentEventCreatesEntryWithRunningStatus(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.recordSubAgentEvent(map[string]any{
		"type":      "task_session_event",
		"eventType": "subagent_started",
		"timestamp": "2026-06-10T10:00:00Z",
		"payload": map[string]any{
			"agentId":      "agent_sub_1",
			"parentTaskId": "task_abc_1",
			"title":        "investigate compile error",
		},
	}, subAgentStatusRunning)
	entry, ok := m.subAgents["agent_sub_1"]
	if !ok {
		t.Fatalf("sub-agent entry should be inserted")
	}
	if entry.Status != subAgentStatusRunning {
		t.Fatalf("status = %s, want running", entry.Status)
	}
	if entry.ParentTask != "task_abc_1" {
		t.Fatalf("parentTask = %q, want task_abc_1", entry.ParentTask)
	}
	if entry.Title != "investigate compile error" {
		t.Fatalf("title = %q, want 'investigate compile error'", entry.Title)
	}
	if entry.UpdatedAt != "2026-06-10T10:00:00Z" {
		t.Fatalf("updatedAt = %q", entry.UpdatedAt)
	}
}

func TestRecordSubAgentEventUpdatesExistingEntryOnCompletion(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	// Started.
	m.recordSubAgentEvent(map[string]any{
		"type": "task_session_event", "eventType": "subagent_started",
		"payload": map[string]any{"agentId": "agent_sub_1"},
	}, subAgentStatusRunning)
	if m.subAgentRunningCount() != 1 {
		t.Fatalf("expected 1 running sub-agent, got %d", m.subAgentRunningCount())
	}
	// Completed.
	m.recordSubAgentEvent(map[string]any{
		"type": "task_session_event", "eventType": "subagent_completed",
		"timestamp": "2026-06-10T10:05:00Z",
		"payload": map[string]any{"agentId": "agent_sub_1"},
	}, subAgentStatusCompleted)
	entry := m.subAgents["agent_sub_1"]
	if entry.Status != subAgentStatusCompleted {
		t.Fatalf("status should be completed, got %s", entry.Status)
	}
	if m.subAgentRunningCount() != 0 {
		t.Fatalf("expected 0 running sub-agents after completion, got %d", m.subAgentRunningCount())
	}
}

func TestRecordSubAgentEventSkipsWhenNoID(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.recordSubAgentEvent(map[string]any{
		"type":      "task_session_event",
		"eventType": "subagent_started",
		"payload":   map[string]any{}, // no agentId / subSessionId / taskId
	}, subAgentStatusRunning)
	if got := len(m.subAgents); got != 0 {
		t.Fatalf("sub-agent without id should be dropped, got %d entries", got)
	}
}

func TestConsumeNexusEventAggregatesSubAgentLifecycle(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_sub_agg_1"
	// Fire subagent_started.
	_ = m.consumeNexusEvent(map[string]any{
		"type":      "task_session_event",
		"eventType": "subagent_started",
		"timestamp": "2026-06-10T10:00:00Z",
		"payload": map[string]any{
			"agentId":      "agent_sub_1",
			"parentTaskId": "task_abc_1",
			"title":        "investigate compile error",
		},
	})
	// Fire subagent_completed.
	_ = m.consumeNexusEvent(map[string]any{
		"type":      "task_session_event",
		"eventType": "subagent_completed",
		"timestamp": "2026-06-10T10:05:00Z",
		"payload":   map[string]any{"agentId": "agent_sub_1"},
	})
	// Fire an unrelated task_session_event — should NOT add a sub-agent.
	_ = m.consumeNexusEvent(map[string]any{
		"type":      "task_session_event",
		"eventType": "task_progressed",
		"timestamp": "2026-06-10T10:06:00Z",
		"payload":   map[string]any{"agentId": "agent_should_not_exist"},
	})
	if got := len(m.subAgents); got != 1 {
		t.Fatalf("expected 1 sub-agent entry, got %d", got)
	}
	entry := m.subAgents["agent_sub_1"]
	if entry.Status != subAgentStatusCompleted {
		t.Fatalf("expected completed status, got %s", entry.Status)
	}
}

func TestHeaderIncludesRunningSubAgentBadge(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.sessionID = "sess_sub_agg_2"
	m.width = 120
	m.height = 30
	m.subAgents["agent_sub_1"] = subAgentEntry{ID: "agent_sub_1", Status: subAgentStatusRunning, Title: "investigate"}
	m.subAgents["agent_sub_2"] = subAgentEntry{ID: "agent_sub_2", Status: subAgentStatusCompleted, Title: "done"}
	m.subAgents["agent_sub_3"] = subAgentEntry{ID: "agent_sub_3", Status: subAgentStatusRunning, Title: "investigate 2"}
	rendered := m.renderHeader(m.width)
	if !strings.Contains(rendered, "sub: 2 running") {
		t.Fatalf("header should surface 'sub: 2 running' badge, got:\n%s", rendered)
	}
	// No sub-agents running: badge must NOT appear.
	m.subAgents = map[string]subAgentEntry{
		"agent_sub_1": {ID: "agent_sub_1", Status: subAgentStatusCompleted, Title: "done"},
	}
	rendered2 := m.renderHeader(m.width)
	if strings.Contains(rendered2, "sub: ") {
		t.Fatalf("header should not include sub badge when no sub-agents running, got:\n%s", rendered2)
	}
}

func TestFormatSubAgentRowRendersLoopSourceTag(t *testing.T) {
	entry := subAgentEntry{
		ID:         "agent_sub_1",
		ParentTask: "task_abc_1",
		Title:      "investigate compile error",
		Status:     subAgentStatusRunning,
		UpdatedAt:  "2026-06-10T10:00:00Z",
	}
	rows := formatSubAgentRow(entry)
	combined := strings.Join(rows, "\n")
	for _, want := range []string{"[run]", "loop", "subagent", "task=#task_abc_1", "id=agent_sub_1", "investigate compile error", "updated=2026-06-10T10:00:00Z"} {
		if !strings.Contains(combined, want) {
			t.Fatalf("formatSubAgentRow missing %q\nfull:\n%s", want, combined)
		}
	}
}

func TestBuildMergedAgentOverlayLinesJoinsJobsAndSubAgents(t *testing.T) {
	envelope := sessionAgentJobsResponse{}
	if err := json.Unmarshal(fullAgentJobsPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	subs := map[string]subAgentEntry{
		"agent_sub_1": {ID: "agent_sub_1", Status: subAgentStatusRunning, Title: "investigate"},
	}
	lines := buildMergedAgentOverlayLines(envelope.Jobs, subs)
	combined := strings.Join(lines, "\n")
	// Job row markers (from PR3 fixture).
	for _, want := range []string{"[run] job explore", "task=#task_abc_1", "prompt: find the auth middleware"} {
		if !strings.Contains(combined, want) {
			t.Fatalf("merged overlay missing job row %q\nfull:\n%s", want, combined)
		}
	}
	// Sub-agent row markers.
	for _, want := range []string{"--- AgentLoop sub-agents (event-aggregated) ---", "[run] loop subagent", "id=agent_sub_1", "investigate"} {
		if !strings.Contains(combined, want) {
			t.Fatalf("merged overlay missing sub-agent row %q\nfull:\n%s", want, combined)
		}
	}
}

func TestBuildMergedAgentOverlayLinesEmptyWhenBothSourcesEmpty(t *testing.T) {
	lines := buildMergedAgentOverlayLines(nil, nil)
	if len(lines) != 1 || lines[0] != "No agent jobs for this session." {
		t.Fatalf("expected single empty placeholder, got %v", lines)
	}
}

func TestBuildMergedAgentOverlayLinesOrdersSubAgentsAlphabetically(t *testing.T) {
	subs := map[string]subAgentEntry{
		"agent_zeta": {ID: "agent_zeta", Status: subAgentStatusRunning, Title: "z"},
		"agent_alpha": {ID: "agent_alpha", Status: subAgentStatusRunning, Title: "a"},
		"agent_mu": {ID: "agent_mu", Status: subAgentStatusRunning, Title: "m"},
	}
	lines := buildMergedAgentOverlayLines(nil, subs)
	combined := strings.Join(lines, "\n")
	idxAlpha := strings.Index(combined, "id=agent_alpha")
	idxMu := strings.Index(combined, "id=agent_mu")
	idxZeta := strings.Index(combined, "id=agent_zeta")
	if !(idxAlpha < idxMu && idxMu < idxZeta) {
		t.Fatalf("sub-agent rows should be alphabetical, got alpha=%d mu=%d zeta=%d", idxAlpha, idxMu, idxZeta)
	}
}

// fullToolAuditPayload returns a representative tool audit
// response with three tools: a builtin read tool, a builtin
// execute tool with approval + suggested allow rule, and an
// MCP tool with server name + MCP server allowed flag. Used
// by the tool audit overlay + fetch / fallback tests below.
func fullToolAuditPayload() []byte {
	return []byte(`{
		"type": "tools_audit",
		"tools": [
			{
				"name": "Read",
				"description": "read a workspace file",
				"risk": "read",
				"allowed": true,
				"requiresApproval": false,
				"source": {"type": "builtin"}
			},
			{
				"name": "Bash",
				"description": "run a shell command",
				"risk": "execute",
				"allowed": true,
				"requiresApproval": true,
				"suggestedAllowRule": "allow:bash:read-only",
				"source": {"type": "builtin"}
			},
			{
				"name": "mcp_filesystem_list",
				"description": "list workspace entries via filesystem MCP server",
				"risk": "read",
				"allowed": true,
				"requiresApproval": false,
				"mcpServerAllowed": true,
				"source": {
					"type": "mcp",
					"serverName": "filesystem",
					"originalName": "list"
				}
			}
		]
	}`)
}

func TestFormatToolRiskIconAllValues(t *testing.T) {
	cases := map[toolRisk]string{
		toolRiskRead:    "[read]",
		toolRiskWrite:   "[write]",
		toolRiskExecute: "[execute]",
		toolRiskTask:    "[task]",
	}
	for risk, want := range cases {
		if got := formatToolRiskIcon(risk); got != want {
			t.Fatalf("formatToolRiskIcon(%s) = %q, want %q", risk, got, want)
		}
	}
	// Unknown risk falls through to the bracketed raw text.
	if got := formatToolRiskIcon(toolRisk("destructive")); got != "[destructive]" {
		t.Fatalf("unknown risk should bracket raw text, got %q", got)
	}
}

func TestFormatToolSourceTagBuiltinAndMcp(t *testing.T) {
	cases := []struct {
		name   string
		source *toolAuditSource
		want   string
	}{
		{name: "builtin", source: &toolAuditSource{Type: toolSourceBuiltin}, want: "builtin"},
		{name: "mcp with serverName", source: &toolAuditSource{Type: toolSourceMCP, ServerName: "filesystem"}, want: "mcp:filesystem"},
		{name: "mcp without serverName", source: &toolAuditSource{Type: toolSourceMCP}, want: "mcp"},
		{name: "nil source", source: nil, want: ""},
		{name: "unknown source type", source: &toolAuditSource{Type: toolSourceType("plugin")}, want: "plugin"},
	}
	for _, tc := range cases {
		if got := formatToolSourceTag(tc.source); got != tc.want {
			t.Fatalf("%s: formatToolSourceTag = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestFormatToolApprovalStatus(t *testing.T) {
	if got := formatToolApprovalStatus(true); got != "approval-required" {
		t.Fatalf("approval-required = %q", got)
	}
	if got := formatToolApprovalStatus(false); got != "no-approval" {
		t.Fatalf("no-approval = %q", got)
	}
}

func TestBuildToolAuditOverlayLinesRendersEntries(t *testing.T) {
	envelope := toolsAuditResponse{}
	if err := json.Unmarshal(fullToolAuditPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	lines := buildToolAuditOverlayLines(envelope.Tools)
	combined := strings.Join(lines, "\n")
	for _, want := range []string{
		"[read]", "builtin", "no-approval", "Read", "read a workspace file",
		"[execute]", "approval-required", "Bash", "suggested allow rule: allow:bash:read-only",
		"[read]", "mcp:filesystem", "mcp server: allowed", "mcp_filesystem_list",
	} {
		if !strings.Contains(combined, want) {
			t.Fatalf("buildToolAuditOverlayLines missing %q\nfull:\n%s", want, combined)
		}
	}
}

func TestBuildToolAuditOverlayLinesEmptyPlaceholder(t *testing.T) {
	lines := buildToolAuditOverlayLines(nil)
	if len(lines) != 1 || lines[0] != "No tools registered in the current runtime." {
		t.Fatalf("expected single empty placeholder, got %v", lines)
	}
}

func TestSummarizeToolAuditRendersRiskCounts(t *testing.T) {
	envelope := toolsAuditResponse{}
	if err := json.Unmarshal(fullToolAuditPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := summarizeToolAudit(envelope.Tools)
	for _, want := range []string{"execute 1", "read 2"} {
		if !strings.Contains(got, want) {
			t.Fatalf("summarizeToolAudit missing %q\nfull:\n%s", want, got)
		}
	}
}

func TestSummarizeToolAuditEmpty(t *testing.T) {
	if got := summarizeToolAudit(nil); got != "no tools" {
		t.Fatalf("empty summary should report no tools, got %q", got)
	}
}

func TestRenderToolAuditOverlayEmptyOutsideMode(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	if got := m.renderToolAuditOverlay(120); got != "" {
		t.Fatalf("renderToolAuditOverlay outside modeToolAuditOverlay should be empty, got %q", got)
	}
}

func TestRenderToolAuditOverlayShowsHeaderInMode(t *testing.T) {
	envelope := toolsAuditResponse{}
	if err := json.Unmarshal(fullToolAuditPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	m.toolAuditEntries = envelope.Tools
	m.inputMode = modeToolAuditOverlay
	m.height = 30
	rendered := m.renderToolAuditOverlay(120)
	if rendered == "" {
		t.Fatalf("renderToolAuditOverlay in modeToolAuditOverlay should be non-empty")
	}
	for _, want := range []string{
		"Tools audit · Phase 4 wire overlay",
		"execute 1", "read 2",
		"Read", "Bash", "mcp_filesystem_list",
		"scroll", "close",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered tool audit overlay missing %q\nfull:\n%s", want, rendered)
		}
	}
}

func TestToolAuditOverlayOpensOnMsgAndClearsOnClose(t *testing.T) {
	envelope := toolsAuditResponse{}
	if err := json.Unmarshal(fullToolAuditPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(toolAuditMsg{raw: fullToolAuditPayload(), envelope: envelope, trigger: "user"})
	um, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if um.inputMode != modeToolAuditOverlay {
		t.Fatalf("inputMode = %q, want %q", um.inputMode, modeToolAuditOverlay)
	}
	if len(um.toolAuditEntries) != 3 {
		t.Fatalf("toolAuditEntries = %d, want 3", len(um.toolAuditEntries))
	}
	// Esc closes.
	closed, _ := um.Update(tea.KeyMsg{Type: tea.KeyEsc})
	cm := closed.(model)
	if cm.inputMode != modeComposing {
		t.Fatalf("inputMode after esc = %q, want %q", cm.inputMode, modeComposing)
	}
}

func TestToolAuditOverlayEscapeEnterQAllClose(t *testing.T) {
	envelope := toolsAuditResponse{}
	if err := json.Unmarshal(fullToolAuditPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(toolAuditMsg{raw: fullToolAuditPayload(), envelope: envelope, trigger: "user"})
	um := updated.(model)
	for _, keyType := range []tea.KeyType{tea.KeyEsc, tea.KeyEnter} {
		um.inputMode = modeToolAuditOverlay
		closed, _ := um.Update(tea.KeyMsg{Type: keyType})
		cm := closed.(model)
		if cm.inputMode != modeComposing {
			t.Fatalf("key %v should close the overlay, got %q", keyType, cm.inputMode)
		}
	}
	um.inputMode = modeToolAuditOverlay
	closed, _ := um.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	cm := closed.(model)
	if cm.inputMode != modeComposing {
		t.Fatalf("'q' should close the overlay, got %q", cm.inputMode)
	}
}

func TestToolAuditOverlayScrollClamps(t *testing.T) {
	envelope := toolsAuditResponse{}
	if err := json.Unmarshal(fullToolAuditPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(toolAuditMsg{raw: fullToolAuditPayload(), envelope: envelope, trigger: "user"})
	um := updated.(model)
	// Up at 0 stays at 0.
	up, _ := um.Update(tea.KeyMsg{Type: tea.KeyUp})
	u := up.(model)
	if u.toolAuditScroll != 0 {
		t.Fatalf("up at 0 should stay at 0, got %d", u.toolAuditScroll)
	}
	// Down advances and clamps at len-1.
	cur := u
	for i := 0; i < 200; i++ {
		next, _ := cur.Update(tea.KeyMsg{Type: tea.KeyDown})
		cur = next.(model)
	}
	allLines := buildToolAuditOverlayLines(cur.toolAuditEntries)
	maxScroll := len(allLines) - 1
	if cur.toolAuditScroll != maxScroll {
		t.Fatalf("scroll should clamp at %d, got %d", maxScroll, cur.toolAuditScroll)
	}
}

func TestToolAuditOverlayStrayKeyDoesNotReachTextinput(t *testing.T) {
	envelope := toolsAuditResponse{}
	if err := json.Unmarshal(fullToolAuditPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(toolAuditMsg{raw: fullToolAuditPayload(), envelope: envelope, trigger: "user"})
	m = updated.(model)
	m.input.SetValue("untouched")
	updated, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'z'}})
	um := updated.(model)
	if um.input.Value() != "untouched" {
		t.Fatalf("stray key reached textinput, got %q", um.input.Value())
	}
	if um.inputMode != modeToolAuditOverlay {
		t.Fatalf("stray key should leave mode unchanged, got %q", um.inputMode)
	}
}

func TestToolsSlashCommandFetchesAuditOnSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/tools/audit" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"tools_audit","tools":[{"name":"Read","description":"read a workspace file","risk":"read","allowed":true,"requiresApproval":false}]}`))
	}))
	defer server.Close()
	m := newModel(config{baseURL: server.URL, cwd: "/workspace"})
	cmd := m.handleLocalCommand("/tools")
	if cmd == nil {
		t.Fatalf("expected non-nil cmd from /tools")
	}
	msg := cmd()
	audit, ok := msg.(toolAuditMsg)
	if !ok {
		t.Fatalf("expected toolAuditMsg, got %T", msg)
	}
	if audit.err != nil {
		t.Fatalf("audit err: %v", audit.err)
	}
	if len(audit.envelope.Tools) != 1 {
		t.Fatalf("envelope.Tools len = %d, want 1", len(audit.envelope.Tools))
	}
	if audit.envelope.Tools[0].Name != "Read" {
		t.Fatalf("first tool name = %q, want Read", audit.envelope.Tools[0].Name)
	}
	if audit.trigger != "user" {
		t.Fatalf("trigger = %q, want user", audit.trigger)
	}
}

func TestToolsSlashCommandFallsBackToStaticOnFetchError(t *testing.T) {
	// Point at a port nothing is listening on to force a
	// connection refused.
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	cmd := m.handleLocalCommand("/tools")
	if cmd == nil {
		t.Fatalf("expected non-nil cmd from /tools")
	}
	msg := cmd()
	audit, ok := msg.(toolAuditMsg)
	if !ok {
		t.Fatalf("expected toolAuditMsg, got %T", msg)
	}
	if audit.err == nil {
		t.Fatalf("expected fetch error, got nil")
	}
	// Verify the static catalog fallback is reachable and
	// contains Bash (always present in the offline list).
	static := staticToolDescriptorCatalog()
	found := false
	for _, t := range static {
		if t.name == "Bash" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("static catalog should include Bash as a known-good fallback")
	}
}

func TestToolAuditMsgErrorFallsBackToStaticCatalogInTranscript(t *testing.T) {
	m := newModel(config{baseURL: "http://127.0.0.1:1", cwd: "/workspace"})
	updated, _ := m.Update(toolAuditMsg{err: errors.New("dial tcp: connection refused")})
	um := updated.(model)
	// The error must surface in the transcript so the user
	// can see why the wire failed. Walk the transcript
	// because the static catalog fallback pushes additional
	// lines after the error line.
	combined := ""
	foundError := false
	for _, line := range um.transcript {
		combined += line.text + "\n"
		if line.kind == "error" && strings.Contains(line.text, "tools audit: dial tcp") {
			foundError = true
		}
	}
	if !foundError {
		t.Fatalf("expected friendly error line in transcript, got:\n%s", combined)
	}
	// The static catalog rows should also be in the transcript
	// (the test for /tools on a bad URL must still show a
	// usable list).
	if !strings.Contains(combined, "Bash") {
		t.Fatalf("static catalog fallback should push Bash into the transcript, got:\n%s", combined)
	}
	if !strings.Contains(combined, "approval-required") {
		t.Fatalf("static catalog fallback should preserve the approval column, got:\n%s", combined)
	}
}

func TestFetchToolAuditHTTPCmdSendsCorrectPath(t *testing.T) {
	var seenPath string
	var seenMethod string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenMethod = r.Method
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"tools_audit","tools":[]}`))
	}))
	defer server.Close()
	m := newModel(config{baseURL: server.URL, cwd: "/workspace"})
	cmd := fetchToolAudit(m.cfg, "user")
	msg := cmd()
	audit, ok := msg.(toolAuditMsg)
	if !ok {
		t.Fatalf("expected toolAuditMsg, got %T", msg)
	}
	if audit.err != nil {
		t.Fatalf("fetchToolAudit returned err: %v", audit.err)
	}
	if seenPath != "/v1/tools/audit" {
		t.Fatalf("seenPath = %q", seenPath)
	}
	if seenMethod != http.MethodGet {
		t.Fatalf("seenMethod = %q, want GET", seenMethod)
	}
	if audit.trigger != "user" {
		t.Fatalf("trigger = %q, want user", audit.trigger)
	}
}

func TestStaticToolDescriptorCatalogIsStableReferenceShape(t *testing.T) {
	// The static catalog is the offline fallback. The names
	// and risk levels must remain stable so a future refactor
	// that re-orders the slice (or drops a tool) trips this
	// test and forces an explicit decision.
	tools := staticToolDescriptorCatalog()
	wantNames := []string{"Read", "Write", "Edit", "Bash", "Glob", "Grep", "TaskCreate"}
	if len(tools) != len(wantNames) {
		t.Fatalf("static catalog should have %d tools, got %d", len(wantNames), len(tools))
	}
	for index, want := range wantNames {
		if tools[index].name != want {
			t.Fatalf("static catalog[%d].name = %q, want %q", index, tools[index].name, want)
		}
	}
	// Bash is the only execute-risk tool and the only one
	// that requires approval.
	if tools[3].risk != "execute" || !tools[3].approval {
		t.Fatalf("Bash should be execute-risk + approval-required, got risk=%q approval=%v", tools[3].risk, tools[3].approval)
	}
}
