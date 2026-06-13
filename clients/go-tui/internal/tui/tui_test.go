package tui

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/gorilla/websocket"
)

type fmtString string

func (s fmtString) String() string { return string(s) }

func viewContent(view tea.View) string {
	return view.Content
}

func keyPress(code rune) tea.KeyPressMsg {
	return tea.KeyPressMsg(tea.Key{Code: code})
}

func ctrlKey(r rune) tea.KeyPressMsg {
	return tea.KeyPressMsg(tea.Key{Code: r, Mod: tea.ModCtrl})
}

func textKey(text string) tea.KeyPressMsg {
	code := tea.KeyExtended
	if r := []rune(text); len(r) == 1 {
		code = r[0]
	}
	return tea.KeyPressMsg(tea.Key{Code: code, Text: text})
}

func mouseClick(button tea.MouseButton, x, y int) tea.MouseClickMsg {
	return tea.MouseClickMsg(tea.Mouse{Button: button, X: x, Y: y})
}

func mouseMotion(button tea.MouseButton, x, y int) tea.MouseMotionMsg {
	return tea.MouseMotionMsg(tea.Mouse{Button: button, X: x, Y: y})
}

func mouseRelease(button tea.MouseButton, x, y int) tea.MouseReleaseMsg {
	return tea.MouseReleaseMsg(tea.Mouse{Button: button, X: x, Y: y})
}

func mouseWheel(button tea.MouseButton, x, y int) tea.MouseWheelMsg {
	return tea.MouseWheelMsg(tea.Mouse{Button: button, X: x, Y: y})
}

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
		Config{BaseURL: server.URL, APIKey: "secret-key"},
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

func TestSaveRuntimeProviderConfigPostsProviderCredentials(t *testing.T) {
	var seenMethod, seenPath string
	var seenBody map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&seenBody); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"runtime_config","modelId":"minimax/MiniMax-M3","providerId":"minimax","authMode":"api-key","hasApiKey":true}`))
	}))
	defer server.Close()

	msg := saveRuntimeProviderConfig(Config{BaseURL: server.URL}, "minimax", "sk-test", "https://api.minimaxi.com/anthropic")()
	got, ok := msg.(providerConfigMsg)
	if !ok {
		t.Fatalf("expected providerConfigMsg, got %T", msg)
	}
	if got.err != nil {
		t.Fatalf("saveRuntimeProviderConfig returned error: %v", got.err)
	}
	if seenMethod != http.MethodPost || seenPath != "/v1/runtime/config/provider" {
		t.Fatalf("request = %s %s", seenMethod, seenPath)
	}
	if seenBody["provider"] != "minimax" || seenBody["apiKey"] != "sk-test" || seenBody["baseUrl"] != "https://api.minimaxi.com/anthropic" {
		t.Fatalf("unexpected body: %#v", seenBody)
	}
	if got.providerID != "minimax" || got.config.ProviderID != "minimax" || !got.config.HasAPIKey {
		t.Fatalf("unexpected msg: %+v", got)
	}
}

func TestSaveRuntimeProviderConfigOmitsEmptyAPIKeyToKeepSavedCredential(t *testing.T) {
	var seenBody map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&seenBody); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"runtime_config","modelId":"minimax/MiniMax-M3","providerId":"minimax","authMode":"api-key","hasApiKey":true}`))
	}))
	defer server.Close()

	msg := saveRuntimeProviderConfig(Config{BaseURL: server.URL}, "minimax", "", "https://api.minimaxi.com/anthropic")()
	got, ok := msg.(providerConfigMsg)
	if !ok {
		t.Fatalf("expected providerConfigMsg, got %T", msg)
	}
	if got.err != nil {
		t.Fatalf("saveRuntimeProviderConfig returned error: %v", got.err)
	}
	if _, ok := seenBody["apiKey"]; ok {
		t.Fatalf("empty API key should be omitted so the saved credential is preserved: %#v", seenBody)
	}
	if seenBody["provider"] != "minimax" || seenBody["baseUrl"] != "https://api.minimaxi.com/anthropic" {
		t.Fatalf("unexpected body: %#v", seenBody)
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

func TestFormatRuntimeModels(t *testing.T) {
	response := runtimeModelsResponse{
		Type:          "runtime_models",
		Version:       4,
		DefaultModel:  "minimax/MiniMax-M3",
		ActiveProfile: "alpha",
		Providers: []registeredProvider{
			{
				ID:          "minimax",
				DisplayName: "MiniMax",
				Configured:  true,
				Active:      true,
				Models: []registeredModel{
					{
						ID:            "minimax/MiniMax-M3",
						ContextWindow: 245760,
						Capabilities: runtimeCapabilities{
							ToolCalling: true,
							JSONOutput:  true,
							Streaming:   true,
						},
					},
				},
			},
		},
	}
	lines := formatRuntimeModels(response)

	joined := strings.Join(lines, "\n")
	wants := []string{
		"models (capability matrix):",
		"provider minimax (MiniMax, configured) (active):",
		"minimax/MiniMax-M3",
		"context=245760",
		"✓ tool-call",
		"✓ json",
		"✓ stream",
	}
	for _, want := range wants {
		if !strings.Contains(joined, want) {
			t.Fatalf("models matrix missing %q:\n%s", want, joined)
		}
	}
}

func TestBuildModelOverlayLinesMirrorsChatModelConfigSemantics(t *testing.T) {
	response := runtimeModelsResponse{
		Type:          "runtime_models",
		Version:       4,
		DefaultModel:  "minimax/MiniMax-M3",
		ActiveProfile: "alpha",
		Providers: []registeredProvider{
			{
				ID:           "minimax",
				DisplayName:  "MiniMax",
				AuthMode:     "apiKey",
				DefaultModel: "minimax/MiniMax-M3",
				Configured:   true,
				Active:       true,
				Models: []registeredModel{
					{
						ID:               "minimax/MiniMax-M3",
						Name:             "MiniMax M3",
						ContextWindow:    245760,
						DefaultMaxTokens: 4096,
						Capabilities: runtimeCapabilities{
							ToolCalling:      true,
							JSONOutput:       true,
							StructuredOutput: true,
							Streaming:        true,
						},
					},
				},
			},
		},
	}
	combined := strings.Join(buildModelOverlayLines(response), "\n")
	for _, want := range []string{
		"Active model: minimax/MiniMax-M3",
		"Active profile: alpha",
		"Configuration writes stay CLI-owned in Go TUI",
		"bbl config use <modelId>",
		"bbl chat /model",
		"minimax (MiniMax) · active · configured · auth=apiKey",
		"* minimax/MiniMax-M3",
		"ctx=245760",
		"tool-call,json,structured,stream",
		"MiniMax M3",
	} {
		if !strings.Contains(combined, want) {
			t.Fatalf("model overlay missing %q:\n%s", want, combined)
		}
	}
}

func TestModelRegistryOpensOnModelTriggerAndCloses(t *testing.T) {
	response := runtimeModelsResponse{
		Type:         "runtime_models",
		DefaultModel: "local/coding-runtime",
		Providers: []registeredProvider{
			{
				ID:             "local",
				DisplayName:    "Local",
				Adapter:        "native",
				AuthMode:       "none",
				DefaultBaseURL: "",
				DefaultModel:   "local/coding-runtime",
				Configured:     true,
				Active:         true,
				Models: []registeredModel{
					{ID: "local/coding-runtime", ContextWindow: 8192},
				},
			},
		},
	}
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	updated, _ := m.Update(runtimeModelsMsg{response: response, trigger: "model"})
	um := updated.(model)
	um.height = 30
	if um.inputMode != modeModelPickProvider {
		t.Fatalf("inputMode = %q, want %q", um.inputMode, modeModelPickProvider)
	}
	if um.modelCatalog.DefaultModel != "local/coding-runtime" {
		t.Fatalf("modelCatalog default = %q", um.modelCatalog.DefaultModel)
	}
	rendered := um.renderModelPickProvider(100)
	for _, want := range []string{"BABEL Model Registry", "Select provider", "Local"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered model registry missing %q:\n%s", want, rendered)
		}
	}
	closed, _ := um.Update(keyPress(tea.KeyEsc))
	cm := closed.(model)
	if cm.inputMode != modeComposing {
		t.Fatalf("inputMode after esc = %q, want %q", cm.inputMode, modeComposing)
	}
}

func TestModelRegistryOverlayCoversInputAndTranscriptAtSmallHeight(t *testing.T) {
	response := runtimeModelsResponse{
		Type:         "runtime_models",
		DefaultModel: "minimax/MiniMax-M3",
		Providers: []registeredProvider{
			{
				ID:             "minimax",
				DisplayName:    "MiniMax",
				Adapter:        "openai-compatible",
				AuthMode:       "apiKey",
				DefaultBaseURL: "https://api.minimax.io/v1",
				DefaultModel:   "minimax/MiniMax-M3",
				Configured:     true,
				Active:         true,
				Models: []registeredModel{
					{ID: "minimax/MiniMax-M3", Name: "MiniMax M3", ContextWindow: 245760},
				},
			},
		},
	}
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 18
	m.appendLine("status", "loading shared Nexus model configuration")
	m.resize()

	updated, _ := m.Update(runtimeModelsMsg{response: response, trigger: "model"})
	after := updated.(model)
	after.width = 120
	after.height = 18
	after.resize()

	view := viewContent(after.View())
	plain := stripANSICodes(view)
	if got := lipgloss.Height(view); got != after.height {
		t.Fatalf("model registry view height = %d, want terminal height %d:\n%s", got, after.height, plain)
	}
	for _, want := range []string{"BABEL Model Registry", "Select provider", "MiniMax"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("model registry overlay missing %q:\n%s", want, plain)
		}
	}
	if strings.Contains(plain, "> Ask BabeL-O") || strings.Contains(plain, "/ or ctrl+p commands") {
		t.Fatalf("model registry overlay should cover input/footer area:\n%s", plain)
	}
	if strings.Contains(plain, "loading shared Nexus model configuration") {
		t.Fatalf("model registry overlay should hide the main transcript while open:\n%s", plain)
	}
}

func TestFullScreenOverlaysCoverInputAndTranscriptAtSmallHeight(t *testing.T) {
	baseCatalog := runtimeModelsResponse{
		DefaultModel: "local/coding-runtime",
		Providers: []registeredProvider{
			{
				ID:             "local",
				DisplayName:    "Local",
				DefaultBaseURL: "http://127.0.0.1:3000/v1",
				DefaultModel:   "local/coding-runtime",
				Configured:     true,
				Models: []registeredModel{
					{ID: "local/coding-runtime", Name: "Coding Runtime"},
				},
			},
		},
	}
	makeModel := func(mode inputMode) model {
		m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
		m.width = 120
		m.height = 18
		m.sessionID = "sess_overlay_smoke"
		m.modelCatalog = baseCatalog
		m.modelPickerLive = baseCatalog.Providers[0].Models
		m.modelPickSelectedID = "local"
		m.contextOverlayLines = []string{"BABEL Context", "Current context by source", "runtime 1024/8192"}
		m.inboxMessages = []sessionMessage{{MessageID: "msg_1", Content: "check pending work", Status: messageStatusDelivered}}
		m.inboxChannels = []sessionChannel{{ChannelID: "chan_1", Kind: channelKindDirect, Status: channelStatusOpen}}
		m.agentJobs = []agentJob{{JobID: "job_1", Status: agentStatusRunning, Prompt: "verify overlay"}}
		m.taskBoard = []nexusTask{{TaskID: "task_1", Status: taskStatusInProgress, Title: "verify overlay"}}
		m.activityEvents = []activityEventEntry{{Kind: activityKindToolStarted, Summary: "Bash echo hi", Timestamp: "2026-06-10T10:00:00Z"}}
		m.toolAuditEntries = []runtimeToolAuditEntry{{Name: "bash", Risk: toolRiskExecute}}
		m.appendLine("status", "TRANSCRIPT_MARKER_should_be_hidden")
		m.setMode(mode)
		m.resize()
		return m
	}

	cases := []struct {
		name string
		mode inputMode
		want string
	}{
		{"help", modeHelpOverlay, "BabeL-O Go TUI"},
		{"context", modeContextOverlay, "Context"},
		{"inbox", modeInboxOverlay, "Inbox"},
		{"agents", modeAgentOverlay, "Agents"},
		{"tasks", modeTaskBoard, "Tasks"},
		{"activity", modeActivityOverlay, "Activity"},
		{"tools", modeToolAuditOverlay, "Tools audit"},
		{"model", modeModelOverlay, "Model configuration"},
		{"model provider", modeModelPickProvider, "BABEL Model Registry"},
		{"model api key", modeModelPickApiKey, "Enter your local Key"},
		{"model base url", modeModelPickBaseURL, "local base URL"},
		{"model picker", modeModelPickModel, "local models"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := makeModel(tc.mode)
			view := viewContent(m.View())
			plain := stripANSICodes(view)
			if got := lipgloss.Height(view); got != m.height {
				t.Fatalf("%s view height = %d, want terminal height %d:\n%s", tc.name, got, m.height, plain)
			}
			if !strings.Contains(plain, tc.want) {
				t.Fatalf("%s overlay missing %q:\n%s", tc.name, tc.want, plain)
			}
			for _, unwanted := range []string{
				"> Ask BabeL-O",
				"/ or ctrl+p commands",
				"TRANSCRIPT_MARKER_should_be_hidden",
			} {
				if strings.Contains(plain, unwanted) {
					t.Fatalf("%s overlay leaked %q:\n%s", tc.name, unwanted, plain)
				}
			}
		})
	}
}

func TestModelSlashCommandWithArgumentEntersRegistry(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	// Pre-load a fake catalog so openModelRegistry has
	// something to display. handleLocalCommand requires
	// the catalog to be non-empty; if it isn't, it
	// re-fetches via fetchRuntimeModels and returns a tea.Cmd.
	m.modelCatalog = runtimeModelsResponse{
		Providers: []registeredProvider{
			{ID: "openai", DisplayName: "OpenAI", Adapter: "openai-compatible", DefaultBaseURL: "https://api.openai.com/v1", DefaultModel: "openai/gpt-4o", Configured: true},
		},
	}
	cmd := m.handleLocalCommand("/model openai/gpt-4o")
	if cmd != nil {
		t.Fatalf("/model <id> should not produce a tea.Cmd when catalog is pre-loaded")
	}
	// The model id passed on the slash command is staged
	// as the apiKey/baseURL draft so the operator can
	// override or accept the default values. The /model
	// flow is interactive; the in-memory modelID is only
	// set after the operator explicitly picks a model
	// from the picker.
	if m.modelPickProviderDraft != "openai/gpt-4o" {
		t.Fatalf("expected draft to be seeded with the slash arg, got %q", m.modelPickProviderDraft)
	}
	if m.inputMode != modeModelPickProvider {
		t.Fatalf("expected modeModelPickProvider, got %v", m.inputMode)
	}
	if m.modelID == "openai/gpt-4o" {
		t.Fatalf("/model <id> must not commit a model id without the picker confirm step")
	}
}

func TestHandleLocalConfigCommandsDoNotStartAgentStream(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
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

func TestHandleModelsSlashCommand(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	cmd := m.handleLocalCommand("/models")
	if cmd == nil {
		t.Fatalf("/models command should return a non-nil fetch Command")
	}
	// Verify it outputs the status line
	found := false
	for _, line := range m.transcript {
		if line.kind == "status" && strings.Contains(line.text, "loading shared Nexus models capability matrix") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("transcript missing loading status message, got: %#v", m.transcript)
	}
}

func TestHandleModelSlashCommandOpensModelOverlayFetch(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	cmd := m.handleLocalCommand("/model")
	if cmd == nil {
		t.Fatalf("/model command should return a non-nil fetch Command")
	}
	found := false
	for _, line := range m.transcript {
		if line.kind == "status" && strings.Contains(line.text, "loading shared Nexus model configuration") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("transcript missing model loading status, got: %#v", m.transcript)
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

// Phase 2 of docs/nexus/reference/task-adaptive-recoverable-timeout-plan.md:
// the new `timeout_budget_exceeded` formatter must still surface
// elapsed/budget numbers, suggested next-step actions, and the
// message for non-transcript surfaces such as diagnostics. The
// main transcript suppresses these rows as operational telemetry.
func TestFormatNexusEventTimeoutBudgetExceeded(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":      "timeout_budget_exceeded",
		"sessionId": "session_456",
		"timeoutMs": 60_000,
		"elapsedMs": 60_120,
		"policy":    "soft",
		"suggestedActions": []any{
			"continue",
			"summarize",
			"narrow_scope",
			"retry_last_tool",
		},
		"message": "Soft timeout budget exhausted; the workflow continues.",
	})
	if !strings.Contains(got, "soft timeout budget reached") {
		t.Fatalf("formatNexusEvent() missing soft timeout banner: %q", got)
	}
	if !strings.Contains(got, "elapsed=60120ms/60000ms") {
		t.Fatalf("formatNexusEvent() missing elapsed/budget split: %q", got)
	}
	if !strings.Contains(got, "policy=soft") {
		t.Fatalf("formatNexusEvent() missing policy=soft: %q", got)
	}
	if !strings.Contains(got, "suggested=continue,summarize,narrow_scope,retry_last_tool") {
		t.Fatalf("formatNexusEvent() missing suggested actions: %q", got)
	}
	if !strings.Contains(got, "Soft timeout budget exhausted") {
		t.Fatalf("formatNexusEvent() missing event message: %q", got)
	}
}

// Phase 3 of docs/nexus/reference/task-adaptive-recoverable-timeout-plan.md:
// the new `timeout_extension_granted` event must render in the
// transcript as a budget-extension row carrying the extension
// count out of the max, the delta (additionalMs), the new running
// soft budget, the reason, and the event message. This lets the
// operator see at a glance that the runtime just bought the model
// more time — not that a fatal cutoff was avoided silently.
func TestFormatNexusEventTimeoutExtensionGranted(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":              "timeout_extension_granted",
		"sessionId":         "session_789",
		"extensionCount":    1,
		"maxExtensions":     1,
		"additionalMs":      60_000,
		"totalSoftBudgetMs": 120_000,
		"elapsedMs":         60_500,
		"policy":            "soft",
		"reason":            "auto-first-budget-exhausted",
		"message":           "Soft timeout extended by 60000ms (extension 1/1; this is the last automatic extension).",
	})
	if !strings.Contains(got, "soft timeout extension granted +60000ms") {
		t.Fatalf("formatNexusEvent() missing extension banner / delta: %q", got)
	}
	if !strings.Contains(got, "extension 1/1") {
		t.Fatalf("formatNexusEvent() missing extension count/cap: %q", got)
	}
	if !strings.Contains(got, "total=120000ms") {
		t.Fatalf("formatNexusEvent() missing new running budget: %q", got)
	}
	if !strings.Contains(got, "reason=auto-first-budget-exhausted") {
		t.Fatalf("formatNexusEvent() missing reason: %q", got)
	}
	if !strings.Contains(got, "elapsed=60500ms") {
		t.Fatalf("formatNexusEvent() missing elapsed: %q", got)
	}
	if !strings.Contains(got, "Soft timeout extended") {
		t.Fatalf("formatNexusEvent() missing event message: %q", got)
	}
}

// Phase 4 of docs/nexus/reference/task-adaptive-recoverable-timeout-plan.md:
// formatSoftTimeoutFooter must render a single one-line indicator
// driven purely by the soft-cycle snapshot. Empty snapshot →
// empty string so the footer stays clean. A snapshot with a
// budget but no extensions shows `budget=Xms`; one with
// extensions also shows `ext=N/M`. Tests cover three core
// flavours so the next regression catches a silently dropped
// field.
func TestFormatNexusEventContextUsage(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":          "context_usage",
		"percentUsed":   36,
		"tokenEstimate": 64000,
		"maxTokens":     180000,
	})
	if !strings.Contains(got, "context usage 36%") {
		t.Fatalf("formatNexusEvent(context_usage) = %q, want context usage percent", got)
	}
	if !strings.Contains(got, "tokens=64000/180000") {
		t.Fatalf("formatNexusEvent(context_usage) = %q, want token estimate/max", got)
	}
}

func TestFormatNexusEventContextMicrocompact(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":                        "context_microcompact",
		"estimatedTokensSaved":        2000,
		"compactedEventCount":         2,
		"deduplicatedToolResultCount": 1,
	})
	if !strings.Contains(got, "context microcompact saved≈2000 tokens") {
		t.Fatalf("formatNexusEvent(context_microcompact) = %q, want saved tokens", got)
	}
	if !strings.Contains(got, "events=2") || !strings.Contains(got, "dedup=1") {
		t.Fatalf("formatNexusEvent(context_microcompact) = %q, want event/dedup counts", got)
	}
}

func TestFormatNexusEventContextCompactBoundary(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":                 "context_compact_boundary",
		"trigger":              "manual",
		"beforeEventCount":     120,
		"afterEventCount":      14,
		"retainedEventCount":   13,
		"preservedTailEventId": "event_tail",
	})
	if !strings.Contains(got, "context compact boundary trigger=manual") {
		t.Fatalf("formatNexusEvent(context_compact_boundary) = %q, want trigger", got)
	}
	for _, want := range []string{"before=120", "after=14", "retained=13", "tail=event_tail"} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatNexusEvent(context_compact_boundary) = %q, want %q", got, want)
		}
	}
}

func TestFormatNexusEventContextRecoveryAttempted(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":        "context_recovery_attempted",
		"attempt":     1,
		"maxAttempts": 1,
		"strategy":    "semantic_compact_retry",
		"preTokens":   42000,
		"postTokens":  7500,
		"retryable":   true,
	})
	for _, want := range []string{"context recovery 1/1", "strategy=semantic_compact_retry", "tokens=42000->7500", "retryable=true"} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatNexusEvent(context_recovery_attempted) = %q, want %q", got, want)
		}
	}
}

func TestFormatNexusEventContextGroundingRequired(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":             "context_grounding_required",
		"source":           "post_compact",
		"state":            "summary-derived",
		"suggestedActions": []any{"re_read_referenced_files", "inspect_changed_files"},
	})
	for _, want := range []string{"context grounding required", "source=post_compact", "state=summary-derived", "re_read_referenced_files,inspect_changed_files"} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatNexusEvent(context_grounding_required) = %q, want %q", got, want)
		}
	}
}

func TestFormatNexusEventContextGroundingConfirmed(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":             "context_grounding_confirmed",
		"confirmationKind": "file_read",
		"toolName":         "Read",
		"confirmedFor":     []any{"file_facts", "implementation_status"},
	})
	for _, want := range []string{"context grounding confirmed", "kind=file_read", "tool=Read", "file_facts,implementation_status"} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatNexusEvent(context_grounding_confirmed) = %q, want %q", got, want)
		}
	}
}

func TestFormatNexusEventWorkspaceDirtyDetected(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":             "workspace_dirty_detected",
		"source":           "post_compact",
		"changedFileCount": 2,
		"changedFiles":     []any{"src/runtime/LLMCodingRuntime.ts", "test/runtime.test.ts"},
	})
	for _, want := range []string{"workspace dirty", "source=post_compact", "changed=2", "src/runtime/LLMCodingRuntime.ts,test/runtime.test.ts"} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatNexusEvent(workspace_dirty_detected) = %q, want %q", got, want)
		}
	}
}

func TestFormatNexusEventTaskScopeDeclared(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":                   "task_scope_declared",
		"mode":                   "single_root",
		"primaryRoot":            "/repo/BabeL-O",
		"explicitRoots":          []any{},
		"confirmedExternalRoots": []any{},
	})
	for _, want := range []string{"task scope", "mode=single_root", "primary=/repo/BabeL-O"} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatNexusEvent(task_scope_declared) = %q, want %q", got, want)
		}
	}
}

func TestFormatNexusEventScopeBoundaryDetected(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":            "scope_boundary_detected",
		"boundaryKind":    "sibling_repo",
		"action":          "require_confirmation",
		"targetRoot":      "/repo/BabeL-X",
		"taskPrimaryRoot": "/repo/BabeL-O",
		"reason":          "sibling repo not explicitly requested",
	})
	for _, want := range []string{"scope boundary", "kind=sibling_repo", "action=require_confirmation", "target=/repo/BabeL-X", "current=/repo/BabeL-O"} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatNexusEvent(scope_boundary_detected) = %q, want %q", got, want)
		}
	}
}

func TestFormatNexusEventScopeBoundaryConfirmed(t *testing.T) {
	got := formatNexusEvent(map[string]any{
		"type":              "scope_boundary_confirmed",
		"confirmationScope": "once",
		"targetRoot":        "/repo/BabeL-X",
	})
	for _, want := range []string{"scope boundary confirmed", "scope=once", "target=/repo/BabeL-X"} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatNexusEvent(scope_boundary_confirmed) = %q, want %q", got, want)
		}
	}
}

func TestFormatContextUsageFooter(t *testing.T) {
	if got := formatContextUsageFooter(nil); got != "" {
		t.Fatalf("formatContextUsageFooter(nil) = %q, want empty", got)
	}
	got := formatContextUsageFooter(&contextUsageSnapshot{
		PercentUsed:      36,
		TokenEstimate:    64000,
		MaxTokens:        180000,
		WarningThreshold: 126000,
		CompactThreshold: 162000,
	})
	if !strings.Contains(got, "ctx 36% 64000/180000") {
		t.Fatalf("formatContextUsageFooter() = %q, want ctx usage", got)
	}
	if !strings.Contains(got, "warn=126000 compact=162000") {
		t.Fatalf("formatContextUsageFooter() = %q, want thresholds", got)
	}
}

func TestFormatSoftTimeoutFooterRendersBudgetAndExtensions(t *testing.T) {
	if got := formatSoftTimeoutFooter(nil); got != "" {
		t.Fatalf("formatSoftTimeoutFooter(nil) = %q, want empty", got)
	}
	// Snapshot with zero BudgetExceededAt means the cycle has
	// never fired this turn; still expect empty footer.
	if got := formatSoftTimeoutFooter(&softTimeoutSnapshot{OriginalBudgetMs: 60_000}); got != "" {
		t.Fatalf("formatSoftTimeoutFooter() with no fire = %q, want empty", got)
	}
	// Budget only.
	budgetOnly := formatSoftTimeoutFooter(&softTimeoutSnapshot{
		BudgetExceededAt:  time.Now(),
		OriginalBudgetMs:  60_000,
		TotalSoftBudgetMs: 60_000,
	})
	if !strings.Contains(budgetOnly, "soft timeout budget=60000ms") {
		t.Fatalf("budget-only footer = %q, want soft timeout budget=60000ms", budgetOnly)
	}
	if strings.Contains(budgetOnly, "ext=") {
		t.Fatalf("budget-only footer = %q, must not show ext when MaxExtensions=0", budgetOnly)
	}
	// Budget + one of one extension.
	full := formatSoftTimeoutFooter(&softTimeoutSnapshot{
		BudgetExceededAt:  time.Now(),
		OriginalBudgetMs:  60_000,
		TotalSoftBudgetMs: 120_000,
		ExtensionCount:    1,
		MaxExtensions:     1,
	})
	if !strings.Contains(full, "budget=120000ms") {
		t.Fatalf("post-extension footer = %q, must surface running budget", full)
	}
	if !strings.Contains(full, "ext=1/1") {
		t.Fatalf("post-extension footer = %q, must surface extensions used / cap", full)
	}
}

// Phase 4: friendlyNexusErrorWithContext must reshape
// REQUEST_TIMEOUT when the soft cycle had already fired this turn
// (= watchdog cutoff) instead of recommending the operator raise
// --execute-timeout-ms. With a nil snapshot the legacy message is
// preserved so HTTP API consumers and old `bbl chat` paths keep
// the same wording.
func TestFriendlyNexusErrorWithSoftContextDistinguishesWatchdog(t *testing.T) {
	legacy, ok := friendlyNexusErrorWithContext("REQUEST_TIMEOUT", map[string]any{"timeoutMs": 180_000}, nil)
	if !ok || !strings.Contains(legacy, "consider shorter context") {
		t.Fatalf("legacy REQUEST_TIMEOUT = %q (ok=%v), want fixed-cutoff recommendation", legacy, ok)
	}

	watchdog, ok := friendlyNexusErrorWithContext("REQUEST_TIMEOUT", map[string]any{"timeoutMs": 180_000}, &softTimeoutSnapshot{
		BudgetExceededAt:  time.Now(),
		OriginalBudgetMs:  60_000,
		TotalSoftBudgetMs: 120_000,
		ExtensionCount:    1,
		MaxExtensions:     1,
	})
	if !ok {
		t.Fatalf("watchdog REQUEST_TIMEOUT must still return ok=true")
	}
	if !strings.Contains(watchdog, "watchdog") {
		t.Fatalf("watchdog REQUEST_TIMEOUT = %q, must credit the watchdog", watchdog)
	}
	if strings.Contains(watchdog, "raising --execute-timeout-ms") == false &&
		strings.Contains(watchdog, "raise --execute-timeout-ms") == false &&
		strings.Contains(watchdog, "raising") == false {
		// We do mention --execute-timeout-ms in the watchdog
		// message but ONLY to discourage raising it. Make sure
		// the discouragement wording is present.
		t.Fatalf("watchdog REQUEST_TIMEOUT = %q, must discuss --execute-timeout-ms recommendation context", watchdog)
	}
	if strings.Contains(watchdog, "consider shorter context") {
		t.Fatalf("watchdog REQUEST_TIMEOUT must NOT recommend the fixed-cutoff workaround, got %q", watchdog)
	}
	if !strings.Contains(watchdog, "ext=") && !strings.Contains(watchdog, "extensions used 1/1") {
		t.Fatalf("watchdog REQUEST_TIMEOUT = %q, must surface extensions used out of cap", watchdog)
	}
}

// Phase 5 of docs/nexus/reference/task-adaptive-recoverable-timeout-plan.md:
// when the Nexus error envelope explicitly carries
// `details.kind="watchdog"` (server-side decoration), the Go TUI
// friendly message must use the watchdog flavour even if the
// model never saw the soft cycle snapshot mid-turn. This covers
// the corner case where the watchdog tripped right after the
// final soft cycle, or where state was cleared between the
// soft-cycle event and the error event.
func TestFriendlyNexusErrorWithDetailsKindWatchdogTriggersWatchdogMessage(t *testing.T) {
	payload := map[string]any{
		"timeoutMs": 180_000,
		"details": map[string]any{
			"kind":                     "watchdog",
			"policy":                   "soft",
			"softTimeoutMs":            60_000,
			"watchdogTimeoutMs":        180_000,
			"maxSoftTimeoutExtensions": 1,
			"softCycleEvents":          2,
			"retryable":                false,
		},
	}
	got, ok := friendlyNexusErrorWithContext("REQUEST_TIMEOUT", payload, nil)
	if !ok {
		t.Fatalf("friendlyNexusErrorWithContext must still return ok=true for watchdog REQUEST_TIMEOUT")
	}
	if !strings.Contains(got, "watchdog") {
		t.Fatalf("watchdog-decorated REQUEST_TIMEOUT = %q, must credit the watchdog", got)
	}
	if !strings.Contains(got, "policy=soft") {
		t.Fatalf("watchdog-decorated REQUEST_TIMEOUT = %q, must surface policy=soft from details", got)
	}
	if !strings.Contains(got, "soft budget cycled at 60000ms") {
		t.Fatalf("watchdog-decorated REQUEST_TIMEOUT = %q, must surface details.softTimeoutMs as the cycled soft budget", got)
	}
	if !strings.Contains(got, "watchdog budget 180000ms") {
		t.Fatalf("watchdog-decorated REQUEST_TIMEOUT = %q, must surface details.watchdogTimeoutMs", got)
	}
	if strings.Contains(got, "consider shorter context") {
		t.Fatalf("watchdog-decorated REQUEST_TIMEOUT must NOT fall back to the fixed-cutoff workaround, got %q", got)
	}
}

// Phase 4 lifecycle: consumeNexusEvent must update
// softTimeoutState on the new events and clear it on
// result/error. When an error event arrives mid-flight after the
// soft cycle already fired, the appended transcript line should
// be the watchdog flavour of friendlyNexusError.
func TestConsumeNexusEventTracksSoftTimeoutLifecycle(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()

	m.consumeNexusEvent(map[string]any{
		"type":      "session_started",
		"sessionId": "session_abcdef1234567890",
		"model":     "local/test",
	})
	if m.softTimeoutState != nil {
		t.Fatalf("softTimeoutState should be nil at session start, got %+v", m.softTimeoutState)
	}
	m.consumeNexusEvent(map[string]any{
		"type":      "timeout_budget_exceeded",
		"sessionId": "session_abcdef1234567890",
		"timeoutMs": 60_000,
		"elapsedMs": 60_120,
		"policy":    "soft",
	})
	if m.softTimeoutState == nil {
		t.Fatalf("timeout_budget_exceeded must populate softTimeoutState")
	}
	if m.softTimeoutState.OriginalBudgetMs != 60_000 || m.softTimeoutState.TotalSoftBudgetMs != 60_000 {
		t.Fatalf("post-budget snapshot = %+v, want original=60000 total=60000", m.softTimeoutState)
	}
	if m.softTimeoutState.LastElapsedMs != 60_120 {
		t.Fatalf("post-budget snapshot LastElapsedMs = %d, want 60120", m.softTimeoutState.LastElapsedMs)
	}

	m.consumeNexusEvent(map[string]any{
		"type":              "timeout_extension_granted",
		"sessionId":         "session_abcdef1234567890",
		"extensionCount":    1,
		"maxExtensions":     1,
		"additionalMs":      60_000,
		"totalSoftBudgetMs": 120_000,
		"elapsedMs":         60_500,
		"policy":            "soft",
		"reason":            "auto-first-budget-exhausted",
	})
	if m.softTimeoutState == nil ||
		m.softTimeoutState.ExtensionCount != 1 ||
		m.softTimeoutState.MaxExtensions != 1 ||
		m.softTimeoutState.TotalSoftBudgetMs != 120_000 {
		t.Fatalf("post-extension snapshot = %+v, want ext=1/1 total=120000", m.softTimeoutState)
	}

	// Soft cycle is still live; if the hard watchdog now fires
	// the friendly message must credit the watchdog.
	m.consumeNexusEvent(map[string]any{
		"type":      "error",
		"sessionId": "session_abcdef1234567890",
		"code":      "REQUEST_TIMEOUT",
		"message":   "watchdog timeout",
		"timeoutMs": 120_000,
	})
	if m.softTimeoutState != nil {
		t.Fatalf("softTimeoutState must be cleared on error event, got %+v", m.softTimeoutState)
	}
	// The most recent transcript row should carry the
	// watchdog-flavoured friendly message; scan from the back
	// to skip any earlier rows from this turn.
	var lastErrText string
	for i := len(m.transcript) - 1; i >= 0; i-- {
		if m.transcript[i].kind == "error" {
			lastErrText = m.transcript[i].text
			break
		}
	}
	if lastErrText == "" {
		t.Fatalf("expected an error row in the transcript")
	}
	if !strings.Contains(lastErrText, "watchdog") {
		t.Fatalf("error row = %q, want watchdog-credit friendly message", lastErrText)
	}
	if strings.Contains(lastErrText, "consider shorter context") {
		t.Fatalf("error row = %q, must NOT recommend fixed-cutoff workaround after a soft cycle", lastErrText)
	}
}

// Phase 4: after a successful turn, softTimeoutState must be
// cleared so the next turn starts with a fresh budget.
func TestConsumeNexusEventClearsSoftTimeoutStateOnResult(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()
	m.consumeNexusEvent(map[string]any{
		"type":      "timeout_budget_exceeded",
		"sessionId": "session_clear",
		"timeoutMs": 30_000,
		"elapsedMs": 30_010,
		"policy":    "soft",
	})
	if m.softTimeoutState == nil {
		t.Fatalf("budget_exceeded must populate snapshot")
	}
	m.consumeNexusEvent(map[string]any{
		"type":      "result",
		"sessionId": "session_clear",
		"success":   true,
		"message":   "done",
	})
	if m.softTimeoutState != nil {
		t.Fatalf("softTimeoutState must be cleared on result, got %+v", m.softTimeoutState)
	}
}

