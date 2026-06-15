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
type LoopHealthPane struct {
	SessionID             string         `json:"sessionId"`
	Agent                 string         `json:"agent"`
	Status                string         `json:"status"`
	PendingPermissions    int            `json:"pendingPermissions"`
	PendingScopeBoundaries int            `json:"pendingScopeBoundaries"`
	OutOfScopeEvidence    int            `json:"outOfScopeEvidence"`
	LastEventRev          int64          `json:"lastEventRev"`
	LastEventAt           string         `json:"lastEventAt"`
	TaskScope             LoopTaskScope  `json:"taskScope"`
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

// LoopWorkspacesResponse mirrors GET /v1/loop/workspaces.
type LoopWorkspacesResponse struct {
	Type   string         `json:"type"`
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
