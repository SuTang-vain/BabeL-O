package tui

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/gorilla/websocket"
)

func startStream(cfg Config, prompt string, timeout timeoutDecision) tea.Cmd {
	return func() tea.Msg {
		eventCh := make(chan streamEvent, 128)
		decisionCh := make(chan permissionDecision, 8)
		cancelCh := make(chan struct{})
		// Phase 1.2: emit sessionIDAllocatedMsg BEFORE the
		// streamStartedMsg so the model can update
		// m.sessionID synchronously — slash commands
		// (`/context`, `/compact`, `/status`) that check
		// m.sessionID don't see a stale empty id between
		// allocation and stream start. tea.Bubbletea
		// processes msgs in order, so this fires first.
		sessionID, err := ensureStreamSession(cfg, prompt)
		if err != nil {
			close(eventCh)
			return streamEventMsg{event: streamEvent{err: err}}
		}
		// Two messages: allocated (m.sessionID update) +
		// started (channel wiring). We can't ship both
		// from one tea.Msg because Update only fires one
		// mutation per message; use tea.Batch so they
		// fire in order.
		go runStream(cfg, sessionID, prompt, timeout, eventCh, decisionCh, cancelCh)
		return tea.Batch(
			func() tea.Msg { return sessionIDAllocatedMsg{sessionID: sessionID} },
			func() tea.Msg { return streamStartedMsg{events: eventCh, decisions: decisionCh, cancel: cancelCh, sessionID: sessionID} },
		)()
	}
}

func waitForStreamEvent(ch <-chan streamEvent) tea.Cmd {
	return func() tea.Msg {
		if ch == nil {
			return streamClosedMsg{}
		}
		event, ok := <-ch
		if !ok {
			return streamClosedMsg{}
		}
		return streamEventMsg{event: event}
	}
}

func ensureStartupSession(cfg Config) tea.Cmd {
	return func() tea.Msg {
		if sessionID := strings.TrimSpace(cfg.SessionID); sessionID != "" {
			return startupSessionMsg{sessionID: sessionID}
		}
		// No clientSessionId here — the operator pinned the
		// session via `--session`, so the client didn't
		// generate a `session_go_<unixnano>` placeholder. The
		// server's session row keeps the metadata link
		// empty in this case; the operator knows the id
		// because they typed it.
		sessionID, err := allocateServerSession(cfg, "", "")
		if err != nil {
			return startupSessionMsg{err: fmt.Errorf("allocate server session: %w", err)}
		}
		return startupSessionMsg{sessionID: sessionID}
	}
}

const (
	DefaultGoTuiExecuteTimeoutMs     = 180_000
	longContextGoTuiExecuteTimeoutMs = 300_000
	longContextTokenThreshold        = 100_000
)

func resolveGoTuiTimeout(cfg Config, prompt string, usage *usageSnapshot) timeoutDecision {
	base := cfg.ExecuteTimeoutMs
	if base <= 0 {
		base = DefaultGoTuiExecuteTimeoutMs
	}
	decision := timeoutDecision{TimeoutMs: base}
	if base != DefaultGoTuiExecuteTimeoutMs {
		return decision
	}
	if usage != nil && usage.InputTokens > longContextTokenThreshold {
		return timeoutDecision{TimeoutMs: longContextGoTuiExecuteTimeoutMs, Reason: "long-context", Adaptive: true}
	}
	if looksLikeLongContextPrompt(prompt) {
		return timeoutDecision{TimeoutMs: longContextGoTuiExecuteTimeoutMs, Reason: "long-context", Adaptive: true}
	}
	return decision
}

