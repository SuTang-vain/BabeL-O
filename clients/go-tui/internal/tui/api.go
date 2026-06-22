package tui

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

func fetchRuntimeConfig(cfg Config, since int) tea.Cmd {
	return func() tea.Msg {
		var payload runtimeConfig
		var query url.Values
		if since > 0 {
			query = url.Values{"since": {strconv.Itoa(since)}}
		}
		err := nexusJSON(cfg, http.MethodGet, "/v1/runtime/config", nil, &payload, query)
		return runtimeConfigMsg{config: payload, err: err}
	}
}

// fetchRuntimeStatus issues a lightweight GET /v1/runtime/status
// poll. The Go TUI uses it to drive the persistent memory
// footer indicator (Z6 of the zero-friction memory plan). We
// intentionally do not store the full payload — only the
// rendered one-line hint survives in the model.
func fetchRuntimeStatus(cfg Config) tea.Cmd {
	return func() tea.Msg {
		body, err := nexusRawJSON(cfg, http.MethodGet, "/v1/runtime/status", nil)
		return runtimeStatusMsg{raw: body, err: err}
	}
}

func pollTick() tea.Msg {
	return pollTickMsg{}
}

func fetchRuntimeProfiles(cfg Config) tea.Cmd {
	return func() tea.Msg {
		var payload runtimeProfilesResponse
		err := nexusJSON(cfg, http.MethodGet, "/v1/runtime/config/profiles", nil, &payload)
		return runtimeProfilesMsg{response: payload, err: err}
	}
}

func fetchRuntimeModels(cfg Config, trigger string) tea.Cmd {
	return func() tea.Msg {
		var payload runtimeModelsResponse
		err := nexusJSON(cfg, http.MethodGet, "/v1/runtime/models", nil, &payload)
		return runtimeModelsMsg{response: payload, trigger: trigger, err: err}
	}
}

func selectRuntimeProfile(cfg Config, profile string) tea.Cmd {
	return func() tea.Msg {
		var payload runtimeConfig
		err := nexusJSON(cfg, http.MethodPost, "/v1/runtime/config/select", map[string]string{"profile": profile}, &payload)
		return profileSelectMsg{profile: profile, config: payload, err: err}
	}
}

// selectRuntimeModel issues POST /v1/runtime/config/select
// with body {model: "<provider>/<id>"} and returns the
// resolved runtimeConfig on success. The Nexus side stores
// the model as defaultModel; an active profile that pins a
// model still wins at resolve time (see
// ConfigManager.resolveSettings), so the operator should
// clear the active profile or pick a profile that uses
// this model for the new model to take effect on the next
// turn.
func selectRuntimeModel(cfg Config, modelID string) tea.Cmd {
	return func() tea.Msg {
		var payload runtimeConfig
		err := nexusJSON(cfg, http.MethodPost, "/v1/runtime/config/select", map[string]string{"model": modelID}, &payload)
		return modelSelectMsg{modelID: modelID, config: payload, err: err}
	}
}

func saveRuntimeProviderConfig(cfg Config, providerID string, apiKey string, baseURL string) tea.Cmd {
	return func() tea.Msg {
		var payload runtimeConfig
		body := map[string]string{"provider": providerID}
		apiKey = sanitizeModelAPIKeyInput(apiKey)
		if strings.TrimSpace(apiKey) != "" {
			body["apiKey"] = apiKey
		}
		if strings.TrimSpace(baseURL) != "" {
			body["baseUrl"] = baseURL
		}
		err := nexusJSON(cfg, http.MethodPost, "/v1/runtime/config/provider", body, &payload)
		return providerConfigMsg{providerID: providerID, config: payload, err: err}
	}
}

func fetchMemoryStatus(cfg Config) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(cfg, http.MethodGet, "/v1/runtime/memory/status", nil)
		return memoryStatusMsg{raw: raw, err: err}
	}
}

func fetchMemorySearch(cfg Config, query string) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(cfg, http.MethodPost, "/v1/runtime/memory/search", map[string]any{"query": query})
		return memoryStatusMsg{raw: raw, err: err}
	}
}

func fetchMemoryCandidates(cfg Config, sessionID string) tea.Cmd {
	return func() tea.Msg {
		query := url.Values{}
		if strings.TrimSpace(sessionID) != "" {
			query.Set("sessionId", sessionID)
		}
		raw, err := nexusRawJSON(cfg, http.MethodGet, "/v1/runtime/memory/candidates", nil, query)
		return memoryStatusMsg{raw: raw, err: err}
	}
}

