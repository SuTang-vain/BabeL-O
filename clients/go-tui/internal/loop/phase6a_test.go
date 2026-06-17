// internal/loop/phase6a_test.go
//
// Phase 6a tests (docs §6'): the reconcile → LoopModel
// re-hydrate. Two behaviors that were broken before 6a:
//
//  1. applySnapshotToLoop used to be append-only, so calling it
//     twice for the same pane duplicated it. It is now
//     upsert-by-paneId.
//  2. handleReconcileDone used to never re-hydrate m.loop from
//     the Store, so a pane the reconciler pulled in only showed
//     up after a full bbl loop restart. It now re-applies the
//     snapshot.

package loop

import (
	"path/filepath"
	"testing"
	"time"
)

// defaultWorkspaceTabIDs matches the workspace/tab that
// NewLoopModel creates so AddPane's parent-match check passes.
const (
	defaultWSID  = "ws-default"
	defaultTabID = "ws-default:1"
)

// TestApplySnapshotToLoopIsIdempotent calls applySnapshotToLoop
// twice with the same pane and asserts the pane is refreshed,
// not duplicated. This is the regression guard for the old
// append-only behavior (docs §6'.1 fact 7).
func TestApplySnapshotToLoopIsIdempotent(t *testing.T) {
	model := NewLoopModel()
	entry := PaneStateEntry{
		PaneID:      "pane-A",
		WorkspaceID: defaultWSID,
		TabID:       defaultTabID,
		SessionID:   "session-A",
		Agent:       "bbl",
		Cwd:         "/repo",
		Label:       "main",
		LastRev:     10,
	}
	snap := Snapshot{Version: snapshotVersion, Panes: []PaneStateEntry{entry}}

	model = applySnapshotToLoop(model, snap)
	model = applySnapshotToLoop(model, snap)

	pane, ok := model.FocusedPane()
	if !ok {
		t.Fatal("expected a focused pane after apply")
	}
	count := 0
	for _, p := range model.Workspaces[model.Focus.WorkspaceIdx].Tabs[model.Focus.TabIdx].Panes {
		if p.PaneID == "pane-A" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("pane-A should appear exactly once after two applies, got %d", count)
	}
	if pane.LastEventRev != 10 {
		t.Fatalf("LastEventRev should be refreshed to 10, got %d", pane.LastEventRev)
	}
}

// TestApplySnapshotToLoopUpdatesExistingMetadata verifies the
// upsert path refreshes metadata on a pane that is already in
// the model (e.g. the server bumped lastRev / changed the
// label) without resetting its Status. Status is owned by the
// health poll and must survive a reconcile tick.
func TestApplySnapshotToLoopUpdatesExistingMetadata(t *testing.T) {
	model := NewLoopModel()
	// Seed the model with a pane already in a non-idle status
	// (as the health poll would have set it).
	model, _ = seedPane(model, PaneModel{
		PaneID:       "pane-B",
		WorkspaceID:  defaultWSID,
		TabID:        defaultTabID,
		SessionID:    "session-B",
		Agent:        "bbl",
		Cwd:          "/old",
		Label:        "old-label",
		Status:       StatusDrift,
		LastEventRev: 5,
	})

	// Reconcile now reports a bumped rev + relabel for the
	// same pane id.
	model = applySnapshotToLoop(model, Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{{
			PaneID:      "pane-B",
			WorkspaceID: defaultWSID,
			TabID:       defaultTabID,
			SessionID:   "session-B",
			Agent:       "bbl",
			Cwd:         "/new",
			Label:       "new-label",
			LastRev:     42,
		}},
	})

	pane, ok := model.FocusedPane()
	if !ok {
		t.Fatal("expected a focused pane")
	}
	if pane.LastEventRev != 42 {
		t.Fatalf("LastEventRev should be refreshed to 42, got %d", pane.LastEventRev)
	}
	if pane.Label != "new-label" {
		t.Fatalf("Label should be refreshed to new-label, got %q", pane.Label)
	}
	if pane.Cwd != "/new" {
		t.Fatalf("Cwd should be refreshed to /new, got %q", pane.Cwd)
	}
	// Status must be preserved: reconcile does not own status.
	if pane.Status != StatusDrift {
		t.Fatalf("Status should remain drift, got %s", pane.Status)
	}
}

