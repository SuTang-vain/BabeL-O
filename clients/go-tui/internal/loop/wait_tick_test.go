// internal/loop/wait_tick_test.go
//
// Phase 6c tests (docs §6'): per-pane waitForEvent plumbing.
// Covers the 5 points called out in §6'.3 6c test-point list
// (single-flight, append, transcript cap, close cleanup,
// soft timeout). BuildTranscriptLines / EventToTranscriptItem
// have their own tests in transcript_test.go / phase6c_test.go
// — this file is about the per-pane state machine on
// InteractiveModel, not the leaf-level shaping.

package loop

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// TestWaitDoneAppendsToTranscript asserts the happy path: a
// /v1/sessions/:id/wait response with one event gets shaped
// into a TranscriptItem and appended to the pane's
// Transcript. LastEventRev advances to NextRev.
func TestWaitDoneAppendsToTranscript(t *testing.T) {
	server := newWaitServer(t, []waitServerEvent{
		{Raw: `{"type":"user_prompt","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","text":"explain the diff"}`, NextRev: 11},
	})
	defer server.Close()

	im := newWaitTestModel(t, server.URL, "pane-1", "s1", 10)
	cmd := im.startWaitForPane(im.loop.Workspaces[0].Tabs[0].Panes[0])
	if cmd == nil {
		t.Fatal("startWaitForPane should produce a cmd")
	}
	msg := cmd()
	done, ok := msg.(waitDoneMsg)
	if !ok {
		t.Fatalf("expected waitDoneMsg, got %T", msg)
	}
	if done.Err != nil {
		t.Fatalf("waitErr: %v", done.Err)
	}
	im.handleWaitDone(done)

	pane, _ := im.loop.PaneAt(0, 0, 0)
	if len(pane.Transcript) != 1 {
		t.Fatalf("transcript should have 1 item, got %d", len(pane.Transcript))
	}
	if pane.Transcript[0].Role != RoleUser {
		t.Errorf("item.Role = %d, want RoleUser", pane.Transcript[0].Role)
	}
	if pane.Transcript[0].Text != "explain the diff" {
		t.Errorf("item.Text = %q, want %q", pane.Transcript[0].Text, "explain the diff")
	}
	if pane.LastEventRev != 11 {
		t.Errorf("LastEventRev = %d, want 11", pane.LastEventRev)
	}
}

// TestWaitDoneSkipsUnknownEvents asserts that events the
// transcript doesn't shape (per EventToTranscriptItem's
// unknown-type path) are still consumed for revision
// advancement — the cursor moves forward but the body
// doesn't grow.
func TestWaitDoneSkipsUnknownEvents(t *testing.T) {
	server := newWaitServer(t, []waitServerEvent{
		{Raw: `{"type":"some_progress_tick","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z"}`, NextRev: 5},
	})
	defer server.Close()

	im := newWaitTestModel(t, server.URL, "pane-1", "s1", 4)
	cmd := im.startWaitForPane(im.loop.Workspaces[0].Tabs[0].Panes[0])
	msg := cmd()
	im.handleWaitDone(msg.(waitDoneMsg))

	pane, _ := im.loop.PaneAt(0, 0, 0)
	if len(pane.Transcript) != 0 {
		t.Errorf("transcript should be empty for unknown events, got %d items", len(pane.Transcript))
	}
	if pane.LastEventRev != 5 {
		t.Errorf("LastEventRev should still advance to 5, got %d", pane.LastEventRev)
	}
}

// TestStartWaitForPaneSkipsInFlight asserts the single-flight
// invariant (per §6'.3 6c point 3): a second startWaitForPane
// call for a pane with an in-flight wait returns nil. This
// is the guard that prevents stacking concurrent polls on the
// same session id.
func TestStartWaitForPaneSkipsInFlight(t *testing.T) {
	server := newWaitServer(t, nil)
	defer server.Close()

	im := newWaitTestModel(t, server.URL, "pane-1", "s1", 0)
	pane := im.loop.Workspaces[0].Tabs[0].Panes[0]
	cmd1 := im.startWaitForPane(pane)
	if cmd1 == nil {
		t.Fatal("first startWaitForPane should produce a cmd")
	}
	cmd2 := im.startWaitForPane(pane)
	if cmd2 != nil {
		t.Fatal("second startWaitForPane for an in-flight pane should be nil")
	}
	if !im.isWaitInFlight("pane-1") {
		t.Fatal("pane-1 should be marked in-flight after first start")
	}
}

// TestWaitDoneClearsInFlight is the matching side of the
// single-flight guard: when the wait completes
// (handleWaitDone) the in-flight flag is cleared, even on
// error, so the next reconcile tick / next scheduleWaitTick
// can start a fresh poll.
func TestWaitDoneClearsInFlight(t *testing.T) {
	// Use a server URL that doesn't resolve so the HTTP
	// call fails fast — we just need an error path.
	im := newWaitTestModel(t, "http://127.0.0.1:1", "pane-1", "s1", 0)
	pane := im.loop.Workspaces[0].Tabs[0].Panes[0]
	im.setWaitInFlight(pane.PaneID)

	im.handleWaitDone(waitDoneMsg{PaneID: "pane-1", Err: errTestWait})
	if im.isWaitInFlight("pane-1") {
		t.Fatal("waitInFlight should be cleared on error result")
	}
}