func TestSoftTimeoutEventsDoNotAppendTranscriptNoise(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	before := len(m.transcript)

	m.consumeNexusEvent(map[string]any{
		"type":      "near_timeout_warning",
		"sessionId": "session_noise",
		"timeoutMs": 180_000,
		"elapsedMs": 144_003,
		"message":   "Execution is near its timeout budget.",
	})
	m.consumeNexusEvent(map[string]any{
		"type":      "timeout_budget_exceeded",
		"sessionId": "session_noise",
		"timeoutMs": 180_000,
		"elapsedMs": 180_003,
		"policy":    "soft",
		"message":   "Soft timeout budget exhausted; the workflow continues.",
	})
	m.consumeNexusEvent(map[string]any{
		"type":              "timeout_extension_granted",
		"sessionId":         "session_noise",
		"extensionCount":    1,
		"maxExtensions":     1,
		"additionalMs":      180_000,
		"totalSoftBudgetMs": 360_000,
		"elapsedMs":         180_004,
		"policy":            "soft",
	})

	if len(m.transcript) != before {
		t.Fatalf("soft timeout events should not append transcript rows, got %d new rows", len(m.transcript)-before)
	}
	if m.softTimeoutState == nil || m.softTimeoutState.TotalSoftBudgetMs != 360_000 {
		t.Fatalf("soft timeout state should still update, got %+v", m.softTimeoutState)
	}
}

func TestInternalStatusEventsDoNotAppendTranscriptNoise(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	before := len(m.transcript)

	for _, event := range []map[string]any{
		{
			"type":     "permit",
			"approved": true,
			"reason":   "Approved from trusted Go TUI session",
		},
		{
			"type":      "status",
			"status":    "slash cancelled",
			"message":   "slash cancelled",
			"sessionId": "session_noise",
		},
		{
			"type":      "unknown_runtime_status",
			"message":   "near timeout elapsed=144003ms/180000ms Execution is near its timeout budget",
			"sessionId": "session_noise",
		},
		{
			"type":    "status",
			"status":  "permit    approved (session)",
			"message": "permit    approved=true reason=Approved from trusted Go TUI sessi",
		},
		{
			"type":    "status",
			"status":  "timeout  near timeout elapsed=144003ms/180000ms Execution is near its timeout budget;",
			"message": "preserve a concise partial answer now.",
		},
	} {
		m.consumeNexusEvent(event)
	}

	if got := len(m.transcript); got != before {
		t.Fatalf("internal status events should not append transcript rows, got %d new rows", got-before)
	}
}

func TestNonTextModesDoNotReceivePasteOrCSIInput(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeContextOverlay)

	updated, _ := m.Update(tea.PasteMsg{Content: "should not paste"})
	m = updated.(model)
	updated, _ = m.Update(fmt.Stringer(fmtString("?CSI[49 51 59 50 117]?")))
	m = updated.(model)

	if got := m.input.Value(); got != "" {
		t.Fatalf("non-text overlay should not receive paste/CSI input, got %q", got)
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

func TestToolCompletedUpdatesRuntimeAnimationState(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	m.running = true
	m.consumeNexusEvent(map[string]any{
		"type":    "tool_completed",
		"name":    "Bash",
		"success": true,
	})
	label, kind := m.runtimeAnimationState()
	if !strings.Contains(label, "tool activity") || kind != runtimeAnimationTool {
		t.Fatalf("tool_completed runtime animation = (%q, %q), want tool activity/%q",
			label, kind, runtimeAnimationTool)
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
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
	view := viewContent(m.View())
	if !strings.Contains(view, "BabeL-O · Go TUI") {
		t.Fatalf("view does not include title: %q", view)
	}
	if !strings.Contains(view, "Permission: Bash") {
		t.Fatalf("view does not include permission panel: %q", view)
	}
}

func TestStreamStartedPersistsAllocatedSessionForNextTurn(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	events := make(chan streamEvent)
	decisions := make(chan permissionDecision)
	updated, _ := m.Update(streamStartedMsg{
		events:    events,
		decisions: decisions,
		cancel:    make(chan struct{}),
		sessionID: "session_allocated_once",
	})
	m = updated.(model)
	if m.sessionID != "session_allocated_once" {
		t.Fatalf("sessionID = %q, want allocated session", m.sessionID)
	}
	if m.cfg.SessionID != "session_allocated_once" {
		t.Fatalf("cfg.SessionID = %q, want allocated session for the next submit", m.cfg.SessionID)
	}
}

func TestSessionSlashCommandNewAndUseControlSessionSwitching(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", SessionID: "session_old"})
	m.sessionID = "session_old"

	cmd := findSlashCommand("/session")
	if cmd == nil {
		t.Fatalf("/session command should be registered")
	}
	cmd.run(&m, []string{"new"})
	if m.sessionID != "" || m.cfg.SessionID != "" {
		t.Fatalf("/session new should clear active session, got model=%q cfg=%q", m.sessionID, m.cfg.SessionID)
	}

	cmd.run(&m, []string{"use", "session_next"})
	if m.sessionID != "session_next" || m.cfg.SessionID != "session_next" {
		t.Fatalf("/session use should switch active session, got model=%q cfg=%q", m.sessionID, m.cfg.SessionID)
	}

	alias := findSlashCommand("/sessions")
	if alias == nil || alias.name != "/session" {
		t.Fatalf("/sessions should resolve to /session alias, got %+v", alias)
	}
}

func TestSessionSlashCommandOpensInteractivePanel(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", SessionID: "session_old"})
	m.sessionID = "session_old"

	cmd := findSlashCommand("/session")
	if cmd == nil {
		t.Fatalf("/session command should be registered")
	}
	cmd.run(&m, nil)

	if m.inputMode != modeSessionOverlay {
		t.Fatalf("/session should open session overlay, got %q", m.inputMode)
	}
	rendered := viewContent(m.View())
	for _, want := range []string{"Session Control", "session new", "session select", "session switch", "ctrl+p copy id"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("session panel missing %q:\n%s", want, rendered)
		}
	}

	updated, _ := m.Update(textKey("down"))
	m = updated.(model)
	if m.sessionPanelSelected != 1 {
		t.Fatalf("down should select session new, got %d", m.sessionPanelSelected)
	}

	updated, _ = m.Update(textKey("enter"))
	m = updated.(model)
	if m.inputMode != modeSessionConfirm {
		t.Fatalf("enter on session new should open confirm panel, got %q", m.inputMode)
	}

	updated, _ = m.Update(textKey("esc"))
	m = updated.(model)
	if m.inputMode != modeComposing {
		t.Fatalf("esc should close session panel, got %q", m.inputMode)
	}
	if m.sessionID != "session_old" || m.cfg.SessionID != "session_old" {
		t.Fatalf("esc should not change active session, got model=%q cfg=%q", m.sessionID, m.cfg.SessionID)
	}
}

func TestSessionPanelCanConfirmNewSession(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", SessionID: "session_old"})
	m.sessionID = "session_old"
	m.openSessionPanel()
	m.sessionPanelSelected = 1

	updated, _ := m.Update(textKey("enter"))
	m = updated.(model)
	if m.inputMode != modeSessionConfirm {
		t.Fatalf("new selection inputMode = %q", m.inputMode)
	}
	updated, _ = m.Update(textKey("enter"))
	m = updated.(model)

	if m.inputMode != modeComposing {
		t.Fatalf("confirm should return to composing, got %q", m.inputMode)
	}
	if m.sessionID != "" || m.cfg.SessionID != "" {
		t.Fatalf("confirm new should clear session, got model=%q cfg=%q", m.sessionID, m.cfg.SessionID)
	}
}

func TestSessionPanelCtrlPCopiesCurrentSessionID(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", SessionID: "session_1234567890abcdef"})
	m.openSessionPanel()

	updated, cmd := m.Update(ctrlKey('p'))
	after := updated.(model)
	if cmd == nil {
		t.Fatalf("ctrl+p should return clipboard copy command")
	}
	if after.copyToastMessage != "Session id copied to clipboard" {
		t.Fatalf("copy toast = %q", after.copyToastMessage)
	}
	if after.copyToastShownAt.IsZero() {
		t.Fatalf("copy toast timestamp should be set")
	}
	if after.inputMode != modeSessionOverlay {
		t.Fatalf("ctrl+p should keep session panel open, got %q", after.inputMode)
	}
}

func TestSessionPanelCtrlPWithoutSessionShowsStatus(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.openSessionPanel()

	updated, cmd := m.Update(ctrlKey('p'))
	after := updated.(model)
	if cmd != nil {
		t.Fatalf("ctrl+p without session should not return clipboard command, got %T", cmd)
	}
	if after.copyToastMessage != "" {
		t.Fatalf("copy toast should remain empty without session, got %q", after.copyToastMessage)
	}
	view := stripANSICodes(viewContent(after.View()))
	compactView := strings.Join(strings.Fields(view), " ")
	if !strings.Contains(compactView, "session: no active session id to copy") {
		t.Fatalf("missing no-session status:\n%s", view)
	}
}

func TestSessionPanelSwitchesBySessionIDInput(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", SessionID: "session_old"})
	m.sessionID = "session_old"
	m.openSessionPanel()
	m.sessionPanelSelected = 3

	updated, _ := m.Update(textKey("enter"))
	m = updated.(model)
	if m.inputMode != modeSessionInput {
		t.Fatalf("switch selection inputMode = %q", m.inputMode)
	}

	for _, r := range "session_next" {
		updated, _ = m.Update(textKey(string(r)))
		m = updated.(model)
	}
	if got := m.input.Value(); got != "session_next" {
		t.Fatalf("session input value = %q", got)
	}
	updated, _ = m.Update(textKey("enter"))
	m = updated.(model)

	if m.inputMode != modeComposing {
		t.Fatalf("confirm should return to composing, got %q", m.inputMode)
	}
	if m.sessionID != "session_next" || m.cfg.SessionID != "session_next" {
		t.Fatalf("session switch got model=%q cfg=%q", m.sessionID, m.cfg.SessionID)
	}
	if got := m.input.Value(); got != "" {
		t.Fatalf("session input should be cleared after switch, got %q", got)
	}
}

func TestEnsureStreamSessionReusesConfiguredSession(t *testing.T) {
	postCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/v1/sessions" {
			postCount++
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"type":"session_created","sessionId":"session_new"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	got, err := ensureStreamSession(Config{BaseURL: srv.URL, SessionID: "session_existing"}, "hello")
	if err != nil {
		t.Fatalf("ensureStreamSession returned error: %v", err)
	}
	if got != "session_existing" {
		t.Fatalf("session = %q, want existing session", got)
	}
	if postCount != 0 {
		t.Fatalf("configured session should not allocate a new session, POST count=%d", postCount)
	}
}

func TestEnsureStreamSessionAllocatesWhenMissing(t *testing.T) {
	postCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/v1/sessions" {
			postCount++
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"type":"session_created","sessionId":"session_new"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	got, err := ensureStreamSession(Config{BaseURL: srv.URL, Cwd: "/workspace"}, "hello")
	if err != nil {
		t.Fatalf("ensureStreamSession returned error: %v", err)
	}
	if got != "session_new" {
		t.Fatalf("session = %q, want allocated session", got)
	}
	if postCount != 1 {
		t.Fatalf("missing session should allocate exactly once, POST count=%d", postCount)
	}
}

func TestRenderTranscriptLabelsLayeredEvents(t *testing.T) {
	// Mirrors the bbl chat TS TUI transcript layout:
	//   > please inspect this project
	//   ● Bash(ls) (ctrl+o to expand)
	//     Done.
	rendered := renderTranscript([]*transcriptItem{
		{kind: "user", text: "please inspect this project"},
		{kind: "tool_started", text: `● Bash(ls)  (ctrl+o to expand)`},
		{kind: "assistant", text: "Done."},
	}, 80)

	for _, want := range []string{">", "●", "  Done."} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered transcript missing %q: %q", want, rendered)
		}
	}
	// The old label-style prefixes ("you", "tool >", "assistant")
	// must NOT appear — they would clutter the chat log with
	// a coloured label column on every row.
	for _, banned := range []string{"you      ", "tool >   ", " assistant "} {
		if strings.Contains(rendered, banned) {
			t.Fatalf("rendered transcript should NOT contain %q: %q", banned, rendered)
		}
	}
}

func TestRenderToolStartedStaysOnOneLineWhenPathIsLong(t *testing.T) {
	rendered := stripANSICodes(renderTranscript([]*transcriptItem{
		{
			kind: "tool_started",
			text: "● Read(/Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui/internal/tui/tui.go)  (ctrl+o to expand)",
		},
	}, 72))
	lines := strings.Split(rendered, "\n")
	if len(lines) != 1 {
		t.Fatalf("tool row should render as one line, got %d lines:\n%s", len(lines), rendered)
	}
	if lipgloss.Width(lines[0]) > 72 {
		t.Fatalf("tool row width = %d, want <= 72: %q", lipgloss.Width(lines[0]), lines[0])
	}
	if !strings.Contains(lines[0], "ctrl+o to expand") {
		t.Fatalf("tool row should keep expand hint when possible: %q", lines[0])
	}
}

func TestBashToolCompletedUpdatesStartedRowWithOutputPreview(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.consumeNexusEvent(map[string]any{
		"type":      "tool_started",
		"toolUseId": "tool_bash_1",
		"name":      "Bash",
		"input":     map[string]any{"command": `ls -la /Users/tangyaoyue/DEV/BABEL/BabeL-O/src && echo "---NEXUS---"`},
	})
	if len(m.transcript) != 1 {
		t.Fatalf("tool_started should append one transcript row, got %d", len(m.transcript))
	}
	m.consumeNexusEvent(map[string]any{
		"type":      "tool_completed",
		"toolUseId": "tool_bash_1",
		"name":      "Bash",
		"success":   true,
		"output": map[string]any{
			"stdout": "total 24\ndrwxr-xr-x 13 tangyaoyue staff 416 Jun 10 14:29 .\ndrwxr-xr-x 25 tangyaoyue staff 800 Jun 12 00:54 ..\n",
			"stderr": "",
		},
	})
	if len(m.transcript) != 1 {
		t.Fatalf("tool_completed should update the started row, got %d transcript rows", len(m.transcript))
	}
	rendered := stripANSICodes(renderTranscript(m.transcript, 96))
	for _, want := range []string{"● Bash", "ls -la", "ctrl+o to expand", "total 24", "drwxr-xr-x"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered Bash tool block missing %q:\n%s", want, rendered)
		}
	}
	if strings.Contains(rendered, "✓ Bash") {
		t.Fatalf("Bash tool block should use the shared tool marker instead of completed checkmark:\n%s", rendered)
	}
}

func TestBashToolFailureKeepsSharedToolMarker(t *testing.T) {
	item := &transcriptItem{
		kind:       "tool_started",
		text:       "● Bash(exit 1)  (ctrl+o to expand)",
		toolName:   "Bash",
		toolInput:  "exit 1",
		toolStatus: "error",
		Versioned:  NewVersioned(),
	}
	rendered := stripANSICodes(renderTranscript([]*transcriptItem{item}, 80))
	for _, want := range []string{"● Bash", "failed", "exit 1", "ctrl+o to expand"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("failed Bash row missing %q:\n%s", want, rendered)
		}
	}
	for _, banned := range []string{"× Bash", "✓ Bash"} {
		if strings.Contains(rendered, banned) {
			t.Fatalf("failed Bash row should not use status-specific icon %q:\n%s", banned, rendered)
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
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

	view := viewContent(m.View())
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
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
	view := viewContent(m.View())
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
		{"missing_provider_api_key", map[string]any{"provider": "minimax", "model": "minimax/MiniMax-M3", "command": "bbl config add minimax <KEY>"}, "provider \"minimax\" needs an API key before selecting \"minimax/MiniMax-M3\""},
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

func TestWelcomeCardShowsSetupHintForMissingRemoteKey(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelID = "minimax/MiniMax-M3"
	m.providerID = "minimax"
	m.authMode = "api-key"
	m.hasAPIKey = false

	view := stripANSICodes(m.renderWelcomeCard(100))
	if !strings.Contains(view, "auth") || !strings.Contains(view, "setup /model") {
		t.Fatalf("welcome card should show setup hint for missing key:\n%s", view)
	}
}

func TestWelcomeCardShowsReadyForNoAuthProvider(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelID = "local/coding-runtime"
	m.providerID = "local"
	m.authMode = "none"
	m.hasAPIKey = false

	view := stripANSICodes(m.renderWelcomeCard(100))
	if !strings.Contains(view, "auth") || !strings.Contains(view, "ready") {
		t.Fatalf("welcome card should show ready auth for no-auth provider:\n%s", view)
	}
	if strings.Contains(view, "setup /model") {
		t.Fatalf("welcome card should not request setup for no-auth provider:\n%s", view)
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

	cfg := Config{BaseURL: srv.URL, PollIntervalMs: 0}
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

	cfg := Config{BaseURL: srv.URL, PollIntervalMs: 0}
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

	cfg := Config{BaseURL: srv.URL}
	var payload runtimeConfig
	err := nexusJSON(cfg, http.MethodGet, "/v1/runtime/config", nil, &payload)
	if !errors.Is(err, errNotModified) {
		t.Fatalf("expected errNotModified, got %v", err)
	}
}

func TestRuntimeConfigMsgHandlerSilentlyReschedulesPollOn304(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", PollIntervalMs: 5})
	m.configVersion = 7

	_, cmd := m.Update(runtimeConfigMsg{err: errNotModified})
	if cmd == nil {
		t.Fatalf("expected a poll reschedule cmd on 304")
	}
}

func TestRuntimeConfigMsgHandlerLogsWhenVersionMoves(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", PollIntervalMs: 5})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", PollIntervalMs: 0})
	if cmd := m.schedulePollTick(); cmd != nil {
		t.Fatalf("expected nil cmd when poll disabled, got %T", cmd)
	}
}

func TestSchedulePollTickEmitsPollTickMsg(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", PollIntervalMs: 5})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", PollIntervalMs: 5})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if m.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeComposing)
	}
}

func TestSetModeIsIdempotentAndRecordsTransition(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m.sendPermissionDecision(true, "Approved from test", "", "", "")
	if m.inputMode != modeComposing {
		t.Fatalf("inputMode = %q after send, want %q", m.inputMode, modeComposing)
	}
	if m.pending != nil {
		t.Fatalf("pending should be nil after send")
	}
}

func TestKeyDoesNotReachTextinputInPermissionMode(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	_, _ = m.Update(textKey("x"))
	if m.input.Value() != before {
		t.Fatalf("textinput received key while in permission mode: %q -> %q", before, m.input.Value())
	}
}

func TestEscDuringRunningPromptsForAlternativeInstruction(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", SessionID: "session_1"})
	m.running = true
	m.input.SetValue("")
	updated, cmd := m.Update(keyPress(tea.KeyEsc))
	if cmd != nil {
		t.Fatalf("first esc while running should only open the guidance prompt, got cmd %T", cmd)
	}
	m = updated.(model)
	if !m.interruptionPromptActive {
		t.Fatalf("first esc should activate interruption prompt")
	}
	if !strings.Contains(m.input.Value(), "BabeL-O should") {
		t.Fatalf("interruption prompt should seed input with guidance prefix, got %q", m.input.Value())
	}
	if got := m.transcript[len(m.transcript)-1].kind; got != "permission" {
		t.Fatalf("interruption prompt should render as yellow permission guidance, got kind %q", got)
	}
	if !strings.Contains(m.transcript[len(m.transcript)-1].text, "What should BabeL-O do instead?") {
		t.Fatalf("interruption prompt text missing guidance: %q", m.transcript[len(m.transcript)-1].text)
	}
}

func TestEnterAfterInterruptionPromptCancelsAndQueuesNextPrompt(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", SessionID: "session_1"})
	m.running = true
	cancelCh := make(chan struct{}, 1)
	m.streamCancel = cancelCh
	m.interruptionPromptActive = true
	m.input.SetValue("summarize current state instead")

	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	m = updated.(model)
	if cmd == nil {
		t.Fatalf("enter after interruption prompt should issue a cancel command")
	}
	if !m.cancelRequested {
		t.Fatalf("enter after interruption prompt should mark cancel requested")
	}
	if m.queuedPrompt != "summarize current state instead" {
		t.Fatalf("queuedPrompt = %q", m.queuedPrompt)
	}
	if m.input.Value() != "" {
		t.Fatalf("queued interruption prompt should clear input, got %q", m.input.Value())
	}
	_ = cmd()
	select {
	case <-cancelCh:
	default:
		t.Fatalf("cancel command should notify the local stream cancel channel")
	}
}

func TestEnterWhileRunningQueuesNextPrompt(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.running = true
	m.input.SetValue("next prompt")
	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	if cmd != nil {
		t.Fatalf("queuing while running should not start a second stream immediately, got %T", cmd)
	}
	m = updated.(model)
	if m.queuedPrompt != "next prompt" {
		t.Fatalf("queuedPrompt = %q, want next prompt", m.queuedPrompt)
	}
	if m.input.Value() != "" {
		t.Fatalf("input should clear after queueing, got %q", m.input.Value())
	}
	if len(m.promptHistory) != 1 || m.promptHistory[0] != "next prompt" {
		t.Fatalf("queued prompt should enter history, got %#v", m.promptHistory)
	}
}

func TestResultStartsQueuedPrompt(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.running = true
	m.queuedPrompt = "next prompt"
	updated, cmd := m.Update(streamEventMsg{event: streamEvent{payload: map[string]any{
		"type":    "result",
		"success": true,
		"message": "done",
	}}})
	m = updated.(model)
	if cmd == nil {
		t.Fatalf("result with queued prompt should return a start command")
	}
	if !m.running {
		t.Fatalf("queued prompt should start immediately after result")
	}
	if m.queuedPrompt != "" {
		t.Fatalf("queuedPrompt should be consumed, got %q", m.queuedPrompt)
	}
	if got := m.transcript[len(m.transcript)-1].text; got != "next prompt" {
		t.Fatalf("last transcript item = %q, want queued user prompt", got)
	}
}

func TestPermissionPanelRendersFiveOptionsWithCursor(t *testing.T) {
	// Phase A.1 of docs/nexus/reference/go-tui-permission-policy-governance-plan.md:
	// the permission panel must render 5 numbered choices with a
	// `~` cursor on the active row, plus a "Suggested rule:" line
	// when the runtime surfaced one.
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"input":         map[string]any{"command": "cd /tmp && git status"},
		"suggestedRule": "git:status",
		"message":       "Tool Bash requires user permission to run.",
	})
	view := viewContent(m.View())
	for _, fragment := range []string{
		"Waiting for permission",
		"Approve once",
		"Approve for this session",
		"Approve with editable rule",
		"Reject",
		"Reject, tell the model what to do instead",
		"Suggested rule: git:status",
		"~ [1]",
		"[2]",
		"[3]",
		"[4]",
		"[5]",
		"esc cancel",
	} {
		if !strings.Contains(view, fragment) {
			t.Fatalf("permission view missing %q; full view:\n%s", fragment, view)
		}
	}
	if m.permissionChoice != 0 {
		t.Fatalf("permissionChoice = %d, want 0 (default cursor on Approve once)", m.permissionChoice)
	}
}

func TestPermissionPanelRendersScopeRisk(t *testing.T) {
	pending := &pendingPermission{
		name:            "Bash",
		risk:            "read",
		input:           "cd /repo/BabeL-X && find . -type f",
		message:         "Tool Bash crosses the current task scope.",
		scopeRisk:       "sibling_repo",
		targetRoot:      "/repo/BabeL-X",
		taskPrimaryRoot: "/repo/BabeL-O",
		scopeReason:     "sibling repo not explicitly requested",
	}
	d := newPermissionDialog(pending, 0)
	out := d.View(120)
	for _, want := range []string{
		"Scope: sibling_repo outside current task",
		"Target: /repo/BabeL-X",
		"Current: /repo/BabeL-O",
		"Scope reason: sibling repo not explicitly requested",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("scope-risk permission view missing %q:\n%s", want, out)
		}
	}
}

func TestPermissionPanelHighlightsRepeatedSuggestedRule(t *testing.T) {
	pending := &pendingPermission{
		name:              "Bash",
		risk:              "execute",
		input:             "grep -n needle file.go",
		message:           "Tool Bash requires user permission to run.",
		suggestedRule:     "bash:grep-read",
		repeatedRuleCount: 2,
	}
	d := newPermissionDialog(pending, 1)
	out := d.View(120)
	for _, want := range []string{
		"Repeated rule seen 2 times recently",
		"consider session approval",
		"~ [2] Approve for this session",
		"recommended for repeated bash:grep-read",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("repeated-rule permission view missing %q:\n%s", want, out)
		}
	}
}

func TestPermissionPanelDoesNotRecommendSessionWithoutSuggestedRule(t *testing.T) {
	pending := &pendingPermission{
		name:              "Bash",
		risk:              "execute",
		input:             "sleep 0",
		message:           "Tool Bash requires user permission to run.",
		repeatedRuleCount: 3,
	}
	d := newPermissionDialog(pending, 1)
	out := d.View(100)
	for _, forbidden := range []string{
		"Repeated rule seen",
		"recommended for repeated",
	} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("permission view should not include %q without suggestedRule:\n%s", forbidden, out)
		}
	}
}

func TestPermissionRequestTracksRepeatedSuggestedRule(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "bash:grep-read",
	})
	if m.pending == nil || m.pending.repeatedRuleCount != 1 {
		t.Fatalf("first repeatedRuleCount = %v, want 1", m.pending)
	}
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_2",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "bash:grep-read",
	})
	if m.pending == nil || m.pending.repeatedRuleCount != 2 {
		t.Fatalf("second repeatedRuleCount = %v, want 2", m.pending)
	}
	view := viewContent(m.View())
	if !strings.Contains(view, "Repeated rule seen 2 times recently") {
		t.Fatalf("permission view missing repeated-rule hint:\n%s", view)
	}
}

func TestPermissionChoiceArrowKeysCycleCursor(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	// Down arrow → cursor 1
	updated, _ := m.Update(keyPress(tea.KeyDown))
	m = updated.(model)
	if m.permissionChoice != 1 {
		t.Fatalf("after down, permissionChoice = %d, want 1", m.permissionChoice)
	}
	// Down again → cursor 2
	updated, _ = m.Update(keyPress(tea.KeyDown))
	m = updated.(model)
	if m.permissionChoice != 2 {
		t.Fatalf("after second down, permissionChoice = %d, want 2", m.permissionChoice)
	}
	// Up → cursor 1
	updated, _ = m.Update(keyPress(tea.KeyUp))
	m = updated.(model)
	if m.permissionChoice != 1 {
		t.Fatalf("after up, permissionChoice = %d, want 1", m.permissionChoice)
	}
	// Up past zero wraps to 4
	updated, _ = m.Update(keyPress(tea.KeyUp))
	m = updated.(model)
	if m.permissionChoice != 0 {
		t.Fatalf("after up at 0, permissionChoice = %d, want 0", m.permissionChoice)
	}
	updated, _ = m.Update(keyPress(tea.KeyUp))
	m = updated.(model)
	if m.permissionChoice != 4 {
		t.Fatalf("after up at 0 again (wrap), permissionChoice = %d, want 4", m.permissionChoice)
	}
}

func TestPermissionChoiceNumberKeysJumpAndConfirm(t *testing.T) {
	// Phase A.1 Round 1 + Round 2 contract:
	//   1, 2, 4 → jump-and-confirm (sends a permissionDecision
	//     on the channel; pending cleared; mode returns to
	//     composing).
	//   3 → opens the inline rule editor (mode =
	//     modePermissionEditRule), pre-filled with the
	//     runtime-suggested rule. No decision is sent yet;
	//     pending stays set; the operator must press Enter
	//     to commit or Esc to return.
	//   5 → opens the inline feedback editor (mode =
	//     modePermissionEditFeedback), empty. Same editor
	//     flow as option 3.
	// Verified by reading the channel after the keypress and
	// checking mode + pending state.
	cases := []struct {
		keyIdx       int
		confirmsNow  bool
		editorMode   inputMode
		wantApproved bool
		wantScope    string
		wantRule     string
	}{
		{0, true, "", true, "once", ""},
		{1, true, "", true, "session", "git:status"},
		{2, false, modePermissionEditRule, false, "", ""},
		{3, true, "", false, "once", ""},
		{4, false, modePermissionEditFeedback, false, "", ""},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(fmt.Sprintf("key-%d", tc.keyIdx+1), func(t *testing.T) {
			m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
			m.width = 80
			m.height = 30
			m.consumeNexusEvent(map[string]any{
				"type":          "permission_request",
				"sessionId":     "session_1",
				"toolUseId":     "tool_1",
				"name":          "Bash",
				"risk":          "execute",
				"suggestedRule": "git:status",
			})
			// m.decisions is `chan<- permissionDecision` (send-only),
			// so we keep a bidirectional local handle for receiving.
			decisions := make(chan permissionDecision, 1)
			m.decisions = decisions
			key := textKey(string(rune('1' + tc.keyIdx)))
			updated, _ := m.Update(key)
			m = updated.(model)
			if tc.confirmsNow {
				if m.pending != nil {
					t.Fatalf("choice %d: pending should be cleared after confirming", tc.keyIdx+1)
				}
				if m.inputMode != modeComposing {
					t.Fatalf("choice %d: inputMode = %q, want %q", tc.keyIdx+1, m.inputMode, modeComposing)
				}
				select {
				case d := <-decisions:
					if d.approved != tc.wantApproved {
						t.Fatalf("choice %d: approved = %v, want %v", tc.keyIdx+1, d.approved, tc.wantApproved)
					}
					if d.scope != tc.wantScope {
						t.Fatalf("choice %d: scope = %q, want %q", tc.keyIdx+1, d.scope, tc.wantScope)
					}
					if d.rule != tc.wantRule {
						t.Fatalf("choice %d: rule = %q, want %q", tc.keyIdx+1, d.rule, tc.wantRule)
					}
					if d.sessionID != "session_1" || d.toolUseID != "tool_1" {
						t.Fatalf("choice %d: decision routing wrong: %+v", tc.keyIdx+1, d)
					}
				default:
					t.Fatalf("choice %d: expected decision on channel", tc.keyIdx+1)
				}
			} else {
				// Editor path: no decision yet, mode flips, pending stays.
				if m.pending == nil {
					t.Fatalf("choice %d: pending should remain set while editor is open", tc.keyIdx+1)
				}
				if m.inputMode != tc.editorMode {
					t.Fatalf("choice %d: inputMode = %q, want %q (editor open)", tc.keyIdx+1, m.inputMode, tc.editorMode)
				}
				select {
				case d := <-decisions:
					t.Fatalf("choice %d: editor should not emit a decision yet, got %+v", tc.keyIdx+1, d)
				default:
				}
			}
		})
	}
}

func TestApproveForSessionAutoApprovesFuturePermissionRequests(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	decisions := make(chan permissionDecision, 2)
	m.decisions = decisions
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	updated, _ := m.Update(textKey("2"))
	m = updated.(model)
	select {
	case d := <-decisions:
		if !d.approved || d.scope != "session" || d.rule != "git:status" {
			t.Fatalf("first decision = %+v, want approved session git:status", d)
		}
	default:
		t.Fatalf("expected first decision after session approval")
	}
	if !m.isPermissionSessionTrusted("session_1") {
		t.Fatalf("session_1 should be trusted after choosing approve for this session")
	}

	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_2",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "bash:grep-read",
	})
	if m.pending != nil {
		t.Fatalf("trusted session should not leave a visible pending permission: %+v", m.pending)
	}
	if m.inputMode != modeComposing {
		t.Fatalf("trusted session inputMode = %q, want %q", m.inputMode, modeComposing)
	}
	select {
	case d := <-decisions:
		if !d.approved || d.scope != "session" || d.rule != "bash:grep-read" {
			t.Fatalf("auto decision = %+v, want approved session bash:grep-read", d)
		}
		if d.sessionID != "session_1" || d.toolUseID != "tool_2" {
			t.Fatalf("auto decision routed to wrong request: %+v", d)
		}
	default:
		t.Fatalf("expected trusted-session auto decision")
	}
}

func TestTrustedPermissionSessionIsScopedBySessionID(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	decisions := make(chan permissionDecision, 2)
	m.decisions = decisions
	m.trustPermissionSession("session_1")

	m.consumeNexusEvent(map[string]any{
		"type":      "permission_request",
		"sessionId": "session_2",
		"toolUseId": "tool_2",
		"name":      "Bash",
		"risk":      "execute",
	})
	if m.pending == nil {
		t.Fatalf("different session should still show a permission prompt")
	}
	if m.inputMode != modePermission {
		t.Fatalf("different session inputMode = %q, want %q", m.inputMode, modePermission)
	}
	select {
	case d := <-decisions:
		t.Fatalf("different session should not auto-approve, got %+v", d)
	default:
	}
}

func TestPermissionRequestResetsChoiceCursor(t *testing.T) {
	// A stale cursor from a previous prompt must not confirm the
	// wrong option. The cursor is reset to 0 on every fresh
	// `permission_request`.
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":      "permission_request",
		"sessionId": "session_1",
		"toolUseId": "tool_1",
		"name":      "Bash",
		"risk":      "execute",
	})
	// Move cursor to option 3 (editable rule)
	for i := 0; i < 3; i++ {
		updated, _ := m.Update(keyPress(tea.KeyDown))
		m = updated.(model)
	}
	if m.permissionChoice != 3 {
		t.Fatalf("setup: permissionChoice = %d, want 3", m.permissionChoice)
	}
	// New permission request from the runtime — cursor must reset.
	m.consumeNexusEvent(map[string]any{
		"type":      "permission_request",
		"sessionId": "session_1",
		"toolUseId": "tool_2",
		"name":      "Write",
		"risk":      "write",
	})
	if m.permissionChoice != 0 {
		t.Fatalf("permissionChoice = %d after second request, want 0 (reset)", m.permissionChoice)
	}
}

func TestPermissionPanelEscCancelsAsReject(t *testing.T) {
	// Esc keeps its old "just close the panel" semantics: it
	// emits a `permissionDecision` with approved=false and
	// scope=once (no feedback, no rule).
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	decisions := make(chan permissionDecision, 1)
	m.decisions = decisions
	updated, _ := m.Update(keyPress(tea.KeyEsc))
	m = updated.(model)
	select {
	case d := <-decisions:
		if d.approved {
			t.Fatalf("esc should reject, got approved=true")
		}
		if d.scope == "session" {
			t.Fatalf("esc should not accumulate session rules")
		}
	default:
		t.Fatalf("esc should send a decision")
	}
}

func TestPermissionOption3OpensRuleEditor(t *testing.T) {
	// Round 2: pressing `3` on the 5-option panel opens the
	// inline rule editor pre-filled with the runtime-suggested
	// rule. No decision is sent yet.
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	decisions := make(chan permissionDecision, 1)
	m.decisions = decisions
	updated, _ := m.Update(textKey("3"))
	m = updated.(model)
	if m.inputMode != modePermissionEditRule {
		t.Fatalf("after '3', inputMode = %q, want %q", m.inputMode, modePermissionEditRule)
	}
	if m.pending == nil {
		t.Fatalf("pending should remain set while editor is open")
	}
	// Pre-fill: the textinput should hold the suggested rule.
	if got := m.input.Value(); got != "git:status" {
		t.Fatalf("editor pre-fill = %q, want %q", got, "git:status")
	}
	// No decision yet on the channel.
	select {
	case d := <-decisions:
		t.Fatalf("editor should not emit a decision yet, got %+v", d)
	default:
	}
	// The overlay should advertise the editing context.
	view := viewContent(m.View())
	for _, fragment := range []string{"Editing rule for Bash", "Suggested rule: git:status", "↵ confirm", "esc back to options"} {
		if !strings.Contains(view, fragment) {
			t.Fatalf("rule editor view missing %q; full view:\n%s", fragment, view)
		}
	}
}

