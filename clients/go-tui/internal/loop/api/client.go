// Package api hosts the Nexus HTTP client used by the multi-pane
// driver. Phase 2c of docs/nexus/reference/go-tui-loop-multipane-plan.md:
// wraps the Phase 1 endpoints (wait / health / loop_state) so the
// runtime layer can stay free of bubble tea and reuse plain
// http.Client + JSON.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client is a thin wrapper over net/http that targets the BabeL-O
// Nexus loop endpoints. The zero value is unusable; construct via
// NewClient with a BaseURL.
type Client struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

// NewClient returns a Client with sensible defaults. Pass a
// custom *http.Client for tests / instrumentation.
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
		HTTP:    &http.Client{Timeout: 30 * time.Second},
	}
}

// LoopPaneState mirrors the Nexus LoopPaneState payload (see
// src/storage/Storage.ts in the TypeScript runtime). Keep field
// names and JSON tags aligned with the server contract.
type LoopPaneState struct {
	PaneID      string `json:"paneId"`
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	SessionID   string `json:"sessionId"`
	Agent       string `json:"agent"`
	Cwd         string `json:"cwd"`
	Label       string `json:"label"`
	LastRev     int64  `json:"lastRev"`
	UpdatedAt   string `json:"updatedAt"`
}

// LoopHealthPane mirrors the per-pane entry in
// GET /v1/runtime/loop/health. Only the fields the driver reads
// are typed; unknown fields are tolerated.
//
// PR-17a (Track B Phase 2 §6.5.2 bbl loop P1 integration):
//   - PendingHints / LastHintAt / LastHintPattern support the
//     StatusBehaviorHint 7th PaneStatus (priority 6, highest per
//     INV-13). When PendingHints > 0, the runtime projection
//     overrides status to "behaviorHint".
type LoopHealthPane struct {
	SessionID              string `json:"sessionId"`
	Agent                  string `json:"agent"`
	Status                 string `json:"status"`
	PendingPermissions     int    `json:"pendingPermissions"`
	PendingScopeBoundaries int    `json:"pendingScopeBoundaries"`
	OutOfScopeEvidence     int    `json:"outOfScopeEvidence"`
	// ActiveMemoryCandidates is the per-pane memory
	// candidate count surfaced by /v1/runtime/loop/health
	// (plan §3.2). The Nexus server may not yet emit this
	// field — 0 is a safe default that the scope_review
	// overlay renders as "no memory candidates".
	ActiveMemoryCandidates int           `json:"activeMemoryCandidates"`
	PendingHints           int           `json:"pendingHints"`
	LastHintAt             int64         `json:"lastHintAt"`
	LastHintPattern        string        `json:"lastHintPattern"`
	LastEventRev           int64         `json:"lastEventRev"`
	LastEventAt            string        `json:"lastEventAt"`
	TaskScope              LoopTaskScope `json:"taskScope"`
}

// LoopTaskScope mirrors the per-pane taskScope summary exposed
// by the loop/health endpoint.
type LoopTaskScope struct {
	Cwd                    string   `json:"cwd"`
	PrimaryRoot            string   `json:"primaryRoot"`
	ExplicitRoots          []string `json:"explicitRoots"`
	ConfirmedExternalRoots []string `json:"confirmedExternalRoots"`
	InferredCandidateRoots []string `json:"inferredCandidateRoots"`
	Mode                   string   `json:"mode"`
	Source                 string   `json:"source"`
	LatestDeclaredAt       string   `json:"latestDeclaredAt"`
}

// LoopHealthResponse is the wire shape of /v1/runtime/loop/health.
type LoopHealthResponse struct {
	Type   string           `json:"type"`
	Panes  []LoopHealthPane `json:"panes"`
	Filter LoopHealthFilter `json:"filter"`
}

// LoopHealthFilter echoes the query filters echoed by the server.
type LoopHealthFilter struct {
	WorkspaceID string `json:"workspaceId"`
	PaneID      string `json:"paneId"`
	SessionID   string `json:"sessionId"`
	LastN       int    `json:"lastN"`
}