func requestMemorySaveNote(cfg Config, note string, sessionID string) tea.Cmd {
	return func() tea.Msg {
		body := map[string]any{"note": note}
		if strings.TrimSpace(sessionID) != "" {
			body["sessionId"] = sessionID
		}
		raw, err := nexusRawJSON(cfg, http.MethodPost, "/v1/runtime/memory/save-note", body)
		return memoryStatusMsg{raw: raw, err: err}
	}
}

func requestMemoryFlush(cfg Config, sessionID string) tea.Cmd {
	return func() tea.Msg {
		body := map[string]any{"sessionId": sessionID}
		raw, err := nexusRawJSON(cfg, http.MethodPost, "/v1/runtime/memory/flush", body)
		return memoryStatusMsg{raw: raw, err: err}
	}
}

func requestMemoryRestart(cfg Config) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(cfg, http.MethodPost, "/v1/runtime/memory/restart", map[string]any{})
		return memoryStatusMsg{raw: raw, err: err}
	}
}

func fetchContextAnalysis(cfg Config, sessionID string) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(cfg, http.MethodGet, "/v1/sessions/"+url.PathEscape(sessionID)+"/context", nil)
		return contextAnalysisMsg{sessionID: sessionID, raw: raw, err: err}
	}
}

func triggerCompact(cfg Config, sessionID string) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(
			cfg,
			http.MethodPost,
			"/v1/sessions/"+url.PathEscape(sessionID)+"/compact",
			map[string]string{"trigger": "manual"},
		)
		return compactResultMsg{sessionID: sessionID, raw: raw, err: err}
	}
}

func cancelStream(cfg Config, sessionID string, cancel chan<- struct{}) tea.Cmd {
	return func() tea.Msg {
		notifyLocalStream := func() {
			if cancel == nil {
				return
			}
			select {
			case cancel <- struct{}{}:
			default:
				close(cancel)
			}
		}
		if sessionID == "" {
			notifyLocalStream()
			return streamCancelMsg{}
		}
		_, err := nexusRawJSON(
			cfg,
			http.MethodPost,
			"/v1/sessions/"+url.PathEscape(sessionID)+"/cancel",
			map[string]string{"reason": "Cancelled from Go TUI"},
		)
		notifyLocalStream()
		return streamCancelMsg{sessionID: sessionID, err: err}
	}
}

// fetchInbox issues GET /v1/sessions/:sessionId/inbox and decodes
// the stable top-level envelope (type / sessionId / messages /
// limit / includeAcknowledged). The raw bytes are retained so any
// future richer renderer (or a server-side schema addition) does
// not break the existing format / overlay code. The trigger field
// ("user" / "auto") tells the Update handler whether to open the
// overlay (user /inbox command) or just refresh the snapshot in
// place (Phase 6 PR2 end-of-turn auto-refresh).
func fetchInbox(cfg Config, sessionID string, includeAck bool, trigger string) tea.Cmd {
	return func() tea.Msg {
		query := url.Values{}
		if includeAck {
			query.Set("includeAcknowledged", "true")
		}
		raw, err := nexusRawJSON(
			cfg,
			http.MethodGet,
			"/v1/sessions/"+url.PathEscape(sessionID)+"/inbox",
			nil,
			query,
		)
		out := inboxMsg{sessionID: sessionID, raw: raw, includeAck: includeAck, trigger: trigger, err: err}
		if err == nil {
			if decodeErr := json.Unmarshal(raw, &out.envelope); decodeErr != nil {
				out.err = fmt.Errorf("decode inbox: %w", decodeErr)
			}
		}
		return out
	}
}

// ackInboxMessage issues POST /v1/sessions/:sessionId/inbox/:messageId/ack.
// The Go TUI does not need the full message body back — only a
// success signal — so the message field is preserved as raw bytes
// for any future audit / governance renderer.
func ackInboxMessage(cfg Config, sessionID string, messageID string) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(
			cfg,
			http.MethodPost,
			"/v1/sessions/"+url.PathEscape(sessionID)+"/inbox/"+url.PathEscape(messageID)+"/ack",
			map[string]any{},
		)
		return inboxAckMsg{sessionID: sessionID, messageID: messageID, raw: raw, err: err}
	}
}