func TestPermissionRuleEditorEnterCommitsEditedRule(t *testing.T) {
	// Round 2: while in the rule editor, pressing Enter commits
	// the edited rule with scope="rule" (not "session" — "rule"
	// is the explicit user-edited scope). Pressing Esc returns
	// to the 5-option panel without sending a decision.
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	decisions := make(chan permissionDecision, 1)
	m.decisions = decisions
	// Open the editor.
	updated, _ := m.Update(textKey("3"))
	m = updated.(model)
	// Type a new rule.
	m.input.SetValue("bash:git:diff")
	// Press Enter to confirm.
	updated, _ = m.Update(keyPress(tea.KeyEnter))
	m = updated.(model)
	if m.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want %q after commit", m.inputMode, modeComposing)
	}
	if m.pending != nil {
		t.Fatalf("pending should be cleared after commit")
	}
	select {
	case d := <-decisions:
		if !d.approved {
			t.Fatalf("commit should approve, got approved=false")
		}
		if d.scope != "rule" {
			t.Fatalf("commit scope = %q, want %q (user-edited)", d.scope, "rule")
		}
		if d.rule != "bash:git:diff" {
			t.Fatalf("commit rule = %q, want %q", d.rule, "bash:git:diff")
		}
		if d.feedback != "" {
			t.Fatalf("commit feedback = %q, want empty (rule editor, not feedback)", d.feedback)
		}
	default:
		t.Fatalf("expected decision on channel after commit")
	}
}

func TestPermissionRuleEditorEscReturnsToFiveOptionPanel(t *testing.T) {
	// Round 2: pressing Esc in the rule editor returns to the
	// 5-option panel without sending a decision. The cursor
	// is restored to option 2 (where the operator was).
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	decisions := make(chan permissionDecision, 1)
	m.decisions = decisions
	updated, _ := m.Update(textKey("3"))
	m = updated.(model)
	if m.inputMode != modePermissionEditRule {
		t.Fatalf("setup: inputMode = %q, want %q", m.inputMode, modePermissionEditRule)
	}
	updated, _ = m.Update(keyPress(tea.KeyEsc))
	m = updated.(model)
	if m.inputMode != modePermission {
		t.Fatalf("after esc, inputMode = %q, want %q (back to 5-option panel)", m.inputMode, modePermission)
	}
	if m.permissionChoice != 2 {
		t.Fatalf("after esc, permissionChoice = %d, want 2 (cursor restored)", m.permissionChoice)
	}
	if m.pending == nil {
		t.Fatalf("pending should still be set after esc (no decision sent)")
	}
	select {
	case d := <-decisions:
		t.Fatalf("esc should NOT emit a decision from the editor, got %+v", d)
	default:
	}
}

func TestPermissionRuleEditorEmptyValueFallsBackToApproveOnce(t *testing.T) {
	// Round 2 invariant: if the operator clears the suggested
	// rule in the editor and presses Enter, we fall back to
	// `scope: 'once'` (no rule accumulated) rather than emit an
	// empty rule. This keeps `addSessionRule` from being called
	// with whitespace.
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	decisions := make(chan permissionDecision, 1)
	m.decisions = decisions
	updated, _ := m.Update(textKey("3"))
	m = updated.(model)
	// Clear the pre-filled value.
	m.input.SetValue("")
	updated, _ = m.Update(keyPress(tea.KeyEnter))
	m = updated.(model)
	select {
	case d := <-decisions:
		if !d.approved {
			t.Fatalf("cleared rule should still approve, got approved=false")
		}
		if d.scope != "once" {
			t.Fatalf("cleared rule scope = %q, want %q (fall back to once)", d.scope, "once")
		}
		if d.rule != "" {
			t.Fatalf("cleared rule value = %q, want empty", d.rule)
		}
	default:
		t.Fatalf("expected decision on channel after commit with cleared rule")
	}
}

func TestPermissionOption5OpensFeedbackEditor(t *testing.T) {
	// Round 2: pressing `5` opens the inline feedback editor
	// (textinput starts empty, no pre-fill).
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	decisions := make(chan permissionDecision, 1)
	m.decisions = decisions
	updated, _ := m.Update(textKey("5"))
	m = updated.(model)
	if m.inputMode != modePermissionEditFeedback {
		t.Fatalf("after '5', inputMode = %q, want %q", m.inputMode, modePermissionEditFeedback)
	}
	if m.pending == nil {
		t.Fatalf("pending should remain set while feedback editor is open")
	}
	if got := m.input.Value(); got != "" {
		t.Fatalf("feedback editor should start empty, got %q", got)
	}
	select {
	case d := <-decisions:
		t.Fatalf("editor should not emit a decision yet, got %+v", d)
	default:
	}
	view := viewContent(m.View())
	for _, fragment := range []string{"Editing feedback for Bash", "Tell the model what to do instead", "↵ confirm", "esc back to options"} {
		if !strings.Contains(view, fragment) {
			t.Fatalf("feedback editor view missing %q; full view:\n%s", fragment, view)
		}
	}
}

func TestPermissionFeedbackEditorEnterCommitsFeedback(t *testing.T) {
	// Round 2: while in the feedback editor, pressing Enter
	// commits the typed feedback with approved=false and
	// scope=once. The model should see the feedback in the
	// next turn via the `permission_response` event.
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	decisions := make(chan permissionDecision, 1)
	m.decisions = decisions
	updated, _ := m.Update(textKey("5"))
	m = updated.(model)
	m.input.SetValue("use a sandboxed test repo instead")
	updated, _ = m.Update(keyPress(tea.KeyEnter))
	m = updated.(model)
	if m.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want %q after commit", m.inputMode, modeComposing)
	}
	select {
	case d := <-decisions:
		if d.approved {
			t.Fatalf("feedback commit should reject, got approved=true")
		}
		if d.scope != "once" {
			t.Fatalf("feedback commit scope = %q, want %q", d.scope, "once")
		}
		if d.feedback != "use a sandboxed test repo instead" {
			t.Fatalf("feedback commit feedback = %q, want %q", d.feedback, "use a sandboxed test repo instead")
		}
		if d.rule != "" {
			t.Fatalf("feedback commit rule = %q, want empty (feedback editor, not rule)", d.rule)
		}
	default:
		t.Fatalf("expected decision on channel after feedback commit")
	}
}

func TestPermissionFeedbackEditorEmptyValueFallsBackToPlainReject(t *testing.T) {
	// Round 2 invariant: if the operator submits the feedback
	// editor empty (just pressed Enter), we fall back to a
	// plain reject (no follow-up hint to the model). The
	// model still gets a denial — just without a "what to do
	// instead" prompt.
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	decisions := make(chan permissionDecision, 1)
	m.decisions = decisions
	updated, _ := m.Update(textKey("5"))
	m = updated.(model)
	updated, _ = m.Update(keyPress(tea.KeyEnter))
	m = updated.(model)
	select {
	case d := <-decisions:
		if d.approved {
			t.Fatalf("empty feedback should still reject, got approved=true")
		}
		if d.scope != "once" {
			t.Fatalf("empty feedback scope = %q, want %q", d.scope, "once")
		}
		if d.feedback != "" {
			t.Fatalf("empty feedback feedback = %q, want empty (fall back to plain reject)", d.feedback)
		}
	default:
		t.Fatalf("expected decision on channel after empty feedback commit")
	}
}

func TestPermissionFeedbackEditorEscReturnsToFiveOptionPanel(t *testing.T) {
	// Round 2: Esc in the feedback editor returns to the
	// 5-option panel without sending a decision. Cursor
	// restored to option 4.
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	decisions := make(chan permissionDecision, 1)
	m.decisions = decisions
	updated, _ := m.Update(textKey("5"))
	m = updated.(model)
	updated, _ = m.Update(keyPress(tea.KeyEsc))
	m = updated.(model)
	if m.inputMode != modePermission {
		t.Fatalf("after esc, inputMode = %q, want %q (back to 5-option panel)", m.inputMode, modePermission)
	}
	if m.permissionChoice != 4 {
		t.Fatalf("after esc, permissionChoice = %d, want 4 (cursor restored)", m.permissionChoice)
	}
	if m.pending == nil {
		t.Fatalf("pending should still be set after esc (no decision sent)")
	}
	select {
	case d := <-decisions:
		t.Fatalf("esc should NOT emit a decision from the feedback editor, got %+v", d)
	default:
	}
}

func TestPermissionEditorClearsInputOnExit(t *testing.T) {
	// Round 2: the textinput must be cleared on every editor
	// exit (Enter or Esc) so the next composing prompt starts
	// from an empty value. This avoids stale text leaking
	// into a subsequent user prompt after the panel closes.
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 30
	m.consumeNexusEvent(map[string]any{
		"type":          "permission_request",
		"sessionId":     "session_1",
		"toolUseId":     "tool_1",
		"name":          "Bash",
		"risk":          "execute",
		"suggestedRule": "git:status",
	})
	// Open rule editor, type, esc.
	updated, _ := m.Update(textKey("3"))
	m = updated.(model)
	m.input.SetValue("bash:something")
	updated, _ = m.Update(keyPress(tea.KeyEsc))
	m = updated.(model)
	if got := m.input.Value(); got != "" {
		t.Fatalf("after esc, textinput = %q, want empty (stale text would leak into next prompt)", got)
	}
}

func TestHelpOverlayOpensOnQuestionMark(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 24
	updated, _ := m.Update(textKey("?"))
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeHelpOverlay {
		t.Fatalf("inputMode = %q, want %q", updatedModel.inputMode, modeHelpOverlay)
	}
	if !strings.Contains(viewContent(updatedModel.View()), "Help") {
		t.Fatalf("help view should mention 'Help' header: %q", viewContent(updatedModel.View()))
	}
}

func TestHelpOverlayClosesOnEsc(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 24
	m.setMode(modeHelpOverlay)
	updated, _ := m.Update(keyPress(tea.KeyEsc))
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want %q after Esc", updatedModel.inputMode, modeComposing)
	}
}

func TestHelpOverlayScrollMovesHelpScroll(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 24
	m.setMode(modeHelpOverlay)
	updated, _ := m.Update(keyPress(tea.KeyDown))
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.helpScroll != 1 {
		t.Fatalf("helpScroll = %d, want 1", updatedModel.helpScroll)
	}
	updated, _ = updatedModel.Update(keyPress(tea.KeyUp))
	updatedModel, _ = updated.(model)
	if updatedModel.helpScroll != 0 {
		t.Fatalf("helpScroll = %d, want 0 after up", updatedModel.helpScroll)
	}
}

func TestQuestionMarkIgnoredWhenInputNonEmpty(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.input.SetValue("abc")
	updated, _ := m.Update(textKey("?"))
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

func TestCtrlCOpensQuitConfirmFromOverlay(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeHelpOverlay)
	updated, cmd := m.Update(ctrlKey('c'))
	if cmd != nil {
		t.Fatalf("ctrl+c from help overlay should open confirm without quit cmd, got %T", cmd)
	}
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeQuitConfirm {
		t.Fatalf("ctrl+c should open quit confirm, got %q", updatedModel.inputMode)
	}
	if updatedModel.quitChoice != 1 {
		t.Fatalf("quit confirm should default to cancel, got choice %d", updatedModel.quitChoice)
	}
	rendered := stripANSICodes(updatedModel.renderQuitConfirm(80))
	if !strings.Contains(rendered, "Quit BabeL-O?") {
		t.Fatalf("quit confirm should render title, got:\n%s", rendered)
	}
}

func TestQDoesNotQuitWhenInOverlay(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeHelpOverlay)
	updated, cmd := m.Update(textKey("q"))
	if cmd != nil {
		t.Fatalf("q from help overlay must not quit, got %T", cmd)
	}
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	// q inside help should be handled by the help handler (close
	// overlay) and route the model back to composing.
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("help should close after q key arrival, got %q", updatedModel.inputMode)
	}
}

func TestQuitDialogConfirmQuits(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeQuitConfirm)
	m.quitChoice = 1
	updated, cmd := m.Update(keyPress(tea.KeyUp))
	if cmd != nil {
		t.Fatalf("up in quit confirm should not return cmd, got %T", cmd)
	}
	m = updated.(model)
	if m.quitChoice != 0 {
		t.Fatalf("up should select quit now, got choice %d", m.quitChoice)
	}
	_, cmd = m.Update(keyPress(tea.KeyEnter))
	if cmd == nil {
		t.Fatalf("enter on selected quit should return quit cmd")
	}
	if msg := cmd(); msg == nil {
		t.Fatalf("quit cmd should emit a message")
	}
}

func TestQuitDialogCancelReturnsToComposing(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.input.SetValue("draft prompt")
	m.setMode(modeQuitConfirm)
	m.quitChoice = 1
	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	if cmd != nil {
		t.Fatalf("enter on cancel in quit confirm should not return cmd, got %T", cmd)
	}
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("cancel selection should return to composing, got %q", updatedModel.inputMode)
	}
	if updatedModel.input.Value() != "draft prompt" {
		t.Fatalf("quit cancel should preserve draft, got %q", updatedModel.input.Value())
	}
}

func TestQuitDialogRendersAboveInputAndFitsView(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()
	m.setMode(modeQuitConfirm)
	m.quitChoice = 1
	m.resize()

	plain := stripANSICodes(viewContent(m.View()))
	if got := lipgloss.Height(plain); got != m.height {
		t.Fatalf("quit view height = %d, want %d:\n%s", got, m.height, plain)
	}
	quitIdx := strings.Index(plain, "Quit BabeL-O?")
	inputIdx := strings.Index(plain, "> Ask BabeL-O")
	footerIdx := strings.Index(plain, "/ or ctrl+p commands")
	if quitIdx < 0 || inputIdx < 0 || footerIdx < 0 {
		t.Fatalf("quit view should contain dialog, input, and footer:\n%s", plain)
	}
	if !(quitIdx < inputIdx && inputIdx < footerIdx) {
		t.Fatalf("quit dialog should render above input and footer, got quit=%d input=%d footer=%d:\n%s",
			quitIdx, inputIdx, footerIdx, plain)
	}
	if !strings.Contains(plain, "> Cancel") {
		t.Fatalf("quit dialog should show selected cancel row, got:\n%s", plain)
	}
}

func TestTextinputInstanceNotReplacedAcrossModes(t *testing.T) {
	// Phase 3 invariant: the textinput instance is created once in
	// newModel and must never be replaced by mode transitions; only its
	// value / cursor are mutated. We assert this by checking that a
	// value the user typed survives a full mode round-trip.
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 24
	if got := m.renderHelp(80); got != "" {
		t.Fatalf("renderHelp should be empty in composing, got %q", got)
	}
}

func TestRenderHelpVisibleInHelpMode(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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

func TestFuzzyFilterRanksPrefixMatchFirst(t *testing.T) {
	got := filterSlashCommands("mod")
	if len(got) == 0 {
		t.Fatalf("filterSlashCommands(mod) returned no matches")
	}
	if got[0].name != "/model" {
		t.Fatalf("filterSlashCommands(mod)[0] = %q, want /model; full=%v", got[0].name, got)
	}
	fuzzyGot := filterSlashCommands("mdl")
	if len(fuzzyGot) == 0 || fuzzyGot[0].name != "/model" {
		t.Fatalf("filterSlashCommands(mdl) = %v, want /model fuzzy match first", fuzzyGot)
	}
}

func TestFuzzyFilterHighlightsMatchedIndexes(t *testing.T) {
	got := filterSlashCommandMatches("mod")
	if len(got) == 0 || got[0].command.name != "/model" {
		t.Fatalf("filterSlashCommandMatches(mod) = %v, want /model first", got)
	}
	name := highlightSlashCommandName(got[0])
	if !strings.Contains(name, buttonHotkeyOpen+"m"+buttonHotkeyClose) ||
		!strings.Contains(name, buttonHotkeyOpen+"o"+buttonHotkeyClose) ||
		!strings.Contains(name, buttonHotkeyOpen+"d"+buttonHotkeyClose) {
		t.Fatalf("highlightSlashCommandName did not highlight matched runes in %q", name)
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

func TestCommandShortcutsResolveTargets(t *testing.T) {
	cases := []struct {
		shortcut string
		want     string
	}{
		{"ctrl+l", "/model"},
		{"ctrl+g", "/agents"},
		{"ctrl+t", "/tasks"},
		{"ctrl+o", "/tools"},
		{"ctrl+q", "/exit"},
	}
	for _, tc := range cases {
		got := findSlashCommandByShortcut(tc.shortcut)
		if got == nil {
			t.Fatalf("findSlashCommandByShortcut(%q) returned nil", tc.shortcut)
		}
		if got.name != tc.want {
			t.Fatalf("findSlashCommandByShortcut(%q).name = %q, want %q", tc.shortcut, got.name, tc.want)
		}
	}
}

func TestCommandShortcutFiresDirectly(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	updated, cmd := m.Update(ctrlKey('o'))
	if cmd == nil {
		t.Fatalf("ctrl+o should dispatch /tools fetch cmd")
	}
	um := updated.(model)
	if um.inputMode != modeComposing {
		t.Fatalf("ctrl+o should leave mode composing until response, got %q", um.inputMode)
	}
}

func TestCtrlDTogglesTopCard(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()

	updated, cmd := m.Update(ctrlKey('d'))
	if cmd != nil {
		t.Fatalf("ctrl+d should not emit a command, got %T", cmd)
	}
	um := updated.(model)
	if !um.topCardOpen {
		t.Fatalf("ctrl+d should open top card")
	}
	if card := stripANSICodes(um.renderTopCard(120)); !strings.Contains(card, "MCPs") {
		t.Fatalf("open top card should render details, got:\n%s", card)
	}

	updated, _ = um.Update(ctrlKey('d'))
	um = updated.(model)
	if um.topCardOpen {
		t.Fatalf("second ctrl+d should close top card")
	}
}

func TestCommandShortcutCtrlMDoesNotStealEnter(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelCatalog = runtimeModelsResponse{
		Providers: []registeredProvider{{ID: "local", DisplayName: "Local", Configured: true}},
	}
	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	if cmd != nil {
		t.Fatalf("Enter must not dispatch ctrl+m /model shortcut, got %T", cmd)
	}
	um := updated.(model)
	if um.inputMode == modeModelPickProvider {
		t.Fatalf("Enter must not enter model picker via ctrl+m shortcut")
	}
}

func TestCommandShortcutQuitFiresDirectly(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeHelpOverlay)
	_, cmd := m.Update(ctrlKey('q'))
	if cmd == nil {
		t.Fatalf("ctrl+q should return quit cmd")
	}
}

func TestSlashPaletteOpensOnSlashFromEmptyInput(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	updated, _ := m.Update(textKey("/"))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.input.SetValue("abc")
	updated, _ := m.Update(textKey("/"))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeSlashPick)
	updated, _ := m.Update(textKey("p"))
	updatedModel, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if updatedModel.paletteFilter != "p" {
		t.Fatalf("paletteFilter = %q, want %q", updatedModel.paletteFilter, "p")
	}
	updated, _ = updatedModel.Update(textKey("r"))
	updatedModel, _ = updated.(model)
	if updatedModel.paletteFilter != "pr" {
		t.Fatalf("paletteFilter = %q, want %q", updatedModel.paletteFilter, "pr")
	}
}

func TestSlashPaletteBackspaceEditsFilter(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeSlashPick)
	m.paletteFilter = "abc"
	updated, _ := m.Update(keyPress(tea.KeyBackspace))
	updatedModel, _ := updated.(model)
	if updatedModel.paletteFilter != "ab" {
		t.Fatalf("paletteFilter = %q, want %q", updatedModel.paletteFilter, "ab")
	}
}

func TestSlashPaletteBackspaceOnEmptyFilterClosesPalette(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeSlashPick)
	updated, _ := m.Update(keyPress(tea.KeyBackspace))
	updatedModel, _ := updated.(model)
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want composing after backspace on empty filter", updatedModel.inputMode)
	}
}

func TestSlashPaletteEscClosesAndClearsInput(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeSlashPick)
	m.paletteFilter = "pro"
	updated, _ := m.Update(keyPress(tea.KeyEsc))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeSlashPick)
	// Filter matches multiple commands ("/h" -> /help + /h-prefixed entries)
	// Actually only /help starts with "h" in our registry. Use "/b" -> /bash.
	updated, _ := m.Update(textKey("b"))
	updatedModel, _ := updated.(model)
	if updatedModel.paletteSelected != 0 {
		t.Fatalf("paletteSelected should start at 0, got %d", updatedModel.paletteSelected)
	}
	updated, _ = updatedModel.Update(keyPress(tea.KeyDown))
	updatedModel, _ = updated.(model)
	// /b matches /bash only — but navigating down should stay at 0 (clamped).
	if updatedModel.paletteSelected != 0 {
		t.Fatalf("paletteSelected = %d, want 0 (clamped at single match)", updatedModel.paletteSelected)
	}
}

func TestSlashPaletteEnterRunsZeroArgCommand(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeSlashPick)
	m.paletteFilter = "help"
	updated, _ := m.Update(keyPress(tea.KeyEnter))
	updatedModel, _ := updated.(model)
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want composing", updatedModel.inputMode)
	}
	// The /help runner should have appended a status line listing commands.
	rendered := viewContent(updatedModel.View())
	if !strings.Contains(rendered, "local commands:") {
		t.Fatalf("view should mention 'local commands:', got %q", rendered)
	}
}

func TestSlashPaletteEnterOnPrefixCommandInsertsPrefix(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeSlashPick)
	m.paletteFilter = "bash"
	updated, _ := m.Update(keyPress(tea.KeyEnter))
	updatedModel, _ := updated.(model)
	if updatedModel.inputMode != modeComposing {
		t.Fatalf("inputMode = %q, want composing", updatedModel.inputMode)
	}
	if got := updatedModel.input.Value(); got != "/bash " {
		t.Fatalf("input.Value = %q, want %q", got, "/bash ")
	}
}

func TestSlashPaletteEnterOnSessionOpensPanel(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeSlashPick)
	m.paletteFilter = "session"

	updated, _ := m.Update(keyPress(tea.KeyEnter))
	updatedModel := updated.(model)
	if updatedModel.inputMode != modeSessionOverlay {
		t.Fatalf("inputMode = %q, want session overlay", updatedModel.inputMode)
	}
	if got := updatedModel.input.Value(); got != "" {
		t.Fatalf("session palette should not leave command text in input, got %q", got)
	}
	if !strings.Contains(stripANSICodes(viewContent(updatedModel.View())), "Session Control") {
		t.Fatalf("session panel should be visible after palette selection")
	}
}

func TestSlashPaletteRenderShowsFilterAndCandidates(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	// D.1 may ANSI-highlight the matched rune, so assert on visible text.
	if !strings.Contains(stripANSICodes(rendered), "/profile") {
		t.Fatalf("palette should show /profile, got %q", rendered)
	}
}

func TestSlashPaletteRendersAboveInputInFinalView(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 32
	m.resize()
	m.setMode(modeSlashPick)

	plain := stripANSICodes(viewContent(m.View()))
	paletteIdx := strings.Index(plain, "Slash · /")
	inputIdx := strings.Index(plain, "> Ask BabeL-O")
	if paletteIdx < 0 {
		t.Fatalf("final view should include slash palette, got:\n%s", plain)
	}
	if inputIdx < 0 {
		t.Fatalf("final view should include input prompt, got:\n%s", plain)
	}
	if paletteIdx > inputIdx {
		t.Fatalf("slash palette should render above input prompt; got palette index %d after input index %d:\n%s",
			paletteIdx, inputIdx, plain)
	}
}

func TestSlashCancelDoesNotAppendTranscriptNoise(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()
	updated, _ := m.Update(textKey("/"))
	m = updated.(model)
	before := len(m.transcript)

	updated, _ = m.Update(textKey("esc"))
	after := updated.(model)
	if after.inputMode != modeComposing {
		t.Fatalf("esc should close slash palette, got %q", after.inputMode)
	}
	if len(after.transcript) != before {
		t.Fatalf("slash cancel should not append transcript rows, got %d new rows", len(after.transcript)-before)
	}
}

func TestSlashPaletteOpenResizesViewportToKeepComposerVisible(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 32
	m.resize()
	beforeHeight := m.viewport.Height()

	updated, _ := m.Update(textKey("/"))
	after := updated.(model)
	if after.inputMode != modeSlashPick {
		t.Fatalf("inputMode = %q, want slash palette", after.inputMode)
	}
	if after.viewport.Height() >= beforeHeight {
		t.Fatalf("opening slash palette should shrink viewport height, before=%d after=%d",
			beforeHeight, after.viewport.Height())
	}
	view := viewContent(after.View())
	plain := stripANSICodes(view)
	if got := lipgloss.Height(view); got != after.height {
		t.Fatalf("slash palette view height = %d, want terminal height %d:\n%s", got, after.height, plain)
	}
	if !strings.Contains(plain, "Slash · /") || !strings.Contains(plain, "> Ask BabeL-O") {
		t.Fatalf("slash palette and input should both remain visible, got:\n%s", plain)
	}
	if !strings.HasSuffix(plain, stripANSICodes(after.renderFooter(after.width))) {
		t.Fatalf("footer should remain the final row with slash palette open, got:\n%s", plain)
	}
}

func TestSessionPanelAnchorsAboveInputAtSmallHeight(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 22
	m.resize()
	m.openSessionPanel()
	m.resize()

	view := viewContent(m.View())
	plain := stripANSICodes(view)
	if got := lipgloss.Height(view); got != m.height {
		t.Fatalf("session panel view height = %d, want terminal height %d:\n%s", got, m.height, plain)
	}
	panelIdx := strings.Index(plain, "Session Control")
	inputIdx := strings.Index(plain, "> Ask BabeL-O")
	if panelIdx < 0 {
		t.Fatalf("session panel should be visible:\n%s", plain)
	}
	if inputIdx < 0 {
		t.Fatalf("input prompt should remain visible:\n%s", plain)
	}
	if panelIdx > inputIdx {
		t.Fatalf("session panel should render above input prompt, panel=%d input=%d:\n%s", panelIdx, inputIdx, plain)
	}
	if !strings.HasSuffix(plain, stripANSICodes(m.renderFooter(m.width))) {
		t.Fatalf("footer should remain the final row with session panel open:\n%s", plain)
	}
}

func TestDirectSessionCommandResizesForBottomAnchoredPanel(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 22
	m.resize()
	beforeHeight := m.viewport.Height()
	m.setInputValue("/session")

	updated, _ := m.Update(keyPress(tea.KeyEnter))
	after := updated.(model)
	if after.inputMode != modeSessionOverlay {
		t.Fatalf("inputMode = %q, want session overlay", after.inputMode)
	}
	if after.viewport.Height() >= beforeHeight {
		t.Fatalf("opening /session should shrink viewport height, before=%d after=%d",
			beforeHeight, after.viewport.Height())
	}
	view := viewContent(after.View())
	plain := stripANSICodes(view)
	if got := lipgloss.Height(view); got != after.height {
		t.Fatalf("direct /session view height = %d, want terminal height %d:\n%s", got, after.height, plain)
	}
	panelIdx := strings.Index(plain, "Session Control")
	inputIdx := strings.Index(plain, "> Ask BabeL-O")
	if panelIdx < 0 || inputIdx < 0 || panelIdx > inputIdx {
		t.Fatalf("session panel should render above input after direct command, panel=%d input=%d:\n%s",
			panelIdx, inputIdx, plain)
	}
	if !strings.Contains(plain, "enter open") {
		t.Fatalf("session panel should show its footer hint, got:\n%s", plain)
	}
}

func TestSlashPaletteRenderHiddenInOtherModes(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 100
	m.height = 24
	if got := m.renderSlashPalette(100); got != "" {
		t.Fatalf("renderSlashPalette should be empty in composing, got %q", got)
	}
}

func TestToolPaletteRendersRiskSourceApproval(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.renderToolPalette([]toolDescriptor{
		{name: "Bash", risk: "execute", source: "builtin", approval: true, summary: "run a shell command"},
		{name: "Read", risk: "read", source: "builtin", approval: false, summary: "read a file"},
	})
	rendered := viewContent(m.View())
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	rendered := viewContent(m.View())
	if !strings.Contains(rendered, "unknown local command") {
		t.Fatalf("view should mention 'unknown local command', got %q", rendered)
	}
}

// --- Profile confirm overlay (§5 path C phase 3 polish continuation) ---

func TestProfileAlreadyActiveShortCircuitsConfirmOverlay(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.activeProfile = "dev"
	if cmd := m.handleLocalCommand("/profile staging"); cmd != nil {
		t.Fatalf("/profile staging should return nil (parked in confirm)")
	}
	if m.inputMode != modeProfileConfirm {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeProfileConfirm)
	}
	updated, cmd := m.Update(textKey("y"))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if cmd := m.handleLocalCommand("/profile prod"); cmd != nil {
		t.Fatalf("/profile prod should return nil (parked in confirm)")
	}
	updated, cmd := m.Update(keyPress(tea.KeyEnter))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if cmd := m.handleLocalCommand("/profile prod"); cmd != nil {
		t.Fatalf("/profile prod should return nil (parked in confirm)")
	}
	updated, cmd := m.Update(textKey("n"))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if cmd := m.handleLocalCommand("/profile prod"); cmd != nil {
		t.Fatalf("/profile prod should return nil (parked in confirm)")
	}
	updated, cmd := m.Update(keyPress(tea.KeyEsc))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if cmd := m.handleLocalCommand("/profile prod"); cmd != nil {
		t.Fatalf("/profile prod should return nil (parked in confirm)")
	}
	before := m.input.Value()
	updated, _ := m.Update(textKey("z"))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.activeProfile = "dev"
	if got := m.renderProfileConfirm(100); got != "" {
		t.Fatalf("renderProfileConfirm in composing mode should return empty, got %q", got)
	}
}

func TestRenderProfileConfirmShowsHeaderInMode(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "session_phase5_test"
	before := len(m.transcript)
	cmd := m.handleLocalCommand("/context")
	if cmd == nil {
		t.Fatalf("/context with active session should fire an HTTP command")
	}
	rendered := renderTranscript(m.transcript[before:], 200)
	if strings.Contains(rendered, "analyzing shared Nexus context") {
		t.Fatalf("/context loading should not append noisy status rows, got %q", rendered)
	}
}

func TestCompactWithActiveSessionFiresHTTP(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
		"estimate": {"totalTokens": 1234, "systemPromptTokens": 420, "toolDefinitionTokens": 280, "messageTokens": 534},
		"window": {"maxTokens": 8192, "tokenEstimate": 1234, "compactThresholdTokens": 6553, "blockingLimitTokens": 8000},
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
			"compactRemainingTokens": 5319, "blockingRemainingTokens": 6766,
			"usageSummary": {"inputTokens": 1234, "outputTokens": 120, "cacheReadInputTokens": 64, "estimatedReasoningTokens": 32},
			"cacheEconomics": {
				"policySource": "large_context", "modelContextWindow": 8192, "effectiveContextCeiling": 8192,
				"legacyContextCeiling": 8192, "reservedOutputTokens": 512, "providerSafetyBufferTokens": 0,
				"warningThresholdPercent": 70, "compactThresholdPercent": 80,
				"warningThresholdTokens": 5734, "compactThresholdTokens": 6553, "blockingLimitTokens": 8000,
				"reason": "test policy"
			},
			"visualization": {
					"buckets": [
						{"kind": "system", "estimatedTokens": 420, "itemCount": 3, "percentOfEstimate": 34},
						{"kind": "tool_results", "estimatedTokens": 280, "itemCount": 1, "percentOfEstimate": 23}
					],
					"topItems": [
						{"kind": "tool_results", "label": "Bash:call_big", "estimatedTokens": 280, "source": "tool result output"},
						{"kind": "compact_summary", "label": "summary:session", "estimatedTokens": 64, "source": "compact summary retained"}
					],
					"nextThreshold": {"name": "warning", "thresholdTokens": 5734, "remainingTokens": 4500, "percent": 70},
					"grounding": {
						"state": "dirty-workspace", "summaryDerived": true, "dirtyWorkspace": true,
						"changedFileCount": 2,
						"changedFiles": ["src/runtime/contextAnalysis.ts", "clients/go-tui/internal/tui/context.go"],
						"suggestedActions": ["inspect_changed_files", "re_read_referenced_files"]
					},
					"suggestions": ["inspect changed files", "re-read referenced files before source/test/git conclusions", "inspect largest items"]
				},
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
			"taskScope": {
					"cwd": "/workspace",
					"primaryRoot": "/workspace",
					"explicitRoots": [],
					"confirmedExternalRoots": ["/workspace-sibling-confirmed"],
					"inferredCandidateRoots": [],
					"mode": "multi_root",
					"source": "user_confirmation",
					"latestDeclaredAt": "2026-06-13T00:00:00.000Z",
					"pendingBoundaries": [
						{"targetRoot": "/workspace-sibling-pending", "boundaryKind": "sibling_repo", "toolName": "Bash", "toolUseId": "tool-sibling-find", "action": "require_confirmation", "reason": "Sibling repo was not explicitly requested.", "timestamp": "2026-06-13T00:00:01.000Z"}
					],
					"confirmedBoundaries": [
						{"targetRoot": "/workspace-sibling-confirmed", "confirmationScope": "once", "confirmedBy": "user", "timestamp": "2026-06-13T00:00:02.000Z"}
					],
					"outOfScopeEvidence": [
						{"toolUseId": "tool-sibling-find", "toolName": "Bash", "targetRoot": "/workspace-sibling-pending", "reason": "Successful Bash evidence targeted a pending root.", "timestamp": "2026-06-13T00:00:03.000Z"}
					]
				},
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
		"BABEL Context · session_",
		"· coding-runtime",
		"current context 1.2k/8.2k (15%) · available 7.0k",
		"[",
		"Current context by source",
		"System prompt · 420",
		"System tools · 280",
		"Messages · 534",
		"Capacity",
		"compact headroom 5.3k · blocking headroom 6.8k",
		"State",
		"status: ok",
		"sections:",
		"messages: 5 (selected=7",
		"tools visible: 4",
		"token buckets:",
		"system=420 tokens (34%, items=3)",
		"tool_results=280 tokens (23%, items=1)",
		"top context items:",
		"tool_results 280 tokens · Bash:call_big",
		"next threshold: warning at 5734 tokens (70%), remaining=4500",
		"task scope multi_root · primary=/workspace",
		"scope roots explicit=0 confirmedExternal=1 pendingBoundaries=1 outOfScopeEvidence=1",
		"confirmed external roots: /workspace-sibling-confirmed",
		"pending scope boundary: sibling_repo target=/workspace-sibling-pending tool=Bash",
		"out-of-scope evidence: Bash:tool-sibling-find target=/workspace-sibling-pending",
		"grounding: state=dirty-workspace · dirty files=2",
		"actions=inspect_changed_files,re_read_referenced_files",
		"context suggestions:",
		"inspect changed files",
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	closed, _ := updatedModel.Update(keyPress(tea.KeyEsc))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	updated, _ := m.Update(contextAnalysisMsg{raw: fullContextPayload()})
	updatedModel := updated.(model)
	// Up at 0 should stay at 0.
	up, _ := updatedModel.Update(keyPress(tea.KeyUp))
	upModel := up.(model)
	if upModel.contextOverlayScroll != 0 {
		t.Fatalf("up at 0 should stay at 0, got %d", upModel.contextOverlayScroll)
	}
	// Down should advance and clamp at len-1.
	cur := upModel
	for i := 0; i < 200; i++ {
		next, _ := cur.Update(keyPress(tea.KeyDown))
		cur = next.(model)
	}
	maxScroll := len(cur.contextOverlayLines) - 1
	if cur.contextOverlayScroll != maxScroll {
		t.Fatalf("scroll should clamp at %d, got %d", maxScroll, cur.contextOverlayScroll)
	}
	// One more down should stay clamped.
	more, _ := cur.Update(keyPress(tea.KeyDown))
	moreModel := more.(model)
	if moreModel.contextOverlayScroll != maxScroll {
		t.Fatalf("scroll should remain at %d, got %d", maxScroll, moreModel.contextOverlayScroll)
	}
}