func looksLikeLongContextPrompt(prompt string) bool {
	lower := strings.ToLower(prompt)
	markers := []string{
		"long-context",
		"large context",
		"100k",
		"大上下文",
		"长上下文",
		"深度分析",
		"全面分析",
		"完整分析",
	}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// buildExecuteRequest assembles the WebSocket payload sent to /v1/stream.
// timeoutMs is only emitted when positive so the Nexus default 30s budget
// remains the fallback for callers that explicitly opt out (cfg.ExecuteTimeoutMs = 0).
// policy defaults to 'soft-deny' so Go TUI users can run write/execute
// Bash subcommands (git commit, npm install, etc.) via the existing
// permission panel; Phase B of
// docs/nexus/reference/go-tui-permission-policy-governance-plan.md.
func buildExecuteRequest(cfg Config, sessionID, prompt string) map[string]any {
	return buildExecuteRequestWithTimeout(cfg, sessionID, prompt, resolveGoTuiTimeout(cfg, prompt, nil))
}

func buildExecuteRequestWithTimeout(cfg Config, sessionID, prompt string, timeout timeoutDecision) map[string]any {
	payload := map[string]any{
		"prompt":    prompt,
		"cwd":       cfg.Cwd,
		"sessionId": sessionID,
	}
	if timeout.TimeoutMs > 0 {
		payload["timeoutMs"] = timeout.TimeoutMs
		payload["timeoutPolicy"] = "soft"
		payload["softTimeoutMs"] = timeout.TimeoutMs
	}
	policy := cfg.PolicyMode
	if policy == "" {
		policy = "soft-deny"
	}
	payload["policy"] = policy
	// Phase D: emit per-turn `allowedTools` override when configured.
	// Empty / unset: per-turn override off; the server-side startup
	// policy applies. Scoped to this turn only; the next turn
	// re-evaluates from the body. Each entry is comma-split (so
	// programmatic Config.AllowTools can carry comma-laden values
	// the same way the --allow-tools CLI flag does) and trimmed.
	if len(cfg.AllowTools) > 0 {
		allow := make([]any, 0, len(cfg.AllowTools))
		for _, raw := range cfg.AllowTools {
			for _, part := range strings.Split(raw, ",") {
				if trimmed := strings.TrimSpace(part); trimmed != "" {
					allow = append(allow, trimmed)
				}
			}
		}
		if len(allow) > 0 {
			payload["allowedTools"] = allow
		}
	}
	return payload
}

func ensureStreamSession(cfg Config, prompt string) (string, error) {
	// Phase 1 of docs/nexus/reference/go-tui-session-observability-governance-plan.md:
	// When the operator hasn't pinned a session id via the `--session` flag,
	// allocate one server-side via `POST /v1/sessions` so the WebSocket
	// payload, pending permission matching, and event-card rendering all
	// share a single canonical `session_<uuid>` id (instead of the local
	// `session_go_<unixnano>` placeholder). The locally-generated id is
	// preserved as `clientSessionId` metadata so the same id can be
	// reverse-resolved from the client log later.
	clientSessionID := ""
	sessionID := cfg.SessionID
	if sessionID == "" {
		// Phase 1.1: generate the client id BEFORE the allocate
		// call so we can put it in the server's session metadata
		// on the same round-trip. The order matters — server
		// metadata + client log are both keyed by this id, so
		// the operator's reverse-resolve path works whether they
		// query SQLite (server metadata) or the client log
		// (fallback when the SQLite row is gone).
		clientSessionID = fmt.Sprintf("session_go_%d", time.Now().UnixNano())
		allocated, err := allocateServerSession(cfg, prompt, clientSessionID)
		if err != nil {
			return "", fmt.Errorf("allocate server session: %w", err)
		}
		sessionID = allocated
		// Best-effort: write the client↔server mapping to the client
		// log so a future `bbl inspect-session session_go_...` can
		// reverse-resolve the server uuid. Failure is non-fatal — the
		// session still runs; only the reverse lookup is lost.
		appendClientSessionLog(cfg, clientSessionID, sessionID)
	}
	_ = clientSessionID // reserved for future use (e.g. local transcript)
	return sessionID, nil
}

func runStream(cfg Config, sessionID, prompt string, timeout timeoutDecision, eventCh chan<- streamEvent, decisions <-chan permissionDecision, cancel <-chan struct{}) {
	defer close(eventCh)

	wsURL, err := streamURL(cfg.BaseURL)
	if err != nil {
		eventCh <- streamEvent{err: err}
		return
	}

	headers := http.Header{}
	if cfg.APIKey != "" {
		headers.Set("X-Nexus-API-Key", cfg.APIKey)
	}

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		eventCh <- streamEvent{err: err}
		return
	}
	defer conn.Close()

	var writeMu sync.Mutex
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-cancel:
			_ = conn.Close()
		case <-done:
		}
	}()
	go func() {
		for {
			select {
			case decision, ok := <-decisions:
				if !ok {
					return
				}
				// Phase A.1: include scope/rule/feedback in the
				// permission_response payload so the runtime can
				// (a) accumulate session-scope rules into the
				// per-session map, and (b) surface the user's
				// "tell the model what to do instead" text in
				// the next turn.
				payload := map[string]any{
					"type":      "permission_response",
					"sessionId": decision.sessionID,
					"toolUseId": decision.toolUseID,
					"approved":  decision.approved,
					"reason":    decision.reason,
				}
				if decision.scope != "" {
					payload["scope"] = decision.scope
				}
				if decision.rule != "" {
					payload["rule"] = decision.rule
				}
				if decision.feedback != "" {
					payload["feedback"] = decision.feedback
				}
				writeMu.Lock()
				_ = conn.WriteJSON(payload)
				writeMu.Unlock()
			case <-done:
				return
			}
		}
	}()

	writeMu.Lock()
	err = conn.WriteJSON(buildExecuteRequestWithTimeout(cfg, sessionID, prompt, timeout))
	writeMu.Unlock()
	if err != nil {
		eventCh <- streamEvent{err: err}
		return
	}

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			eventCh <- streamEvent{err: err}
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(data, &payload); err != nil {
			eventCh <- streamEvent{err: fmt.Errorf("decode Nexus event: %w", err)}
			continue
		}
		eventCh <- streamEvent{payload: payload}
		eventType := stringField(payload, "type")
		if eventType == "result" || eventType == "error" {
			return
		}
	}
}