// fetchSessionAgents issues GET /v1/sessions/:sessionId/agents
// and decodes the stable top-level envelope
// (type / sessionId / jobs). The raw bytes are retained so any
// future richer renderer (or a server-side schema addition)
// does not break the existing format / overlay code. The
// trigger field ("user" / "auto") tells the Update handler
// whether to open the overlay (user /agents command) or just
// refresh the snapshot in place (Phase 6 PR3 end-of-turn
// auto-refresh, paired with fetchInbox auto-refresh).
func fetchSessionAgents(cfg Config, sessionID string, trigger string) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(
			cfg,
			http.MethodGet,
			"/v1/sessions/"+url.PathEscape(sessionID)+"/agents",
			nil,
		)
		out := agentJobsMsg{sessionID: sessionID, raw: raw, trigger: trigger, err: err}
		if err == nil {
			if decodeErr := json.Unmarshal(raw, &out.envelope); decodeErr != nil {
				out.err = fmt.Errorf("decode agent jobs: %w", decodeErr)
			}
		}
		return out
	}
}

// fetchSessionTasks issues GET /v1/sessions/:sessionId/tasks and
// decodes the stable top-level envelope
// (type / sessionId / tasks). The raw bytes are retained so any
// future richer renderer (or a server-side schema addition)
// does not break the existing format / overlay code. The
// trigger field ("user" / "auto") tells the Update handler
// whether to open the overlay (user /tasks command) or just
// refresh the snapshot in place (Phase 6 PR4 end-of-turn
// auto-refresh, paired with fetchInbox + fetchSessionAgents).
func fetchSessionTasks(cfg Config, sessionID string, trigger string) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(
			cfg,
			http.MethodGet,
			"/v1/sessions/"+url.PathEscape(sessionID)+"/tasks",
			nil,
		)
		out := tasksListMsg{sessionID: sessionID, raw: raw, trigger: trigger, err: err}
		if err == nil {
			if decodeErr := json.Unmarshal(raw, &out.envelope); decodeErr != nil {
				out.err = fmt.Errorf("decode tasks: %w", decodeErr)
			}
		}
		return out
	}
}

// checkRuntimeVersion issues GET /v1/runtime/version and
// decodes the stable top-level envelope
// (type / serverVersion / schemaVersion /
// goTuiCompatibility / nodeCliCompatibility). The raw bytes
// are retained so any future richer renderer (or a
// server-side schema addition) does not break the existing
// format / compat check. Called once at startup from
// Init() as a non-blocking version-compat sanity check.
func checkRuntimeVersion(cfg Config) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(
			cfg,
			http.MethodGet,
			"/v1/runtime/version",
			nil,
		)
		out := runtimeVersionMsg{raw: raw, err: err}
		if err == nil {
			if decodeErr := json.Unmarshal(raw, &out.envelope); decodeErr != nil {
				out.err = fmt.Errorf("decode runtime version: %w", decodeErr)
			}
		}
		return out
	}
}

// fetchToolAudit issues GET /v1/tools/audit and decodes the
// stable top-level envelope (type / tools). The raw bytes are
// retained so any future richer renderer (or a server-side
// schema addition) does not break the existing format /
// overlay code. The trigger field ("user" / "auto") tells the
// Update handler whether to open the overlay (user /tools
// command) or just refresh the snapshot in place (a future
// end-of-turn auto-refresh).
//
// /v1/tools/audit is a GLOBAL endpoint — it does NOT take a
// session id, so the command is parameter-free on that
// dimension. The Go TUI does not auto-refresh it on result
// events (the audit is a snapshot of the runtime tool
// registry, not a per-session view); a future PR can wire
// an "auto" trigger if the runtime ever signals a registry
// change via the stream.
func fetchToolAudit(cfg Config, trigger string) tea.Cmd {
	return func() tea.Msg {
		raw, err := nexusRawJSON(
			cfg,
			http.MethodGet,
			"/v1/tools/audit",
			nil,
		)
		out := toolAuditMsg{raw: raw, trigger: trigger, err: err}
		if err == nil {
			if decodeErr := json.Unmarshal(raw, &out.envelope); decodeErr != nil {
				out.err = fmt.Errorf("decode tool audit: %w", decodeErr)
			}
		}
		return out
	}
}

