// internal/loop/api/behavior_trace_test.go
//
// PR-B2 tests for FetchBehaviorTrace. httptest.Server stands in for
// the real Nexus so the test surface stays hermetic; the contract is
// verified against the JSON shapes produced by src/nexus/app.ts
// (runBehaviorTraceGet helper).
//
// Pattern mirrors client_test.go (newTestClient, captured path assertions).

package api

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestFetchBehaviorTraceDecodesEntries(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/context/trace" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		cwd := r.URL.Query().Get("cwd")
		if cwd == "" {
			t.Error("cwd query param missing")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"type": "behavior_trace_result",
			"cwd": "/tmp/test-cwd",
			"sessionId": "session-1",
			"entries": [
				{
					"schemaVersion": "2026-06-16.behavior-trace.v1",
					"traceId": "trace-001",
					"sessionId": "session-1",
					"cwd": "/tmp/test-cwd",
					"timestamp": "2026-06-17T12:00:00.000Z",
					"trigger": "error",
					"triggerConfidence": 0.9,
					"context": {"recentEvents": []},
					"anomaly": {
						"errorCode": "E_TIMEOUT",
						"errorMessage": "tool execution timed out"
					}
				},
				{
					"schemaVersion": "2026-06-16.behavior-trace.v1",
					"traceId": "trace-002",
					"sessionId": "session-1",
					"cwd": "/tmp/test-cwd",
					"timestamp": "2026-06-17T14:00:00.000Z",
					"trigger": "scope-drift",
					"triggerConfidence": 0.7,
					"context": {},
					"anomaly": {
						"driftPath": "src/nexus/app.ts",
						"expectedScope": "tool surface"
					}
				}
			],
			"count": 2
		}`))
	})
	client, _ := newTestClient(t, handler)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	resp, err := client.FetchBehaviorTrace(ctx, "/tmp/test-cwd", "session-1", 100, 0)
	if err != nil {
		t.Fatalf("FetchBehaviorTrace: %v", err)
	}
	if resp.Count != 2 {
		t.Errorf("Count = %d, want 2", resp.Count)
	}
	if len(resp.Entries) != 2 {
		t.Fatalf("len(Entries) = %d, want 2", len(resp.Entries))
	}
	e0 := resp.Entries[0]
	if e0.Trigger != "error" {
		t.Errorf("Entries[0].Trigger = %q, want %q", e0.Trigger, "error")
	}
	if e0.Anomaly.ErrorCode != "E_TIMEOUT" {
		t.Errorf("Entries[0].Anomaly.ErrorCode = %q, want %q", e0.Anomaly.ErrorCode, "E_TIMEOUT")
	}
	e1 := resp.Entries[1]
	if e1.Trigger != "scope-drift" {
		t.Errorf("Entries[1].Trigger = %q, want %q", e1.Trigger, "scope-drift")
	}
	if e1.Anomaly.DriftPath != "src/nexus/app.ts" {
		t.Errorf("Entries[1].Anomaly.DriftPath = %q, want %q", e1.Anomaly.DriftPath, "src/nexus/app.ts")
	}
}

func TestFetchBehaviorTraceMissingCwd(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":"cwd query param is required"}`))
	})
	client, _ := newTestClient(t, handler)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, err := client.FetchBehaviorTrace(ctx, "", "", 100, 0)
	if err == nil {
		t.Fatal("expected error for missing cwd")
	}
}

func TestFetchBehaviorTraceEmptyArray(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"type": "behavior_trace_result",
			"cwd": "/tmp/test-cwd",
			"sessionId": "",
			"entries": [],
			"count": 0
		}`))
	})
	client, _ := newTestClient(t, handler)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	resp, err := client.FetchBehaviorTrace(ctx, "/tmp/test-cwd", "", 100, 0)
	if err != nil {
		t.Fatalf("FetchBehaviorTrace: %v", err)
	}
	if resp.Count != 0 {
		t.Errorf("Count = %d, want 0", resp.Count)
	}
	if len(resp.Entries) != 0 {
		t.Errorf("len(Entries) = %d, want 0", len(resp.Entries))
	}
}

func TestFetchBehaviorTracePassesParams(t *testing.T) {
	var capturedPath string
	var capturedQuery string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"behavior_trace_result","cwd":"/tmp","sessionId":"","entries":[],"count":0}`))
	})
	client, _ := newTestClient(t, handler)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, err := client.FetchBehaviorTrace(ctx, "/tmp/my-cwd", "sid-1", 50, 3600000)
	if err != nil {
		t.Fatalf("FetchBehaviorTrace: %v", err)
	}
	if capturedPath != "/v1/context/trace" {
		t.Errorf("path = %q, want /v1/context/trace", capturedPath)
	}
	// Verify query parameters are passed correctly.
	vals, err := parseQuery(capturedQuery)
	if err != nil {
		t.Fatalf("parseQuery: %v", err)
	}
	if vals.Get("cwd") != "/tmp/my-cwd" {
		t.Errorf("cwd = %q, want /tmp/my-cwd", vals.Get("cwd"))
	}
	if vals.Get("sessionId") != "sid-1" {
		t.Errorf("sessionId = %q, want sid-1", vals.Get("sessionId"))
	}
	if vals.Get("limit") != "50" {
		t.Errorf("limit = %q, want 50", vals.Get("limit"))
	}
	if vals.Get("sinceMs") != "3600000" {
		t.Errorf("sinceMs = %q, want 3600000", vals.Get("sinceMs"))
	}
}

func TestFetchBehaviorTraceLimitZeroOmitted(t *testing.T) {
	var capturedQuery string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"behavior_trace_result","cwd":"/tmp","sessionId":"","entries":[],"count":0}`))
	})
	client, _ := newTestClient(t, handler)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, err := client.FetchBehaviorTrace(ctx, "/tmp/my-cwd", "", 0, 0)
	if err != nil {
		t.Fatalf("FetchBehaviorTrace: %v", err)
	}
	// limit=0 and sinceMs=0 should be omitted (server default).
	vals, err := parseQuery(capturedQuery)
	if err != nil {
		t.Fatalf("parseQuery: %v", err)
	}
	if vals.Get("limit") != "" {
		t.Errorf("limit should be omitted when 0, got %q", vals.Get("limit"))
	}
	if vals.Get("sinceMs") != "" {
		t.Errorf("sinceMs should be omitted when 0, got %q", vals.Get("sinceMs"))
	}
}

func parseQuery(raw string) (result, error) {
	values, err := url.ParseQuery(raw)
	if err != nil {
		return nil, err
	}
	return result(values), nil
}

type result url.Values

func (r result) Get(key string) string {
	return url.Values(r).Get(key)
}