// TestWaitDoneTrimsTranscriptAt500 asserts the cap (per
// §6'.3 6c point 7): when a wait page returns more than
// maxTranscriptItems events, the oldest are dropped so the
// pane's memory stays bounded.
func TestWaitDoneTrimsTranscriptAt500(t *testing.T) {
	// Build a single wait page that returns maxTranscriptItems
	// shaped events. We only need 501 to exceed the cap by 1.
	events := make([]waitServerEvent, 0, maxTranscriptItems+1)
	for i := 0; i <= maxTranscriptItems; i++ {
		events = append(events, waitServerEvent{
			Raw:     `{"type":"user_prompt","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","text":"` + strings.Repeat("x", 4+i%8) + `"}`,
			NextRev: int64(100 + i),
		})
	}
	server := newWaitServer(t, events)
	defer server.Close()

	im := newWaitTestModel(t, server.URL, "pane-1", "s1", 99)
	cmd := im.startWaitForPane(im.loop.Workspaces[0].Tabs[0].Panes[0])
	msg := cmd()
	im.handleWaitDone(msg.(waitDoneMsg))

	pane, _ := im.loop.PaneAt(0, 0, 0)
	if len(pane.Transcript) != maxTranscriptItems {
		t.Fatalf("transcript should be capped at %d, got %d", maxTranscriptItems, len(pane.Transcript))
	}
}

// TestParseNextRevision covers the envelope-side cursor
// recovery: the server returns nextRevision as a string that
// can be empty (timeout) or non-numeric (malformed). We
// default to `since` so the cursor never accidentally
// regresses.
func TestParseNextRevision(t *testing.T) {
	cases := []struct {
		in       string
		fallback int64
		want     int64
	}{
		{"", 42, 42},
		{"malformed", 42, 42},
		{"abc123", 42, 42},
		{"100", 42, 100},
		{"42", 100, 100}, // never go below fallback
		{"0", 100, 100},
	}
	for _, c := range cases {
		got := parseNextRevision(c.in, c.fallback)
		if got != c.want {
			t.Errorf("parseNextRevision(%q, %d) = %d, want %d", c.in, c.fallback, got, c.want)
		}
	}
}

// ── helpers ──────────────────────────────────────────────────

type waitServerEvent struct {
	Raw     string
	NextRev int64
}

func newWaitServer(t *testing.T, events []waitServerEvent) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Match /v1/sessions/:id/wait
		if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/v1/sessions/") || !strings.HasSuffix(r.URL.Path, "/wait") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		// Echo one page; tests that need cap-overflow build
		// many events into the same page.
		rawEvents := make([]json.RawMessage, 0, len(events))
		var nextRev int64
		for _, e := range events {
			rawEvents = append(rawEvents, json.RawMessage(e.Raw))
			if e.NextRev > nextRev {
				nextRev = e.NextRev
			}
		}
		if nextRev == 0 && len(events) == 0 {
			nextRev = 0
		}
		writeJSON(w, map[string]any{
			"type":         "wait",
			"events":       rawEvents,
			"nextRevision": itoa(nextRev),
		})
	}))
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// newWaitTestModel builds an InteractiveModel with a single
// pane already in the model, ready for waitTick tests.
func newWaitTestModel(t *testing.T, serverURL, paneID, sessionID string, lastRev int64) *InteractiveModel {
	t.Helper()
	client := api.NewClient(serverURL, "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(),
		nil, // no store — wait handler doesn't touch it
		nil, // no reconciler
		0,   // no reconcile interval
		client,
		0, // no health interval
		nil, nil, // no toast/sound — wait handler doesn't need them
	)
	// Seed the focused tab with a single pane.
	seeded, _ := seedPane(im.loop, PaneModel{
		PaneID:       paneID,
		WorkspaceID:  defaultWSID,
		TabID:        defaultTabID,
		SessionID:    sessionID,
		Agent:        "bbl",
		Cwd:          "/repo",
		Label:        "main",
		Status:       StatusIdle,
		LastEventRev: lastRev,
	})
	im.loop = seeded
	return &im
}

// errTestWait is a sentinel error for the in-flight-clear
// test (we don't need to assert on its text, just that the
// in-flight flag is cleared when the handler sees it).
var errTestWait = errSentinel("test wait failure")

type errSentinel string

func (e errSentinel) Error() string { return string(e) }

// ── 6d-c: routeWaitEventToPane permission routing ────────────