// allocateServerSession is the Phase 1 server-side session-id allocator.
// It calls `POST /v1/sessions` (with `clientSessionId` metadata so
// the server's session row has a back-reference to the local
// `session_go_<unixnano>` id) and returns the server-allocated
// `session_<uuid>`. If the call fails, the caller should surface the
// error to the operator rather than fall back to a local id — the
// WebSocket payload would then carry a session id that the server
// doesn't have a row for, which is the exact
// `session_go_1781146359507755000` failure mode the governance plan
// is trying to prevent.
func allocateServerSession(cfg Config, prompt, clientSessionID string) (string, error) {
	type sessionCreatedResponse struct {
		Type            string `json:"type"`
		SessionID       string `json:"sessionId"`
		ClientSessionID string `json:"clientSessionId"`
		CreatedAt       string `json:"createdAt"`
	}
	// Phase 1.1: the locally-generated `session_go_<unixnano>` id
	// is sent as `clientSessionId` so the server's session row has
	// the back-reference. `bbl inspect-session session_<uuid>` can
	// then reverse-resolve to `session_go_xxx` from server
	// metadata (tier (a) — found in SQLite), no longer requiring
	// the client log fallback (tier (b)) for normal cases.
	metadata := map[string]any{
		"client": "go-tui",
		"phase":  "session_allocate",
	}
	if clientSessionID != "" {
		metadata["clientSessionId"] = clientSessionID
	}
	body := map[string]any{
		"cwd":      cfg.Cwd,
		"metadata": metadata,
	}
	var resp sessionCreatedResponse
	if err := nexusJSON(cfg, http.MethodPost, "/v1/sessions", body, &resp); err != nil {
		return "", err
	}
	if resp.SessionID == "" {
		return "", fmt.Errorf("server returned empty sessionId for POST /v1/sessions")
	}
	return resp.SessionID, nil
}

// appendClientSessionLog writes the client↔server session id mapping
// to `~/.babel-o/log/go-tui-session.log`. Best-effort: failure to
// write is non-fatal. The Phase 0 `bbl inspect-session` CLI uses
// this log to reverse-resolve `session_go_<unixnano>` ids to the
// server-allocated uuid.
//
// Line format (tab-separated, line-prefixed timestamp):
//
//	[YYYY-MM-DDTHH:MM:SS+ZZ:ZZ]\tclientSessionId=session_go_xxx\tserverSessionId=session_<uuid>
func appendClientSessionLog(cfg Config, clientSessionID, serverSessionID string) {
	// Honour BABEL_O_CONFIG_DIR override (mirrors `inspectSession.ts`
	// Phase 0 logic) so tests can redirect the log path.
	configDir := resolveClientConfigDir()
	logDir := filepath.Join(configDir, "log")
	logPath := filepath.Join(logDir, "go-tui-session.log")
	line := fmt.Sprintf(
		"%s\tclientSessionId=%s\tserverSessionId=%s\n",
		time.Now().Format(time.RFC3339),
		clientSessionID,
		serverSessionID,
	)
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return
	}
	// Append (O_APPEND|O_CREATE|O_WRONLY).
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}

// resolveClientConfigDir mirrors the Phase 0 `resolveConfigDir` helper
// in `src/cli/commands/inspectSession.ts`: honour `BABEL_O_CONFIG_DIR`
// / `BABEL_O_CONFIG_FILE` overrides so tests can redirect. We can't
// import the TS helper, so we re-implement the resolution here —
// same three-tier precedence.
func resolveClientConfigDir() string {
	if dir := os.Getenv("BABEL_O_CONFIG_DIR"); dir != "" {
		return dir
	}
	if file := os.Getenv("BABEL_O_CONFIG_FILE"); file != "" {
		return filepath.Dir(file)
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ".babel-o"
	}
	return filepath.Join(home, ".babel-o")
}

func streamURL(base string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported Nexus URL scheme %q", parsed.Scheme)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/v1/stream"
	parsed.RawQuery = ""
	return parsed.String(), nil
}