func TestRenderContextOverlayEmptyOutsideMode(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if got := m.renderContextOverlay(120); got != "" {
		t.Fatalf("renderContextOverlay in composing mode should be empty, got %q", got)
	}
}

func TestRenderContextOverlayShowsHeaderInMode(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	updated, _ := m.Update(contextAnalysisMsg{raw: fullContextPayload()})
	updatedModel := updated.(model)
	// Force a small height so the overlay has a finite window.
	updatedModel.height = 30
	rendered := updatedModel.renderContextOverlay(120)
	if rendered == "" {
		t.Fatalf("renderContextOverlay in modeContextOverlay should be non-empty")
	}
	for _, want := range []string{"Context", "BABEL Context", "· coding-runtime", "Current context by source", "scroll"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered context overlay missing %q\nfull:\n%s", want, rendered)
		}
	}
}

func TestContextAnalysisMsgOpensPanelWithoutTranscriptSummary(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	before := len(m.transcript)
	updated, _ := m.Update(contextAnalysisMsg{raw: fullContextPayload()})
	after := updated.(model)
	if after.inputMode != modeContextOverlay {
		t.Fatalf("context analysis should open overlay, got %q", after.inputMode)
	}
	rendered := renderTranscript(after.transcript[before:], 200)
	if strings.Contains(rendered, "context_analysis") || strings.Contains(rendered, "context 1234/8192") {
		t.Fatalf("context analysis should not append transcript summary, got %q", rendered)
	}
}

func TestContextOverlayFitsAboveComposerAtSmallHeight(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 22
	m.resize()

	updated, _ := m.Update(contextAnalysisMsg{raw: fullContextPayload()})
	after := updated.(model)
	after.width = 120
	after.height = 22
	after.resize()

	view := viewContent(after.View())
	plain := stripANSICodes(view)
	if got := lipgloss.Height(view); got != after.height {
		t.Fatalf("context overlay view height = %d, want terminal height %d:\n%s", got, after.height, plain)
	}
	contextIdx := strings.Index(plain, "Context")
	if contextIdx < 0 {
		t.Fatalf("context overlay should be visible:\n%s", plain)
	}
	if strings.Contains(plain, "> Ask BabeL-O") {
		t.Fatalf("context overlay should not reserve the input box:\n%s", plain)
	}
	if !strings.Contains(plain, "up/down/tab scroll  esc/enter/q close") {
		t.Fatalf("context overlay footer hint should remain visible:\n%s", plain)
	}
	if strings.Contains(plain, "/ or ctrl+p commands") {
		t.Fatalf("context overlay should not reserve the footer:\n%s", plain)
	}
}

func TestContextOverlayWithExistingTranscriptDoesNotClipComposer(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 26
	m.appendLine("status", "analyzing shared Nexus context: session_1234567890abcdef")
	m.appendLine("status", "context_analysis model=minimax/MiniMax-M3\n  context 42510/179616 tokens; 137106 remaining\n  status: warning")
	m.resize()

	updated, _ := m.Update(contextAnalysisMsg{raw: fullContextPayload()})
	after := updated.(model)
	after.width = 120
	after.height = 26
	after.resize()

	view := viewContent(after.View())
	plain := stripANSICodes(view)
	if got := lipgloss.Height(view); got != after.height {
		t.Fatalf("context overlay with transcript height = %d, want terminal height %d:\n%s", got, after.height, plain)
	}
	if after.viewport.Height() < 0 {
		t.Fatalf("context overlay viewport height should not be negative, got %d", after.viewport.Height())
	}
	for _, want := range []string{"Context", "up/down/tab scroll  esc/enter/q close"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("context overlay view missing %q:\n%s", want, plain)
		}
	}
	if strings.Contains(plain, "> Ask BabeL-O") || strings.Contains(plain, "/ or ctrl+p commands") {
		t.Fatalf("context overlay should cover the input/footer area:\n%s", plain)
	}
	if strings.Contains(plain, "context_analysis model=minimax") {
		t.Fatalf("context overlay should hide the main transcript while open:\n%s", plain)
	}
}