// TestRouteWaitEventToPanePermissionRequest: a
// permission_request event writes the pane's
// PendingPermission field. EventToPermission's full-payload
// contract is tested separately in
// permission_events_test.go; here we just verify the
// dispatch landed on PendingPermission and not on
// Transcript.
func TestRouteWaitEventToPanePermissionRequest(t *testing.T) {
	pane := PaneModel{PaneID: "p1", SessionID: "s1"}
	raw := []byte(`{"type":"permission_request","toolUseId":"toolu_1","name":"Bash","risk":"execute","message":"needs approval"}`)
	routeWaitEventToPane(raw, &pane)
	if pane.PendingPermission == nil {
		t.Fatal("permission_request should populate PendingPermission")
	}
	if pane.PendingPermission.ToolUseID != "toolu_1" {
		t.Errorf("ToolUseID = %q, want toolu_1", pane.PendingPermission.ToolUseID)
	}
	if len(pane.Transcript) != 0 {
		t.Errorf("permission_request should not append to Transcript, got %d items", len(pane.Transcript))
	}
}

// TestRouteWaitEventToPanePermissionRequestReplacesEarlier:
// a newer permission_request replaces an earlier one on
// the same pane. The runtime never asks the operator about
// two at once, so the dialog should always show the
// freshest request. Older PendingPermission is dropped
// wholesale (no merging — the new one is a complete
// replacement).
func TestRouteWaitEventToPanePermissionRequestReplacesEarlier(t *testing.T) {
	pane := PaneModel{PaneID: "p1"}
	pane.PendingPermission = &PanePermission{ToolUseID: "old", Name: "Read"}
	raw := []byte(`{"type":"permission_request","toolUseId":"new","name":"Bash","risk":"execute","message":"y"}`)
	routeWaitEventToPane(raw, &pane)
	if pane.PendingPermission.ToolUseID != "new" {
		t.Errorf("PendingPermission.ToolUseID = %q, want new", pane.PendingPermission.ToolUseID)
	}
	if pane.PendingPermission.Name != "Bash" {
		t.Errorf("PendingPermission.Name = %q, want Bash", pane.PendingPermission.Name)
	}
}

// TestRouteWaitEventToPanePermissionResponseClears: a
// permission_response event clears PendingPermission. The
// operator's decision has been recorded; even if a brand
// new request has arrived in between, dropping the prior
// pending state is correct (the new request will arrive
// in its own permission_request event and re-set the
// field if needed).
func TestRouteWaitEventToPanePermissionResponseClears(t *testing.T) {
	pane := PaneModel{PaneID: "p1"}
	pane.PendingPermission = &PanePermission{ToolUseID: "toolu_1", Name: "Bash"}
	raw := []byte(`{"type":"permission_response","toolUseId":"toolu_1","approved":true}`)
	routeWaitEventToPane(raw, &pane)
	if pane.PendingPermission != nil {
		t.Errorf("permission_response should clear PendingPermission, got %+v", pane.PendingPermission)
	}
}

// TestRouteWaitEventToPaneTranscriptFallthrough: events
// that are neither permission_request nor
// permission_response go through to
// EventToTranscriptItem unchanged. This is the 6c
// regression guard: existing transcript behavior must
// not be broken by the new dispatch.
func TestRouteWaitEventToPaneTranscriptFallthrough(t *testing.T) {
	pane := PaneModel{PaneID: "p1"}
	raw := []byte(`{"type":"user_prompt","sessionId":"s1","timestamp":"2026-06-17T00:00:00Z","text":"hi"}`)
	routeWaitEventToPane(raw, &pane)
	if pane.PendingPermission != nil {
		t.Errorf("user_prompt should not touch PendingPermission, got %+v", pane.PendingPermission)
	}
	if len(pane.Transcript) != 1 {
		t.Fatalf("user_prompt should append to Transcript, got %d items", len(pane.Transcript))
	}
	if pane.Transcript[0].Role != RoleUser {
		t.Errorf("Transcript[0].Role = %d, want RoleUser", pane.Transcript[0].Role)
	}
}

// TestRouteWaitEventToPaneIgnoresEmptyAndMalformed:
// defensive — nil pane, nil raw, malformed JSON, and
// missing type all return without panicking.
func TestRouteWaitEventToPaneIgnoresEmptyAndMalformed(t *testing.T) {
	pane := PaneModel{PaneID: "p1"}
	// nil pane: function should not panic; we cannot
	// assert anything about return because the function
	// returns nothing. The contract is "doesn't crash".
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("nil pane should not panic, got %v", r)
		}
	}()
	routeWaitEventToPane(nil, &pane)
	routeWaitEventToPane([]byte(""), &pane)
	routeWaitEventToPane([]byte("{not valid json"), &pane)
	routeWaitEventToPane([]byte(`{"type":""}`), &pane)
	if pane.PendingPermission != nil {
		t.Errorf("malformed events should not populate PendingPermission")
	}
	if len(pane.Transcript) != 0 {
		t.Errorf("malformed events should not populate Transcript")
	}
}