// TestHandleReconcileDoneRehydratesNewServerPane is the
// end-to-end Phase 6a behavior: a pane the reconciler pulls
// from the server into the Store must appear in m.loop after
// handleReconcileDone, without a restart.
func TestHandleReconcileDoneRehydratesNewServerPane(t *testing.T) {
	storePath := filepath.Join(t.TempDir(), "state.json")
	store, err := NewStore(storePath)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer store.Close()

	// Build a model whose workspace/tab match the pane the
	// server will report so AddPane's parent check passes.
	model := NewLoopModel()
	im := NewInteractiveModelWithReconciler(model, store, nil, 100*time.Millisecond)

	// Simulate the reconciler having pulled a server-only pane
	// into the Store (what RunOnce's PullFromServer path does).
	if err := store.Replace(Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{{
			PaneID:      "pane-discovered",
			WorkspaceID: defaultWSID,
			TabID:       defaultTabID,
			SessionID:   "session-discovered",
			Agent:       "bbl",
			Cwd:         "/repo",
			Label:       "main",
			LastRev:     1,
		}},
	}); err != nil {
		t.Fatalf("store.Replace: %v", err)
	}

	// Before reconcile-done: the pane is in the Store but not
	// yet in m.loop (applySnapshotToLoop ran once at
	// construction against an empty Store).
	if p, ok := im.loop.FocusedPane(); ok && p.PaneID == "pane-discovered" {
		t.Fatalf("pane-discovered should not be in m.loop before reconcile-done")
	}

	im.handleReconcileDone(reconcileDoneMsg{result: RunOnceResult{Pulled: 1}})

	// Walk the focused tab to find the discovered pane. The
	// focused pane index may or may not point at it.
	found := false
	for _, p := range im.loop.Workspaces[im.loop.Focus.WorkspaceIdx].Tabs[im.loop.Focus.TabIdx].Panes {
		if p.PaneID == "pane-discovered" && p.SessionID == "session-discovered" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("pane-discovered should be in m.loop after handleReconcileDone, got %s", im.loop)
	}
}

// TestHandleReconcileDonePreservesStatusAcrossTicks asserts the
// re-hydrate does not reset an existing pane's status. This is
// the invariant that makes it safe to re-apply the snapshot on
// every tick: health-poll-owned status survives reconcile.
func TestHandleReconcileDonePreservesStatusAcrossTicks(t *testing.T) {
	storePath := filepath.Join(t.TempDir(), "state.json")
	store, err := NewStore(storePath)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer store.Close()

	model := NewLoopModel()
	model, _ = seedPane(model, PaneModel{
		PaneID:       "pane-C",
		WorkspaceID:  defaultWSID,
		TabID:        defaultTabID,
		SessionID:    "session-C",
		Agent:        "bbl",
		Cwd:          "/repo",
		Label:        "main",
		Status:       StatusBlocked,
		LastEventRev: 3,
	})
	im := NewInteractiveModelWithReconciler(model, store, nil, 100*time.Millisecond)
	// Mirror the seeded pane into the Store so the snapshot
	// the re-hydrate reads contains the same pane id.
	if err := store.Replace(Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{{
			PaneID:      "pane-C",
			WorkspaceID: defaultWSID,
			TabID:       defaultTabID,
			SessionID:   "session-C",
			Agent:       "bbl",
			Cwd:         "/repo",
			Label:       "main",
			LastRev:     3,
		}},
	}); err != nil {
		t.Fatalf("store.Replace: %v", err)
	}

	im.handleReconcileDone(reconcileDoneMsg{result: RunOnceResult{Unchanged: 1}})

	pane, ok := im.loop.FocusedPane()
	if !ok {
		t.Fatal("expected a focused pane")
	}
	if pane.Status != StatusBlocked {
		t.Fatalf("Status should remain blocked across reconcile ticks, got %s", pane.Status)
	}
}

// seedPane appends a pane to the focused tab of the default
// workspace, returning the model. It bypasses AddPane's
// constructor so tests can set an arbitrary Status (AddPane
// callers can't set Status mid-construction cleanly). Returns
// the model and the appended pane.
func seedPane(model LoopModel, p PaneModel) (LoopModel, PaneModel) {
	if model.Focus.WorkspaceIdx < 0 || model.Focus.WorkspaceIdx >= len(model.Workspaces) {
		return model, p
	}
	ws := model.Workspaces[model.Focus.WorkspaceIdx]
	if len(ws.Tabs) == 0 {
		ws.Tabs = []Tab{{ID: defaultTabID, Label: "main"}}
	}
	if model.Focus.TabIdx < 0 || model.Focus.TabIdx >= len(ws.Tabs) {
		model.Focus.TabIdx = 0
	}
	ws.Tabs[model.Focus.TabIdx].Panes = append(ws.Tabs[model.Focus.TabIdx].Panes, p)
	model.Workspaces[model.Focus.WorkspaceIdx] = ws
	if model.Focus.PaneIdx < 0 {
		model.Focus.PaneIdx = 0
	}
	return model, p
}
