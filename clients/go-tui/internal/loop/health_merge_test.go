// internal/loop/health_merge_test.go
//
// Tests for the pure-function health → LoopModel merge
// (applyHealthToLoop). The merge never touches Bubble Tea
// or the network, so the tests run synchronously against
// a stub LoopHealthResponse.

package loop

import (
	"testing"
	"time"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// seedHealthModel builds a LoopModel with one workspace /
// one tab / one pane whose SessionID is `sessionID`. The
// pane starts at StatusIdle so any health-driven status
// change is observable in the transition slice.
func seedHealthModel(t *testing.T, sessionID string) LoopModel {
	t.Helper()
	model := NewLoopModel()
	ws := model.Workspaces[0]
	tab := ws.Tabs[0]
	updated, err := tab.AddPane(PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: ws.ID,
		TabID:       tab.ID,
		SessionID:   sessionID,
		Agent:       "bbl",
		Status:      StatusIdle,
	})
	if err != nil {
		t.Fatalf("AddPane: %v", err)
	}
	ws.Tabs[0] = updated
	model.Workspaces[0] = ws
	return model
}

func TestApplyHealthToLoop_UpdatesStatusAndRev(t *testing.T) {
	model := seedHealthModel(t, "session-1")
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	health := api.LoopHealthResponse{
		Type: "loop_health",
		Panes: []api.LoopHealthPane{{
			SessionID:    "session-1",
			Agent:        "bbl",
			Status:       "working",
			LastEventRev: 42,
			LastEventAt:  "2026-06-16T12:00:00.000Z",
		}},
	}
	updated, transitions := applyHealthToLoop(model, health)
	if len(transitions) != 1 {
		t.Fatalf("expected 1 transition, got %d", len(transitions))
	}
	tr := transitions[0]
	if tr.PaneID != "pane-1" {
		t.Errorf("transition PaneID = %q, want pane-1", tr.PaneID)
	}
	if tr.From != StatusIdle || tr.To != StatusWorking {
		t.Errorf("transition %s→%s, want idle→working", tr.From, tr.To)
	}
	pane, _ := updated.FocusedPane()
	if pane.Status != StatusWorking {
		t.Errorf("pane.Status = %v, want StatusWorking", pane.Status)
	}
	if pane.LastEventRev != 42 {
		t.Errorf("pane.LastEventRev = %d, want 42", pane.LastEventRev)
	}
	if !pane.LastEventAt.Equal(now) {
		t.Errorf("pane.LastEventAt = %v, want %v", pane.LastEventAt, now)
	}
}

func TestApplyHealthToLoop_NoTransitionsWhenStatusUnchanged(t *testing.T) {
	model := seedHealthModel(t, "session-1")
	// First transition: idle → working.
	health := api.LoopHealthResponse{Panes: []api.LoopHealthPane{{
		SessionID: "session-1", Status: "working", LastEventRev: 1,
	}}}
	updated, trans := applyHealthToLoop(model, health)
	if len(trans) != 1 {
		t.Fatalf("first pass: expected 1 transition, got %d", len(trans))
	}
	// Second pass with the same status should produce zero
	// transitions even though LastEventRev changes.
	health2 := api.LoopHealthResponse{Panes: []api.LoopHealthPane{{
		SessionID: "session-1", Status: "working", LastEventRev: 2,
	}}}
	_, trans2 := applyHealthToLoop(updated, health2)
	if len(trans2) != 0 {
		t.Errorf("no-change pass: expected 0 transitions, got %d", len(trans2))
	}
}

func TestApplyHealthToLoop_IgnoresUnknownSession(t *testing.T) {
	model := seedHealthModel(t, "session-1")
	health := api.LoopHealthResponse{Panes: []api.LoopHealthPane{{
		SessionID: "session-other", Status: "drift", LastEventRev: 5,
	}}}
	updated, trans := applyHealthToLoop(model, health)
	if len(trans) != 0 {
		t.Errorf("unknown session: expected 0 transitions, got %d", len(trans))
	}
	pane, _ := updated.FocusedPane()
	if pane.Status != StatusIdle {
		t.Errorf("pane.Status should stay idle, got %v", pane.Status)
	}
}