func nexusJSON(cfg Config, method string, path string, body any, out any, query ...url.Values) error {
	endpoint, err := apiURL(cfg.BaseURL, path)
	if err != nil {
		return err
	}
	if len(query) > 0 && len(query[0]) > 0 {
		endpoint = endpoint + "?" + query[0].Encode()
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cfg.APIKey != "" {
		req.Header.Set("X-Nexus-API-Key", cfg.APIKey)
	}
	client := http.Client{Timeout: 10 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	// 304 Not Modified means the server's configVersion has not moved
	// past `since`. Surface a sentinel so the caller can no-op without
	// treating it as an error.
	if res.StatusCode == http.StatusNotModified {
		return errNotModified
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("%s %s failed: %s %s", method, path, res.Status, summarizeHTTPError(data))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}

// nexusRawJSON is the raw-bytes sibling of nexusJSON: same request
// shape and error semantics, but the response body is returned
// untouched so the caller can lazily decode only the fields it
// needs (and ignore schema churn on the rest of the payload).
func nexusRawJSON(cfg Config, method string, path string, body any, query ...url.Values) ([]byte, error) {
	endpoint, err := apiURL(cfg.BaseURL, path)
	if err != nil {
		return nil, err
	}
	if len(query) > 0 && len(query[0]) > 0 {
		endpoint = endpoint + "?" + query[0].Encode()
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cfg.APIKey != "" {
		req.Header.Set("X-Nexus-API-Key", cfg.APIKey)
	}
	client := http.Client{Timeout: 10 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("%s %s failed: %s %s", method, path, res.Status, summarizeHTTPError(data))
	}
	return data, nil
}

// errNotModified is returned by nexusJSON when the server replies
// 304 Not Modified; callers compare with errors.Is.
var errNotModified = fmt.Errorf("config not modified")

func apiURL(base string, path string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "http", "https":
	case "ws":
		parsed.Scheme = "http"
	case "wss":
		parsed.Scheme = "https"
	default:
		return "", fmt.Errorf("unsupported Nexus URL scheme %q", parsed.Scheme)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/" + strings.TrimLeft(path, "/")
	parsed.RawQuery = ""
	return parsed.String(), nil
}

func summarizeHTTPError(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return truncatePlain(singleLine(string(data)), 200)
	}
	code := stringField(payload, "error")
	if hint, ok := friendlyNexusError(code, payload); ok {
		return hint
	}
	return truncatePlain(singleLine(firstNonEmpty(stringField(payload, "message"), code, compactJSON(payload))), 200)
}

func friendlyNexusRequestError(err error) string {
	if err == nil {
		return ""
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		if errors.Is(urlErr.Err, os.ErrDeadlineExceeded) {
			return "Nexus request timed out; check that `bbl go` started Nexus, or run `bbl nexus start` and retry."
		}
		var netErr net.Error
		if errors.As(urlErr.Err, &netErr) && netErr.Timeout() {
			return "Nexus request timed out; check that `bbl go` started Nexus, or run `bbl nexus start` and retry."
		}
		return fmt.Sprintf("cannot reach Nexus at %s; check that `bbl go` started Nexus, or run `bbl nexus start` and retry.", urlErr.URL)
	}
	return err.Error()
}

func isNexusTransportError(err error) bool {
	if err == nil {
		return false
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "connection refused") ||
		strings.Contains(text, "connection reset") ||
		strings.Contains(text, "broken pipe") ||
		strings.Contains(text, "no such host") ||
		text == "eof" ||
		strings.Contains(text, "unexpected eof")
}

// friendlyNexusError maps known §5 path C error codes to human
// hints. Returns ok=false when the code is not in the friendly set.
//
// This is the back-compat entry point (no soft-cycle context). For
// REQUEST_TIMEOUT classification under Phase 4 of the
// task-adaptive-recoverable-timeout plan, the consumer should
// prefer `friendlyNexusErrorWithContext()` so it can distinguish a
// watchdog cutoff (the soft cycle had already fired) from a fresh
// fatal cutoff.
func friendlyNexusError(code string, payload map[string]any) (string, bool) {
	return friendlyNexusErrorWithContext(code, payload, nil)
}

// formatErrorEventWithSoftContext is the consumer-side helper that
// renders an `error` event using the model's current soft-cycle
// snapshot. Returns the same string `formatNexusEvent` would for
// non-REQUEST_TIMEOUT errors; for REQUEST_TIMEOUT it credits the
// watchdog when the soft cycle had already fired.
func (m *model) formatErrorEventWithSoftContext(event map[string]any) string {
	code := stringField(event, "code")
	if hint, ok := friendlyNexusErrorWithContext(code, event, m.softTimeoutState); ok {
		return hint
	}
	return strings.TrimSpace(fmt.Sprintf("%s %s", code, stringField(event, "message")))
}

// friendlyNexusErrorWithContext is the Phase 4 variant of
// friendlyNexusError. When `soft` is non-nil and the error is a
// REQUEST_TIMEOUT, the message is reshaped to credit the watchdog
// (which actually ended the turn) rather than telling the operator
// to raise --execute-timeout-ms — the soft cycle had already
// extended the budget as far as it was allowed and the workflow
// kept running until the hard watchdog fired.
func friendlyNexusErrorWithContext(code string, payload map[string]any, soft *softTimeoutSnapshot) (string, bool) {
	switch code {
	case "tombstoned_profile":
		profile := stringField(payload, "profile")
		return fmt.Sprintf("profile %q is tombstoned; restore via `bbl config profile restore %s`", profile, profile), true
	case "unknown_profile":
		profile := stringField(payload, "profile")
		return fmt.Sprintf("unknown profile %q", profile), true
	case "not_supported":
		return "model / role / roleModel switching is not supported via HTTP; use `bbl config use <modelId>` CLI", true
	case "missing_profile":
		return "missing profile name in request body", true
	case "missing_provider_api_key":
		provider := stringField(payload, "provider")
		model := stringField(payload, "model")
		command := firstNonEmpty(stringField(payload, "command"), "bbl config add "+provider+" <KEY>")
		return fmt.Sprintf("provider %q needs an API key before selecting %q; run /model to configure it, or run `%s`", provider, model, command), true
	case "unknown_provider":
		provider := stringField(payload, "provider")
		return fmt.Sprintf("unknown provider %q", provider), true
	case "REQUEST_TIMEOUT":
		timeout := anyInt(payload["timeoutMs"])
		// Phase 5: Nexus now decorates watchdog cutoffs with
		// `details.kind='watchdog'` (and a `softCycleEvents`
		// counter). Detect that marker first — it is the
		// authoritative signal that the hard watchdog (not the
		// soft budget) ended the turn, and it works even when
		// the soft cycle never fired before the watchdog
		// tripped (a corner case in unusual configurations).
		var watchdogKind, watchdogPolicy string
		var watchdogSoftBudgetMs, watchdogWatchdogMs int
		if details, ok := payload["details"].(map[string]any); ok {
			watchdogKind = stringField(details, "kind")
			watchdogPolicy = stringField(details, "policy")
			watchdogSoftBudgetMs = anyInt(details["softTimeoutMs"])
			watchdogWatchdogMs = anyInt(details["watchdogTimeoutMs"])
		}
		// Phase 4: if the soft cycle had already fired during
		// this turn, the watchdog (not the soft budget) was the
		// thing that ended the turn. Surface that explicitly
		// instead of recommending "raise --execute-timeout-ms",
		// which would re-introduce the fixed-cutoff anti-pattern
		// the soft policy was designed to retire.
		softFiredThisTurn := soft != nil && !soft.BudgetExceededAt.IsZero()
		if watchdogKind == "watchdog" || softFiredThisTurn {
			extensions := ""
			if soft != nil && soft.MaxExtensions > 0 {
				extensions = fmt.Sprintf("; soft extensions used %d/%d", soft.ExtensionCount, soft.MaxExtensions)
			}
			runningBudget := 0
			if soft != nil {
				runningBudget = soft.TotalSoftBudgetMs
				if runningBudget <= 0 {
					runningBudget = soft.OriginalBudgetMs
				}
			}
			// Phase 5: when the snapshot is missing but the
			// Nexus details payload carries explicit soft /
			// watchdog budgets, use those so the operator still
			// sees the actual numbers.
			if runningBudget <= 0 && watchdogSoftBudgetMs > 0 {
				runningBudget = watchdogSoftBudgetMs
			}
			policyLabel := watchdogPolicy
			if policyLabel == "" {
				policyLabel = "soft"
			}
			watchdogBudget := ""
			if watchdogWatchdogMs > 0 {
				watchdogBudget = fmt.Sprintf("; watchdog budget %dms", watchdogWatchdogMs)
			}
			if runningBudget > 0 {
				return fmt.Sprintf(
					"watchdog stopped the turn (REQUEST_TIMEOUT) — soft budget cycled at %dms (policy=%s)%s%s and the hard watchdog tripped. Ask the model to summarize, narrow scope, or split the task instead of raising --execute-timeout-ms.",
					runningBudget,
					policyLabel,
					extensions,
					watchdogBudget,
				), true
			}
			return fmt.Sprintf(
				"watchdog stopped the turn (REQUEST_TIMEOUT) — soft cycle / hard watchdog tripped (policy=%s)%s%s. Ask the model to summarize, narrow scope, or split the task instead of raising --execute-timeout-ms.",
				policyLabel,
				extensions,
				watchdogBudget,
			), true
		}
		if timeout > 0 {
			return fmt.Sprintf("turn exceeded %dms execute timeout (REQUEST_TIMEOUT); consider shorter context, fewer tool calls, or a higher --execute-timeout-ms", timeout), true
		}
		return "turn exceeded Nexus execute timeout (REQUEST_TIMEOUT); consider shorter context, fewer tool calls, or a higher --execute-timeout-ms", true
	case "REQUEST_CANCELLED":
		return "turn was cancelled (REQUEST_CANCELLED); no retry needed", true
	}
	return "", false
}