func TestContextOverlayCloseRestoresComposerViewportHeight(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()
	initialHeight := m.viewport.Height()
	if initialHeight <= 0 {
		t.Fatalf("test setup expected positive viewport height, got %d", initialHeight)
	}

	updated, _ := m.Update(contextAnalysisMsg{raw: fullContextPayload()})
	overlay := updated.(model)
	if overlay.inputMode != modeContextOverlay {
		t.Fatalf("context analysis should open overlay, got %q", overlay.inputMode)
	}
	if got := overlay.viewport.Height(); got != 0 {
		t.Fatalf("context overlay should collapse transcript viewport, got %d", got)
	}

	closed, _ := overlay.Update(keyPress(tea.KeyEsc))
	after := closed.(model)
	if after.inputMode != modeComposing {
		t.Fatalf("context overlay esc should return to composing, got %q", after.inputMode)
	}
	if got := after.viewport.Height(); got <= 0 {
		t.Fatalf("composer viewport height was not restored after context close, got %d", got)
	}
	view := stripANSICodes(viewContent(after.View()))
	if !strings.Contains(view, "> Ask BabeL-O") {
		t.Fatalf("composer input should be visible after context close:\n%s", view)
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
		0:       "0",
		12:      "12",
		999:     "999",
		1234:    "1.2k",
		9999:    "10.0k",
		12345:   "12k",
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
	// Index 0 is the column header row; the first message's
	// header row sits at index 1. The first message (handoff)
	// is selected → its header row must carry the `›` marker.
	if !strings.Contains(lines[1], "›") {
		t.Fatalf("selected marker missing from first message row:\n%s", lines[1])
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if got := m.renderInboxOverlay(120); got != "" {
		t.Fatalf("renderInboxOverlay outside modeInboxOverlay should be empty, got %q", got)
	}
}

func TestRenderInboxOverlayShowsHeaderInMode(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	m.inboxMessages = envelope.Messages
	m.inputMode = modeInboxOverlay
	m.height = 30
	rendered := m.renderInboxOverlay(120)
	if rendered == "" {
		t.Fatalf("renderInboxOverlay in modeInboxOverlay should be non-empty")
	}
	for _, want := range []string{"Inbox", "sess_inbox_smoke_abc123", "move", "ack", "close"} {
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	m.inboxMessages = envelope.Messages
	m.inboxOverlayIncludeAck = true
	m.inputMode = modeInboxOverlay
	m.height = 30
	rendered := m.renderInboxOverlay(120)
	if !strings.Contains(rendered, "Inbox · all") {
		t.Fatalf("includeAck should switch the banner, got %q", rendered)
	}
}

func TestInboxOverlayOpensOnMsgAndClearsOnClose(t *testing.T) {
	envelope := sessionInboxResponse{}
	if err := json.Unmarshal(fullInboxPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	closed, _ := updatedModel.Update(keyPress(tea.KeyEsc))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	m = updated.(model)
	// Up at 0 stays at 0.
	up, _ := m.Update(keyPress(tea.KeyUp))
	m = up.(model)
	if m.inboxOverlaySelected != 0 {
		t.Fatalf("up at 0 should stay at 0, got %d", m.inboxOverlaySelected)
	}
	// Down advances and clamps at len-1.
	cur := m
	for i := 0; i < 10; i++ {
		next, _ := cur.Update(keyPress(tea.KeyDown))
		cur = next.(model)
	}
	if cur.inboxOverlaySelected != len(cur.inboxMessages)-1 {
		t.Fatalf("down should clamp at %d, got %d", len(cur.inboxMessages)-1, cur.inboxOverlaySelected)
	}
	// One more down stays clamped.
	more, _ := cur.Update(keyPress(tea.KeyDown))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	m = updated.(model)
	// esc / enter still close the overlay.
	for _, keyType := range []rune{tea.KeyEsc, tea.KeyEnter} {
		m.inputMode = modeInboxOverlay
		closed, _ := m.Update(keyPress(keyType))
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
	closed, _ := m.Update(textKey("q"))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	m = updated.(model)
	m.input.SetValue("untouched")
	// Press 'z' (a non-overlay key). The textinput must not change.
	updated, _ = m.Update(textKey("z"))
	um := updated.(model)
	if um.input.Value() != "untouched" {
		t.Fatalf("stray key reached textinput, got %q", um.input.Value())
	}
	if um.inputMode != modeInboxOverlay {
		t.Fatalf("stray key should leave mode unchanged, got %q", um.inputMode)
	}
}

func TestInboxMsgErrorAppendsFriendlyLine(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	cmd := m.handleLocalCommand("/inbox all")
	if cmd != nil {
		t.Fatalf("expected nil cmd when no session, got %T", cmd)
	}
}

func TestInboxSlashCommandAckMissingArgShortCircuits(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
		MessageID:     "msg_mc_1",
		ChannelID:     "chan_direct_1",
		Type:          messageTypeMemoryCandidate,
		Priority:      priorityNormal,
		FromSessionID: "sess_peer_1",
		ToSessionID:   "sess_self",
		Content:       "blocked auto-write",
		Metadata: map[string]any{
			"memoryCandidateGovernance": map[string]any{
				"decision":  "rejected",
				"scope":     "long_term",
				"approval":  map[string]any{"status": "rejected", "requiredBy": "user"},
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: server.URL, Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: server.URL, Cwd: "/workspace"})
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
				"decision":  "rejected",
				"scope":     "long_term",
				"approval":  map[string]any{"status": "rejected", "requiredBy": "user"},
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	m = updated.(model)
	// 'q' quotes the first (selected) message into the textinput.
	updated, _ = m.Update(textKey("q"))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	m = updated.(model)
	updated, _ = m.Update(textKey("c"))
	um := updated.(model)
	if !strings.Contains(um.input.Value(), "message=msg_handoff_1") {
		t.Fatalf("'c' should prefill just like 'q', got %q", um.input.Value())
	}
}

func TestInboxOverlayQuoteKeyEmptyListIsNoop(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_xyz"
	m.input.SetValue("preserved")
	m.inputMode = modeInboxOverlay
	m.inboxMessages = nil
	updated, _ := m.Update(textKey("q"))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_inbox_smoke_abc123"
	// Compose a turn so we're not in modeInboxOverlay.
	updated, _ := m.Update(inboxMsg{raw: fullInboxPayload(), envelope: envelope, sessionID: "sess_inbox_smoke_abc123", trigger: "user"})
	um := updated.(model)
	// Close the overlay first.
	closed, _ := um.Update(keyPress(tea.KeyEsc))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if got := m.renderAgentOverlay(120); got != "" {
		t.Fatalf("renderAgentOverlay outside modeAgentOverlay should be empty, got %q", got)
	}
}

func TestRenderAgentOverlayShowsHeaderInMode(t *testing.T) {
	envelope := sessionAgentJobsResponse{}
	if err := json.Unmarshal(fullAgentJobsPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_agents_smoke_xyz"
	m.agentJobs = envelope.Jobs
	m.inputMode = modeAgentOverlay
	m.height = 30
	rendered := m.renderAgentOverlay(120)
	if rendered == "" {
		t.Fatalf("renderAgentOverlay in modeAgentOverlay should be non-empty")
	}
	for _, want := range []string{
		"Agents",
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	closed, _ := um.Update(keyPress(tea.KeyEsc))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_agents_smoke_xyz"
	updated, _ := m.Update(agentJobsMsg{raw: fullAgentJobsPayload(), envelope: envelope, sessionID: "sess_agents_smoke_xyz", trigger: "user"})
	um := updated.(model)
	// esc/enter close.
	for _, keyType := range []rune{tea.KeyEsc, tea.KeyEnter} {
		um.inputMode = modeAgentOverlay
		closed, _ := um.Update(keyPress(keyType))
		cm := closed.(model)
		if cm.inputMode != modeComposing {
			t.Fatalf("key %v should close the overlay, got %q", keyType, cm.inputMode)
		}
	}
	// 'q' rune also closes (no quote path for agents).
	um.inputMode = modeAgentOverlay
	closed, _ := um.Update(textKey("q"))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_agents_smoke_xyz"
	updated, _ := m.Update(agentJobsMsg{raw: fullAgentJobsPayload(), envelope: envelope, sessionID: "sess_agents_smoke_xyz", trigger: "user"})
	um := updated.(model)
	// Up at 0 stays at 0.
	up, _ := um.Update(keyPress(tea.KeyUp))
	u := up.(model)
	if u.agentOverlayScroll != 0 {
		t.Fatalf("up at 0 should stay at 0, got %d", u.agentOverlayScroll)
	}
	// Down should advance and clamp at len-1.
	cur := u
	for i := 0; i < 200; i++ {
		next, _ := cur.Update(keyPress(tea.KeyDown))
		cur = next.(model)
	}
	allLines := buildAgentOverlayLines(cur.agentJobs)
	maxScroll := len(allLines) - 1
	if cur.agentOverlayScroll != maxScroll {
		t.Fatalf("scroll should clamp at %d, got %d", maxScroll, cur.agentOverlayScroll)
	}
	// One more down should stay clamped.
	more, _ := cur.Update(keyPress(tea.KeyDown))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_agents_smoke_xyz"
	updated, _ := m.Update(agentJobsMsg{raw: fullAgentJobsPayload(), envelope: envelope, sessionID: "sess_agents_smoke_xyz", trigger: "user"})
	m = updated.(model)
	m.input.SetValue("untouched")
	// Press 'z' (a non-overlay key). The textinput must not change.
	updated, _ = m.Update(textKey("z"))
	um := updated.(model)
	if um.input.Value() != "untouched" {
		t.Fatalf("stray key reached textinput, got %q", um.input.Value())
	}
	if um.inputMode != modeAgentOverlay {
		t.Fatalf("stray key should leave mode unchanged, got %q", um.inputMode)
	}
}

func TestAgentSlashCommandEmptySessionShortCircuits(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: server.URL, Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_agents_smoke_xyz"
	// Open the overlay once and close it.
	updated, _ := m.Update(agentJobsMsg{raw: fullAgentJobsPayload(), envelope: envelope, sessionID: "sess_agents_smoke_xyz", trigger: "user"})
	um := updated.(model)
	closed, _ := um.Update(keyPress(tea.KeyEsc))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if got := m.renderTaskBoard(120); got != "" {
		t.Fatalf("renderTaskBoard outside modeTaskBoard should be empty, got %q", got)
	}
}

func TestRenderTaskBoardShowsHeaderInMode(t *testing.T) {
	envelope := tasksListResponse{}
	if err := json.Unmarshal(fullTasksListPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_tasks_smoke_xyz"
	m.taskBoard = envelope.Tasks
	m.inputMode = modeTaskBoard
	m.height = 30
	rendered := m.renderTaskBoard(120)
	if rendered == "" {
		t.Fatalf("renderTaskBoard in modeTaskBoard should be non-empty")
	}
	for _, want := range []string{
		"Tasks",
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	closed, _ := um.Update(keyPress(tea.KeyEsc))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_tasks_smoke_xyz"
	updated, _ := m.Update(tasksListMsg{raw: fullTasksListPayload(), envelope: envelope, sessionID: "sess_tasks_smoke_xyz", trigger: "user"})
	um := updated.(model)
	// Up at 0 stays at 0.
	up, _ := um.Update(keyPress(tea.KeyUp))
	u := up.(model)
	if u.taskBoardScroll != 0 {
		t.Fatalf("up at 0 should stay at 0, got %d", u.taskBoardScroll)
	}
	// Down should advance and clamp at len-1.
	cur := u
	for i := 0; i < 200; i++ {
		next, _ := cur.Update(keyPress(tea.KeyDown))
		cur = next.(model)
	}
	allLines := buildTaskBoardLines(cur.taskBoard)
	maxScroll := len(allLines) - 1
	if cur.taskBoardScroll != maxScroll {
		t.Fatalf("scroll should clamp at %d, got %d", maxScroll, cur.taskBoardScroll)
	}
}

func TestTaskSlashCommandEmptySessionShortCircuits(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_tasks_smoke_xyz"
	// Open then close.
	updated, _ := m.Update(tasksListMsg{raw: fullTasksListPayload(), envelope: envelope, sessionID: "sess_tasks_smoke_xyz", trigger: "user"})
	um := updated.(model)
	closed, _ := um.Update(keyPress(tea.KeyEsc))
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
	m := newModel(Config{BaseURL: server.URL, Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	// 1 column header + 3 entries = 4 lines.
	if len(lines) != 4 {
		t.Fatalf("expected 4 lines, got %d", len(lines))
	}
	// Newest first → first event line (lines[1], after the
	// column header at lines[0]) should reference "third".
	if !strings.Contains(lines[1], "third") {
		t.Fatalf("first event line should be newest (third), got %q", lines[1])
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if got := m.renderActivityOverlay(120); got != "" {
		t.Fatalf("renderActivityOverlay outside modeActivityOverlay should be empty, got %q", got)
	}
}

func TestRenderActivityOverlayShowsHeaderInMode(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
		"Activity",
		"tool_started 1", "permission 1",
		"Bash echo hi", "permit approved=true",
		"scroll", "close",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered activity overlay missing %q\nfull:\n%s", want, rendered)
		}
	}
}

func TestBuildMemoryOverlayLinesParsesMemoryStatusPayload(t *testing.T) {
	raw := []byte(`{
		"type": "memory_status",
		"capability": {"available": true, "longTermMemory": true, "autoSearch": "cue-driven", "save": "permission-gated"},
		"everCore": {
			"enabled": true, "healthy": true, "mode": "managed",
			"url": "http://127.0.0.1:45123", "appId": "app-1", "projectId": "proj-1", "agentId": "agent-1",
			"retrieveMethod": "hybrid", "topK": 8,
			"namespace": {"layer": "project", "isolationKey": "dataDir:abc", "projectIdSource": "workspace", "warningCode": ""},
			"sidecar": {"managed": true, "running": true, "healthy": true, "dataDir": "/tmp/abc", "pid": 4242}
		},
		"guidance": {"memoryIsHint": true, "projectFactsRequireWorkspaceEvidence": true, "candidatesAutoWrite": false, "flushRuntimeOwned": true}
	}`)
	lines := buildMemoryOverlayLines(raw)
	want := []string{
		"Status: available",
		"EverCore: enabled=true healthy=true mode=managed",
		"Endpoint: http://127.0.0.1:45123",
		"App: app-1",
		"Project: proj-1",
		"Agent: agent-1",
		"Retrieval: method=hybrid topK=8",
		"layer=project", "isolation=dataDir:abc", "source=workspace",
		"Sidecar:",
		"managed=true", "running=true", "healthy=true",
		"dataDir=/tmp/abc", "pid=4242",
		"Capability: auto-search=cue-driven save=permission-gated",
		"Boundaries:",
		"read-only",
	}
	for _, w := range want {
		if !containsLine(lines, w) {
			t.Fatalf("expected line containing %q in:\n%s", w, strings.Join(lines, "\n"))
		}
	}
}

func TestBuildMemoryOverlayLinesEmptyAndErrorPaths(t *testing.T) {
	if lines := buildMemoryOverlayLines(nil); len(lines) != 1 || !strings.Contains(lines[0], "No memory status payload") {
		t.Fatalf("empty payload should report placeholder, got %v", lines)
	}
	if lines := buildMemoryOverlayLines([]byte("not json {")); len(lines) != 1 || !strings.Contains(lines[0], "Unable to decode memory status") {
		t.Fatalf("invalid json should report decode error, got %v", lines)
	}
	raw := []byte(`{"everCore": {"enabled": false, "healthy": false}, "capability": {"available": false}}`)
	lines := buildMemoryOverlayLines(raw)
	if !containsLine(lines, "Status: disabled") {
		t.Fatalf("disabled capability should yield 'Status: disabled', got:\n%s", strings.Join(lines, "\n"))
	}
}

func TestBuildMemoryOverlayLinesUnhealthyState(t *testing.T) {
	raw := []byte(`{
		"everCore": {"enabled": true, "healthy": false, "mode": "remote", "errorCode": "EVERCORE_UNREACHABLE", "errorMessage": "dial tcp 127.0.0.1:1: connect: connection refused"},
		"capability": {"available": false}
	}`)
	lines := buildMemoryOverlayLines(raw)
	for _, want := range []string{
		"Status: unhealthy",
		"EverCore: enabled=true healthy=false mode=remote",
		"Error: EVERCORE_UNREACHABLE",
		"dial tcp",
	} {
		if !containsLine(lines, want) {
			t.Fatalf("expected line containing %q in:\n%s", want, strings.Join(lines, "\n"))
		}
	}
}

func TestBuildMemoryOverlayLinesParsesSearchResult(t *testing.T) {
	raw := []byte(`{
		"type": "memory_search_result",
		"query": "remember preference",
		"provider": "evercore",
		"hitCount": 1,
		"totalExtractedHits": 2,
		"injectedChars": 48,
		"budgetChars": 100,
		"maxHitChars": 80,
		"truncated": true,
		"searchLatencyMs": 12,
		"method": "keyword",
		"topK": 1,
		"content": "- User prefers regression-first fixes."
	}`)
	lines := buildMemoryOverlayLines(raw)
	for _, want := range []string{
		"memory search",
		"Query: remember preference",
		"hits=1 extracted=2 truncated=true method=keyword topK=1",
		"latencyMs=12",
		"memory hints are not workspace facts",
		"User prefers regression-first fixes",
	} {
		if !containsLine(lines, want) {
			t.Fatalf("expected line containing %q in:\n%s", want, strings.Join(lines, "\n"))
		}
	}
}

func TestBuildMemoryOverlayLinesParsesCandidatesResult(t *testing.T) {
	raw := []byte(`{
		"type": "memory_candidates",
		"limit": 20,
		"includeRejected": true,
		"candidates": [{
			"messageId": "msg_1",
			"content": "User prefers focused regression tests before broad hygiene.",
			"evidence": [{"type": "session_event", "ref": "evt_1"}],
			"governance": {
				"scope": "user",
				"decision": "requires_approval",
				"autoWrite": false,
				"approval": {"status": "required", "requiredBy": "user"},
				"blockedReasons": [],
				"reviewReasons": ["memory_candidates_are_not_persisted_automatically"]
			}
		}]
	}`)
	lines := buildMemoryOverlayLines(raw)
	for _, want := range []string{
		"memory candidates",
		"count=1 limit=20 includeRejected=true",
		"autoWrite=false; save requires explicit approval",
		"msg_1 scope=user decision=requires_approval approval=required:user autoWrite=false evidence=1",
		"focused regression tests",
		"review=memory_candidates_are_not_persisted_automatically",
	} {
		if !containsLine(lines, want) {
			t.Fatalf("expected line containing %q in:\n%s", want, strings.Join(lines, "\n"))
		}
	}
}

func TestBuildMemoryOverlayLinesParsesApprovalRequiredResult(t *testing.T) {
	raw := []byte(`{"type":"memory_action_approval_required","action":"save-note","risk":"write_lifecycle","requiredConfirmation":"save-note","guidance":"Memory save is write-risk."}`)
	lines := buildMemoryOverlayLines(raw)
	for _, want := range []string{"approval required", "Action: save-note", "Risk: write_lifecycle", "No memory write/lifecycle operation was executed"} {
		if !containsLine(lines, want) {
			t.Fatalf("expected line containing %q in:\n%s", want, strings.Join(lines, "\n"))
		}
	}
}

func TestRenderMemoryOverlayLinesClampsScroll(t *testing.T) {
	lines := []string{"line-0", "line-1", "line-2", "line-3", "line-4", "line-5"}
	rendered := renderMemoryOverlayLines(lines, 0, 20)
	if len(rendered) != 6 {
		t.Fatalf("expected all 6 lines when height is large, got %d", len(rendered))
	}
	rendered = renderMemoryOverlayLines(lines, 10, 4)
	if len(rendered) == 0 {
		t.Fatalf("renderMemoryOverlayLines should clamp overflow, got empty")
	}
	rendered = renderMemoryOverlayLines([]string{}, 0, 0)
	if len(rendered) != 1 || !strings.Contains(rendered[0], "No memory status loaded") {
		t.Fatalf("empty lines should yield placeholder, got %v", rendered)
	}
}

func TestRenderMemoryOverlayEmptyOutsideMode(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if got := m.renderMemoryOverlay(120); got != "" {
		t.Fatalf("renderMemoryOverlay outside modeMemoryOverlay should be empty, got %q", got)
	}
}

func TestRenderMemoryOverlayShowsHeaderInMode(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.inputMode = modeMemoryOverlay
	m.height = 30
	m.memoryOverlayLines = buildMemoryOverlayLines([]byte(`{
		"capability": {"available": true, "autoSearch": "cue-driven", "save": "permission-gated"},
		"everCore": {"enabled": true, "healthy": true, "mode": "managed", "appId": "app-1"},
		"guidance": {"memoryIsHint": true, "projectFactsRequireWorkspaceEvidence": true, "candidatesAutoWrite": false}
	}`))
	rendered := m.renderMemoryOverlay(120)
	if rendered == "" {
		t.Fatalf("renderMemoryOverlay in modeMemoryOverlay should be non-empty")
	}
	for _, want := range []string{
		"Memory",
		"Status: available",
		"App: app-1",
		"auto-search=cue-driven",
		"Boundaries:",
		"read-only",
		"scroll", "close",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered memory overlay missing %q\nfull:\n%s", want, rendered)
		}
	}
}

func TestUsesFullScreenOverlayIncludesMemoryOverlay(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.inputMode = modeMemoryOverlay
	if !m.usesFullScreenOverlay() {
		t.Fatalf("usesFullScreenOverlay should return true for modeMemoryOverlay")
	}
}

func containsLine(lines []string, want string) bool {
	for _, line := range lines {
		if strings.Contains(line, want) {
			return true
		}
	}
	return false
}

func TestConsumeNexusEventRecordsActivityForToolEvents(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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

func TestPermissionResponseRecordsActivityWithoutTranscriptNoise(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	beforeTranscript := len(m.transcript)

	_ = m.consumeNexusEvent(map[string]any{
		"type":      "permission_response",
		"approved":  true,
		"reason":    "Approved from trusted Go TUI session",
		"timestamp": "2026-06-10T10:00:01Z",
	})

	if got := len(m.transcript); got != beforeTranscript {
		t.Fatalf("permission_response should not append transcript rows, got %d new rows", got-beforeTranscript)
	}
	if got := len(m.activityEvents); got != 1 {
		t.Fatalf("permission_response should still record one activity event, got %d", got)
	}
	if got := m.activityEvents[0].Kind; got != activityKindPermission {
		t.Fatalf("permission_response activity kind = %s, want %s", got, activityKindPermission)
	}
}

func TestConsumeNexusEventSkipsActivityForIrrelevantEvents(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.sessionID = "sess_activity_2"
	// tool_denied, usage, hook_* are intentionally NOT recorded.
	for _, eventType := range []string{"tool_denied", "usage", "hook_started", "hook_completed", "hook_failed"} {
		_ = m.consumeNexusEvent(map[string]any{"type": eventType})
	}
	if got := len(m.activityEvents); got != 0 {
		t.Fatalf("only tool_started / tool_completed / permission_response / context_warning / context_blocking / agent_job_event should record; got %d entries", got)
	}
}

func TestFormatNexusEventRendersRecoverableToolDenial(t *testing.T) {
	out := formatNexusEvent(map[string]any{
		"type":        "tool_denied",
		"name":        "Bash",
		"risk":        "execute",
		"message":     "Tool denied by Nexus policy: Bash",
		"recoverable": true,
	})
	if !strings.Contains(out, "blocked recoverable") {
		t.Fatalf("expected recoverable denial wording, got %q", out)
	}
	if !strings.Contains(out, "Tool denied by Nexus policy: Bash") {
		t.Fatalf("expected message field to be rendered, got %q", out)
	}
}

func TestActivityOverlayOpensAndCloses(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	// /activity should open the overlay even with an empty buffer.
	cmd := m.handleLocalCommand("/activity")
	if cmd != nil {
		t.Fatalf("expected nil cmd (no HTTP round-trip), got %T", cmd)
	}
	if m.inputMode != modeActivityOverlay {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeActivityOverlay)
	}
	// Esc closes.
	updated, _ := m.Update(keyPress(tea.KeyEsc))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
		"payload":   map[string]any{"agentId": "agent_sub_1"},
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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

func TestHeaderShowsStyledTopBarAndContextToggle(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/Users/tangyaoyue/DEV/BABEL/BabeL-O"})
	m.sessionID = "session_compact_abcdef108000"
	m.width = 120
	m.height = 30
	m.contextWindow = 128000
	m.lastUsage = &usageSnapshot{InputTokens: 11900}
	m.subAgents["agent_sub_1"] = subAgentEntry{ID: "agent_sub_1", Status: subAgentStatusRunning, Title: "investigate"}
	m.subAgents["agent_sub_2"] = subAgentEntry{ID: "agent_sub_2", Status: subAgentStatusRunning, Title: "investigate 2"}
	rendered := m.renderHeader(m.width)
	for _, want := range []string{
		"BabeL-O · Go TUI",
		"idle",
		"context 9%",
		"ctrl+d open",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("header should include %q, got:\n%s", want, rendered)
		}
	}
	for _, banned := range []string{"v" + Version, "~/DEV/BABEL/BabeL-O", "/Users/tangyaoyue", "bbl-go-tui", "session=", "url=", "model=", "profile=", "sub: "} {
		if strings.Contains(rendered, banned) {
			t.Fatalf("header should not include verbose legacy field %q, got:\n%s", banned, rendered)
		}
	}
	lines := strings.Split(stripANSICodes(rendered), "\n")
	if len(lines) != 3 {
		t.Fatalf("header should render guard divider plus title row plus divider, got %d line(s):\n%s", len(lines), rendered)
	}
	if strings.Trim(lines[0], "-") != "" || len(lines[0]) != m.width {
		t.Fatalf("header guard divider should span width %d, got %q", m.width, lines[0])
	}
	if !strings.Contains(lines[1], "BabeL-O · Go TUI") {
		t.Fatalf("header title row missing title, got %q", lines[1])
	}
	if !strings.Contains(lines[1], "─── ◆ ───") {
		t.Fatalf("header should render quiet diamond accent, got %q", lines[1])
	}
	if strings.Contains(lines[1], "////") {
		t.Fatalf("header should not render legacy slash accent, got %q", lines[1])
	}
	if strings.Trim(lines[2], "-") != "" || len(lines[2]) != m.width {
		t.Fatalf("header divider should span width %d, got %q", m.width, lines[2])
	}
}

func TestHeaderContextPrefersRuntimeContextSnapshot(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	m.contextWindow = 120000
	m.lastUsage = &usageSnapshot{InputTokens: 60000}
	m.contextUsage = &contextUsageSnapshot{
		PercentUsed:   8,
		TokenEstimate: 13586,
		MaxTokens:     179616,
		PolicySource:  "large_context",
	}

	if got := m.formatContextUsageLabel(); got != "context 8%" {
		t.Fatalf("formatContextUsageLabel() = %q, want runtime snapshot percent", got)
	}
	detail := m.formatContextUsageDetail()
	for _, want := range []string{"context: 13k / 179k used", "8%", "large_context"} {
		if !strings.Contains(detail, want) {
			t.Fatalf("formatContextUsageDetail() missing %q, got %q", want, detail)
		}
	}
}

func TestExecutionMetricsHydratesContextUsage(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	_ = m.consumeNexusEvent(map[string]any{
		"type":                          "execution_metrics",
		"inputTokens":                   13586,
		"outputTokens":                  1604,
		"modelContextWindow":            200000,
		"effectiveContextCeiling":       179616,
		"contextWarningThresholdTokens": 125731,
		"contextCompactThresholdTokens": 161654,
		"contextBlockingLimitTokens":    178616,
		"contextPolicySource":           "large_context",
	})

	if m.contextUsage == nil {
		t.Fatal("execution_metrics should hydrate context usage")
	}
	if m.contextUsage.TokenEstimate != 13586 || m.contextUsage.MaxTokens != 179616 {
		t.Fatalf("context usage = %+v, want token estimate 13586 and max 179616", *m.contextUsage)
	}
	if got := m.formatContextUsageLabel(); got != "context 8%" {
		t.Fatalf("formatContextUsageLabel() = %q, want context 8%%", got)
	}
	if got := formatContextUsageFooter(m.contextUsage); !strings.Contains(got, "ctx 8% 13586/179616") || !strings.Contains(got, "warn=125731 compact=161654") {
		t.Fatalf("formatContextUsageFooter() = %q", got)
	}
}

func TestContextUsagePersistsAfterResult(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	m.contextUsage = &contextUsageSnapshot{PercentUsed: 8, TokenEstimate: 13586, MaxTokens: 179616}
	m.latestUsage = &usageSnapshot{InputTokens: 13586, OutputTokens: 400}
	m.running = true

	_ = m.consumeNexusEvent(map[string]any{"type": "result", "success": true})

	if m.contextUsage == nil {
		t.Fatal("result should keep last runtime context snapshot for the header/top card")
	}
	if m.latestUsage != nil {
		t.Fatalf("result should still clear transient usage snapshot, got %+v", *m.latestUsage)
	}
	if got := m.formatContextUsageLabel(); got != "context 8%" {
		t.Fatalf("formatContextUsageLabel() = %q, want persisted context snapshot", got)
	}
}

func TestOutputOnlyUsageDoesNotOverwriteLastInputContext(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	m.contextWindow = 100000
	_ = m.consumeNexusEvent(map[string]any{"type": "usage", "inputTokens": 42000, "outputTokens": 0, "cacheReadInputTokens": 1200})
	_ = m.consumeNexusEvent(map[string]any{"type": "usage", "inputTokens": 0, "outputTokens": 800})

	if m.lastUsage == nil || m.lastUsage.InputTokens != 42000 {
		t.Fatalf("lastUsage should retain last non-zero input snapshot, got %+v", m.lastUsage)
	}
	if got := m.formatContextUsageLabel(); got != "context 42%" {
		t.Fatalf("formatContextUsageLabel() = %q, want context 42%%", got)
	}
}

func TestWelcomeCardShowsVersionOnTopRight(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/Users/tangyaoyue/DEV/BABEL/BabeL-O"})
	m.width = 120
	rendered := stripANSICodes(m.renderWelcomeCard(120))
	if !strings.Contains(rendered, "v"+Version) {
		t.Fatalf("welcome card should show version, got:\n%s", rendered)
	}
	for _, want := range []string{"Welcome back!", "model", "work", "session", "mode", "chat", "nexus", "config", "models"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("welcome card missing %q, got:\n%s", want, rendered)
		}
	}
	if strings.Contains(rendered, "BABEL-O") {
		t.Fatalf("welcome card should show version in the title slot instead of BABEL-O, got:\n%s", rendered)
	}
	if strings.Contains(rendered, "────") {
		t.Fatalf("welcome card should not render the middle divider, got:\n%s", rendered)
	}
	if strings.Contains(rendered, "user ") {
		t.Fatalf("welcome card should not mix user/session into one noisy row, got:\n%s", rendered)
	}
}

func TestHeaderKeepsDividerInCompactMode(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	m.width = compactModeWidthBreakpoint - 1
	m.height = compactModeHeightBreakpoint - 1

	rendered := m.renderHeader(m.width)
	lines := strings.Split(stripANSICodes(rendered), "\n")
	if len(lines) != 3 {
		t.Fatalf("compact header should keep guard divider plus title row plus divider, got %d line(s):\n%s", len(lines), rendered)
	}
	if strings.Trim(lines[0], "-") != "" || len(lines[0]) != m.width {
		t.Fatalf("compact header guard divider should span width %d, got %q", m.width, lines[0])
	}
	if strings.Trim(lines[2], "-") != "" || len(lines[2]) != m.width {
		t.Fatalf("compact header divider should span width %d, got %q", m.width, lines[2])
	}
}

func TestHeaderTitleIsBelowTopGuardDivider(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:3000", Cwd: "/workspace"})
	m.width = 100
	rendered := stripANSICodes(m.renderHeader(m.width))
	lines := strings.Split(rendered, "\n")
	if len(lines) < 2 {
		t.Fatalf("header should have guard divider and title row, got:\n%s", rendered)
	}
	if strings.Contains(lines[0], "BabeL-O · Go TUI") {
		t.Fatalf("header title must not be on the clipped top row, got first line %q", lines[0])
	}
	if !strings.Contains(lines[1], "BabeL-O · Go TUI") {
		t.Fatalf("header title should be on visible second row, got %q", lines[1])
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
		"agent_zeta":  {ID: "agent_zeta", Status: subAgentStatusRunning, Title: "z"},
		"agent_alpha": {ID: "agent_alpha", Status: subAgentStatusRunning, Title: "a"},
		"agent_mu":    {ID: "agent_mu", Status: subAgentStatusRunning, Title: "m"},
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

func TestTopCardShowsContextAndReservedSections(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/Users/tangyaoyue/DEV/BABEL/BabeL-O"})
	m.width = 132
	m.height = 36
	m.topCardOpen = true
	m.modelID = "openai/gpt-5"
	m.providerID = "openai"
	m.activeProfile = "default"
	m.sessionID = "sess_top_card_abcdef123456"
	m.contextWindow = 128000
	m.lastUsage = &usageSnapshot{InputTokens: 11900, OutputTokens: 400, CacheRead: 2000}
	var envelope toolsAuditResponse
	if err := json.Unmarshal(fullToolAuditPayload(), &envelope); err != nil {
		t.Fatalf("decode fullToolAuditPayload: %v", err)
	}
	m.toolAuditEntries = envelope.Tools
	m.inboxMessages = []sessionMessage{
		{MessageID: "msg_1", Status: messageStatusDelivered},
		{MessageID: "msg_2", Status: messageStatusAcknowledged},
	}
	m.inboxChannels = []sessionChannel{{ChannelID: "ch_1", Status: channelStatusOpen}}

	rendered := stripANSICodes(m.renderTopCard(132))
	for _, want := range []string{
		"context: 11k / 128k used",
		"MCPs",
		"filesystem (1)",
		"Skills",
		"reserved: runtime skills",
		"Session to session",
		"inbox 1 unread / 2 total",
		"Memory",
		"reserved: memory",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("top card missing %q, got:\n%s", want, rendered)
		}
	}
}

func TestViewHeightBudgetAccountsForTopCard(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.topCardOpen = true
	m.contextWindow = 128000
	m.lastUsage = &usageSnapshot{InputTokens: 11900}
	m.resize()

	view := viewContent(m.View())
	if got := lipgloss.Height(view); got != m.height {
		t.Fatalf("view height = %d, want terminal height %d; full view:\n%s", got, m.height, stripANSICodes(view))
	}
	if !strings.Contains(stripANSICodes(view), "BabeL-O · Go TUI") {
		t.Fatalf("view should keep header title visible with top card open; got:\n%s", stripANSICodes(view))
	}
	if strings.Contains(stripANSICodes(view), "Ask BabeL-O") {
		t.Fatalf("top card open should not reserve space for the bottom input box; got:\n%s", stripANSICodes(view))
	}
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	if got := m.renderToolAuditOverlay(120); got != "" {
		t.Fatalf("renderToolAuditOverlay outside modeToolAuditOverlay should be empty, got %q", got)
	}
}

func TestRenderToolAuditOverlayShowsHeaderInMode(t *testing.T) {
	envelope := toolsAuditResponse{}
	if err := json.Unmarshal(fullToolAuditPayload(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.toolAuditEntries = envelope.Tools
	m.inputMode = modeToolAuditOverlay
	m.height = 30
	rendered := m.renderToolAuditOverlay(120)
	if rendered == "" {
		t.Fatalf("renderToolAuditOverlay in modeToolAuditOverlay should be non-empty")
	}
	for _, want := range []string{
		"Tools audit",
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	closed, _ := um.Update(keyPress(tea.KeyEsc))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	updated, _ := m.Update(toolAuditMsg{raw: fullToolAuditPayload(), envelope: envelope, trigger: "user"})
	um := updated.(model)
	for _, keyType := range []rune{tea.KeyEsc, tea.KeyEnter} {
		um.inputMode = modeToolAuditOverlay
		closed, _ := um.Update(keyPress(keyType))
		cm := closed.(model)
		if cm.inputMode != modeComposing {
			t.Fatalf("key %v should close the overlay, got %q", keyType, cm.inputMode)
		}
	}
	um.inputMode = modeToolAuditOverlay
	closed, _ := um.Update(textKey("q"))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	updated, _ := m.Update(toolAuditMsg{raw: fullToolAuditPayload(), envelope: envelope, trigger: "user"})
	um := updated.(model)
	// Up at 0 stays at 0.
	up, _ := um.Update(keyPress(tea.KeyUp))
	u := up.(model)
	if u.toolAuditScroll != 0 {
		t.Fatalf("up at 0 should stay at 0, got %d", u.toolAuditScroll)
	}
	// Down advances and clamps at len-1.
	cur := u
	for i := 0; i < 200; i++ {
		next, _ := cur.Update(keyPress(tea.KeyDown))
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	updated, _ := m.Update(toolAuditMsg{raw: fullToolAuditPayload(), envelope: envelope, trigger: "user"})
	m = updated.(model)
	m.input.SetValue("untouched")
	updated, _ = m.Update(textKey("z"))
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
	m := newModel(Config{BaseURL: server.URL, Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
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
	m := newModel(Config{BaseURL: server.URL, Cwd: "/workspace"})
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
	wantNames := []string{"Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "TaskCreate"}
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

func TestVersionStringFallsBackToDevWhenLDFlagsEmpty(t *testing.T) {
	// Snapshot the package-level version vars so we can
	// restore them after the test (the test is parallel-
	// unsafe; the rest of the suite assumes the "dev"
	// defaults).
	prevVersion, prevCommit, prevBuildDate := Version, Commit, BuildDate
	t.Cleanup(func() {
		Version, Commit, BuildDate = prevVersion, prevCommit, prevBuildDate
	})
	Version, Commit, BuildDate = "dev", "", ""
	if got := versionString(); got != "bbl-go-tui dev" {
		t.Fatalf("dev build should print 'bbl-go-tui dev', got %q", got)
	}
}

func TestVersionStringIncludesCommitAndBuildDateWhenSet(t *testing.T) {
	prevVersion, prevCommit, prevBuildDate := Version, Commit, BuildDate
	t.Cleanup(func() {
		Version, Commit, BuildDate = prevVersion, prevCommit, prevBuildDate
	})
	Version = "1.2.3"
	Commit = "abc1234"
	BuildDate = "2026-06-10T10:00:00Z"
	got := versionString()
	for _, want := range []string{"1.2.3", "abc1234", "2026-06-10T10:00:00Z"} {
		if !strings.Contains(got, want) {
			t.Fatalf("versionString missing %q in %q", want, got)
		}
	}
}

func TestMajorVersionParsesStandardSemver(t *testing.T) {
	prevVersion := Version
	t.Cleanup(func() { Version = prevVersion })
	cases := map[string]int{
		"0.0.0":           0,
		"0.3.2":           0,
		"1.0.0":           1,
		"2.5.7":           2,
		"10.20.30":        10,
		"dev":             0, // dev fallback is treated as major 0
		"":                0, // empty fallback is treated as major 0
		"1.2.3-pre.4+abc": 1,
	}
	for version, want := range cases {
		Version = version
		if got := majorVersion(); got != want {
			t.Fatalf("majorVersion(%q) = %d, want %d", version, got, want)
		}
	}
}

func TestIsGoTuiMajorCompatibleMatchesSupportedMajors(t *testing.T) {
	prevVersion := Version
	t.Cleanup(func() { Version = prevVersion })
	cases := []struct {
		name            string
		localVersion    string
		supportedMajors []int
		want            bool
	}{
		{name: "dev build always passes", localVersion: "dev", supportedMajors: []int{1, 2, 3}, want: true},
		{name: "empty build always passes", localVersion: "", supportedMajors: []int{1, 2, 3}, want: true},
		{name: "empty supported list = no policy = pass", localVersion: "1.2.3", supportedMajors: nil, want: true},
		{name: "matching major passes", localVersion: "1.2.3", supportedMajors: []int{1, 2, 3}, want: true},
		{name: "non-matching major fails", localVersion: "2.5.0", supportedMajors: []int{1, 3}, want: false},
		{name: "major 0 in supported = dev build always passes", localVersion: "0.3.2", supportedMajors: []int{0, 1}, want: true},
	}
	for _, tc := range cases {
		Version = tc.localVersion
		if got := isGoTuiMajorCompatible(tc.supportedMajors); got != tc.want {
			t.Fatalf("%s: isGoTuiMajorCompatible(%v) for Version=%q = %v, want %v",
				tc.name, tc.supportedMajors, tc.localVersion, got, tc.want)
		}
	}
}

func TestCheckRuntimeVersionHTTPCmdSendsCorrectPath(t *testing.T) {
	var seenPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"runtime_version","serverVersion":"0.3.2","schemaVersion":"2026-05-21.babel-o.v1","goTuiCompatibility":{"supportedMajors":[0],"latestSupported":"0.3.2"},"nodeCliCompatibility":{"supportedMajors":[0],"latestSupported":"0.3.2"}}`))
	}))
	defer server.Close()
	m := newModel(Config{BaseURL: server.URL, Cwd: "/workspace"})
	cmd := checkRuntimeVersion(m.cfg)
	msg := cmd()
	rv, ok := msg.(runtimeVersionMsg)
	if !ok {
		t.Fatalf("expected runtimeVersionMsg, got %T", msg)
	}
	if rv.err != nil {
		t.Fatalf("checkRuntimeVersion returned err: %v", rv.err)
	}
	if seenPath != "/v1/runtime/version" {
		t.Fatalf("seenPath = %q", seenPath)
	}
	if rv.envelope.ServerVersion != "0.3.2" {
		t.Fatalf("ServerVersion = %q, want 0.3.2", rv.envelope.ServerVersion)
	}
	if len(rv.envelope.GoTuiCompatibility.SupportedMajors) != 1 || rv.envelope.GoTuiCompatibility.SupportedMajors[0] != 0 {
		t.Fatalf("SupportedMajors = %v, want [0]", rv.envelope.GoTuiCompatibility.SupportedMajors)
	}
}

func TestRuntimeVersionMsgCompatMismatchAppendsErrorLine(t *testing.T) {
	prevVersion := Version
	t.Cleanup(func() { Version = prevVersion })
	Version = "2.5.0"
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	envelope := runtimeVersionResponse{
		Type:          "runtime_version",
		ServerVersion: "3.0.0",
		SchemaVersion: "2026-05-21.babel-o.v1",
		GoTuiCompatibility: runtimeVersionCompat{
			SupportedMajors: []int{1, 3},
			LatestSupported: "3.0.0",
		},
	}
	updated, _ := m.Update(runtimeVersionMsg{raw: []byte(`{}`), envelope: envelope})
	um := updated.(model)
	last := um.transcript[len(um.transcript)-1]
	if last.kind != "error" || !strings.Contains(last.text, "Go TUI major version mismatch") {
		t.Fatalf("expected compat mismatch error line, got %+v", last)
	}
	if !strings.Contains(last.text, "local=2.5.0") {
		t.Fatalf("error should include local version 2.5.0, got %q", last.text)
	}
}

func TestRuntimeVersionMsgCompatMatchIsSilent(t *testing.T) {
	prevVersion := Version
	t.Cleanup(func() { Version = prevVersion })
	Version = "1.2.3"
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	envelope := runtimeVersionResponse{
		Type:          "runtime_version",
		ServerVersion: "1.2.3",
		SchemaVersion: "2026-05-21.babel-o.v1",
		GoTuiCompatibility: runtimeVersionCompat{
			SupportedMajors: []int{0, 1, 2},
			LatestSupported: "1.2.3",
		},
	}
	baseline := len(m.transcript)
	updated, _ := m.Update(runtimeVersionMsg{raw: []byte(`{}`), envelope: envelope})
	um := updated.(model)
	if len(um.transcript) != baseline {
		t.Fatalf("matching compat should be silent, transcript grew from %d to %d", baseline, len(um.transcript))
	}
}

func TestRuntimeVersionMsgErrorIsSilent(t *testing.T) {
	// A failed version check should NOT add an error line —
	// the Nexus may be booting or the binary may be older
	// than the endpoint. The existing runtimeConfigMsg path
	// surfaces the real connectivity error.
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	baseline := len(m.transcript)
	updated, _ := m.Update(runtimeVersionMsg{err: errors.New("connection refused")})
	um := updated.(model)
	if len(um.transcript) != baseline {
		t.Fatalf("version check fetch error should be silent, transcript grew from %d to %d", baseline, len(um.transcript))
	}
}

func TestBuildExecuteRequestEmitsSoftDenyPolicyByDefault(t *testing.T) {
	// Phase B of docs/nexus/reference/go-tui-permission-policy-governance-plan.md:
	// Go TUI defaults to `policy: 'soft-deny'` so write/execute Bash
	// subcommands (git commit, npm install, etc.) reach the approval
	// gate instead of being hard-denied.
	cfg := Config{Cwd: "/workspace"}
	payload := buildExecuteRequest(cfg, "session_abc", "hello")
	if got := payload["policy"]; got != "soft-deny" {
		t.Fatalf("default policy = %v, want 'soft-deny'", got)
	}
}

func TestBuildExecuteRequestHonoursExplicitPolicyMode(t *testing.T) {
	cfg := Config{Cwd: "/workspace", PolicyMode: "strict"}
	payload := buildExecuteRequest(cfg, "session_abc", "hello")
	if got := payload["policy"]; got != "strict" {
		t.Fatalf("explicit policy = %v, want 'strict'", got)
	}
}

func TestBuildExecuteRequestEmitsSoftTimeoutPolicy(t *testing.T) {
	cfg := Config{Cwd: "/workspace", ExecuteTimeoutMs: DefaultGoTuiExecuteTimeoutMs}
	payload := buildExecuteRequest(cfg, "session_abc", "hello")
	if got := payload["timeoutPolicy"]; got != "soft" {
		t.Fatalf("timeoutPolicy = %v, want soft", got)
	}
	if got := anyInt(payload["timeoutMs"]); got != DefaultGoTuiExecuteTimeoutMs {
		t.Fatalf("timeoutMs = %d, want %d", got, DefaultGoTuiExecuteTimeoutMs)
	}
	if got := anyInt(payload["softTimeoutMs"]); got != DefaultGoTuiExecuteTimeoutMs {
		t.Fatalf("softTimeoutMs = %d, want %d", got, DefaultGoTuiExecuteTimeoutMs)
	}
}

func TestResolveGoTuiTimeoutKeepsDefaultForOrdinaryTurn(t *testing.T) {
	decision := resolveGoTuiTimeout(Config{Cwd: "/workspace", ExecuteTimeoutMs: DefaultGoTuiExecuteTimeoutMs}, "hello", nil)
	if decision.TimeoutMs != DefaultGoTuiExecuteTimeoutMs || decision.Adaptive {
		t.Fatalf("ordinary timeout decision = %+v, want default non-adaptive", decision)
	}
}

func TestResolveGoTuiTimeoutRaisesLongContextTo300s(t *testing.T) {
	for name, tc := range map[string]struct {
		prompt string
		usage  *usageSnapshot
	}{
		"prompt-marker": {prompt: "请深度分析这个大上下文 session"},
		"usage-tokens":  {prompt: "continue", usage: &usageSnapshot{InputTokens: 149378}},
	} {
		t.Run(name, func(t *testing.T) {
			decision := resolveGoTuiTimeout(Config{Cwd: "/workspace", ExecuteTimeoutMs: DefaultGoTuiExecuteTimeoutMs}, tc.prompt, tc.usage)
			if decision.TimeoutMs != longContextGoTuiExecuteTimeoutMs || !decision.Adaptive || decision.Reason != "long-context" {
				t.Fatalf("long-context timeout decision = %+v", decision)
			}
		})
	}
}

func TestResolveGoTuiTimeoutHonoursExplicitNonDefaultTimeout(t *testing.T) {
	decision := resolveGoTuiTimeout(Config{Cwd: "/workspace", ExecuteTimeoutMs: 240000}, "请深度分析这个大上下文 session", &usageSnapshot{InputTokens: 149378})
	if decision.TimeoutMs != 240000 || decision.Adaptive {
		t.Fatalf("explicit timeout decision = %+v, want 240000 non-adaptive", decision)
	}
}

func TestBuildExecuteRequestRaisesLongContextTimeout(t *testing.T) {
	cfg := Config{Cwd: "/workspace", ExecuteTimeoutMs: DefaultGoTuiExecuteTimeoutMs}
	decision := resolveGoTuiTimeout(cfg, "long-context analysis", nil)
	payload := buildExecuteRequestWithTimeout(cfg, "session_abc", "long-context analysis", decision)
	if got := anyInt(payload["timeoutMs"]); got != longContextGoTuiExecuteTimeoutMs {
		t.Fatalf("timeoutMs = %d, want %d", got, longContextGoTuiExecuteTimeoutMs)
	}
}

func TestHeaderHidesAdaptiveTimeout(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 100
	m.running = true
	m.startedAt = time.Now()
	m.currentTimeout = timeoutDecision{TimeoutMs: longContextGoTuiExecuteTimeoutMs, Reason: "long-context", Adaptive: true}
	rendered := m.renderHeader(m.width)
	if strings.Contains(rendered, "timeout=") || strings.Contains(rendered, "long-context") {
		t.Fatalf("header should hide adaptive timeout, got:\n%s", rendered)
	}
}

func TestBuildExecuteRequestEmitsPolicyAlongsideTimeoutMs(t *testing.T) {
	// policy and timeoutMs are independent knobs; both should appear in
	// the payload when set.
	cfg := Config{Cwd: "/workspace", ExecuteTimeoutMs: 180000}
	payload := buildExecuteRequest(cfg, "session_abc", "hello")
	if got := anyInt(payload["timeoutMs"]); got != 180000 {
		t.Fatalf("timeoutMs = %d, want 180000", got)
	}
	if got := payload["policy"]; got != "soft-deny" {
		t.Fatalf("policy = %v, want 'soft-deny'", got)
	}
}

// fakeNexusWSPermissionHandler spins up an httptest WebSocket server that
// (1) captures the first inbound frame (Go TUI's request payload) and
// (2) replies with a scripted sequence of Nexus events. Used by the
// soft-deny end-to-end test below.
func fakeNexusWSPermissionHandler(t *testing.T, events []map[string]any) (*httptest.Server, func() *map[string]any) {
	t.Helper()
	upgrader := websocket.Upgrader{}
	captured := &map[string]any{}
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Phase 1 of go-tui-session-observability-governance-plan.md:
		// Go TUI now first calls `POST /v1/sessions` to allocate a
		// server-side `session_<uuid>`. The fake server returns a
		// stable fake id without going through real SQLite.
		if r.Method == http.MethodPost && r.URL.Path == "/v1/sessions" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{
				"type": "session_created",
				"sessionId": "session_test_allocated",
				"createdAt": "2026-06-11T02:52:39.000Z"
			}`))
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(data, &payload); err == nil {
			mu.Lock()
			*captured = payload
			mu.Unlock()
		}
		for _, ev := range events {
			if err := conn.WriteJSON(ev); err != nil {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		time.Sleep(20 * time.Millisecond)
	}))
	return srv, func() *map[string]any { return captured }
}

func TestRunStreamEmitsSoftDenyPolicyAndHandlesPermissionRequest(t *testing.T) {
	// End-to-end smoke for Phase B of
	// docs/nexus/reference/go-tui-permission-policy-governance-plan.md:
	// Go TUI sends `policy: 'soft-deny'` on the wire; the fake Nexus
	// backend emits a `permission_request`; runStream forwards it to
	// the consumer channel (where the Go TUI permission panel would
	// pop up and ask the user to approve / deny).
	events := []map[string]any{
		{
			"type":      "session_started",
			"sessionId": "session_soft_deny",
			"model":     "mock-model",
		},
		{
			"type":          "tool_started",
			"toolUseId":     "tool_1",
			"name":          "Bash",
			"input":         map[string]any{"command": "git commit -m x"},
			"effectiveRisk": "execute",
		},
		{
			"type":      "permission_request",
			"toolUseId": "tool_1",
			"name":      "Bash",
			"input":     map[string]any{"command": "git commit -m x"},
			"risk":      "execute",
			"message":   "Tool Bash requires user permission to run.",
		},
	}
	srv, getCaptured := fakeNexusWSPermissionHandler(t, events)
	defer srv.Close()

	eventCh := make(chan streamEvent, 8)
	decisions := make(chan permissionDecision)
	cfg := Config{BaseURL: srv.URL}

	doneCh := make(chan struct{})
	go func() {
		runStream(cfg, "session_test_allocated", "git commit", resolveGoTuiTimeout(cfg, "git commit", nil), eventCh, decisions, make(chan struct{}))
		close(doneCh)
	}()

	// 1. Poll the captured payload until the runStream goroutine has
	// finished writing the request frame. The capture pointer is
	// pre-allocated as an empty map, so we need to check for the
	// presence of a known field rather than nil.
	var captured map[string]any
	deadline := time.After(2 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for Go TUI to send request frame")
		default:
		}
		captured = *getCaptured()
		if _, hasPrompt := captured["prompt"]; hasPrompt {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := captured["policy"]; got != "soft-deny" {
		t.Fatalf("captured policy = %v, want 'soft-deny'; full payload = %+v", got, captured)
	}

	// 2. Drain events until we see the permission_request.
	var permEvent map[string]any
	eventDeadline := time.After(2 * time.Second)
	for permEvent == nil {
		select {
		case ev := <-eventCh:
			if ev.err != nil {
				t.Fatalf("stream err: %v", ev.err)
			}
			if stringField(ev.payload, "type") == "permission_request" {
				permEvent = ev.payload
			}
		case <-eventDeadline:
			t.Fatalf("timed out waiting for permission_request")
		}
	}
	if got := stringField(permEvent, "name"); got != "Bash" {
		t.Fatalf("permission_request.name = %q, want Bash", got)
	}
	<-doneCh
}

func TestBuildExecuteRequestEmitsAllowedToolsWhenConfigured(t *testing.T) {
	// Phase D of docs/nexus/reference/go-tui-permission-policy-governance-plan.md.
	cfg := Config{Cwd: "/workspace", AllowTools: []string{"Bash", "Edit"}}
	payload := buildExecuteRequest(cfg, "session_abc", "hello")
	raw, ok := payload["allowedTools"]
	if !ok {
		t.Fatalf("allowedTools should be present in payload, got keys %v", mapKeys(payload))
	}
	arr, ok := raw.([]any)
	if !ok {
		t.Fatalf("allowedTools should be a []any, got %T", raw)
	}
	got := make([]string, 0, len(arr))
	for _, item := range arr {
		s, ok := item.(string)
		if !ok {
			t.Fatalf("allowedTools items should be strings, got %T", item)
		}
		got = append(got, s)
	}
	want := []string{"Bash", "Edit"}
	if len(got) != len(want) {
		t.Fatalf("allowedTools = %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("allowedTools[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestBuildExecuteRequestOmitsAllowedToolsWhenUnset(t *testing.T) {
	// No AllowTools on Config → the per-turn override is off; the
	// server-startup policy applies. The payload must not carry a
	// null / empty `allowedTools` array.
	cfg := Config{Cwd: "/workspace"}
	payload := buildExecuteRequest(cfg, "session_abc", "hello")
	if raw, ok := payload["allowedTools"]; ok {
		t.Fatalf("allowedTools should be omitted when Config.AllowTools is empty, got %v", raw)
	}
}

func TestBuildExecuteRequestStripsWhitespaceAndEmptyFromAllowedTools(t *testing.T) {
	// The CLI flag passes comma-separated values that may include
	// stray spaces and trailing commas; buildExecuteRequest should
	// trim / drop empty entries so the Nexus schema receives a
	// clean array.
	cfg := Config{Cwd: "/workspace", AllowTools: []string{" Bash ", ",Edit,", "  ", "Glob"}}
	payload := buildExecuteRequest(cfg, "session_abc", "hello")
	raw := payload["allowedTools"].([]any)
	got := make([]string, 0, len(raw))
	for _, item := range raw {
		got = append(got, item.(string))
	}
	want := []string{"Bash", "Edit", "Glob"}
	if len(got) != len(want) {
		t.Fatalf("allowedTools = %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("allowedTools[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestBuildExecuteRequestAllowlistWildcardPassesThrough(t *testing.T) {
	// "*" / "all" are passed verbatim to Nexus, where they map to
	// allowAllTools via buildPerRequestAllowedToolsPolicy. The
	// Go TUI side does NOT pre-translate them — that translation
	// happens in the runtime's policy builder.
	cfg := Config{Cwd: "/workspace", AllowTools: []string{"*"}}
	payload := buildExecuteRequest(cfg, "session_abc", "hello")
	raw := payload["allowedTools"].([]any)
	if len(raw) != 1 || raw[0] != "*" {
		t.Fatalf("wildcard allowlist should pass through verbatim, got %v", raw)
	}
}

// mapKeys is a tiny helper used by the buildExecuteRequest tests
// to surface a useful diagnostic when a payload key is missing.
func mapKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// === Phase C end-to-end permission flow tests ===
//
// Phase C of
// docs/nexus/reference/go-tui-permission-policy-governance-plan.md.
// These tests cover the two terminal paths of the permission flow:
// (1) `permission_request` → user approves → tool runs to completion
// → `result` → model back in `modeComposing`;
// (2) `permission_request` → user denies → `tool dened` → `result`
// → model back in `modeComposing`.
//
// They also pin the bug fix in `consumeNexusEvent`: the `result`
// case now explicitly calls `m.setMode(modeComposing)` so the
// model exits `modePermission` cleanly after every turn that
// involved a permission gate.

func TestModelEntersPermissionModeOnPermissionRequest(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})

	if m.inputMode != modeComposing {
		t.Fatalf("model should start in modeComposing, got %s", m.inputMode)
	}

	// `Update` is a value receiver, so the returned model carries
	// the post-event state; capture it for the assertions below.
	updated, _ := m.Update(streamEventMsg{event: streamEvent{payload: map[string]any{
		"type":      "permission_request",
		"toolUseId": "tool_phase_c_1",
		"sessionId": "session_phase_c",
		"name":      "Bash",
		"risk":      "execute",
		"input":     map[string]any{"command": "git commit -m x"},
		"message":   "Tool Bash requires user permission to run.",
	}}})
	m = updated.(model)

	if m.pending == nil {
		t.Fatalf("pending permission should be recorded after permission_request")
	}
	if m.inputMode != modePermission {
		t.Fatalf("mode should be modePermission after permission_request, got %s", m.inputMode)
	}
	if got := len(m.transcript); got == 0 {
		t.Fatalf("permission_request should append at least one transcript row")
	}
	last := m.transcript[len(m.transcript)-1].text
	if !strings.Contains(last, "Bash") {
		t.Fatalf("transcript row should mention the tool name Bash, got %q", last)
	}
	if !strings.Contains(last, "execute") {
		t.Fatalf("transcript row should mention the risk 'execute', got %q", last)
	}
}

func TestModelExitsPermissionModeOnResultAfterApproval(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.running = true

	updated, _ := m.Update(streamEventMsg{event: streamEvent{payload: map[string]any{
		"type":      "permission_request",
		"toolUseId": "tool_phase_c_2",
		"sessionId": "session_phase_c",
		"name":      "Bash",
		"risk":      "execute",
		"input":     map[string]any{"command": "git commit -m x"},
	}}})
	m = updated.(model)
	if m.inputMode != modePermission {
		t.Fatalf("setup: mode should be modePermission, got %s", m.inputMode)
	}

	updated, _ = m.Update(streamEventMsg{event: streamEvent{payload: map[string]any{
		"type":    "tool_completed",
		"name":    "Bash",
		"success": true,
		"output":  map[string]any{"stdout": "[main abc1234] x\n", "stderr": ""},
	}}})
	updated, _ = m.Update(streamEventMsg{event: streamEvent{payload: map[string]any{
		"type":    "result",
		"success": true,
		"message": "done",
	}}})
	m = updated.(model)

	if m.inputMode != modeComposing {
		t.Fatalf("after result, mode should be modeComposing, got %s", m.inputMode)
	}
	if m.running {
		t.Fatalf("after result, running should be false")
	}
	if m.pending != nil {
		t.Fatalf("after result, pending should be nil")
	}
}

func TestModelExitsPermissionModeOnResultAfterDenial(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.running = true

	updated, _ := m.Update(streamEventMsg{event: streamEvent{payload: map[string]any{
		"type":      "permission_request",
		"toolUseId": "tool_phase_c_3",
		"sessionId": "session_phase_c",
		"name":      "Bash",
		"risk":      "execute",
		"input":     map[string]any{"command": "git commit -m x"},
	}}})
	m = updated.(model)
	if m.inputMode != modePermission {
		t.Fatalf("setup: mode should be modePermission, got %s", m.inputMode)
	}

	updated, _ = m.Update(streamEventMsg{event: streamEvent{payload: map[string]any{
		"type":   "tool_denied",
		"name":   "Bash",
		"risk":   "execute",
		"reason": "Tool execution denied by user: Bash",
	}}})
	updated, _ = m.Update(streamEventMsg{event: streamEvent{payload: map[string]any{
		"type":    "result",
		"success": false,
		"message": "Tool execution denied by user: Bash",
	}}})
	m = updated.(model)

	if m.inputMode != modeComposing {
		t.Fatalf("after denial result, mode should be modeComposing, got %s", m.inputMode)
	}
	if m.running {
		t.Fatalf("after denial result, running should be false")
	}
	if m.pending != nil {
		t.Fatalf("after denial result, pending should be nil")
	}
}

// fillScrollableViewport primes the model so the transcript viewport
// has enough content to scroll. The bubble viewport's YOffset is what
// every scroll test asserts against, and without enough lines the
// viewport's maxYOffset is 0 and LineUp / LineDown are no-ops.
func fillScrollableViewport(m *model) {
	m.width = 80
	m.height = 24
	// Force a resize so the viewport picks up the new height and
	// width before we inject content. refreshViewport() also
	// auto-goto-bottoms when wasAtBottom=true, which is the
	// default; SetYOffset below then drops us to a known
	// starting position for the assertion.
	m.resize()
	var b strings.Builder
	for i := 0; i < 200; i++ {
		fmt.Fprintf(&b, "transcript line %d\n", i)
	}
	m.viewport.SetContent(b.String())
	m.viewport.SetYOffset(100)
}

// TestMouseWheelScrollsViewportInComposingMode verifies the
// fix for the up/down vs mouse-wheel overlap: the wheel must
// scroll the transcript viewport by exactly one line per tick
// in composing mode (where the keyboard ↑/↓ binding is still
// reserved for prompt history).
func TestMouseWheelScrollsViewportInComposingMode(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	fillScrollableViewport(&m)
	startingYOffset := m.viewport.YOffset()

	updated, _ := m.Update(mouseWheel(tea.MouseWheelUp, 0, 0))
	afterUp, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if got, want := afterUp.viewport.YOffset(), startingYOffset-mouseWheelStepLines; got != want {
		t.Fatalf("after wheel up, YOffset = %d, want %d (one line up from %d)", got, want, startingYOffset)
	}

	updated, _ = afterUp.Update(mouseWheel(tea.MouseWheelDown, 0, 0))
	afterDown, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if got, want := afterDown.viewport.YOffset(), startingYOffset; got != want {
		t.Fatalf("after wheel up+down round trip, YOffset = %d, want %d (back to %d)", got, want, startingYOffset)
	}
}

func TestMouseWheelRepeatedTicksAreNotThrottled(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	fillScrollableViewport(&m)
	startingYOffset := m.viewport.YOffset()

	updated, _ := m.Update(mouseWheel(tea.MouseWheelUp, 0, 0))
	m = updated.(model)
	updated, _ = m.Update(mouseWheel(tea.MouseWheelUp, 0, 0))
	after := updated.(model)

	if got, want := after.viewport.YOffset(), startingYOffset-(mouseWheelStepLines*2); got != want {
		t.Fatalf("two immediate wheel ticks should both scroll, got YOffset %d want %d", got, want)
	}
}

// TestMouseWheelRoutesToHelpOverlay verifies the Phase 11
// overlay-wheel routing: when the help overlay is open the
// wheel drives the overlay's own internal scroll (helpScroll)
// rather than the transcript viewport underneath. The
// viewport's YOffset is asserted unchanged so the operator
// can't accidentally yank themselves out of whatever they
// were reading on the transcript while navigating the
// help text.
func TestMouseWheelRoutesToHelpOverlay(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	m.width = 80
	m.height = 24
	m.resize()
	m.setMode(modeHelpOverlay)
	startingYOffset := m.viewport.YOffset()
	startingHelpScroll := m.helpScroll

	updated, _ := m.Update(mouseWheel(tea.MouseWheelDown, 0, 0))
	after, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after.helpScroll != startingHelpScroll+mouseWheelStepLines {
		t.Fatalf("help overlay: wheel down should bump helpScroll by %d, got %d (from %d)",
			mouseWheelStepLines, after.helpScroll, startingHelpScroll)
	}
	if after.viewport.YOffset() != startingYOffset {
		t.Fatalf("help overlay: wheel must NOT scroll the underlying transcript, YOffset %d -> %d",
			startingYOffset, after.viewport.YOffset())
	}
	if after.inputMode != modeHelpOverlay {
		t.Fatalf("wheel in help overlay should not change inputMode; got %s", after.inputMode)
	}
}

// TestMouseWheelDisabledWhenMouseCaptureOff verifies that
// the wheel is a complete no-op when the operator explicitly
// opts out with --mouse=false. In that mode the terminal owns
// the wheel-to-arrow conversion (or just scrolls its own
// scrollback), and the app must ignore any stray MouseMsg it
// still sees. This is the gate that preserves terminal-native
// drag-to-select text selection for the opt-out path.
func TestMouseWheelDisabledWhenMouseCaptureOff(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: false})
	fillScrollableViewport(&m)
	startingYOffset := m.viewport.YOffset()

	updated, _ := m.Update(mouseWheel(tea.MouseWheelUp, 0, 0))
	after, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after.viewport.YOffset() != startingYOffset {
		t.Fatalf("MouseCapture=off: wheel up should be a no-op, YOffset %d -> %d",
			startingYOffset, after.viewport.YOffset())
	}
}

func TestMouseWheelNeverScrollsTextEntryInput(t *testing.T) {
	cases := []inputMode{
		modeModelPickBaseURL,
		modePermissionEditRule,
		modePermissionEditFeedback,
		modeSessionInput,
	}
	for _, mode := range cases {
		t.Run(string(mode), func(t *testing.T) {
			m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
			m.width = 100
			m.height = 30
			m.setMode(mode)
			m.setInputValue(strings.Repeat("line\n", 20))
			m.input.SetHeight(3)
			updated, _ := m.input.Update(keyPress(tea.KeyDown))
			m.input = updated
			startingInputOffset := m.input.ScrollYOffset()

			updatedModel, cmd := m.Update(mouseWheel(tea.MouseWheelDown, 0, 0))
			if cmd != nil {
				t.Fatalf("mouse wheel in %s returned cmd %T", mode, cmd)
			}
			after := updatedModel.(model)
			if got := after.input.ScrollYOffset(); got != startingInputOffset {
				t.Fatalf("mouse wheel in %s scrolled textarea YOffset %d -> %d", mode, startingInputOffset, got)
			}
		})
	}
}

func TestLeakedSGRMouseWheelDoesNotTypeIntoInput(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	fillScrollableViewport(&m)
	startingYOffset := m.viewport.YOffset()

	for _, fragment := range []string{"[", "<64;45;5M"} {
		updated, _ := m.Update(textKey(fragment))
		m = updated.(model)
	}
	if got := m.input.Value(); got != "" {
		t.Fatalf("leaked SGR mouse report should not type into input, got %q", got)
	}
	if got, want := m.viewport.YOffset(), startingYOffset-mouseWheelStepLines; got != want {
		t.Fatalf("leaked SGR wheel up should scroll viewport, got YOffset %d want %d", got, want)
	}
}

func TestLeakedMouseReportsDoNotTypeIntoInputAcrossProtocols(t *testing.T) {
	cases := []struct {
		name      string
		fragments []string
		paste     bool
		wantDelta int
	}{
		{name: "sgr complete wheel up", fragments: []string{"\x1b[<64;45;5M"}, wantDelta: -mouseWheelStepLines},
		{name: "sgr split wheel down", fragments: []string{"\x1b[", "<65;45;5M"}, wantDelta: mouseWheelStepLines},
		{name: "x10 complete wheel up", fragments: []string{"\x1b[M`MM"}, wantDelta: -mouseWheelStepLines},
		{name: "x10 split wheel down", fragments: []string{"\x1b[M", "aMM"}, wantDelta: mouseWheelStepLines},
		{name: "paste sgr wheel up", fragments: []string{"\x1b[<64;45;5M"}, paste: true, wantDelta: -mouseWheelStepLines},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
			fillScrollableViewport(&m)
			startingYOffset := m.viewport.YOffset()
			for _, fragment := range tc.fragments {
				var updated tea.Model
				if tc.paste {
					updated, _ = m.Update(tea.PasteMsg{Content: fragment})
				} else {
					updated, _ = m.Update(textKey(fragment))
				}
				m = updated.(model)
			}
			if got := m.input.Value(); got != "" {
				t.Fatalf("leaked mouse report should not type into input, got %q", got)
			}
			if got, want := m.viewport.YOffset(), startingYOffset+tc.wantDelta; got != want {
				t.Fatalf("leaked mouse wheel should scroll viewport, got YOffset %d want %d", got, want)
			}
		})
	}
}

// TestPermissionWheelRoutesToChoiceRing verifies the
// permission-mode branch of scrollOverlay: the wheel
// advances permissionChoice modulo 5, so a 5-tick wheel
// lands back on the same option while a single tick
// moves it forward (or back) by one.
func TestPermissionWheelRoutesToChoiceRing(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	m.width = 80
	m.height = 24
	m.resize()
	m.setMode(modePermission)
	m.permissionChoice = 0

	updated, _ := m.Update(mouseWheel(tea.MouseWheelDown, 0, 0))
	after, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after.permissionChoice != mouseWheelStepLines%5 {
		t.Fatalf("permission ring: wheel down once should land on choice %d, got %d",
			mouseWheelStepLines%5, after.permissionChoice)
	}

	// A second wheel up should walk back to 0.
	updated, _ = after.Update(mouseWheel(tea.MouseWheelUp, 0, 0))
	after, ok = updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after.permissionChoice != 0 {
		t.Fatalf("permission ring: wheel up should land on choice 0, got %d", after.permissionChoice)
	}
}

// TestPermissionGracePeriodAbsorbsKeystrokes verifies the
// crush-style async-dialog grace period: when the
// permission panel opens, keystrokes arriving in the
// following 200ms-quiet / 1.5s-max window are absorbed
// (not dispatched) so an in-flight 'y' from the main
// input box can't accidentally approve a tool prompt
// the operator never saw.
func TestPermissionGracePeriodAbsorbsKeystrokes(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	// newModel disables the grace period under `go test`
	// (so existing permission tests can drive the panel
	// deterministically). Re-arm it here for this single
	// assertion.
	m.graceQuietPeriod = 200 * time.Millisecond
	m.graceMaxDelay = 1500 * time.Millisecond
	m.width = 80
	m.height = 24
	m.resize()
	m.setMode(modePermission)
	m.permissionChoice = 2
	// m.setMode armed permissionOpenedAt at time.Now(); the
	// grace period is therefore active for the next
	// graceMaxDelay.
	if !m.inPermissionGracePeriod() {
		t.Fatalf("test precondition: permission grace period should be active immediately after setMode")
	}

	// `y` would normally approve, but during grace it must
	// be absorbed (no change in permissionChoice, no
	// permission decision sent).
	updated, _ := m.Update(textKey("y"))
	after, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after.permissionChoice != 2 {
		t.Fatalf("grace period: 'y' should be absorbed, permissionChoice moved to %d", after.permissionChoice)
	}
	if after.inputMode != modePermission {
		t.Fatalf("grace period: panel should still be open, got mode %s", after.inputMode)
	}
}

// TestPermissionGracePeriodMaxDelayReleasesAfter1p5s verifies
// the upper bound: even with continuous keystrokes that
// keep resetting the quiet timer, the panel arms itself
// after graceMaxDelay has elapsed. We simulate this by
// pushing permissionOpenedAt 2 seconds into the past and
// re-checking inPermissionGracePeriod.
func TestPermissionGracePeriodMaxDelayReleasesAfter1p5s(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.graceQuietPeriod = 200 * time.Millisecond
	m.graceMaxDelay = 1500 * time.Millisecond
	m.permissionOpenedAt = time.Now().Add(-2 * time.Second)
	m.permissionLastInputAt = time.Now()
	if m.inPermissionGracePeriod() {
		t.Fatalf("after graceMaxDelay the panel should be armed (grace period over)")
	}
}

// TestMouseWheelMotionAndPressFiltering verifies that
// only the Press action on WheelUp/WheelDown is treated
// as a scroll tick; motion and release events must be
// ignored so the operator can still move the mouse over
// the transcript without the viewport yanking itself.
func TestMouseWheelMotionAndPressFiltering(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	fillScrollableViewport(&m)
	startingYOffset := m.viewport.YOffset()

	for _, msg := range []tea.Msg{
		mouseMotion(tea.MouseWheelUp, 0, 0),
		mouseRelease(tea.MouseWheelUp, 0, 0),
	} {
		updated, _ := m.Update(msg)
		after, ok := updated.(model)
		if !ok {
			t.Fatalf("expected model, got %T", updated)
		}
		if after.viewport.YOffset() != startingYOffset {
			t.Fatalf("msg=%T: YOffset changed from %d to %d; only MouseWheelMsg should scroll", msg, startingYOffset, after.viewport.YOffset())
		}
	}
}

// TestMousePressOnNonWheelButtonIsNoOp verifies that a
// plain left-click press on the transcript does not
// scroll — only the wheel is wired up. Selecting text
// should still feel "free" to the operator when the
// terminal forwards drag events to the app.
func TestMousePressOnNonWheelButtonIsNoOp(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	fillScrollableViewport(&m)
	startingYOffset := m.viewport.YOffset()

	updated, _ := m.Update(mouseClick(tea.MouseLeft, 0, 0))
	after, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after.viewport.YOffset() != startingYOffset {
		t.Fatalf("left-click press changed YOffset from %d to %d; only wheel should scroll", startingYOffset, after.viewport.YOffset())
	}
}

// TestPgUpPgDownInComposingScrollsViewport verifies the
// keyboard companion to the wheel: PgUp / PgDn page-scroll
// the transcript in composing mode. The bubble viewport
// already handles these via Update, but the handler
// intercepts them here to make the single-input-owner
// invariant explicit (the textinput never sees the key).
func TestPgUpPgDownInComposingScrollsViewport(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	fillScrollableViewport(&m)
	startingYOffset := m.viewport.YOffset()

	updated, _ := m.Update(keyPress(tea.KeyPgUp))
	after, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	afterUp := after.viewport.YOffset()
	if afterUp >= startingYOffset {
		t.Fatalf("after PgUp, YOffset = %d; want strictly less than %d", afterUp, startingYOffset)
	}
	if afterUp != startingYOffset-after.viewport.Height() && after.viewport.Height() > 0 {
		// bubbles PageUp advances by Height, so the
		// delta should match the viewport height
		// (allow off-by-one due to clamping at top=0).
		if afterUp > 0 {
			t.Fatalf("after PgUp, YOffset = %d; want roughly %d (start - Height=%d)",
				afterUp, startingYOffset-after.viewport.Height(), after.viewport.Height())
		}
	}

	updated, _ = after.Update(keyPress(tea.KeyPgDown))
	after2, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after2.viewport.YOffset() <= afterUp {
		t.Fatalf("after PgUp+PgDown, YOffset = %d; want strictly greater than %d", after2.viewport.YOffset(), afterUp)
	}
}

// TestUpDownStillWalkPromptHistoryAfterMouseFix is the
// regression guard for the wheel fix: even with mouse
// capture now enabled, ↑/↓ in composing mode must keep
// walking the per-session prompt history (not scroll
// the viewport). This is the historical binding; if
// the wheel fix ever crept in and stole the keys, this
// test would catch it.
func TestUpDownStillWalkPromptHistoryAfterMouseFix(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 24
	m.resize()
	// Seed two historical prompts.
	m.promptHistory = []string{"first turn", "second turn"}

	// `up` should restore the most recent prompt into
	// the input box and bump the history index, NOT
	// scroll the transcript.
	updated, _ := m.Update(keyPress(tea.KeyUp))
	after, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if got, want := after.input.Value(), "second turn"; got != want {
		t.Fatalf("after up, input = %q, want %q (most recent prompt)", got, want)
	}
	if after.historyIndex != 0 {
		t.Fatalf("after up, historyIndex = %d, want 0", after.historyIndex)
	}

	// Second `up` walks one further back in history.
	updated, _ = after.Update(keyPress(tea.KeyUp))
	after2, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if got, want := after2.input.Value(), "first turn"; got != want {
		t.Fatalf("after second up, input = %q, want %q (older prompt)", got, want)
	}
	if after2.historyIndex != 1 {
		t.Fatalf("after second up, historyIndex = %d, want 1", after2.historyIndex)
	}

	// `down` walks forward and restores the live draft
	// once the cursor returns to the bottom.
	updated, _ = after2.Update(keyPress(tea.KeyDown))
	after3, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	updated, _ = after3.Update(keyPress(tea.KeyDown))
	after4, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after4.historyIndex != -1 {
		t.Fatalf("after walking back to live draft, historyIndex = %d, want -1", after4.historyIndex)
	}
	if after4.input.Value() != "" {
		t.Fatalf("after walking back to live draft, input = %q, want empty", after4.input.Value())
	}
}

// Regression: the /model step-2/3 overlays and the permission
// inline editor (modePermissionEditRule + modePermissionEditFeedback)
// must render the input box with a SINGLE "> " prompt, not the
// pre-fix "  > > …" double-prefix.
//
// The fix relied on the fact that m.input.Prompt is already "> "
// — the overlay used to prepend another "> " literal, producing
// the user-visible "│ > > Ask BabeL-O" line in the model pick
// overlay. We assert the rendered overlay no longer contains a
// "> >" pattern AND still surfaces the input's own prompt so the
// operator sees a usable input line.
func TestModelPickApiKeyRendersSinglePromptArrow(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	// setMode wires the mode-specific placeholder; do NOT preset
	// m.inputMode — setMode short-circuits when the mode is unchanged
	// and would skip the placeholder swap.
	m.setMode(modeModelPickApiKey)
	m.height = 30
	rendered := m.renderModelPickApiKey(120)
	if rendered == "" {
		t.Fatalf("renderModelPickApiKey should be non-empty in modeModelPickApiKey")
	}
	if strings.Contains(rendered, "> >") {
		t.Fatalf("renderModelPickApiKey rendered a double-prompt line; the input line is duplicated.\nfull:\n%s", rendered)
	}
	visible := stripANSICodes(rendered)
	if !strings.Contains(visible, "> paste API key") {
		t.Fatalf("renderModelPickApiKey missing the mode-specific placeholder; the user should see `> paste API key`.\nfull:\n%s", rendered)
	}
	if strings.Contains(visible, "Ask BabeL-O") {
		t.Fatalf("renderModelPickApiKey still shows the default 'Ask BabeL-O' placeholder; the /model context should override it.\nfull:\n%s", rendered)
	}
	if strings.Contains(visible, ":::") {
		t.Fatalf("renderModelPickApiKey should not use textarea continuation prompts for API keys.\nfull:\n%s", rendered)
	}
}

func TestModelPickBaseURLRendersSinglePromptArrow(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeModelPickBaseURL)
	m.height = 30
	rendered := m.renderModelPickBaseURL(120)
	if rendered == "" {
		t.Fatalf("renderModelPickBaseURL should be non-empty in modeModelPickBaseURL")
	}
	if strings.Contains(rendered, "> >") {
		t.Fatalf("renderModelPickBaseURL rendered a double-prompt line.\nfull:\n%s", rendered)
	}
	visible := stripANSICodes(rendered)
	if !strings.Contains(visible, "> https://api.example.com") {
		t.Fatalf("renderModelPickBaseURL missing the mode-specific placeholder.\nfull:\n%s", rendered)
	}
	if strings.Contains(visible, "Ask BabeL-O") {
		t.Fatalf("renderModelPickBaseURL still shows the default 'Ask BabeL-O' placeholder.\nfull:\n%s", rendered)
	}
}

func TestInputTextKeysInsertOnceAndInOrder(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	for _, key := range []tea.KeyPressMsg{textKey("A"), textKey("B"), textKey("你")} {
		updated, _ := m.Update(key)
		var ok bool
		m, ok = updated.(model)
		if !ok {
			t.Fatalf("expected model, got %T", updated)
		}
	}
	if got := m.input.Value(); got != "AB你" {
		t.Fatalf("text keys should insert exactly once and preserve order, got %q", got)
	}
}

func TestInputShiftEnterInsertsNewlineWithoutSubmitting(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setInputValue("hello")
	beforeTranscript := len(m.transcript)

	updated, cmd := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEnter, Mod: tea.ModShift}))
	m = updated.(model)

	if cmd != nil {
		t.Fatalf("shift+enter should not submit a prompt")
	}
	if got := m.input.Value(); got != "hello\n" {
		t.Fatalf("shift+enter input = %q, want newline appended", got)
	}
	if got := len(m.transcript); got != beforeTranscript {
		t.Fatalf("shift+enter should not append transcript rows, got %d new rows", got-beforeTranscript)
	}
}

func TestModelPickApiKeyPasteSanitizesSingleLineSecret(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeModelPickApiKey)

	updated, _ := m.Update(tea.PasteMsg{Content: " sk-cp-abc\r\nDEF\tGHI\n "})
	m = updated.(model)

	if got := m.modelPickAPIKeyDraft; got != "sk-cp-abcDEFGHI" {
		t.Fatalf("api key draft = %q, want sanitized single-line key", got)
	}
	if got := m.input.Value(); got != "" {
		t.Fatalf("api key paste should not touch textarea, got %q", got)
	}
	if m.pastedTextCounter != 0 {
		t.Fatalf("api key paste should not create pasted-text placeholders, got counter=%d", m.pastedTextCounter)
	}
}

func TestModelPickApiKeyBackspaceAndClear(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeModelPickApiKey)
	m.modelPickAPIKeyDraft = "sk-test"

	updated, _ := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyBackspace}))
	m = updated.(model)
	if got := m.modelPickAPIKeyDraft; got != "sk-tes" {
		t.Fatalf("backspace draft = %q, want sk-tes", got)
	}

	updated, _ = m.Update(ctrlKey('u'))
	m = updated.(model)
	if got := m.modelPickAPIKeyDraft; got != "" {
		t.Fatalf("ctrl+u draft = %q, want empty", got)
	}
}

func TestModelPickApiKeySpecialKeysDoNotTypeOrBreakWheelCSI(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelCatalog = runtimeModelsResponse{
		Providers: []registeredProvider{
			{ID: "anthropic"},
			{ID: "minimax"},
			{ID: "openai"},
		},
	}
	m.modelPickProviderIdx = 1
	m.setMode(modeModelPickApiKey)
	m.modelPickAPIKeyDraft = "sk-test"

	updated, cmd := m.Update(keyPress(tea.KeyUp))
	m = updated.(model)
	if cmd != nil {
		t.Fatalf("up key in api key mode should not return cmd, got %T", cmd)
	}
	if got := m.modelPickAPIKeyDraft; got != "sk-test" {
		t.Fatalf("up key should not type into api key draft, got %q", got)
	}

	updated, cmd = m.Update(fmt.Stringer(fmtString("?CSI[60 54 53 59 52 53 59 53 77]?")))
	m = updated.(model)
	if cmd != nil {
		t.Fatalf("wheel CSI in api key mode should not return cmd, got %T", cmd)
	}
	if got := m.modelPickAPIKeyDraft; got != "sk-test" {
		t.Fatalf("wheel CSI should not type into api key draft, got %q", got)
	}
}

func TestModelPickApiKeyRequiresNonEmptyDraft(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeModelPickApiKey)

	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	m = updated.(model)

	if cmd != nil {
		t.Fatalf("empty api key should not return cmd, got %T", cmd)
	}
	if m.inputMode != modeModelPickApiKey {
		t.Fatalf("empty api key inputMode = %q, want %q", m.inputMode, modeModelPickApiKey)
	}
	rendered := renderTranscript(m.transcript, 120)
	if !strings.Contains(rendered, "provider API key is required") {
		t.Fatalf("empty api key should surface an error, got %q", rendered)
	}
}

func TestModelPickConfiguredProviderStillShowsApiKeyStep(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelCatalog = runtimeModelsResponse{
		Providers: []registeredProvider{{
			ID:             "minimax",
			DisplayName:    "MiniMax",
			AuthMode:       "api-key",
			DefaultBaseURL: "https://api.minimaxi.com/anthropic",
			DefaultModel:   "minimax/MiniMax-M3",
			Configured:     true,
			AuthConfigured: true,
			AuthSource:     "provider_config",
		}},
	}
	m.setMode(modeModelPickProvider)

	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	m = updated.(model)

	if cmd != nil {
		t.Fatalf("configured API-key provider should not jump directly to model picker, got cmd %T", cmd)
	}
	if m.inputMode != modeModelPickApiKey {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeModelPickApiKey)
	}
	if m.modelPickSelectedID != "minimax" {
		t.Fatalf("modelPickSelectedID = %q, want minimax", m.modelPickSelectedID)
	}
}

func TestModelPickNoAuthProviderSkipsApiKeyStep(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelCatalog = runtimeModelsResponse{
		Providers: []registeredProvider{{
			ID:           "local",
			DisplayName:  "Local",
			AuthMode:     "none",
			DefaultModel: "local/coding-runtime",
			Configured:   true,
		}},
	}
	m.setMode(modeModelPickProvider)

	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	m = updated.(model)

	if cmd == nil {
		t.Fatalf("no-auth provider should enter the live model picker and fetch runtime models")
	}
	if m.inputMode != modeModelPickModel {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeModelPickModel)
	}
	if !m.modelPickerLoading {
		t.Fatalf("modelPickerLoading = false, want true")
	}
}

func TestModelPickApiKeyEmptyEnterKeepsSavedProviderCredential(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelCatalog = runtimeModelsResponse{
		Providers: []registeredProvider{{
			ID:          "minimax",
			DisplayName: "MiniMax",
			AuthMode:    "api-key",
			Configured:  true,
			AuthSource:  "provider_config",
		}},
	}
	m.modelPickSelectedID = "minimax"
	m.setMode(modeModelPickApiKey)

	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	m = updated.(model)

	if cmd != nil {
		t.Fatalf("empty enter with saved provider credential should only advance to base URL, got cmd %T", cmd)
	}
	if m.inputMode != modeModelPickBaseURL {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeModelPickBaseURL)
	}
	rendered := renderTranscript(m.transcript, 120)
	if strings.Contains(rendered, "provider API key is required") {
		t.Fatalf("empty enter with saved provider credential should not emit missing-key error: %q", rendered)
	}
}

func TestModelPickApiKeyEnterUsesSanitizedDraft(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeModelPickApiKey)
	m.modelPickAPIKeyDraft = " sk-cp-abc\nDEF "

	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	m = updated.(model)

	if cmd != nil {
		t.Fatalf("api key enter should only advance to base URL step, got cmd %T", cmd)
	}
	if got := m.modelPickAPIKeyDraft; got != "sk-cp-abcDEF" {
		t.Fatalf("api key draft = %q, want sanitized key", got)
	}
	if m.inputMode != modeModelPickBaseURL {
		t.Fatalf("inputMode = %q, want %q", m.inputMode, modeModelPickBaseURL)
	}
}

func TestModelProviderTextStepsAcceptTypedInput(t *testing.T) {
	t.Run("api key", func(t *testing.T) {
		m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
		m.setMode(modeModelPickApiKey)
		for _, r := range "sk-test" {
			updated, _ := m.Update(textKey(string(r)))
			var ok bool
			m, ok = updated.(model)
			if !ok {
				t.Fatalf("expected model, got %T", updated)
			}
		}
		if got := m.modelPickAPIKeyDraft; got != "sk-test" {
			t.Fatalf("api key draft = %q, want %q", got, "sk-test")
		}
		if got := m.input.Value(); got != "" {
			t.Fatalf("api key step should not write into the textarea, got %q", got)
		}
	})

	cases := []struct {
		name string
		mode inputMode
		want string
	}{
		{"base url", modeModelPickBaseURL, "https://api.example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
			m.setMode(tc.mode)
			for _, r := range tc.want {
				updated, _ := m.Update(textKey(string(r)))
				var ok bool
				m, ok = updated.(model)
				if !ok {
					t.Fatalf("expected model, got %T", updated)
				}
			}
			if got := m.input.Value(); got != tc.want {
				t.Fatalf("%s input = %q, want %q", tc.name, got, tc.want)
			}
		})
	}
}

func TestPermissionEditorTextStepsAcceptTypedInput(t *testing.T) {
	cases := []struct {
		name string
		mode inputMode
		want string
	}{
		{"rule", modePermissionEditRule, "bash:*"},
		{"feedback", modePermissionEditFeedback, "try ls"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
			m.pending = &pendingPermission{name: "Bash"}
			m.setMode(tc.mode)
			for _, r := range tc.want {
				updated, _ := m.Update(textKey(string(r)))
				var ok bool
				m, ok = updated.(model)
				if !ok {
					t.Fatalf("expected model, got %T", updated)
				}
			}
			if got := m.input.Value(); got != tc.want {
				t.Fatalf("%s input = %q, want %q", tc.name, got, tc.want)
			}
		})
	}
}

