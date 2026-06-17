// clients/go-tui/internal/loop/api/behavior_trace.go
//
// PR-B2: typed response shape + FetchBehaviorTrace method for the
// /v1/context/trace server endpoint (user-approved 2026-06-17).
// Mirrors the FetchLoopHealth pattern at client.go:230-254.
// Types mirror src/runtime/behaviorTrace.ts:69-89.
//
// This file is separate from client.go to keep the 600+ line core
// client untouched during the user's Phase 6' WIP window.

package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// BehaviorTraceAnomaly mirrors src/runtime/behaviorTrace.ts:69-76.
type BehaviorTraceAnomaly struct {
	ErrorCode          string `json:"errorCode,omitempty"`
	ErrorMessage       string `json:"errorMessage,omitempty"`
	DenialReason       string `json:"denialReason,omitempty"`
	DriftPath          string `json:"driftPath,omitempty"`
	ExpectedScope      string `json:"expectedScope,omitempty"`
	UserRedirectSignal string `json:"userRedirectSignal,omitempty"`
}

// BehaviorTraceEntry mirrors src/runtime/behaviorTrace.ts:78-89.
type BehaviorTraceEntry struct {
	SchemaVersion     string               `json:"schemaVersion"`
	TraceID           string               `json:"traceId"`
	SessionID         string               `json:"sessionId"`
	Cwd               string               `json:"cwd"`
	Timestamp         string               `json:"timestamp"`
	Trigger           string               `json:"trigger"`
	TriggerConfidence float64              `json:"triggerConfidence"`
	Context           map[string]any       `json:"context"`
	Anomaly           BehaviorTraceAnomaly `json:"anomaly"`
	SelfAssessment    map[string]any       `json:"selfAssessment,omitempty"`
}

// BehaviorTraceResponse is the server response shape for
// GET /v1/context/trace.
type BehaviorTraceResponse struct {
	Type      string               `json:"type"`
	Cwd       string               `json:"cwd"`
	SessionID string               `json:"sessionId"`
	Entries   []BehaviorTraceEntry `json:"entries"`
	Count     int                  `json:"count"`
}

// FetchBehaviorTrace calls GET /v1/context/trace?cwd=&sessionId=&limit=&sinceMs=.
// limit defaults to 100 (server default when 0). sinceMs defaults to 24h
// (server default when 0).
func (c *Client) FetchBehaviorTrace(ctx context.Context, cwd, sessionID string, limit int, sinceMs int64) (BehaviorTraceResponse, error) {
	q := url.Values{}
	q.Set("cwd", cwd)
	if sessionID != "" {
		q.Set("sessionId", sessionID)
	}
	if limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", limit))
	}
	if sinceMs > 0 {
		q.Set("sinceMs", fmt.Sprintf("%d", sinceMs))
	}
	path := "/v1/context/trace"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var out BehaviorTraceResponse
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return BehaviorTraceResponse{}, fmt.Errorf("loop api: fetch behavior trace: %w", err)
	}
	return out, nil
}
