// internal/loop/persistence_test.go
//
// Phase 5a tests: snapshot roundtrip, atomic write, ghost
// pane cleanup, missing pane recovery. The Reconcile function
// is pure (no I/O) so it lives here without a server.

package loop

import (
	"path/filepath"
	"testing"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

func TestReconcileIdenticalSnapshotIsUnchanged(t *testing.T) {
	entry := PaneStateEntry{
		PaneID:      "pane-1",
		WorkspaceID: "ws-1",
		TabID:       "ws-1:1",
		SessionID:   "session-1",
		Agent:       "bbl",
		Cwd:         "/tmp",
		Label:       "main",
		LastRev:     5,
	}
	local := Snapshot{Version: snapshotVersion, Panes: []PaneStateEntry{entry}}
	server := []api.LoopPaneState{loopPaneFromEntry(entry)}

	out := Reconcile(local, server)
	if len(out.Unchanged) != 1 || out.Unchanged[0].PaneID != "pane-1" {
		t.Fatalf("expected unchanged pane-1, got %+v", out)
	}
	if len(out.PushToServer) != 0 {
		t.Fatalf("identical snapshot should not push, got %+v", out.PushToServer)
	}
	if len(out.PullFromServer) != 0 {
		t.Fatalf("identical snapshot should not pull, got %+v", out.PullFromServer)
	}
}

func TestReconcileDetectsLocalOnlyPane(t *testing.T) {
	local := Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{
			{PaneID: "pane-keep", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-keep", Agent: "bbl", Cwd: "/tmp", LastRev: 1},
			{PaneID: "pane-local-only", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-local-only", Agent: "bbl", Cwd: "/tmp", LastRev: 1},
		},
	}
	// Server only knows about pane-keep; pane-local-only is
	// local-only and should be pushed (recreate on server).
	server := []api.LoopPaneState{
		loopPaneFromEntry(local.Panes[0]),
	}
	out := Reconcile(local, server)
	if len(out.Unchanged) != 1 || out.Unchanged[0].PaneID != "pane-keep" {
		t.Fatalf("expected unchanged pane-keep, got %+v", out.Unchanged)
	}
	if len(out.PushToServer) != 1 || out.PushToServer[0].PaneID != "pane-local-only" {
		t.Fatalf("expected push pane-local-only (recreate on server), got %+v", out.PushToServer)
	}
	if len(out.PullFromServer) != 0 {
		t.Fatalf("local-only pane should not pull, got %+v", out.PullFromServer)
	}
}

func TestReconcileDetectsServerOnlyPane(t *testing.T) {
	local := Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{
			{PaneID: "pane-local", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-local", Agent: "bbl", Cwd: "/tmp", LastRev: 1},
		},
	}
	server := []api.LoopPaneState{
		loopPaneFromEntry(local.Panes[0]),
		{PaneID: "pane-remote", WorkspaceID: "ws-1", TabID: "ws-1:2", SessionID: "session-remote", Agent: "bbl", Cwd: "/tmp", Label: "remote", LastRev: 2, UpdatedAt: "2026-06-13T00:00:00.000Z"},
	}
	out := Reconcile(local, server)
	if len(out.Unchanged) != 1 {
		t.Fatalf("expected unchanged pane-local, got %+v", out.Unchanged)
	}
	if len(out.PullFromServer) != 1 || out.PullFromServer[0].PaneID != "pane-remote" {
		t.Fatalf("expected pull pane-remote (adopt server state), got %+v", out.PullFromServer)
	}
	if len(out.PushToServer) != 0 {
		t.Fatalf("server-only pane should not push, got %+v", out.PushToServer)
	}
}

func TestReconcileDetectsLastRevDrift(t *testing.T) {
	entry := PaneStateEntry{PaneID: "pane-1", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-1", Agent: "bbl", Cwd: "/tmp", LastRev: 1}
	local := Snapshot{Version: snapshotVersion, Panes: []PaneStateEntry{entry}}
	server := []api.LoopPaneState{loopPaneFromEntry(entry)}
	server[0].LastRev = 99

	out := Reconcile(local, server)
	if len(out.PushToServer) != 1 || out.PushToServer[0].LastRev != 1 {
		t.Fatalf("expected push local entry with lastRev=1, got %+v", out.PushToServer)
	}
}

func TestSnapshotRoundTripAndAtomicWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	snap := Snapshot{
		Version:   snapshotVersion,
		UpdatedAt: "2026-06-13T00:00:00.000Z",
		Panes: []PaneStateEntry{
			{PaneID: "pane-1", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-1", Agent: "bbl", Cwd: "/tmp", Label: "main", LastRev: 5, UpdatedAt: "2026-06-13T00:00:00.000Z"},
		},
	}
	if err := writeSnapshotAtomic(path, snap); err != nil {
		t.Fatalf("writeSnapshotAtomic: %v", err)
	}
	loaded, err := LoadSnapshot(path)
	if err != nil {
		t.Fatalf("LoadSnapshot: %v", err)
	}
	if loaded.Version != snap.Version || len(loaded.Panes) != 1 {
		t.Fatalf("roundtrip mismatch: %+v vs %+v", loaded, snap)
	}
	if loaded.Panes[0].PaneID != "pane-1" || loaded.Panes[0].LastRev != 5 {
		t.Fatalf("roundtrip pane mismatch: %+v", loaded.Panes[0])
	}
}

func TestLoadSnapshotMissingFileReturnsEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.json")
	snap, err := LoadSnapshot(path)
	if err != nil {
		t.Fatalf("LoadSnapshot on missing file: %v", err)
	}
	if snap.Version != snapshotVersion || len(snap.Panes) != 0 {
		t.Fatalf("missing file should return empty snapshot, got %+v", snap)
	}
}

func TestStoreReplaceAndClose(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := NewStore(path)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer store.Close()

	snap := Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{
			{PaneID: "pane-1", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-1", Agent: "bbl", Cwd: "/tmp", LastRev: 1, UpdatedAt: "2026-06-13T00:00:00.000Z"},
		},
	}
	if err := store.Replace(snap); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	loaded, err := LoadSnapshot(path)
	if err != nil {
		t.Fatalf("LoadSnapshot: %v", err)
	}
	if len(loaded.Panes) != 1 || loaded.Panes[0].PaneID != "pane-1" {
		t.Fatalf("on-disk snapshot does not match Replace, got %+v", loaded)
	}
}

func TestNewStoreCreatesDirectory(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "nested")
	path := filepath.Join(parent, "loop", "state.json")
	store, err := NewStore(path)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer store.Close()
	if store.Path() != path {
		t.Fatalf("NewStore path = %q, want %q", store.Path(), path)
	}
}

// loopPaneFromEntry builds an api.LoopPaneState from a local
// PaneStateEntry so tests can reuse the entry fixtures.
func loopPaneFromEntry(entry PaneStateEntry) api.LoopPaneState {
	return api.LoopPaneState{
		PaneID:      entry.PaneID,
		WorkspaceID: entry.WorkspaceID,
		TabID:       entry.TabID,
		SessionID:   entry.SessionID,
		Agent:       entry.Agent,
		Cwd:         entry.Cwd,
		Label:       entry.Label,
		LastRev:     entry.LastRev,
		UpdatedAt:   entry.UpdatedAt,
	}
}