func TestPermissionEditorRendersSinglePromptArrow(t *testing.T) {
	cases := []struct {
		name string
		mode inputMode
	}{
		{"rule", modePermissionEditRule},
		{"feedback", modePermissionEditFeedback},
	}
	for _, tc := range cases {
		t.Run(string(tc.mode), func(t *testing.T) {
			m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
			// Do NOT preset m.inputMode — setMode short-circuits
			// when the mode is unchanged and would skip the
			// placeholder swap.
			m.setMode(tc.mode)
			m.height = 30
			m.pending = &pendingPermission{
				name:  "Bash",
				risk:  "low",
				input: "ls -la",
			}
			rendered := m.renderPermissionEditor(120)
			if rendered == "" {
				t.Fatalf("renderPermissionEditor should be non-empty in %q", tc.mode)
			}
			if strings.Contains(rendered, "> >") {
				t.Fatalf("renderPermissionEditor(%s) rendered a double-prompt line.\nfull:\n%s", tc.mode, rendered)
			}
			if strings.Contains(rendered, "Ask BabeL-O") {
				t.Fatalf("renderPermissionEditor(%s) still shows the default 'Ask BabeL-O' placeholder.\nfull:\n%s", tc.mode, rendered)
			}
		})
	}
}

// TestPlaceholderFollowsMode verifies that setMode swaps the
// input placeholder to a context-appropriate hint for /model and
// the permission editor, and that returning to a normal mode
// restores the default "Ask BabeL-O" placeholder.
func TestPlaceholderFollowsMode(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})

	cases := []struct {
		mode inputMode
		want string
	}{
		{modeModelPickApiKey, "paste API key (or accept default)"},
		{modeModelPickBaseURL, "https://api.example.com"},
		{modePermissionEditRule, "git:status, bash:*, npm:install"},
		{modePermissionEditFeedback, "tell the model what to do instead"},
	}
	for _, tc := range cases {
		m.setMode(tc.mode)
		if got := m.input.Placeholder; got != tc.want {
			t.Fatalf("after setMode(%q) placeholder = %q, want %q", tc.mode, got, tc.want)
		}
	}

	// Returning to modeComposing restores the default placeholder
	// so the bottom input box reads `> Ask BabeL-O` again.
	m.setMode(modeComposing)
	if got := m.input.Placeholder; got != "Ask BabeL-O" {
		t.Fatalf("after setMode(modeComposing) placeholder = %q, want %q", got, "Ask BabeL-O")
	}
}

// primeSelectionViewport fills the transcript with a few
// plain-text lines so the in-app selection tests can press
// / drag / release and read back the extracted text. The
// lines are short enough to fit on a single visual row
// (no wrap) so the column math stays simple.
func primeSelectionViewport(m *model) {
	m.width = 80
	m.height = 24
	m.resize()
	m.transcript = []*transcriptItem{
		{kind: "status", text: "alpha line"},
		{kind: "status", text: "beta line"},
		{kind: "status", text: "gamma line"},
		{kind: "status", text: "delta line"},
	}
	m.refreshViewport()
	m.viewport.GotoTop()
}

// TestInAppSelectionDragAndCopy verifies the full
// Phase 11.3 in-app selection pipeline: left-button press
// starts a selection, motion updates the end anchor,
// release with a non-empty range returns an OSC 52
// copy command and stamps the feedback timestamp on
// the model. The selection rect itself is checked via
// normalizedSelection() so this test does not depend on
// the highlight-rendering path.
func TestInAppSelectionDragAndCopy(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	primeSelectionViewport(&m)

	viewportTop := m.viewportTopY()
	lines := strings.Split(stripANSICodes(m.fullViewportContent()), "\n")
	targetLine := -1
	for i, line := range lines {
		if strings.Contains(line, "alpha line") {
			targetLine = i
			break
		}
	}
	if targetLine < 0 {
		t.Fatalf("test setup could not find alpha line in viewport content:\n%s", strings.Join(lines, "\n"))
	}
	targetCol := strings.Index(lines[targetLine], "alpha")
	if targetCol < 0 {
		t.Fatalf("test setup could not find alpha column in %q", lines[targetLine])
	}

	// press inside a visible transcript row. The header height
	// is dynamic, so translate viewport-content line/col back
	// into screen coordinates instead of baking in a row number.
	updated, _ := m.Update(mouseClick(tea.MouseLeft, targetCol, viewportTop+targetLine))
	afterPress, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if !afterPress.mouseDownInViewport {
		t.Fatalf("press should arm mouseDownInViewport")
	}
	if !afterPress.selectionActive {
		t.Fatalf("press should activate selection")
	}

	// drag across the same transcript row — should extend end
	// (but not move start) and make a visible text highlight.
	updated, _ = afterPress.Update(mouseMotion(tea.MouseLeft, targetCol+5, viewportTop+targetLine))
	afterDrag, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if !afterDrag.mouseDownInViewport {
		t.Fatalf("motion should keep mouseDownInViewport armed")
	}
	sl, sc, el, ec, ok := afterDrag.normalizedSelection()
	if !ok {
		t.Fatalf("after drag, selection should be non-empty")
	}
	if sl == el && sc == ec {
		t.Fatalf("after drag, selection should span more than one cell")
	}
	if sl != afterPress.selectionStartLine {
		t.Fatalf("drag must not move start line: %d -> %d",
			afterPress.selectionStartLine, sl)
	}

	// release — should produce a clipboard cmd, clear mouse
	// button state, and keep the highlight visible briefly so
	// the operator sees the selected region after copy.
	updated, cmd := afterDrag.Update(mouseRelease(tea.MouseLeft, targetCol+5, viewportTop+targetLine))
	afterRelease, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if cmd == nil {
		t.Fatalf("release with non-empty selection should return an OSC 52 copy cmd")
	}
	if afterRelease.mouseDownInViewport {
		t.Fatalf("release should clear mouseDownInViewport")
	}
	if !afterRelease.selectionActive {
		t.Fatalf("release after copy should keep selectionActive until the delayed highlight expiry")
	}
	if view := viewContent(afterRelease.View()); !containsCellSelectionHighlight(view) {
		t.Fatalf("release should keep the copied selection highlighted briefly, got:\n%s", view)
	}
	if afterRelease.lastSelectionCopy != "alpha" {
		t.Fatalf("release should copy the same visible text that stays highlighted, got %q", afterRelease.lastSelectionCopy)
	}
	if afterRelease.lastSelectionCopyAt.IsZero() {
		t.Fatalf("release should stamp lastSelectionCopyAt")
	}
	if afterRelease.copyToastMessage != "Selected text copied to clipboard" {
		t.Fatalf("release should show copy toast, got %q", afterRelease.copyToastMessage)
	}
	if !strings.Contains(afterRelease.renderFooter(80), "Selected text copied to clipboard") {
		t.Fatalf("footer status should include English clipboard message, got:\n%s", afterRelease.renderFooter(80))
	}
}

func TestInAppSelectionReverseDragAndCopy(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	primeSelectionViewport(&m)

	viewportTop := m.viewportTopY()
	lines := strings.Split(stripANSICodes(m.fullViewportContent()), "\n")
	targetLine := -1
	for i, line := range lines {
		if strings.Contains(line, "alpha line") {
			targetLine = i
			break
		}
	}
	if targetLine < 0 {
		t.Fatalf("test setup could not find alpha line in viewport content:\n%s", strings.Join(lines, "\n"))
	}
	alphaCol := strings.Index(lines[targetLine], "alpha")
	if alphaCol < 0 {
		t.Fatalf("test setup could not find alpha column in %q", lines[targetLine])
	}

	updated, _ := m.Update(mouseClick(tea.MouseLeft, alphaCol+5, viewportTop+targetLine))
	afterPress := updated.(model)
	updated, _ = afterPress.Update(mouseMotion(tea.MouseLeft, alphaCol, viewportTop+targetLine))
	afterDrag := updated.(model)
	updated, cmd := afterDrag.Update(mouseRelease(tea.MouseLeft, alphaCol, viewportTop+targetLine))
	afterRelease := updated.(model)

	if cmd == nil {
		t.Fatalf("reverse drag release should copy selected text")
	}
	if got := afterRelease.lastSelectionCopy; got != "alpha" {
		t.Fatalf("reverse drag should normalize copied text, got %q", got)
	}
	if !afterRelease.selectionActive {
		t.Fatalf("reverse drag release should keep highlight active until delayed expiry")
	}
	if view := viewContent(afterRelease.View()); !containsCellSelectionHighlight(view) {
		t.Fatalf("reverse drag release should keep visible highlight, got:\n%s", view)
	}
}

func TestInAppSelectionMouseCaptureOffNoOp(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: false})
	primeSelectionViewport(&m)

	updated, cmd := m.Update(mouseClick(tea.MouseLeft, 5, m.viewportTopY()))
	after := updated.(model)
	if cmd != nil {
		t.Fatalf("mouse-capture off selection press should not return a command")
	}
	if after.selectionActive || after.mouseDownInViewport {
		t.Fatalf("mouse-capture off selection press should not start selection")
	}
}

func TestSelectionClearsOnModeTransition(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	primeSelectionViewport(&m)
	m.selectionActive = true
	m.selectionStartLine = 1
	m.selectionStartCol = 2
	m.selectionEndLine = 1
	m.selectionEndCol = 8
	m.mouseDownInViewport = true

	m.setMode(modeHelpOverlay)
	if m.selectionActive || m.mouseDownInViewport {
		t.Fatalf("entering an overlay should clear transcript selection state")
	}
}

func TestExtractSelectedTextUsesVisibleColumnsForWideRunes(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	m.width = 120
	m.height = 30
	m.resize()
	m.transcript = []*transcriptItem{
		{kind: "status", text: "你好abcdef", Versioned: NewVersioned()},
	}
	m.refreshViewport()

	lines := strings.Split(stripANSICodes(m.fullViewportContent()), "\n")
	targetLine := -1
	for i, line := range lines {
		if strings.Contains(line, "你好abcdef") {
			targetLine = i
			break
		}
	}
	if targetLine < 0 {
		t.Fatalf("test setup could not find wide-rune transcript line in:\n%s", strings.Join(lines, "\n"))
	}
	start := strings.Index(lines[targetLine], "你好abcdef")
	if start < 0 {
		t.Fatalf("test setup could not find target text in line %q", lines[targetLine])
	}
	startCol := visibleWidth(lines[targetLine][:start]) + 4
	got := m.extractSelectedText(targetLine, startCol, targetLine, startCol+3)
	if got != "abc" {
		t.Fatalf("selected text = %q, want %q", got, "abc")
	}
}

func TestSelectionHighlightExpiresOnlyMatchingCopy(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	primeSelectionViewport(&m)
	m.selectionActive = true
	m.selectionStartLine = 1
	m.selectionStartCol = 2
	m.selectionEndLine = 1
	m.selectionEndCol = 8
	m.lastSelectionCopyAt = time.Unix(20, 0)

	updated, _ := m.Update(selectionHighlightExpiredMsg{
		copiedAt:  time.Unix(10, 0),
		startLine: 1,
		startCol:  2,
		endLine:   1,
		endCol:    8,
	})
	after, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if !after.selectionActive {
		t.Fatalf("stale selection highlight expiry should not clear newer selection")
	}

	updated, _ = after.Update(selectionHighlightExpiredMsg{
		copiedAt:  time.Unix(20, 0),
		startLine: 1,
		startCol:  2,
		endLine:   1,
		endCol:    9,
	})
	after, ok = updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if !after.selectionActive {
		t.Fatalf("selection expiry with mismatched range should not clear current selection")
	}

	updated, _ = after.Update(selectionHighlightExpiredMsg{
		copiedAt:  time.Unix(20, 0),
		startLine: 1,
		startCol:  2,
		endLine:   1,
		endCol:    8,
	})
	after, ok = updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after.selectionActive || after.mouseDownInViewport {
		t.Fatalf("matching selection highlight expiry should clear selection state")
	}
}

func TestCopyToastExpiresOnlyMatchingCopy(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	first := time.Unix(10, 0)
	second := time.Unix(20, 0)
	m.copyToastMessage = "Selected text copied to clipboard"
	m.copyToastShownAt = second

	updated, _ := m.Update(copyToastExpiredMsg{copiedAt: first})
	after, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after.copyToastMessage == "" {
		t.Fatalf("stale copy toast expiry should not clear newer toast")
	}

	updated, _ = after.Update(copyToastExpiredMsg{copiedAt: second})
	after, ok = updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after.copyToastMessage != "" || !after.copyToastShownAt.IsZero() {
		t.Fatalf("matching copy toast expiry should clear toast, got message=%q shownAt=%v",
			after.copyToastMessage, after.copyToastShownAt)
	}
}

// TestInAppSelectionOutsideViewportDoesNothing verifies
// that a left-button press outside the viewport (e.g.
// on the input box, or above the header) does NOT start
// a selection. This is the single-input-owner invariant:
// the input box still owns its own mouse events for
// cursor positioning, and the header / footer are
// non-interactive chrome.
func TestInAppSelectionOutsideViewportDoesNothing(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	primeSelectionViewport(&m)

	// y=0 is the header row, outside the viewport.
	updated, _ := m.Update(mouseClick(tea.MouseLeft, 5, 0))
	after, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after.selectionActive {
		t.Fatalf("press on header should not start a selection")
	}
	if after.mouseDownInViewport {
		t.Fatalf("press on header should not arm mouseDownInViewport")
	}
}