// SessionInboxMessage mirrors a single entry in the
// GET /v1/sessions/:id/inbox response. Field set is
// deliberately minimal — the loop driver only consumes
// the surface fields needed for the footer unread /
// high-priority summary and the sidebar unread badge.
// Source of truth: src/shared/sessionChannel.ts.
type SessionInboxMessage struct {
	MessageID    string `json:"messageId"`
	ChannelID    string `json:"channelId"`
	FromSessionID string `json:"fromSessionId"`
	Type         string `json:"type"`
	Priority     string `json:"priority"`
	Status       string `json:"status"`
	CreatedAt    string `json:"createdAt"`
	AcknowledgedAt string `json:"acknowledgedAt,omitempty"`
}

// SessionInboxResponse mirrors GET /v1/sessions/:id/inbox.
// We only model the fields the footer + sidebar consume
// (linked-channel kind + the message list); session_id is
// duplicated for sanity checks.
type SessionInboxResponse struct {
	Type    string               `json:"type"`
	SessionID string              `json:"sessionId"`
	Messages []SessionInboxMessage `json:"messages"`
}

// SessionInboxOptions tunes the inbox fetch. includeAck
// defaults to false (the footer only cares about unread
// counts); limit defaults to 20 to match the Nexus default.
type SessionInboxOptions struct {
	IncludeAcknowledged bool
	Limit               int
}

// FetchSessionInbox wraps GET /v1/sessions/:id/inbox. Returns
// the response struct on 200 and (zero, err) on any other
// status. The loop driver calls this from the inbox tick
// (see internal/loop/inbox_tick.go) for the focused pane's
// session id; the chrome consumes the response via
// activeInboxStatus / per-pane badge lookup.
func (c *Client) FetchSessionInbox(ctx context.Context, sessionID string, opts SessionInboxOptions) (SessionInboxResponse, error) {
	if sessionID == "" {
		return SessionInboxResponse{}, errors.New("loop api: empty sessionID for inbox fetch")
	}
	q := url.Values{}
	if opts.IncludeAcknowledged {
		q.Set("includeAcknowledged", "true")
	}
	if opts.Limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", opts.Limit))
	}
	path := "/v1/sessions/" + url.PathEscape(sessionID) + "/inbox"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var out SessionInboxResponse
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return SessionInboxResponse{}, err
	}
	return out, nil
}

// WaitResponse mirrors GET /v1/sessions/:id/wait.
type WaitResponse struct {
	Type         string            `json:"type"`
	SessionID    string            `json:"sessionId"`
	Events       []json.RawMessage `json:"events"`
	NextRevision string            `json:"nextRevision"`
	Matched      bool              `json:"matched"`
	Order        string            `json:"order"`
	Limit        int               `json:"limit"`
}

// CreateSessionResponse mirrors POST /v1/sessions. bbl loop
// uses this to allocate a canonical Nexus session before a
// pane is persisted or starts its wait stream.
type CreateSessionResponse struct {
	Type            string `json:"type"`
	SessionID       string `json:"sessionId"`
	ClientSessionID string `json:"clientSessionId"`
	CreatedAt       string `json:"createdAt"`
}

// CreateSessionRequest carries the optional session creation
// metadata accepted by Nexus.
type CreateSessionRequest struct {
	Cwd             string
	ClientSessionID string
	Metadata        map[string]any
}

// ExecuteResponse mirrors POST /v1/execute. The loop driver
// only needs the final session id, success bit, and raw event
// array so it can shape transcript rows through the same
// EventToTranscriptItem path used by wait polling.
type ExecuteResponse struct {
	Type              string            `json:"type"`
	SessionID         string            `json:"sessionId"`
	Success           bool              `json:"success"`
	StatusCode        int               `json:"statusCode"`
	DurationMs        int               `json:"durationMs"`
	TimeoutMs         int               `json:"timeoutMs"`
	ExecuteDurationMs int               `json:"executeDurationMs"`
	Outcome           string            `json:"outcome"`
	Events            []json.RawMessage `json:"events"`
}