func TestApplyHealthToLoop_MultiPane(t *testing.T) {
	model := NewLoopModel()
	ws := model.Workspaces[0]
	tab := ws.Tabs[0]
	for _, sid := range []string{"s-a", "s-b", "s-c"} {
		updated, err := tab.AddPane(PaneModel{
			PaneID:      "pane-" + sid,
			WorkspaceID: ws.ID,
			TabID:       tab.ID,
			SessionID:   sid,
			Agent:       "bbl",
			Status:      StatusIdle,
		})
		if err != nil {
			t.Fatalf("AddPane: %v", err)
		}
		tab = updated
	}
	ws.Tabs[0] = tab
	model.Workspaces[0] = ws
	health := api.LoopHealthResponse{Panes: []api.LoopHealthPane{
		{SessionID: "s-a", Status: "working"},
		{SessionID: "s-b", Status: "blocked"},
		// s-c intentionally missing — should be left at idle.
	}}
	_, transitions := applyHealthToLoop(model, health)
	if len(transitions) != 2 {
		t.Fatalf("expected 2 transitions, got %d: %+v", len(transitions), transitions)
	}
	// Order: buildPaneListRows walks in insertion order, so
	// the transition slice should be s-a then s-b.
	if transitions[0].PaneID != "pane-s-a" || transitions[0].To != StatusWorking {
		t.Errorf("first transition = %+v, want pane-s-a → working", transitions[0])
	}
	if transitions[1].PaneID != "pane-s-b" || transitions[1].To != StatusBlocked {
		t.Errorf("second transition = %+v, want pane-s-b → blocked", transitions[1])
	}
}

func TestApplyHealthToLoop_EmptyHealthIsNoop(t *testing.T) {
	model := seedHealthModel(t, "session-1")
	updated, trans := applyHealthToLoop(model, api.LoopHealthResponse{})
	if len(trans) != 0 {
		t.Errorf("empty health should yield 0 transitions, got %d", len(trans))
	}
	pane, _ := updated.FocusedPane()
	if pane.Status != StatusIdle {
		t.Errorf("pane.Status changed unexpectedly to %v", pane.Status)
	}
}

func TestApplyHealthToLoop_EmptySessionIDIsSkipped(t *testing.T) {
	model := seedHealthModel(t, "session-1")
	// A health pane with an empty SessionID should be
	// dropped silently — the server only sends a SessionID
	// when it has a real pane to report on.
	health := api.LoopHealthResponse{Panes: []api.LoopHealthPane{{
		SessionID: "", Status: "drift",
	}}}
	_, trans := applyHealthToLoop(model, health)
	if len(trans) != 0 {
		t.Errorf("empty SessionID should be skipped, got %d transitions", len(trans))
	}
}

func TestApplyHealthToLoop_DuplicateSessionIDFirstWins(t *testing.T) {
	model := seedHealthModel(t, "session-1")
	health := api.LoopHealthResponse{Panes: []api.LoopHealthPane{
		{SessionID: "session-1", Status: "working"},
		{SessionID: "session-1", Status: "blocked"}, // duplicate
	}}
	updated, trans := applyHealthToLoop(model, health)
	if len(trans) != 1 {
		t.Errorf("duplicate SessionID: expected 1 transition, got %d", len(trans))
	}
	pane, _ := updated.FocusedPane()
	if pane.Status != StatusWorking {
		t.Errorf("first write should win, got %v", pane.Status)
	}
}

func TestApplyHealthToLoop_DriftUnconfirmedCountsAsDrift(t *testing.T) {
	// The wire-status string is the one Nexus already
	// derived (the Go side doesn't recompute scope
	// boundaries). This test pins the contract: "drift" on
	// the wire → StatusDrift on the model.
	model := seedHealthModel(t, "session-1")
	health := api.LoopHealthResponse{Panes: []api.LoopHealthPane{{
		SessionID: "session-1",
		Status:    "drift",
		PendingScopeBoundaries: 2,
		OutOfScopeEvidence:     1,
	}}}
	updated, trans := applyHealthToLoop(model, health)
	if len(trans) != 1 || trans[0].To != StatusDrift {
		t.Errorf("expected drift transition, got %+v", trans)
	}
	pane, _ := updated.FocusedPane()
	if pane.Status != StatusDrift {
		t.Errorf("pane.Status = %v, want StatusDrift", pane.Status)
	}
}