func TestInAppSelectionHeaderDividerOutsideViewport(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	primeSelectionViewport(&m)
	if m.viewportTopY() < 2 {
		t.Fatalf("test expects header title + divider, viewportTopY=%d", m.viewportTopY())
	}

	updated, _ := m.Update(mouseClick(tea.MouseLeft, 5, m.viewportTopY()-1))
	after, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if after.selectionActive {
		t.Fatalf("press on header divider should not start selection")
	}
	if after.mouseDownInViewport {
		t.Fatalf("press on header divider should not arm mouseDownInViewport")
	}
}

// TestInAppSelectionClearsOnEmptyRelease verifies that
// clicking a single cell (press + release with no
// motion) clears the selection instead of pushing an
// empty string through OSC 52. We don't want OSC 52
// to fire for a bare click — that would overwrite the
// clipboard with "" and erase whatever the operator had
// there.
func TestInAppSelectionClearsOnEmptyRelease(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	primeSelectionViewport(&m)

	updated, _ := m.Update(mouseClick(tea.MouseLeft, 5, m.viewportTopY()))
	afterPress := updated.(model)

	updated, cmd := afterPress.Update(mouseRelease(tea.MouseLeft, 5, m.viewportTopY()))
	after, _ := updated.(model)
	if cmd != nil {
		t.Fatalf("single-cell click should not return a copy cmd")
	}
	if after.selectionActive {
		t.Fatalf("single-cell click should clear the selection")
	}
	if after.lastSelectionCopy != "" {
		t.Fatalf("single-cell click should not update lastSelectionCopy")
	}
}

// TestApplySelectionHighlightAddsCellReverse verifies
// that the highlight path paints selected cells inside
// the selected row of the viewport output, without
// disturbing the foreground colors of the surrounding
// cells. This locks the rendering contract that the
// operator sees.
func TestApplySelectionHighlightAddsCellReverse(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	primeSelectionViewport(&m)

	// Manually arm a selection over a real transcript line so we
	// can assert the renderer paints the highlight. Selecting the
	// welcome card's blank padding is brittle because the viewport
	// may trim invisible trailing spaces before they reach View().
	transcriptStart := transcriptStartLine(m.renderWelcomeCard(max(40, m.viewport.Width())))
	m.selectionActive = true
	m.selectionStartLine = transcriptStart
	m.selectionStartCol = 2
	m.selectionEndLine = transcriptStart
	m.selectionEndCol = 8
	m.viewport.SetYOffset(transcriptStart)

	view := viewContent(m.View())
	if !containsCellSelectionHighlight(view) {
		t.Fatalf("expected cell-level selection highlight in View output, got: %q", view)
	}
	if !strings.Contains(stripANSICodes(view), "alpha line") {
		t.Fatalf("cell-level selection highlight should preserve visible transcript text, got: %q", view)
	}
}

// TestStripANSICodesRoundTrip is a utility guard: every
// copy that goes through OSC 52 should be plain text,
// free of CSI / OSC escapes. This locks the contract
// without binding to a specific transcript fixture.
func TestStripANSICodesRoundTrip(t *testing.T) {
	in := "\x1b[31mhello\x1b[0m \x1b]52;c;abc\x07world"
	out := stripANSICodes(in)
	if strings.Contains(out, "\x1b") {
		t.Fatalf("stripANSICodes left an ESC byte: %q", out)
	}
	if out != "hello world" {
		t.Fatalf("stripANSICodes result = %q, want %q", out, "hello world")
	}
}

// TestPaintColumnRangePreservesForeground verifies that
// splicing a background span into a styled line does not
// clobber the foreground color of the substring being
// highlighted. We construct a string with red on the
// selected span and assert the red is still in the
// output after the splice.
func TestPaintColumnRangePreservesForeground(t *testing.T) {
	in := "\x1b[31mABCDE\x1b[0m"
	got := paintColumnRange(in, 1, 3, "\x1b[48;5;240m", "\x1b[49m")
	if !strings.Contains(got, "\x1b[31m") {
		t.Fatalf("paintColumnRange stripped the foreground red: %q", got)
	}
	if !strings.Contains(got, "\x1b[48;5;240m") {
		t.Fatalf("paintColumnRange did not insert the background start: %q", got)
	}
	if !strings.Contains(got, "\x1b[49m") {
		t.Fatalf("paintColumnRange did not insert the background reset: %q", got)
	}
}

// TestOsC52CopyCmdEmitsBase64 is the smoke test for the
// OSC 52 payload: the raw sequence must start with
// ESC]52;c;, contain a base64 blob, and end in BEL. The
// base64 must decode back to the original text. We test
// the builder directly because tea.Printf's returned
// tea.Cmd hides its inner printLineMessage type from
// outside callers.
func TestOsC52CopyCmdEmitsBase64(t *testing.T) {
	body := buildOSC52Sequence("hello world")
	if !strings.HasPrefix(body, "\x1b]52;c;") {
		t.Fatalf("OSC 52 prefix missing: %q", body)
	}
	if !strings.HasSuffix(body, "\x07") {
		t.Fatalf("OSC 52 terminator (BEL) missing: %q", body)
	}
	blob := strings.TrimSuffix(strings.TrimPrefix(body, "\x1b]52;c;"), "\x07")
	decoded, err := base64.StdEncoding.DecodeString(blob)
	if err != nil {
		t.Fatalf("OSC 52 payload is not valid base64: %v", err)
	}
	if string(decoded) != "hello world" {
		t.Fatalf("OSC 52 decoded to %q, want %q", decoded, "hello world")
	}
	// And the cmd itself must be non-nil.
	if osC52CopyCmd("hello world") == nil {
		t.Fatalf("osC52CopyCmd must return a non-nil tea.Cmd")
	}
}

// TestModelPickStep4EnterFiresSelectCommand verifies that pressing
// Enter in the /model Step 4 picker dispatches the
// selectRuntimeModel HTTP command, flips modelPickSubmitting on,
// and seeds the transcript with a "saving model: …" line — but does
// not commit the model id locally (the model id is only updated
// after the server response lands).
func TestModelPickStep4EnterFiresSelectCommand(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelCatalog = runtimeModelsResponse{
		Providers: []registeredProvider{
			{
				ID:             "anthropic",
				DisplayName:    "Anthropic",
				Adapter:        "anthropic-compatible",
				DefaultBaseURL: "https://api.anthropic.com",
				DefaultModel:   "anthropic/claude-3-5-sonnet",
				Configured:     true,
				Models: []registeredModel{
					{ID: "anthropic/claude-3-5-sonnet", Name: "Claude 3.5 Sonnet"},
					{ID: "anthropic/claude-3-opus", Name: "Claude 3 Opus"},
				},
			},
		},
	}
	// Drive the picker to Step 4 with the cursor on the
	// first model: provider pick → base URL confirm (default) →
	// enterModelPicker (clears modelPickerLive + sets
	// modelPickSubmitting=false; the live list is empty so the
	// picker falls back to provider.Models).
	m.modelPickSelectedID = "anthropic"
	m.setMode(modeModelPickModel)
	m.modelPickSelectedIdx = 0
	m.modelID = "openai/gpt-4o" // pre-existing id; should NOT change until response

	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	if cmd == nil {
		t.Fatalf("Enter in Step 4 must return the selectRuntimeModel HTTP command")
	}
	um, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if !um.modelPickSubmitting {
		t.Fatalf("modelPickSubmitting = false, want true while POST is in flight")
	}
	if um.modelID == "anthropic/claude-3-5-sonnet" {
		t.Fatalf("modelID must not flip to the picked model until the POST resolves")
	}
	rendered := renderTranscript(um.transcript, 200)
	if !strings.Contains(rendered, "saving model: anthropic/claude-3-5-sonnet") {
		t.Fatalf("transcript should announce the in-flight save, got %q", rendered)
	}
	// Re-pressing Enter while submitting must NOT dispatch
	// another cmd (the picker is locked until the response
	// lands).
	_, cmd2 := um.Update(keyPress(tea.KeyEnter))
	if cmd2 != nil {
		t.Fatalf("Enter while modelPickSubmitting=true must be a no-op; got %T", cmd2)
	}
}

// TestModelSelectMsgAppliesConfigAndClosesPicker verifies the
// success path: a modelSelectMsg with a resolved runtimeConfig
// flips m.modelID, drops the submitting flag, returns the
// operator to composing mode, and announces the save in the
// transcript.
func TestModelSelectMsgAppliesConfigAndClosesPicker(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()
	initialHeight := m.viewport.Height()
	if initialHeight <= 0 {
		t.Fatalf("test setup expected positive viewport height, got %d", initialHeight)
	}
	m.modelPickSubmitting = true
	m.setMode(modeModelPickModel)
	if got := m.viewport.Height(); got != 0 {
		t.Fatalf("model picker should collapse transcript viewport, got %d", got)
	}
	m.modelID = "openai/gpt-4o"

	updated, cmd := m.Update(modelSelectMsg{
		modelID: "anthropic/claude-3-5-sonnet",
		config: runtimeConfig{
			Type:         "runtime_config",
			Version:      7,
			ModelID:      "anthropic/claude-3-5-sonnet",
			ModelName:    "Claude 3.5 Sonnet",
			ProviderID:   "anthropic",
			ProviderName: "Anthropic",
		},
	})
	um, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if um.modelPickSubmitting {
		t.Fatalf("modelPickSubmitting must clear on response")
	}
	if um.modelID != "anthropic/claude-3-5-sonnet" {
		t.Fatalf("modelID = %q, want %q", um.modelID, "anthropic/claude-3-5-sonnet")
	}
	if um.configVersion != 7 {
		t.Fatalf("configVersion = %d, want 7", um.configVersion)
	}
	if um.inputMode != modeComposing {
		t.Fatalf("inputMode after success = %q, want %q", um.inputMode, modeComposing)
	}
	if got := um.viewport.Height(); got <= 0 {
		t.Fatalf("composer viewport height was not restored after model save, got %d", got)
	}
	view := stripANSICodes(viewContent(um.View()))
	if !strings.Contains(view, "> Ask BabeL-O") {
		t.Fatalf("composer input should be visible after model save:\n%s", view)
	}
	if cmd != nil {
		t.Fatalf("modelSelectMsg success should not return a follow-up cmd, got %T", cmd)
	}
	rendered := renderTranscript(um.transcript, 200)
	if !strings.Contains(rendered, "model saved: Claude 3.5 Sonnet") {
		t.Fatalf("transcript should announce the saved model by display name, got %q", rendered)
	}
	if !strings.Contains(rendered, "provider anthropic") {
		t.Fatalf("transcript should mention the new provider id, got %q", rendered)
	}
}

func TestProviderConfigMsgAppliesConfigAndEntersModelPicker(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelCatalog = runtimeModelsResponse{
		Providers: []registeredProvider{{
			ID:          "minimax",
			DisplayName: "MiniMax",
			AuthMode:    "api-key",
			Configured:  false,
			Models:      []registeredModel{{ID: "minimax/MiniMax-M3", Name: "MiniMax M3"}},
		}},
	}
	m.modelPickSelectedID = "minimax"
	m.setMode(modeModelPickBaseURL)

	updated, cmd := m.Update(providerConfigMsg{
		providerID: "minimax",
		config: runtimeConfig{
			Type:       "runtime_config",
			Version:    11,
			ModelID:    "local/coding-runtime",
			ProviderID: "local",
			AuthMode:   "none",
			HasAPIKey:  true,
		},
	})
	um, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if um.configVersion != 11 {
		t.Fatalf("configVersion = %d, want 11", um.configVersion)
	}
	if !um.modelCatalog.Providers[0].Configured {
		t.Fatalf("provider should be marked configured after providerConfigMsg")
	}
	if um.inputMode != modeModelPickModel {
		t.Fatalf("inputMode = %q, want %q", um.inputMode, modeModelPickModel)
	}
	if !um.modelPickerLoading {
		t.Fatalf("enterModelPicker should mark live model refresh as loading")
	}
	if cmd == nil {
		t.Fatalf("providerConfigMsg success should fetch runtime models")
	}
	rendered := renderTranscript(um.transcript, 200)
	if !strings.Contains(rendered, "provider configured: minimax") {
		t.Fatalf("transcript should announce provider configuration, got %q", rendered)
	}
}

func TestProviderConfigMsgErrorStaysOnBaseURLStep(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.setMode(modeModelPickBaseURL)

	updated, cmd := m.Update(providerConfigMsg{
		providerID: "minimax",
		err:        fmt.Errorf("unknown_provider"),
	})
	um, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if um.inputMode != modeModelPickBaseURL {
		t.Fatalf("inputMode = %q, want %q", um.inputMode, modeModelPickBaseURL)
	}
	if cmd != nil {
		t.Fatalf("providerConfigMsg error should not fetch model list, got %T", cmd)
	}
	rendered := renderTranscript(um.transcript, 200)
	if !strings.Contains(rendered, "provider config: unknown_provider") {
		t.Fatalf("transcript should surface provider config error, got %q", rendered)
	}
}

// TestModelSelectMsgErrorStaysInPicker verifies the failure
// path: a modelSelectMsg with err keeps modelPickSubmitting
// cleared, surfaces the error in the transcript, and does not
// flip m.modelID or transition to composing mode (the operator
// can pick a different model).
func TestModelSelectMsgErrorStaysInPicker(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelPickSubmitting = true
	m.setMode(modeModelPickModel)
	m.modelID = "openai/gpt-4o"
	preMode := m.inputMode

	updated, cmd := m.Update(modelSelectMsg{
		modelID: "anthropic/claude-3-5-sonnet",
		err:     fmt.Errorf("unknown_model: anthropic/claude-3-5-sonnet"),
	})
	um, ok := updated.(model)
	if !ok {
		t.Fatalf("expected model, got %T", updated)
	}
	if um.modelPickSubmitting {
		t.Fatalf("modelPickSubmitting must clear on error so the operator can pick again")
	}
	if um.modelID != "openai/gpt-4o" {
		t.Fatalf("modelID must not change on error, got %q", um.modelID)
	}
	if um.inputMode != preMode {
		t.Fatalf("inputMode changed on error: %q → %q", preMode, um.inputMode)
	}
	if cmd != nil {
		t.Fatalf("modelSelectMsg error should not return a follow-up cmd, got %T", cmd)
	}
	rendered := renderTranscript(um.transcript, 200)
	if !strings.Contains(rendered, "unknown_model") {
		t.Fatalf("transcript should surface the error, got %q", rendered)
	}
}

// TestScrollbarAtTop: with offset=0 the thumb sits at the top
// row. We assert the first line of the rendered scrollbar is the
// thumb glyph and the rest are track glyphs.
func TestScrollbarAtTop(t *testing.T) {
	got := Scrollbar(100, 20, 0, 20)
	lines := strings.Split(got, "\n")
	if len(lines) != 20 {
		t.Fatalf("scrollbar should have 20 lines, got %d", len(lines))
	}
	if !strings.Contains(lines[0], "┃") {
		t.Fatalf("at offset=0, first line should be thumb; got %q", lines[0])
	}
	// last line should be track, not thumb
	if !strings.Contains(lines[19], "│") {
		t.Fatalf("at offset=0, last line should be track; got %q", lines[19])
	}
}

// TestScrollbarAtBottom: with offset=maxOffset the thumb sits at
// the bottom. We assert the last line is the thumb.
func TestScrollbarAtBottom(t *testing.T) {
	got := Scrollbar(100, 20, 80, 20)
	lines := strings.Split(got, "\n")
	if !strings.Contains(lines[19], "┃") {
		t.Fatalf("at offset=maxOffset, last line should be thumb; got %q", lines[19])
	}
	if !strings.Contains(lines[0], "│") {
		t.Fatalf("at offset=maxOffset, first line should be track; got %q", lines[0])
	}
}

// TestScrollbarClampsThumbSize: when viewport ≫ total (extreme
// zoom-out) the thumb would otherwise consume the whole track.
// The helper must clamp thumbSize to height to avoid overflow.
func TestScrollbarClampsThumbSize(t *testing.T) {
	// total=10, viewport=20 — content is shorter than viewport,
	// early return: track-only, no thumb.
	got := Scrollbar(10, 20, 0, 20)
	lines := strings.Split(got, "\n")
	if len(lines) != 20 {
		t.Fatalf("short content should still return 20 lines, got %d", len(lines))
	}
	for i, l := range lines {
		if !strings.Contains(l, "│") {
			t.Fatalf("short content line %d should be track, got %q", i, l)
		}
	}
	// total=200, viewport=2000 — degenerate but possible; thumb
	// would compute to 100, must clamp to 20.
	got2 := Scrollbar(200, 2000, 0, 20)
	thumbCount := 0
	for _, l := range strings.Split(got2, "\n") {
		if strings.Contains(l, "┃") {
			thumbCount++
		}
	}
	if thumbCount > 20 {
		t.Fatalf("thumb should be clamped to height, got %d thumb rows", thumbCount)
	}
}

// TestScrollbarZeroContentReturnsTrackOnly: total=0 (empty
// transcript before any user input) should render track-only.
func TestScrollbarZeroContentReturnsTrackOnly(t *testing.T) {
	got := Scrollbar(0, 0, 0, 10)
	lines := strings.Split(got, "\n")
	if len(lines) != 10 {
		t.Fatalf("empty content should return 10 track lines, got %d", len(lines))
	}
	for i, l := range lines {
		if !strings.Contains(l, "│") {
			t.Fatalf("empty content line %d should be track, got %q", i, l)
		}
	}
	// height=0 must short-circuit to empty string.
	if got := Scrollbar(100, 20, 0, 0); got != "" {
		t.Fatalf("height=0 should return empty string, got %q", got)
	}
}

// TestButtonGroupRendersAllLabels: a group of three buttons
// joins every label into the output, separated by the configured
// spacing, regardless of the underline setting.
func TestButtonGroupRendersAllLabels(t *testing.T) {
	got := ButtonGroup([]ButtonOpt{
		{Text: "enter submit", UnderlineIndex: 0},
		{Text: "ctrl+c confirm", UnderlineIndex: 5},
		{Text: "q quit when idle", UnderlineIndex: 0},
	}, "  ")
	visible := stripANSICodes(got)
	for _, want := range []string{"enter submit", "ctrl+c confirm", "q quit when idle"} {
		if !strings.Contains(visible, want) {
			t.Fatalf("ButtonGroup visible output missing %q; visible=%q raw=%q", want, visible, got)
		}
	}
	// Two-space spacing between the three labels means exactly
	// two separator runs in the output.
	if c := strings.Count(got, "  "); c < 2 {
		t.Fatalf("ButtonGroup should contain 2+ separator runs, got %d in %q", c, got)
	}
}

// TestButtonGroupEmitsUnderlineEscapeOnHotkey: the underlined
// character position should carry an underline SGR escape so
// the terminal renders it as underlined. We don't care which
// exact escape sequence is not important; we just need an
// underline-related SGR (ESC [ … 4 … m) to be present in the
// output in both CI and real terminals.
func TestButtonGroupEmitsUnderlineEscapeOnHotkey(t *testing.T) {
	got := ButtonGroup([]ButtonOpt{
		{Text: "enter submit", UnderlineIndex: 0},
	}, "")
	if !strings.Contains(got, "\x1b[") {
		t.Fatalf("ButtonGroup should emit ANSI escapes for the underline, got %q", got)
	}
	// The SGR for the underlined rune must include the underline
	// attribute (4 in SGR). lipgloss combines Bold + Underline
	// into a single SGR like ESC[1;4m or ESC[1;4;4m, so we check
	// the first SGR segment after the opening ESC[ for the digit
	// 4, rather than the exact byte sequence (which is an
	// implementation detail of the active termenv profile).
	if !strings.HasPrefix(got, "\x1b[") {
		t.Fatalf("first chars should be an SGR opener, got %q", got)
	}
	if !strings.Contains(got[1:], "4") {
		t.Fatalf("first SGR should include underline (4), got %q", got)
	}
	// The visible text is broken by ANSI SGRs around the
	// underlined char, so strip them before checking the
	// surface text.
	stripped := stripANSICodes(got)
	if !strings.Contains(stripped, "enter submit") {
		t.Fatalf("ButtonGroup should still surface the original label text, got stripped=%q raw=%q", stripped, got)
	}
}

// TestButtonGroupEmptyInputReturnsEmptyString: defensive — an
// empty slice must short-circuit to "" so callers can pass a
// possibly-empty list (e.g. when no permission panel is open).
func TestButtonGroupEmptyInputReturnsEmptyString(t *testing.T) {
	if got := ButtonGroup(nil, "  "); got != "" {
		t.Fatalf("empty input should return empty string, got %q", got)
	}
}

// TestButtonGroupOutOfRangeUnderlineIsNoop: passing an
// UnderlineIndex beyond the label length is a no-op — the
// label renders unchanged, no panic, no spurious escape codes.
func TestButtonGroupOutOfRangeUnderlineIsNoop(t *testing.T) {
	got := ButtonGroup([]ButtonOpt{
		{Text: "ab", UnderlineIndex: 10}, // 10 > len("ab")
	}, "")
	if strings.Contains(got, "\x1b[") {
		t.Fatalf("out-of-range UnderlineIndex should not emit escapes, got %q", got)
	}
	if !strings.Contains(got, "ab") {
		t.Fatalf("label should still render, got %q", got)
	}
	// -1 also disables underlining.
	got2 := ButtonGroup([]ButtonOpt{
		{Text: "ab", UnderlineIndex: -1},
	}, "")
	if strings.Contains(got2, "\x1b[") {
		t.Fatalf("UnderlineIndex=-1 should not emit escapes, got %q", got2)
	}
}

// TestTranscriptWidthCapsAt120OnWideTerminal: when the terminal
// is 200 columns wide, the transcript content is wrapped to
// maxTranscriptWidth (120). Long lines should be split; no line
// in the rendered transcript should exceed 120 visible chars.
func TestTranscriptWidthCapsAt120OnWideTerminal(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 200
	m.height = 40
	m.resize()

	if m.viewport.Width() != maxTranscriptWidth {
		t.Fatalf("viewport.Width = %d, want capped to %d on 200-col terminal",
			m.viewport.Width(), maxTranscriptWidth)
	}

	// A long single word longer than the cap should still be
	// wrapped (formatLine / lipgloss.WordWrap will break it).
	longText := strings.Repeat("a", 200)
	m.transcript = []*transcriptItem{
		{kind: "status", text: longText},
	}
	rendered := renderTranscript(m.transcript, m.viewport.Width())
	for i, line := range strings.Split(rendered, "\n") {
		// strip ANSI escapes for the width check
		visible := stripANSICodes(line)
		if len(visible) > maxTranscriptWidth {
			t.Fatalf("transcript line %d length=%d exceeds cap %d: %q",
				i, len(visible), maxTranscriptWidth, visible)
		}
	}
}

// TestIsCompactTriggersAtWidthBelow120: terminal narrower than
// the width breakpoint enters compact mode regardless of height.
func TestIsCompactTriggersAtWidthBelow120(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 119
	m.height = 50
	if !m.isCompact() {
		t.Fatalf("width=119 should be compact, got isCompact=false")
	}
	m.width = 120
	if m.isCompact() {
		t.Fatalf("width=120 is the breakpoint boundary, should NOT be compact (>= 120)")
	}
	m.width = 200
	if m.isCompact() {
		t.Fatalf("width=200 should not be compact")
	}
}

// TestIsCompactTriggersAtHeightBelow30: short terminals enter
// compact mode regardless of width.
func TestIsCompactTriggersAtHeightBelow30(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 200
	m.height = 29
	if !m.isCompact() {
		t.Fatalf("height=29 should be compact, got isCompact=false")
	}
	m.height = 30
	if m.isCompact() {
		t.Fatalf("height=30 is the breakpoint boundary, should NOT be compact (>= 30)")
	}
	m.height = 50
	if m.isCompact() {
		t.Fatalf("height=50 should not be compact")
	}
}

// TestFooterInCompactModeOmitsSecondaryHints: in compact mode
// the footer should not surface inbox / sub-agents / usage
// counters — those go on a separate row that's hidden in
// compact to free vertical space.
func TestFooterInCompactModeOmitsSecondaryHints(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 100 // triggers compact
	m.height = 24

	// Populate side-channel state that would normally appear
	// on the second footer row. We don't need to fully populate
	// usage / inbox — the contract is that in compact mode, the
	// footer is a single line (no "\n"), so the side-channel
	// row simply cannot appear regardless of input.
	m.subAgents = map[string]subAgentEntry{
		"agent-1": {Status: subAgentStatusRunning},
	}

	footer := m.renderFooter(100)
	lines := strings.Split(footer, "\n")
	if len(lines) > 1 {
		t.Fatalf("compact footer should be 1 line, got %d:\n%q", len(lines), footer)
	}
}

func TestFooterShowsCrushStyleHelpHints(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30

	footer := stripANSICodes(m.renderFooter(120))
	for _, want := range []string{"/ or ctrl+p commands", "ctrl+l models", "shift+enter newline", "ctrl+c quit", "? help"} {
		if !strings.Contains(footer, want) {
			t.Fatalf("footer missing %q, got:\n%s", want, footer)
		}
	}
	if !strings.HasPrefix(footer, "  / or ctrl+p") {
		t.Fatalf("footer help should align with input content, got:\n%s", footer)
	}
	if strings.Contains(footer, "...") || strings.Contains(footer, "…") {
		t.Fatalf("footer help should not append a decorative ellipsis, got:\n%s", footer)
	}
}

func TestEmptyTranscriptPlaceholderAlignsWithContent(t *testing.T) {
	rendered := stripANSICodes(renderTranscript(nil, 120))
	if rendered != "  No messages yet." {
		t.Fatalf("empty transcript placeholder = %q, want content-aligned placeholder", rendered)
	}
}

func TestFooterCopyStatusOverridesHelp(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.copyToastMessage = "Selected text copied to clipboard"
	m.copyToastShownAt = time.Unix(20, 0)

	footer := stripANSICodes(m.renderFooter(120))
	if !strings.Contains(footer, "Selected text copied to clipboard") {
		t.Fatalf("copy status missing from footer:\n%s", footer)
	}
	if strings.Contains(footer, "enter send") {
		t.Fatalf("copy status should temporarily replace help row, got:\n%s", footer)
	}
}

func TestInputUsesCrushStyleMultilinePrompt(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()

	rendered := stripANSICodes(m.renderInput(120))
	for _, want := range []string{"> Ask BabeL-O"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("input missing %q, got:\n%s", want, rendered)
		}
	}
	if got := strings.Count(rendered, ":::"); got != inputMinHeight-1 {
		t.Fatalf("empty input should render Crush-style continuation rows = %d, want %d:\n%s",
			got, inputMinHeight-1, rendered)
	}
	if got, want := lipgloss.Height(m.renderInput(120)), inputMinHeight+1; got != want {
		t.Fatalf("empty input chrome height = %d, want divider + textarea min height %d", got, want)
	}
	if got := m.input.Height(); got != inputMinHeight {
		t.Fatalf("empty input height = %d, want %d", got, inputMinHeight)
	}
}

func TestViewHeightBudgetAccountsForMultilineInputChrome(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()

	view := viewContent(m.View())
	if got := lipgloss.Height(view); got != m.height {
		t.Fatalf("view height = %d, want terminal height %d; full view:\n%s", got, m.height, stripANSICodes(view))
	}
	if !strings.Contains(stripANSICodes(view), "BabeL-O · Go TUI") {
		t.Fatalf("view should keep header title visible after multiline input layout; got:\n%s", stripANSICodes(view))
	}
}

func TestViewHeightBudgetKeepsRunningFooterVisible(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()
	m.input.SetValue("hello")
	m.syncInputHeight()

	updated, _ := m.Update(keyPress(tea.KeyEnter))
	after := updated.(model)
	view := viewContent(after.View())
	plain := stripANSICodes(view)
	if got := lipgloss.Height(view); got != after.height {
		t.Fatalf("running view height = %d, want terminal height %d; full view:\n%s", got, after.height, plain)
	}
	if !strings.Contains(plain, "waiting for Nexus events") {
		t.Fatalf("running footer should remain visible, got:\n%s", plain)
	}
	if !strings.HasSuffix(plain, stripANSICodes(after.renderFooter(after.width))) {
		t.Fatalf("running footer should be the final rendered row, got:\n%s", plain)
	}
}

func TestRunningViewShowsRuntimeWaveAboveInput(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.running = true
	m.startedAt = time.Unix(20, 0)
	m.resize()

	view := viewContent(m.View())
	plain := stripANSICodes(view)
	if got := lipgloss.Height(view); got != m.height {
		t.Fatalf("running wave view height = %d, want terminal height %d; full view:\n%s", got, m.height, plain)
	}
	if !strings.Contains(plain, "agent runtime") {
		t.Fatalf("running wave row missing from view:\n%s", plain)
	}
	if strings.Index(plain, "agent runtime") > strings.Index(plain, "> Ask BabeL-O") {
		t.Fatalf("running wave should render above the input prompt, got:\n%s", plain)
	}
	if !strings.HasSuffix(plain, stripANSICodes(m.renderFooter(m.width))) {
		t.Fatalf("footer should remain the final rendered row with running wave enabled, got:\n%s", plain)
	}
}

func TestRuntimeLightBarUsesStableWidthAndCache(t *testing.T) {
	spin := newGradientSpinner()
	first := spin.LightBar(24, runtimeAnimationDefault)
	if got := lipgloss.Width(first); got != 24 {
		t.Fatalf("light bar width = %d, want 24; raw=%q", got, first)
	}
	key := runtimeAnimationCacheKey{width: 24, kind: runtimeAnimationDefault}
	if len(spin.lightBarFrames[key]) != prerenderedFrames {
		t.Fatalf("light bar should prerender %d frames, got %d", prerenderedFrames, len(spin.lightBarFrames[key]))
	}
	second := spin.LightBar(24, runtimeAnimationDefault)
	if second != first {
		t.Fatalf("same step and width should reuse the same rendered frame")
	}
	tool := spin.LightBar(24, runtimeAnimationTool)
	if tool == first {
		t.Fatalf("different runtime animation kinds should render distinct frames")
	}
}

func TestRuntimeAnimationStateFollowsAgentEvent(t *testing.T) {
	tests := []struct {
		name      string
		eventType string
		pending   bool
		wantLabel string
		wantKind  runtimeAnimationKind
	}{
		{name: "thinking", eventType: "thinking_delta", wantLabel: "agent thinking", wantKind: runtimeAnimationThinking},
		{name: "assistant output", eventType: "assistant_delta", wantLabel: "agent writing", wantKind: runtimeAnimationResponding},
		{name: "tool started", eventType: "tool_started", wantLabel: "tool activity", wantKind: runtimeAnimationTool},
		{name: "tool completed", eventType: "tool_completed", wantLabel: "tool activity", wantKind: runtimeAnimationTool},
		{name: "permission event", eventType: "permission_request", wantLabel: "permission needed", wantKind: runtimeAnimationPermission},
		{name: "pending overrides", eventType: "assistant_delta", pending: true, wantLabel: "permission needed", wantKind: runtimeAnimationPermission},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
			m.running = true
			m.lastEventType = tc.eventType
			if tc.pending {
				m.pending = &pendingPermission{name: "Bash"}
			}
			label, kind := m.runtimeAnimationState()
			if !strings.Contains(label, tc.wantLabel) || kind != tc.wantKind {
				t.Fatalf("runtimeAnimationState = (%q, %q), want label containing %q kind %q",
					label, kind, tc.wantLabel, tc.wantKind)
			}
		})
	}
}

func TestViewHeightBudgetDoesNotLeaveBottomOverflowAtMediumHeight(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/Users/tangyaoyue/DEV/BABEL/BabeL-O"})
	m.width = 132
	m.height = 40
	m.resize()

	view := viewContent(m.View())
	if got := lipgloss.Height(view); got > m.height {
		t.Fatalf("view height = %d exceeds terminal height %d; full view:\n%s", got, m.height, stripANSICodes(view))
	}
	plain := stripANSICodes(view)
	footer := stripANSICodes(m.renderFooter(m.width))
	if !strings.HasSuffix(plain, footer) {
		t.Fatalf("footer should be the final rendered row with no extra bottom blank area; got tail:\n%s", plain)
	}
}

func TestViewDoesNotRenderRightScrollbar(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()

	plain := stripANSICodes(viewContent(m.View()))
	for _, line := range strings.Split(plain, "\n") {
		if strings.HasSuffix(line, "┃") || strings.HasSuffix(line, "│") {
			t.Fatalf("view should not render right-side scrollbar, got line %q in:\n%s", line, plain)
		}
	}
}

func TestInputCtrlJInsertsNewlineAndGrows(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()
	m.input.SetValue("first")
	m.syncInputHeight()

	updated, cmd := m.Update(ctrlKey('j'))
	if cmd != nil {
		t.Fatalf("ctrl+j newline should not send a prompt, got cmd %T", cmd)
	}
	after := updated.(model)
	if got := after.input.Value(); got != "first\n" {
		t.Fatalf("ctrl+j input = %q, want %q", got, "first\n")
	}
	if after.input.Height() < inputMinHeight || after.input.Height() > inputMaxHeight {
		t.Fatalf("input height after newline = %d, want within [%d,%d]",
			after.input.Height(), inputMinHeight, inputMaxHeight)
	}
}

func TestInputShiftEnterCSIInsertsNewlineAndDoesNotSend(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()
	m.input.SetValue("first")
	m.syncInputHeight()

	updated, cmd := m.Update(textKey("\x1b[13;2u"))
	if cmd != nil {
		t.Fatalf("shift+enter CSI newline should not send a prompt, got cmd %T", cmd)
	}
	after := updated.(model)
	if got := after.input.Value(); got != "first\n" {
		t.Fatalf("shift+enter CSI input = %q, want %q", got, "first\n")
	}
}

func TestInputUnknownShiftEnterCSIInsertsNewline(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()
	m.input.SetValue("first")
	m.syncInputHeight()

	updated, cmd := m.Update(fmt.Stringer(fmtString("?CSI[49 51 59 50 117]?")))
	if cmd != nil {
		t.Fatalf("unknown shift+enter CSI newline should not send a prompt, got cmd %T", cmd)
	}
	after := updated.(model)
	if got := after.input.Value(); got != "first\n" {
		t.Fatalf("unknown shift+enter CSI input = %q, want %q", got, "first\n")
	}
}

func TestUnknownCSIMouseWheelDoesNotTypeIntoInput(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	m.width = 120
	m.height = 30
	m.resize()
	m.viewport.SetContent(strings.Repeat("line\n", 80))
	m.viewport.SetYOffset(20)
	startingYOffset := m.viewport.YOffset()

	updated, cmd := m.Update(fmt.Stringer(fmtString("?CSI[60 54 53 59 52 53 59 53 77]?")))
	if cmd != nil {
		t.Fatalf("unknown CSI mouse wheel should not produce cmd, got %T", cmd)
	}
	after := updated.(model)
	if got := after.input.Value(); got != "" {
		t.Fatalf("unknown CSI mouse wheel typed into input: %q", got)
	}
	if got, want := after.viewport.YOffset(), startingYOffset+mouseWheelStepLines; got != want {
		t.Fatalf("unknown CSI wheel YOffset = %d, want %d", got, want)
	}
}

func TestInputBackslashEnterInsertsNewline(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()
	m.input.SetValue("first\\")
	m.syncInputHeight()

	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	if cmd != nil {
		t.Fatalf("backslash-enter newline should not send a prompt, got cmd %T", cmd)
	}
	after := updated.(model)
	if got := after.input.Value(); got != "first\n" {
		t.Fatalf("backslash-enter input = %q, want %q", got, "first\n")
	}
}