// LoopWorkspacesResponse mirrors GET /v1/loop/workspaces.
type LoopWorkspacesResponse struct {
	Type   string          `json:"type"`
	Panes  []LoopPaneState `json:"panes"`
	Filter struct {
		WorkspaceID string `json:"workspaceId"`
		SessionID   string `json:"sessionId"`
	} `json:"filter"`
}

// UpsertPaneParams carries the request body for
// POST /v1/loop/workspaces/:workspaceId/panes.
type UpsertPaneParams struct {
	PaneID      string
	WorkspaceID string
	TabID       string
	SessionID   string
	Agent       string
	Cwd         string
	Label       string
	LastRev     int64
}

// UpsertPane POSTs a pane and returns the server's stored state.
func (c *Client) UpsertPane(ctx context.Context, p UpsertPaneParams) (LoopPaneState, error) {
	body := map[string]any{
		"paneId":      p.PaneID,
		"workspaceId": p.WorkspaceID,
		"tabId":       p.TabID,
		"sessionId":   p.SessionID,
		"agent":       p.Agent,
		"cwd":         p.Cwd,
		"label":       p.Label,
		"lastRev":     p.LastRev,
	}
	var envelope struct {
		Type string        `json:"type"`
		Pane LoopPaneState `json:"pane"`
	}
	if err := c.doJSON(ctx, http.MethodPost, "/v1/loop/workspaces/"+url.PathEscape(p.WorkspaceID)+"/panes", body, &envelope); err != nil {
		return LoopPaneState{}, err
	}
	return envelope.Pane, nil
}

// ListPanes returns the loop_state rows, optionally filtered.
func (c *Client) ListPanes(ctx context.Context, workspaceID, sessionID string) ([]LoopPaneState, error) {
	q := url.Values{}
	if workspaceID != "" {
		q.Set("workspaceId", workspaceID)
	}
	if sessionID != "" {
		q.Set("sessionId", sessionID)
	}
	var out LoopWorkspacesResponse
	path := "/v1/loop/workspaces"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out.Panes, nil
}

// DeletePane removes a pane by id. Returns true when the server
// actually deleted something, false when the pane was missing.
func (c *Client) DeletePane(ctx context.Context, workspaceID, tabID, paneID string) (bool, error) {
	path := "/v1/loop/workspaces/" + url.PathEscape(workspaceID) +
		"/tabs/" + url.PathEscape(tabID) +
		"/panes/" + url.PathEscape(paneID)
	req, err := c.newRequest(ctx, http.MethodDelete, path, nil)
	if err != nil {
		return false, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return false, fmt.Errorf("loop api: delete pane failed (%d): %s", resp.StatusCode, string(body))
	}
	return true, nil
}

// FetchLoopHealth wraps GET /v1/runtime/loop/health.
func (c *Client) FetchLoopHealth(ctx context.Context, workspaceID, paneID, sessionID string, lastN int) (LoopHealthResponse, error) {
	q := url.Values{}
	if workspaceID != "" {
		q.Set("workspaceId", workspaceID)
	}
	if paneID != "" {
		q.Set("paneId", paneID)
	}
	if sessionID != "" {
		q.Set("sessionId", sessionID)
	}
	if lastN > 0 {
		q.Set("lastN", fmt.Sprintf("%d", lastN))
	}
	path := "/v1/runtime/loop/health"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var out LoopHealthResponse
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return LoopHealthResponse{}, err
	}
	return out, nil
}

// WaitForEvents wraps GET /v1/sessions/:id/wait with since / match /
// types / timeout. The caller supplies an `events` slice to decode
// the matched events into; pass `*[]json.RawMessage` to skip
// decoding.
func (c *Client) WaitForEvents(ctx context.Context, sessionID string, opts WaitOptions) (WaitResponse, error) {
	q := url.Values{}
	q.Set("since", fmt.Sprintf("%d", opts.Since))
	if opts.Match != "" {
		q.Set("match", opts.Match)
	}
	if opts.Types != "" {
		q.Set("types", opts.Types)
	}
	if opts.TimeoutMs > 0 {
		q.Set("timeout", fmt.Sprintf("%d", opts.TimeoutMs))
	}
	if opts.Limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", opts.Limit))
	}
	path := "/v1/sessions/" + url.PathEscape(sessionID) + "/wait?" + q.Encode()
	var out WaitResponse
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return WaitResponse{}, err
	}
	return out, nil
}

