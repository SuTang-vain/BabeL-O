// internal/loop/scope_review_live_integration_test.go
//
// Phase 6d-e integration: handleHealthDone now promotes
// the live /v1/runtime/loop/health payload to
// m.scopeReviewInput. The ctrl+r scope_review overlay
// therefore renders live taskScope + counts without a
// test-only SetScopeReviewInputForTest injection.
//
// What this file covers:
//   - handleHealthDone (success) populates m.scopeReviewInput
//   - the populated input has the focused pane's taskScope
//     + counts
//   - handleHealthDone (error) clears m.scopeReviewInput so
//     stale data from a previous successful poll doesn't
//     leak into the overlay after a server outage
//
// What this file does NOT cover:
//   - BuildScopeReviewInputFromHealth unit semantics
//     (scope_review_live_test.go)
//   - chrome overlay rendering with the populated input
//     (overlay_splice_test.go covers the splice + placeholder
//     + injected-data paths; a live-data overlay test would
//     be redundant given the pure-function tests above)

package loop

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// TestHandleHealthDonePopulatesScopeReviewInput: a
// successful health poll promotes the focused pane's
// taskScope + counts into m.scopeReviewInput so the
// ctrl+r overlay shows live data.
func TestHandleHealthDonePopulatesScopeReviewInput(t *testing.T) {
	// Spin up a mock Nexus that returns one health pane
	// matching the focused session.
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/runtime/loop/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"type": "loop_health",
			"panes": [{
				"sessionId": "session-1",
				"agent": "bbl",
				"status": "drift",
				"pendingPermissions": 0,
				"pendingScopeBoundaries": 3,
				"outOfScopeEvidence": 1,
				"activeMemoryCandidates": 2,
				"lastEventRev": 42,
				"lastEventAt": "2026-06-17T00:00:00.000Z",
				"taskScope": {
					"cwd": "/workspace",
					"primaryRoot": "/workspace",
					"explicitRoots": [],
					"confirmedExternalRoots": ["/external/x"],
					"inferredCandidateRoots": [],
					"mode": "multi_root",
					"source": "user_confirmation",
					"latestDeclaredAt": "2026-06-17T00:00:00.000Z"
				}
			}],
			"filter": {"workspaceId":null,"paneId":null,"sessionId":null,"lastN":0}
		}`))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	client := api.NewClient(server.URL, "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(),
		nil, nil, 0, client, 0, nil, nil,
	)
	seeded, _ := seedPane(im.loop, PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Label:       "main",
		Status:      StatusWorking,
	})
	im.loop = seeded

	// Pre-state: scopeReviewInput is nil (test-only path
	// not yet used).
	if im.scopeReviewInput != nil {
		t.Fatal("preflight: scopeReviewInput should be nil before first health tick")
	}

	// Drive handleHealthDone with a successful response.
	im.handleHealthDone(healthDoneMsg{
		resp: api.LoopHealthResponse{
			Type: "loop_health",
			Panes: []api.LoopHealthPane{{
				SessionID:              "session-1",
				Status:                 "drift",
				PendingScopeBoundaries: 3,
				OutOfScopeEvidence:     1,
				ActiveMemoryCandidates: 2,
				LastEventRev:           42,
				LastEventAt:            "2026-06-17T00:00:00.000Z",
				TaskScope: api.LoopTaskScope{
					Mode: "multi_root", PrimaryRoot: "/workspace",
					ConfirmedExternalRoots: []string{"/external/x"},
				},
			}},
		},
		at: time.Now(),
	})

	// Post-state: scopeReviewInput is non-nil and reflects
	// the focused pane's health row.
	if im.scopeReviewInput == nil {
		t.Fatal("handleHealthDone should populate scopeReviewInput on success")
	}
	if im.scopeReviewInput.TaskScope == nil {
		t.Fatal("scopeReviewInput.TaskScope should be lifted from the focused pane's taskScope")
	}
	if im.scopeReviewInput.TaskScope.Mode != "multi_root" {
		t.Errorf("TaskScope.Mode = %q, want multi_root", im.scopeReviewInput.TaskScope.Mode)
	}
	if im.scopeReviewInput.PendingBoundaryCount != 3 {
		t.Errorf("PendingBoundaryCount = %d, want 3", im.scopeReviewInput.PendingBoundaryCount)
	}
	if im.scopeReviewInput.OutOfScopeEvidenceCount != 1 {
		t.Errorf("OutOfScopeEvidenceCount = %d, want 1", im.scopeReviewInput.OutOfScopeEvidenceCount)
	}
	if im.scopeReviewInput.MemoryCandidateCount != 2 {
		t.Errorf("MemoryCandidateCount = %d, want 2", im.scopeReviewInput.MemoryCandidateCount)
	}

	// Render the active scope review lines through the
	// model — this is the production path the chrome
	// takes on every View while the overlay is open.
	im.scopeReviewOpen = true
	lines := im.activeScopeReviewLines()
	if len(lines) == 0 {
		t.Fatal("activeScopeReviewLines should render at least the header line")
	}
	body := strings.Join(lines, "\n")
	if !strings.Contains(body, "Scope review") {
		t.Errorf("overlay header missing, got:\n%s", body)
	}
	if !strings.Contains(body, "pending boundaries: 3") {
		t.Errorf("live boundary count missing, got:\n%s", body)
	}
	if !strings.Contains(body, "out-of-scope evidence: 1") {
		t.Errorf("live evidence count missing, got:\n%s", body)
	}
	if !strings.Contains(body, "memory candidates: 2") {
		t.Errorf("live memory count missing, got:\n%s", body)
	}
	if !strings.Contains(body, "mode=multi_root") {
		t.Errorf("live taskScope mode missing, got:\n%s", body)
	}
}

// TestHandleHealthDoneErrorClearsScopeReviewInput: a
// failed health poll clears the cached input so a
// subsequent overlay open falls back to the "no scope
// data yet" placeholder rather than serving stale data
// from the previous successful poll.
func TestHandleHealthDoneErrorClearsScopeReviewInput(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(),
		nil, nil, 0, nil, 0, nil, nil,
	)
	// Seed a stale input (as if a previous successful
	// poll had populated it).
	im.scopeReviewInput = &ScopeReviewInput{Model: im.loop}
	im.scopeReviewOpen = true

	im.handleHealthDone(healthDoneMsg{
		err: errSentinel("simulated nexus outage"),
		at:  time.Now(),
	})
	if im.scopeReviewInput != nil {
		t.Error("handleHealthDone with err should clear scopeReviewInput")
	}
	if !strings.Contains(im.toastMessage, "✗") {
		t.Errorf("error toast should be prefixed with ✗, got %q", im.toastMessage)
	}
	// The overlay's active lines should fall back to the
	// placeholder so the operator knows the data is stale.
	lines := im.activeScopeReviewLines()
	if len(lines) == 0 || !strings.Contains(strings.Join(lines, "\n"), "no scope data") {
		t.Errorf("overlay should render placeholder after error, got:\n%v", lines)
	}
}

// errSentinel is shared with wait_tick_test.go (which
// owns the type declaration); we use it here to construct
// a stable error value for the error-path integration
// test.
//
// TestScopeReviewOverlayShowsLiveData: the overlay
// rendered via the chrome's View path with a live
// scopeReviewInput (as set by handleHealthDone) shows
// the live counts in the chrome output. This is the
// end-to-end sanity check that the wire is plumbed
// correctly: open overlay + View() should display the
// live data, not the placeholder.
func TestScopeReviewOverlayShowsLiveData(t *testing.T) {
	client := api.NewClient("http://127.0.0.1:1", "test") // unreachable; tests SetScopeReviewInputForTest path
	_ = client
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(),
		nil, nil, 0, client, 0, nil, nil,
	)
	seeded, _ := seedPane(im.loop, PaneModel{
		PaneID:      "pane-overlay",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-overlay",
		Agent:       "bbl",
		Label:       "main",
		Status:      StatusDrift,
	})
	im.loop = seeded

	// Simulate handleHealthDone by setting the input
	// directly (avoids needing a real HTTP server in this
	// integration test — the production path is covered by
	// TestHandleHealthDonePopulatesScopeReviewInput).
	im.scopeReviewInput = BuildScopeReviewInputFromHealth(im.loop, api.LoopHealthResponse{
		Type: "loop_health",
		Panes: []api.LoopHealthPane{{
			SessionID: "session-overlay", Status: "drift",
			PendingScopeBoundaries: 5, OutOfScopeEvidence: 2,
			ActiveMemoryCandidates: 1,
			TaskScope: api.LoopTaskScope{Mode: "multi_root", PrimaryRoot: "/workspace"},
		}},
	})

	updated, _ := im.Update(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})
	newModel := updated.(InteractiveModel)
	if !newModel.scopeReviewOpen {
		t.Fatal("ctrl+r should open scope_review overlay")
	}
	body := newModel.View().Content
	if !strings.Contains(body, "pending boundaries: 5") {
		t.Errorf("chrome should show live boundary count, got:\n%s", body)
	}
	if !strings.Contains(body, "out-of-scope evidence: 2") {
		t.Errorf("chrome should show live evidence count, got:\n%s", body)
	}
	if !strings.Contains(body, "memory candidates: 1") {
		t.Errorf("chrome should show live memory count, got:\n%s", body)
	}
	if strings.Contains(body, "no scope data yet") {
		t.Errorf("chrome should NOT show placeholder when live data is present, got:\n%s", body)
	}
}