func TestEnterSendsMultilinePromptAndResetsHeight(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 120
	m.height = 30
	m.resize()
	m.input.SetValue("first\nsecond\nthird\nfourth")
	m.syncInputHeight()
	if m.input.Height() <= inputMinHeight {
		t.Fatalf("test setup expected grown input height, got %d", m.input.Height())
	}

	updated, cmd := m.Update(keyPress(tea.KeyEnter))
	if cmd == nil {
		t.Fatalf("enter should send multiline prompt and return stream cmd")
	}
	after := updated.(model)
	if got := after.input.Value(); got != "" {
		t.Fatalf("enter should clear input, got %q", got)
	}
	if got := after.input.Height(); got != inputMinHeight {
		t.Fatalf("input height after send = %d, want %d", got, inputMinHeight)
	}
	rendered := stripANSICodes(renderTranscript(after.transcript, 120))
	if !strings.Contains(rendered, "first") || !strings.Contains(rendered, "second") {
		t.Fatalf("transcript should include multiline prompt, got:\n%s", rendered)
	}
}

// TestVersionedBumpAdvancesCounter: Bump is the contract that
// invalidates the render cache. This is a one-liner but
// worth pinning down.
func TestVersionedBumpAdvancesCounter(t *testing.T) {
	v := NewVersioned()
	if v.Version() != 0 {
		t.Fatalf("fresh Versioned should start at 0, got %d", v.Version())
	}
	v.Bump()
	if v.Version() != 1 {
		t.Fatalf("after one Bump, version = %d, want 1", v.Version())
	}
	v.Bump()
	v.Bump()
	if v.Version() != 3 {
		t.Fatalf("after three Bumps, version = %d, want 3", v.Version())
	}
}

// TestRenderCacheHitsOnSameInputs: the second GetOrCompute
// call with the same (width, version) returns the cached
// view and does NOT call render again.
func TestRenderCacheHitsOnSameInputs(t *testing.T) {
	var c renderCache
	calls := 0
	render := func() string {
		calls++
		return "hello"
	}
	if got := c.GetOrCompute(80, 1, render); got != "hello" {
		t.Fatalf("first call: got %q, want %q", got, "hello")
	}
	if calls != 1 {
		t.Fatalf("first call should invoke render once, got %d", calls)
	}
	if got := c.GetOrCompute(80, 1, render); got != "hello" {
		t.Fatalf("second call: got %q, want %q", got, "hello")
	}
	if calls != 1 {
		t.Fatalf("second call should hit the cache, got %d render invocations", calls)
	}
}

// TestRenderCacheMissesOnBump: a version bump (via Bump())
// invalidates the cache and the next call re-renders.
func TestRenderCacheMissesOnBump(t *testing.T) {
	var c renderCache
	calls := 0
	render := func() string {
		calls++
		return fmt.Sprintf("v%d", calls)
	}
	_ = c.GetOrCompute(80, 1, render)
	if got := c.GetOrCompute(80, 2, render); got != "v2" {
		t.Fatalf("after version bump: got %q, want %q (re-rendered)", got, "v2")
	}
	if calls != 2 {
		t.Fatalf("expected 2 render invocations, got %d", calls)
	}
}

// TestRenderCacheMissesOnWidthChange: a width change
// (terminal resize) invalidates the cache and the next call
// re-renders at the new width.
func TestRenderCacheMissesOnWidthChange(t *testing.T) {
	var c renderCache
	calls := 0
	render := func() string {
		calls++
		return fmt.Sprintf("w%d", calls)
	}
	_ = c.GetOrCompute(80, 1, render)
	if got := c.GetOrCompute(120, 1, render); got != "w2" {
		t.Fatalf("after width change: got %q, want %q (re-rendered)", got, "w2")
	}
	if calls != 2 {
		t.Fatalf("expected 2 render invocations, got %d", calls)
	}
}

// TestRenderCacheInvalidate: Invalidate() drops the entry so
// the next call re-renders, even at the same width and
// version. This is the escape hatch for paths that mutate the
// item without going through Bump.
func TestRenderCacheInvalidate(t *testing.T) {
	var c renderCache
	calls := 0
	render := func() string {
		calls++
		return fmt.Sprintf("v%d", calls)
	}
	_ = c.GetOrCompute(80, 1, render)
	c.Invalidate()
	if got := c.GetOrCompute(80, 1, render); got != "v2" {
		t.Fatalf("after Invalidate: got %q, want %q (re-rendered)", got, "v2")
	}
}

// TestTranscriptItemRendersIdenticalOutputBeforeAndAfterCache:
// the cache must be a transparent optimization — the rendered
// transcript must be byte-identical whether the cache is hot
// or cold. We render twice in a row and compare.
func TestTranscriptItemRendersIdenticalOutputBeforeAndAfterCache(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.transcript = []*transcriptItem{
		{kind: "user", text: "hello", Versioned: NewVersioned()},
		{kind: "assistant", text: "world", Versioned: NewVersioned()},
	}
	width := 80
	first := renderTranscript(m.transcript, width)
	// Mutate Bump manually between renders? No — that would
	// change the version and force a re-render. Instead, just
	// render again with the same inputs and compare. The
	// second render must hit the cache.
	second := renderTranscript(m.transcript, width)
	if first != second {
		t.Fatalf("cached render should be byte-identical to fresh render\nfirst:\n%s\nsecond:\n%s", first, second)
	}
}

// TestTranscriptItemBumpInvalidatesCache: bumping the version
// on a single item forces that item's row to re-render while
// leaving other items' cached views intact.
func TestTranscriptItemBumpInvalidatesCache(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	a := &transcriptItem{kind: "user", text: "alpha", Versioned: NewVersioned()}
	b := &transcriptItem{kind: "user", text: "beta", Versioned: NewVersioned()}
	m.transcript = []*transcriptItem{a, b}
	width := 80

	// Cold render populates both caches.
	_ = renderTranscript(m.transcript, width)
	if a.cache.view == "" || b.cache.view == "" {
		t.Fatalf("cold render should populate both caches; a=%q b=%q", a.cache.view, b.cache.view)
	}

	// Bump `a` only; the next render should re-render `a` and
	// leave `b` alone. We can observe this by mutating the
	// render output via a side-channel counter — but since
	// renderTranscript doesn't expose a counter, we just
	// assert that the rendered output stays correct and `b`'s
	// cached view string pointer is unchanged.
	bViewBefore := b.cache.view
	a.Bump()
	out := renderTranscript(m.transcript, width)
	if !strings.Contains(out, "alpha") || !strings.Contains(out, "beta") {
		t.Fatalf("render after bump should still surface both items, got %q", out)
	}
	// b was not bumped; its cached view should be untouched.
	if b.cache.view != bViewBefore {
		t.Fatalf("b's cache should be untouched by a.Bump, got %q want %q", b.cache.view, bViewBefore)
	}
	// a's cache version should now be 1.
	if a.cache.cachedVersion != 1 {
		t.Fatalf("a's cache version should be 1 after Bump, got %d", a.cache.cachedVersion)
	}
}

// TestStreamingOnlyInvalidatesTailItem: the canonical
// streaming scenario — a long transcript where the last item
// is being incrementally appended. Only the tail item should
// re-render on each Bump; all preceding items should hit the
// cache. We assert this by snapshotting each prior item's
// cached view pointer and checking it's untouched across 10
// streaming chunks.
func TestStreamingOnlyInvalidatesTailItem(t *testing.T) {
	const N = 50
	tail := &transcriptItem{kind: "assistant", text: "", Versioned: NewVersioned()}
	transcript := make([]*transcriptItem, 0, N+1)
	for i := 0; i < N; i++ {
		transcript = append(transcript, &transcriptItem{
			kind:      "user",
			text:      fmt.Sprintf("prior line %d", i),
			Versioned: NewVersioned(),
		})
	}
	transcript = append(transcript, tail)
	width := 80

	// Cold render: every item is rendered for the first time.
	_ = renderTranscript(transcript, width)

	// Snapshot every prior item's cached view string. After
	// streaming, all of these should be byte-identical
	// (cache hits, no re-render).
	priorViews := make([]string, N)
	for i := 0; i < N; i++ {
		priorViews[i] = transcript[i].cache.view
	}

	// 10 streaming chunks — each Bumps the tail.
	for i := 0; i < 10; i++ {
		tail.text += fmt.Sprintf(" chunk%d", i)
		tail.Bump()
		_ = renderTranscript(transcript, width)
	}

	// Verify every prior item's cached view is unchanged.
	for i := 0; i < N; i++ {
		if transcript[i].cache.view != priorViews[i] {
			t.Fatalf("prior item %d cache should be untouched across 10 streaming chunks; got %q want %q",
				i, transcript[i].cache.view, priorViews[i])
		}
	}
	// Tail's cache version should equal the number of Bumps
	// (initial 0, then 10 Bumps → 10).
	if tail.cache.cachedVersion != 10 {
		t.Fatalf("tail cache version should be 10 after 10 Bumps, got %d", tail.cache.cachedVersion)
	}
}

// BenchmarkTranscriptRenderCold / BenchmarkTranscriptRenderWarm:
// measures the per-frame cost of rendering a 100-line transcript
// before and after the cache is populated. With Phase B.2 the
// warm case should be substantially cheaper than the cold case
// because formatLine is only called for the items whose version
// was bumped between frames. The "warm" benchmark calls
// renderTranscript repeatedly with no Bump, so every call is a
// pure cache hit — this is the upper bound on what the cache
// can save.
func BenchmarkTranscriptRenderCold100Lines(b *testing.B) {
	transcript := makeTranscriptForBench(100, 80)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, it := range transcript {
			it.cache.Invalidate()
		}
		_ = renderTranscript(transcript, 80)
	}
}

func BenchmarkTranscriptRenderWarm100Lines(b *testing.B) {
	transcript := makeTranscriptForBench(100, 80)
	// Warm up: populate the cache.
	_ = renderTranscript(transcript, 80)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = renderTranscript(transcript, 80)
	}
}

// BenchmarkTranscriptRenderStreaming: simulates the streaming
// pattern — a long transcript with a tail item being
// repeatedly Bumped. Each iteration re-renders the full
// transcript, but only the tail should re-execute formatLine.
// This is the realistic per-frame cost during a stream.
func BenchmarkTranscriptRenderStreaming100Lines(b *testing.B) {
	transcript := makeTranscriptForBench(100, 80)
	tail := transcript[len(transcript)-1]
	// Warm up: populate the cache for the initial state.
	_ = renderTranscript(transcript, 80)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tail.text += "x"
		tail.Bump()
		_ = renderTranscript(transcript, 80)
	}
}

// makeTranscriptForBench is a helper that builds a synthetic
// transcript of n user-kind lines for use by the render
// benchmarks. The text is wrap-friendly to mimic a real
// transcript where most rows are single-line.
func makeTranscriptForBench(n, width int) []*transcriptItem {
	out := make([]*transcriptItem, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, &transcriptItem{
			kind:      "user",
			text:      fmt.Sprintf("line %d %s", i, strings.Repeat("a", max(0, width-8))),
			Versioned: NewVersioned(),
		})
	}
	return out
}

// fakeDialog is a minimal Dialog used by the RenderContext /
// InputCursor tests. It returns canned values for ID() and
// View(), and a no-op HandleMsg. The point of these tests is
// to exercise the RenderContext builder and the InputCursor
// helper, not to drive the full dialog flow.
type fakeDialog struct {
	id      string
	view    string
	cmdSeen int
}

func (f *fakeDialog) ID() string                  { return f.id }
func (f *fakeDialog) HandleMsg(_ tea.Msg) tea.Cmd { f.cmdSeen++; return nil }
func (f *fakeDialog) View(_ int) string           { return f.view }

// TestDialogInterfaceImplements: a smoke check that the
// Dialog interface is satisfied by a value with the three
// required methods. The compiler enforces this; the test
// pins the contract down so future refactors don't
// accidentally drop a method.
func TestDialogInterfaceImplements(t *testing.T) {
	var d Dialog = &fakeDialog{id: "fake", view: "body"}
	if d.ID() != "fake" {
		t.Fatalf("ID() = %q, want %q", d.ID(), "fake")
	}
	if d.View(80) != "body" {
		t.Fatalf("View(80) = %q, want %q", d.View(80), "body")
	}
	if d.HandleMsg(keyPress(tea.KeyEnter)) != nil {
		t.Fatalf("HandleMsg should return nil for a no-op fake")
	}
}

// TestRenderContextRendersTitleBodyHelp: the canonical
// 3-part dialog (title + body + help) produces all three
// pieces in the expected order, separated by newlines.
func TestRenderContextRendersTitleBodyHelp(t *testing.T) {
	rc := NewRenderContext(80)
	rc.Title = "Editing rule for Bash"
	rc.AddPart("rule line")
	rc.AddPart("hint line")
	rc.Help = "↵ confirm  esc back"
	out := rc.Render()
	for _, want := range []string{"Editing rule for Bash", "rule line", "hint line", "↵ confirm  esc back"} {
		if !strings.Contains(out, want) {
			t.Fatalf("Render() missing %q\nfull:\n%s", want, out)
		}
	}
}

// TestRenderContextTitleInfoRightAligned: TitleInfo renders
// on the same row as Title, right-aligned via joinColumns.
// We assert the title and the titleInfo both appear in the
// output (their exact column positions depend on
// joinColumns' implementation; we just check both surface).
func TestRenderContextTitleInfoRightAligned(t *testing.T) {
	rc := NewRenderContext(80)
	rc.Title = "step 1"
	rc.TitleInfo = "1/3"
	out := rc.Render()
	if !strings.Contains(out, "step 1") {
		t.Fatalf("missing title %q in %q", "step 1", out)
	}
	if !strings.Contains(out, "1/3") {
		t.Fatalf("missing titleInfo %q in %q", "1/3", out)
	}
}

// TestRenderContextEmptyTitleSkipsTitleRow: when Title is
// empty the output should not contain an empty leading
// line — useful for overlays like the help card that don't
// need a title.
func TestRenderContextEmptyTitleSkipsTitleRow(t *testing.T) {
	rc := NewRenderContext(80)
	rc.AddPart("body only")
	rc.Help = "esc back"
	out := rc.Render()
	if strings.HasPrefix(out, "\n") {
		t.Fatalf("output should not start with newline, got %q", out)
	}
	if !strings.Contains(out, "body only") {
		t.Fatalf("missing body %q in %q", "body only", out)
	}
}

// TestRenderContextEmptyHelpSkipsHelpRow: when Help is
// empty (some dialogs have no key hints) the output should
// not contain a trailing empty line.
func TestRenderContextEmptyHelpSkipsHelpRow(t *testing.T) {
	rc := NewRenderContext(80)
	rc.Title = "only title"
	rc.AddPart("body")
	out := rc.Render()
	if strings.HasSuffix(out, "\n") {
		t.Fatalf("output should not end with newline, got %q", out)
	}
}

// TestRenderContextEmptyInputProducesEmptyOutput: defensive
// — when nothing is added (no title, no body, no help), the
// result is an empty string. The main model's overlay stack
// relies on this to skip rendering a "ghost" dialog.
func TestRenderContextEmptyInputProducesEmptyOutput(t *testing.T) {
	rc := NewRenderContext(80)
	if got := rc.Render(); got != "" {
		t.Fatalf("empty RenderContext should produce empty string, got %q", got)
	}
}

// TestInputCursorAccountsForTitleAndPrompt: a dialog with
// a title + a "> " prompt input box should land the cursor
// at (x0 + 2, y0 + 2) — one row down for the title, one
// row down for the frame top border, two columns right for
// the "> " prompt.
func TestInputCursorAccountsForTitleAndPrompt(t *testing.T) {
	x, y := InputCursor(0, 0, true /*hasTitle*/, ">  Ask BabeL-O")
	if x != 2 {
		t.Fatalf("x = %d, want 2 (x0 + 2 for the prompt)", x)
	}
	if y != 2 {
		t.Fatalf("y = %d, want 2 (y0 + 1 title + 1 frame top)", y)
	}
}

// TestInputCursorNoTitleStillAddsFrameBorder: a dialog
// without a title still gets the +1 for the frame's top
// border. Cursor lands at (x0 + 2, y0 + 1).
func TestInputCursorNoTitleStillAddsFrameBorder(t *testing.T) {
	x, y := InputCursor(0, 0, false /*no title*/, ">  Ask BabeL-O")
	if x != 2 {
		t.Fatalf("x = %d, want 2", x)
	}
	if y != 1 {
		t.Fatalf("y = %d, want 1 (no title, just the frame border)", y)
	}
}

// TestInputCursorNoPrompt: an input view that doesn't start
// with a recognised prompt should land at x=x0 (no prompt
// width added).
func TestInputCursorNoPrompt(t *testing.T) {
	x, y := InputCursor(5, 5, true, "no prompt here")
	if x != 5 {
		t.Fatalf("x = %d, want 5 (no prompt)", x)
	}
	if y != 7 {
		t.Fatalf("y = %d, want 7 (5 + 1 title + 1 frame)", y)
	}
}

// === Phase C.2: helpDialog (renderHelp migration) ===

// TestHelpDialogIDIsHelpOverlay: the dialog's stable id must
// match the modeHelpOverlay inputMode constant so logs and
// tests can correlate the overlay frame with its mode.
func TestHelpDialogIDIsHelpOverlay(t *testing.T) {
	d := newHelpDialog(0, 24)
	if d.ID() != "helpOverlay" {
		t.Fatalf("ID() = %q, want %q", d.ID(), "helpOverlay")
	}
}

// TestHelpDialogHandleMsgIsNoOp: per C.2 (structure migration
// only) HandleMsg must return nil for every msg type. The main
// model still owns helpScroll mutation via its Update dispatch;
// C.3 will move that logic into HandleMsg.
func TestHelpDialogHandleMsgIsNoOp(t *testing.T) {
	d := newHelpDialog(0, 24)
	if cmd := d.HandleMsg(nil); cmd != nil {
		t.Fatalf("HandleMsg(nil) cmd = %v, want nil", cmd)
	}
	if cmd := d.HandleMsg(keyPress(tea.KeyDown)); cmd != nil {
		t.Fatalf("HandleMsg(KeyDown) cmd = %v, want nil", cmd)
	}
}

// TestHelpDialogViewContainsTitleAndFirstLine: the canonical
// case — a fresh dialog at scroll=0 must render the "Help"
// title and the first helpOverlayLines entry. This is the
// substring contract that TestRenderHelpVisibleInHelpMode
// relies on.
func TestHelpDialogViewContainsTitleAndFirstLine(t *testing.T) {
	d := newHelpDialog(0, 30) // height=30 → visibleRows=18, enough for the first line
	out := d.View(80)
	if !strings.Contains(out, "Help") {
		t.Fatalf("View(80) missing 'Help' title:\n%s", out)
	}
	if !strings.Contains(out, helpOverlayLines[0]) {
		t.Fatalf("View(80) missing first helpOverlayLine %q:\n%s", helpOverlayLines[0], out)
	}
}

// TestHelpDialogViewHonorsScroll: scroll=N must skip the first
// N lines of helpOverlayLines. We check that the line at index
// 0 no longer appears (it was scrolled past) and the line at
// index N appears.
func TestHelpDialogViewHonorsScroll(t *testing.T) {
	// Pick a non-empty line further down to avoid the leading
	// blank entries that would match an empty substring.
	scroll := 4
	target := ""
	for i := scroll; i < len(helpOverlayLines); i++ {
		if strings.TrimSpace(helpOverlayLines[i]) != "" {
			target = helpOverlayLines[i]
			break
		}
	}
	if target == "" {
		t.Skip("no non-empty line after scroll point — helpOverlayLines shape changed?")
	}
	d := newHelpDialog(scroll, 30)
	out := d.View(80)
	if !strings.Contains(out, target) {
		t.Fatalf("View at scroll=%d missing %q:\n%s", scroll, target, out)
	}
	// helpOverlayLines[0] is "BabeL-O Go TUI · Local key reference" —
	// scrolling past it should drop it from the visible window.
	if strings.Contains(out, helpOverlayLines[0]) {
		t.Fatalf("View at scroll=%d still shows helpOverlayLines[0] %q:\n%s",
			scroll, helpOverlayLines[0], out)
	}
}

// TestHelpDialogViewClampsScrollPastEnd: scroll values far
// beyond the maximum must clamp to maxScroll (rather than
// panicking or returning empty). The dialog should still
// render — showing the tail of helpOverlayLines.
func TestHelpDialogViewClampsScrollPastEnd(t *testing.T) {
	d := newHelpDialog(9999, 30)
	out := d.View(80)
	if out == "" {
		t.Fatalf("View at scroll=9999 returned empty output")
	}
	// The very last line is the "Press esc / enter / q" footer
	// hint — at clamped scroll, it should be visible.
	last := helpOverlayLines[len(helpOverlayLines)-1]
	if !strings.Contains(out, last) {
		t.Fatalf("View at scroll=9999 missing last line %q:\n%s", last, out)
	}
}

// TestHelpDialogViewClampsNegativeScroll: negative scroll
// values must clamp to 0 (paranoid defence — the main model
// never sets negative, but a future caller might).
func TestHelpDialogViewClampsNegativeScroll(t *testing.T) {
	d := newHelpDialog(-5, 30)
	out := d.View(80)
	if !strings.Contains(out, helpOverlayLines[0]) {
		t.Fatalf("View at scroll=-5 missing helpOverlayLines[0] %q:\n%s",
			helpOverlayLines[0], out)
	}
}

// TestHelpDialogViewWrapsInOverlayFrame: the rendered output
// must be wrapped in the overlayFrameStyle border. We detect
// the border by looking for the box-drawing characters
// lipgloss.NormalBorder() emits (the corner glyphs ┌ ┐ └ ┘).
func TestHelpDialogViewWrapsInOverlayFrame(t *testing.T) {
	d := newHelpDialog(0, 30)
	out := d.View(80)
	for _, glyph := range []string{"┌", "┐", "└", "┘"} {
		if !strings.Contains(out, glyph) {
			t.Fatalf("View missing border glyph %q:\n%s", glyph, out)
		}
	}
}

// TestRenderHelpStillDelegatesToHelpDialog: model.renderHelp
// in helpOverlay mode must produce the same output as
// helpDialog.View(width) with the model's snapshot. This is a
// regression guard for the C.2 migration: if someone reverts
// renderHelp to inline rendering, the two outputs would
// diverge.
func TestRenderHelpStillDelegatesToHelpDialog(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.width = 80
	m.height = 24
	m.setMode(modeHelpOverlay)
	m.helpScroll = 3
	got := m.renderHelp(80)
	want := newHelpDialog(3, 24).View(80)
	if got != want {
		t.Fatalf("renderHelp(80) diverges from helpDialog.View(80):\n--- got ---\n%s\n--- want ---\n%s",
			got, want)
	}
}

// === Phase C.2: modelPickApiKeyDialog (renderModelPickApiKey migration) ===

func TestModelPickApiKeyDialogID(t *testing.T) {
	d := newModelPickApiKeyDialog(nil, "> paste API key (or accept default)")
	if d.ID() != "modelPickApiKey" {
		t.Fatalf("ID() = %q, want %q", d.ID(), "modelPickApiKey")
	}
}

func TestModelPickApiKeyDialogHandleMsgIsNoOp(t *testing.T) {
	d := newModelPickApiKeyDialog(nil, "> paste API key (or accept default)")
	if cmd := d.HandleMsg(keyPress(tea.KeyEnter)); cmd != nil {
		t.Fatalf("HandleMsg(KeyEnter) cmd = %v, want nil", cmd)
	}
}

func TestModelPickApiKeyDialogViewContainsProviderDefaultAndInput(t *testing.T) {
	provider := &registeredProvider{
		ID:           "anthropic",
		DefaultModel: "claude-sonnet-4-6",
	}
	d := newModelPickApiKeyDialog(provider, "> paste API key")
	out := d.View(100)
	for _, want := range []string{
		"Enter your anthropic Key",
		"Paste a single-line provider key",
		"default model  claude-sonnet-4-6",
		"config target  global provider credentials",
		"> paste API key",
		"enter continue · esc back · ctrl+u clear",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("View(100) missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "> >") {
		t.Fatalf("View(100) rendered a double-prompt line:\n%s", out)
	}
}

func TestRenderModelPickApiKeyStillDelegatesToDialog(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelCatalog = runtimeModelsResponse{
		Providers: []registeredProvider{{
			ID:           "anthropic",
			DisplayName:  "Anthropic",
			DefaultModel: "claude-sonnet-4-6",
		}},
	}
	m.modelPickSelectedID = "anthropic"
	m.setMode(modeModelPickApiKey)
	m.modelPickAPIKeyDraft = "sk-ant-1234567890"
	got := m.renderModelPickApiKey(100)
	want := newModelPickApiKeyDialog(m.currentModelProvider(), modelAPIKeyFieldDisplay(m.modelPickAPIKeyDraft)).View(100)
	if got != want {
		t.Fatalf("renderModelPickApiKey(100) diverges from dialog View:\n--- got ---\n%s\n--- want ---\n%s",
			got, want)
	}
}

func TestModelPickApiKeyDialogMasksFullSecret(t *testing.T) {
	secret := "sk-ant-1234567890SECRET"
	out := newModelPickApiKeyDialog(nil, modelAPIKeyFieldDisplay(secret)).View(100)
	visible := stripANSICodes(out)
	if strings.Contains(visible, secret) {
		t.Fatalf("api key dialog leaked full secret:\n%s", visible)
	}
	if !strings.Contains(visible, "sk-ant…CRET") {
		t.Fatalf("api key dialog should show a compact masked hint, got:\n%s", visible)
	}
	if strings.Contains(visible, ":::") {
		t.Fatalf("api key dialog should not render textarea continuation prompts:\n%s", visible)
	}
}

// === Phase C.2: modelPickBaseURLDialog (renderModelPickBaseURL migration) ===

func TestModelPickBaseURLDialogID(t *testing.T) {
	d := newModelPickBaseURLDialog(nil, "> https://api.example.com")
	if d.ID() != "modelPickBaseURL" {
		t.Fatalf("ID() = %q, want %q", d.ID(), "modelPickBaseURL")
	}
}

func TestModelPickBaseURLDialogHandleMsgIsNoOp(t *testing.T) {
	d := newModelPickBaseURLDialog(nil, "> https://api.example.com")
	if cmd := d.HandleMsg(keyPress(tea.KeyEnter)); cmd != nil {
		t.Fatalf("HandleMsg(KeyEnter) cmd = %v, want nil", cmd)
	}
}

func TestModelPickBaseURLDialogViewContainsProviderDefaultAndInput(t *testing.T) {
	provider := &registeredProvider{
		ID:             "anthropic",
		DefaultBaseURL: "https://api.anthropic.com",
	}
	d := newModelPickBaseURLDialog(provider, "> https://api.example.com")
	out := d.View(100)
	for _, want := range []string{
		"anthropic base URL",
		"Press Enter to use https://api.anthropic.com.",
		"> https://api.example.com",
		"enter confirm · esc back",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("View(100) missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "> >") {
		t.Fatalf("View(100) rendered a double-prompt line:\n%s", out)
	}
}

func TestRenderModelPickBaseURLStillDelegatesToDialog(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelCatalog = runtimeModelsResponse{
		Providers: []registeredProvider{{
			ID:             "anthropic",
			DisplayName:    "Anthropic",
			DefaultBaseURL: "https://api.anthropic.com",
		}},
	}
	m.modelPickSelectedID = "anthropic"
	m.setMode(modeModelPickBaseURL)
	got := m.renderModelPickBaseURL(100)
	want := newModelPickBaseURLDialog(m.currentModelProvider(), m.input.View()).View(100)
	if got != want {
		t.Fatalf("renderModelPickBaseURL(100) diverges from dialog View:\n--- got ---\n%s\n--- want ---\n%s",
			got, want)
	}
}

// === Phase C.2: modelPickModelDialog (renderModelPickModel migration) ===

func TestModelPickModelDialogID(t *testing.T) {
	d := newModelPickModelDialog(nil, nil, 0, 24, false, false, "")
	if d.ID() != "modelPickModel" {
		t.Fatalf("ID() = %q, want %q", d.ID(), "modelPickModel")
	}
}

func TestModelPickModelDialogHandleMsgIsNoOp(t *testing.T) {
	d := newModelPickModelDialog(nil, nil, 0, 24, false, false, "")
	if cmd := d.HandleMsg(keyPress(tea.KeyEnter)); cmd != nil {
		t.Fatalf("HandleMsg(KeyEnter) cmd = %v, want nil", cmd)
	}
}

func TestModelPickModelDialogViewListsModels(t *testing.T) {
	provider := &registeredProvider{
		ID: "anthropic",
		Models: []registeredModel{
			{ID: "anthropic/claude-sonnet", Name: "Claude Sonnet"},
			{ID: "anthropic/claude-opus", Name: "Claude Opus"},
		},
	}
	d := newModelPickModelDialog(provider, nil, 1, 30, false, false, "")
	out := d.View(100)
	for _, want := range []string{
		"anthropic models",
		"Pick a model. enter selects; esc back to base URL.",
		"model",
		"Claude Sonnet",
		"Claude Opus",
		"↑↓/Tab navigate · enter select · esc back",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("View(100) missing %q:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "> Claude Opus") {
		t.Fatalf("selected model row should be focused with > marker:\n%s", out)
	}
}

func TestModelPickModelDialogViewLoadingAndSubmitting(t *testing.T) {
	provider := &registeredProvider{ID: "anthropic"}
	loading := newModelPickModelDialog(provider, nil, 0, 30, true, false, "⠋").View(100)
	if !strings.Contains(loading, "refreshing model list…") || !strings.Contains(loading, "esc back · cancel re-fetch") {
		t.Fatalf("loading view missing status/hint:\n%s", loading)
	}
	submitting := newModelPickModelDialog(provider, nil, 0, 30, false, true, "⠋").View(100)
	if !strings.Contains(submitting, "saving model…") || !strings.Contains(submitting, "request still in flight") {
		t.Fatalf("submitting view missing status/hint:\n%s", submitting)
	}
}

func TestRenderModelPickModelStillDelegatesToDialog(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.modelCatalog = runtimeModelsResponse{
		Providers: []registeredProvider{{
			ID:          "anthropic",
			DisplayName: "Anthropic",
			Models: []registeredModel{
				{ID: "anthropic/claude-sonnet", Name: "Claude Sonnet"},
				{ID: "anthropic/claude-opus", Name: "Claude Opus"},
			},
		}},
	}
	m.modelPickSelectedID = "anthropic"
	m.modelPickSelectedIdx = 1
	m.height = 30
	m.setMode(modeModelPickModel)
	got := m.renderModelPickModel(100)
	want := newModelPickModelDialog(
		m.currentModelProvider(),
		m.modelPickerLive,
		m.modelPickSelectedIdx,
		m.height,
		m.modelPickerLoading,
		m.modelPickSubmitting,
		m.spinner.View(),
	).View(100)
	if got != want {
		t.Fatalf("renderModelPickModel(100) diverges from dialog View:\n--- got ---\n%s\n--- want ---\n%s",
			got, want)
	}
}

// === Phase C.2: permissionDialog (renderPermission migration) ===

func TestPermissionDialogID(t *testing.T) {
	d := newPermissionDialog(nil, 0)
	if d.ID() != "permission" {
		t.Fatalf("ID() = %q, want %q", d.ID(), "permission")
	}
}

func TestPermissionDialogHandleMsgIsNoOp(t *testing.T) {
	d := newPermissionDialog(nil, 0)
	if cmd := d.HandleMsg(keyPress(tea.KeyEnter)); cmd != nil {
		t.Fatalf("HandleMsg(KeyEnter) cmd = %v, want nil", cmd)
	}
}

func TestPermissionDialogViewContainsChoicesAndReason(t *testing.T) {
	pending := &pendingPermission{
		name:          "Bash",
		risk:          "execute",
		input:         "{\"command\":\"git status\"}",
		message:       "Tool Bash requires user permission to run.",
		suggestedRule: "git:status",
	}
	d := newPermissionDialog(pending, 2)
	out := d.View(100)
	for _, want := range []string{
		"Permission: Bash",
		"execute risk",
		"Waiting for permission",
		"input:",
		"git status",
		"Suggested rule: git:status",
		"[1] Approve once",
		"[2] Approve for this session",
		"~ [3] Approve with editable rule",
		"[4] Reject",
		"[5] Reject, tell the model what to do instead",
		"esc cancel",
		"reason: Tool Bash requires user permission to run.",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("View(100) missing %q:\n%s", want, out)
		}
	}
}

func TestRenderPermissionStillDelegatesToDialog(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.pending = &pendingPermission{
		name:          "Bash",
		risk:          "execute",
		input:         "{\"command\":\"git status\"}",
		message:       "Tool Bash requires user permission to run.",
		suggestedRule: "git:status",
	}
	m.permissionChoice = 4
	got := m.renderPermission(100)
	want := newPermissionDialog(m.pending, m.permissionChoice).View(100)
	if got != want {
		t.Fatalf("renderPermission(100) diverges from dialog View:\n--- got ---\n%s\n--- want ---\n%s",
			got, want)
	}
}

// === Phase C.2: permissionEditorDialog (renderPermissionEditor migration) ===

func TestPermissionEditorDialogID(t *testing.T) {
	d := newPermissionEditorDialog(nil, modePermissionEditRule, "> git:status")
	if d.ID() != "permissionEditor" {
		t.Fatalf("ID() = %q, want %q", d.ID(), "permissionEditor")
	}
}

func TestPermissionEditorDialogHandleMsgIsNoOp(t *testing.T) {
	d := newPermissionEditorDialog(nil, modePermissionEditRule, "> git:status")
	if cmd := d.HandleMsg(keyPress(tea.KeyEnter)); cmd != nil {
		t.Fatalf("HandleMsg(KeyEnter) cmd = %v, want nil", cmd)
	}
}

func TestPermissionEditorDialogViewRuleAndFeedbackModes(t *testing.T) {
	pending := &pendingPermission{
		name:          "Bash",
		risk:          "execute",
		input:         "{\"command\":\"git status\"}",
		message:       "Tool Bash requires user permission to run.",
		suggestedRule: "git:status",
	}
	rule := newPermissionEditorDialog(pending, modePermissionEditRule, "> git:status").View(100)
	for _, want := range []string{
		"Editing rule for Bash",
		"execute risk",
		"input:",
		"git status",
		"reason: Tool Bash requires user permission to run.",
		"Suggested rule: git:status",
		"> git:status",
		"Edit the allow rule",
		"↵ confirm   esc back to options",
	} {
		if !strings.Contains(rule, want) {
			t.Fatalf("rule View(100) missing %q:\n%s", want, rule)
		}
	}
	if strings.Contains(rule, "> >") {
		t.Fatalf("rule View(100) rendered a double-prompt line:\n%s", rule)
	}

	feedback := newPermissionEditorDialog(pending, modePermissionEditFeedback, "> tell the model").View(100)
	for _, want := range []string{
		"Editing feedback for Bash",
		"execute risk",
		"input:",
		"git status",
		"reason: Tool Bash requires user permission to run.",
		"> tell the model",
		"Tell the model what to do instead",
		"↵ confirm   esc back to options",
	} {
		if !strings.Contains(feedback, want) {
			t.Fatalf("feedback View(100) missing %q:\n%s", want, feedback)
		}
	}
	if strings.Contains(feedback, "Suggested rule:") {
		t.Fatalf("feedback View(100) should not show suggested rule:\n%s", feedback)
	}
	if strings.Contains(feedback, "> >") {
		t.Fatalf("feedback View(100) rendered a double-prompt line:\n%s", feedback)
	}
}

func TestRenderPermissionEditorStillDelegatesToDialog(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace"})
	m.pending = &pendingPermission{
		name:          "Bash",
		risk:          "execute",
		input:         "{\"command\":\"git status\"}",
		message:       "Tool Bash requires user permission to run.",
		suggestedRule: "git:status",
	}
	m.setMode(modePermissionEditRule)
	m.input.SetValue("git:status")
	got := m.renderPermissionEditor(100)
	want := newPermissionEditorDialog(m.pending, m.inputMode, m.input.View()).View(100)
	if got != want {
		t.Fatalf("renderPermissionEditor(100) diverges from dialog View:\n--- got ---\n%s\n--- want ---\n%s",
			got, want)
	}
}