// CreateSession allocates a server-side canonical session id.
func (c *Client) CreateSession(ctx context.Context, req CreateSessionRequest) (CreateSessionResponse, error) {
	body := map[string]any{}
	if req.Cwd != "" {
		body["cwd"] = req.Cwd
	}
	if req.ClientSessionID != "" {
		body["clientSessionId"] = req.ClientSessionID
	}
	if len(req.Metadata) > 0 {
		body["metadata"] = req.Metadata
	}
	var out CreateSessionResponse
	if err := c.doJSON(ctx, http.MethodPost, "/v1/sessions", body, &out); err != nil {
		return CreateSessionResponse{}, err
	}
	if out.SessionID == "" {
		return CreateSessionResponse{}, errors.New("server returned empty sessionId for POST /v1/sessions")
	}
	return out, nil
}

// ExecutePrompt wraps POST /v1/execute for the loop driver.
// This is the first 6d execution bridge: HTTP gives us a
// deterministic "prompt in, events out" path before the later
// WebSocket slice adds bidirectional permission decisions.
func (c *Client) ExecutePrompt(ctx context.Context, req ExecutePromptRequest) (ExecuteResponse, error) {
	body := map[string]any{
		"prompt": req.Prompt,
	}
	if req.SessionID != "" {
		body["sessionId"] = req.SessionID
	}
	if req.Cwd != "" {
		body["cwd"] = req.Cwd
	}
	if req.TimeoutMs > 0 {
		body["timeoutMs"] = req.TimeoutMs
	}
	if req.Policy != "" {
		body["policy"] = req.Policy
	}
	if len(req.AllowedTools) > 0 {
		body["allowedTools"] = req.AllowedTools
	}
	var out ExecuteResponse
	if err := c.doJSON(ctx, http.MethodPost, "/v1/execute", body, &out); err != nil {
		return ExecuteResponse{}, err
	}
	return out, nil
}

// ExecutePromptRequest carries the subset of /v1/execute fields
// that bbl loop needs for 6d-b.
type ExecutePromptRequest struct {
	Prompt       string
	SessionID    string
	Cwd          string
	TimeoutMs    int
	Policy       string
	AllowedTools []string
}

// ApprovePermission wraps POST /v1/sessions/:sessionId/approve
// for the loop driver (6d-c). The server's
// PendingPermissionRegistry resolves the pending request
// matching (sessionId, toolUseId) and emits a
// permission_response event back through the wait stream
// — the client's wait handler clears the pane's
// PendingPermission on receipt.
//
// The `scope` field follows the Nexus Phase A.1 schema:
// "once" (default) / "session" / "rule". `rule` is only
// meaningful when scope="rule"; it's the suggested allow
// pattern (e.g. "Bash(git:*)") the operator may have edited.
func (c *Client) ApprovePermission(ctx context.Context, sessionID, toolUseID string, opts ApprovePermissionOptions) error {
	if sessionID == "" || toolUseID == "" {
		return errors.New("loop api: ApprovePermission requires sessionID and toolUseID")
	}
	body := map[string]any{"toolUseId": toolUseID}
	if opts.Scope != "" {
		body["scope"] = opts.Scope
	}
	if opts.Rule != "" {
		body["rule"] = opts.Rule
	}
	if opts.Feedback != "" {
		body["feedback"] = opts.Feedback
	}
	path := "/v1/sessions/" + url.PathEscape(sessionID) + "/approve"
	return c.doJSON(ctx, http.MethodPost, path, body, nil)
}

// DenyPermission wraps POST /v1/sessions/:sessionId/deny
// (6d-c). `reason` is the "why" surfaced in the runtime's
// trace + the assistant's next prompt; `feedback` is the
// "what to do instead" free text. Either may be empty;
// both travel on the same wire as the runtime expects.
func (c *Client) DenyPermission(ctx context.Context, sessionID, toolUseID, reason, feedback string) error {
	if sessionID == "" || toolUseID == "" {
		return errors.New("loop api: DenyPermission requires sessionID and toolUseID")
	}
	body := map[string]any{"toolUseId": toolUseID}
	if reason != "" {
		body["reason"] = reason
	}
	if feedback != "" {
		body["feedback"] = feedback
	}
	path := "/v1/sessions/" + url.PathEscape(sessionID) + "/deny"
	return c.doJSON(ctx, http.MethodPost, path, body, nil)
}

// CancelSession wraps POST /v1/sessions/:sessionId/cancel
// (6d-d). The server aborts the in-flight execute via
// the activeExecution abortController and transitions
// the session to phase='cancelled' (or whatever
// `reason` field hints at). Returns the server's
// session_cancelled envelope so the caller can see
// whether an active execution was actually cancelled
// (`ActiveExecutionCancelled` flag) and how many child
// sessions were rolled up.
//
// The empty-sessionID guard is the same pattern
// Approve/Deny use; the runtime's session-not-found 404
// surfaces as a normal Go error (doJSON handles the
// status code).
func (c *Client) CancelSession(ctx context.Context, sessionID, reason string) (CancelResponse, error) {
	if sessionID == "" {
		return CancelResponse{}, errors.New("loop api: CancelSession requires sessionID")
	}
	body := map[string]any{}
	if reason != "" {
		body["reason"] = reason
	}
	var out CancelResponse
	path := "/v1/sessions/" + url.PathEscape(sessionID) + "/cancel"
	if err := c.doJSON(ctx, http.MethodPost, path, body, &out); err != nil {
		return CancelResponse{}, err
	}
	return out, nil
}

// CancelResponse mirrors the wire shape of
// POST /v1/sessions/:sessionId/cancel. The runtime
// returns `session_cancelled` plus the bookkeeping
// fields the loop driver reads to decide whether the
// pane should re-show a waiting placeholder (no active
// execution was cancelled — the cancel raced a
// natural completion) or flip straight to a "cancelled
// by operator" status.
type CancelResponse struct {
	Type                     string `json:"type"`
	SessionID                string `json:"sessionId"`
	Phase                    string `json:"phase"`
	ActiveExecutionCancelled bool   `json:"activeExecutionCancelled"`
	RequestID                string `json:"requestId,omitempty"`
	Transport                string `json:"transport,omitempty"`
	PermissionsResolved      int    `json:"permissionsResolved"`
	ChildSessionsCancelled   int    `json:"childSessionsCancelled"`
}

// ApprovePermissionOptions carries the optional scope/rule/
// feedback fields the server accepts on /approve. Zero
// values are dropped from the JSON body so the server falls
// back to its defaults (scope='once', no rule, no feedback).
type ApprovePermissionOptions struct {
	Scope    string
	Rule     string
	Feedback string
}

// WaitOptions carries wait query parameters. Zero values are
// omitted from the URL so the server falls back to its defaults.
type WaitOptions struct {
	Since     int64
	Match     string
	Types     string
	TimeoutMs int
	Limit     int
}

// doJSON is the shared request / decode helper. It sets the API
// key header, encodes `body` as JSON when non-nil, and decodes
// the response into `out`.
func (c *Client) doJSON(ctx context.Context, method, path string, body any, out any) error {
	var bodyReader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("loop api: marshal body: %w", err)
		}
		bodyReader = bytes.NewReader(encoded)
	}
	req, err := c.newRequest(ctx, method, path, bodyReader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("loop api: %s %s failed (%d): %s", method, path, resp.StatusCode, string(raw))
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("loop api: decode response: %w", err)
	}
	return nil
}

func (c *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	if c == nil || c.HTTP == nil {
		return nil, errors.New("loop api: nil client")
	}
	if c.BaseURL == "" {
		return nil, errors.New("loop api: empty BaseURL")
	}
	full := c.BaseURL + path
	req, err := http.NewRequestWithContext(ctx, method, full, body)
	if err != nil {
		return nil, fmt.Errorf("loop api: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	return req, nil
}
