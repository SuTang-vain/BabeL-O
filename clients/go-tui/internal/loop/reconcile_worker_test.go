// internal/loop/reconcile_worker_test.go
//
// Phase 5b tests: drive the Reconciler through httptest.Server
// to verify ghost pane push + missing pane adoption work end
// to end. RunOnce is async-pure (no goroutines, no ticker)
// so each test runs in well under a second.

package loop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// fakeNexus captures the request log so tests can assert
// which endpoints the Reconciler hit.
type fakeNexus struct {
	mu       sync.Mutex
	panes    map[string]api.LoopPaneState
	upserted []api.LoopPaneState
}

func newFakeNexus(seed []api.LoopPaneState) *fakeNexus {
	f := &fakeNexus{panes: make(map[string]api.LoopPaneState, len(seed))}
	for _, pane := range seed {
		f.panes[pane.PaneID] = pane
	}
	return f
}

func (f *fakeNexus) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/loop/workspaces", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		workspaceID := r.URL.Query().Get("workspaceId")
		panes := make([]api.LoopPaneState, 0, len(f.panes))
		for _, pane := range f.panes {
			if workspaceID == "" || pane.WorkspaceID == workspaceID {
				panes = append(panes, pane)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":  "loop_workspaces",
			"panes": panes,
			"filter": map[string]any{
				"workspaceId": workspaceID,
				"sessionId":   nil,
			},
		})
	})
	mux.HandleFunc("/v1/loop/workspaces/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.Method {
		case http.MethodPost:
			body, _ := io.ReadAll(r.Body)
			var req struct {
				PaneID      string `json:"paneId"`
				WorkspaceID string `json:"workspaceId"`
				TabID       string `json:"tabId"`
				SessionID   string `json:"sessionId"`
				Agent       string `json:"agent"`
				Cwd         string `json:"cwd"`
				Label       string `json:"label"`
				LastRev     int64  `json:"lastRev"`
			}
			_ = json.Unmarshal(body, &req)
			pane := api.LoopPaneState{
				PaneID: req.PaneID, WorkspaceID: req.WorkspaceID, TabID: req.TabID,
				SessionID: req.SessionID, Agent: req.Agent, Cwd: req.Cwd,
				Label: req.Label, LastRev: req.LastRev,
				UpdatedAt: "2026-06-13T00:00:00.000Z",
			}
			f.panes[pane.PaneID] = pane
			f.upserted = append(f.upserted, pane)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"type": "loop_pane",
				"pane": pane,
			})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	return mux
}

func newTestReconciler(t *testing.T, fake *fakeNexus) (*Reconciler, *Store) {
	t.Helper()
	server := httptest.NewServer(fake.handler())
	t.Cleanup(server.Close)
	store, err := NewStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return &Reconciler{
		Store:       store,
		Client:      api.NewClient(server.URL, "test"),
		WorkspaceID: "ws-1",
	}, store
}

func TestRunOnceReportsUnchangedWhenSnapshotsMatch(t *testing.T) {
	fake := newFakeNexus([]api.LoopPaneState{
		{PaneID: "pane-1", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-1", Agent: "bbl", Cwd: "/tmp", Label: "main", LastRev: 1, UpdatedAt: "2026-06-13T00:00:00.000Z"},
	})
	r, store := newTestReconciler(t, fake)
	if err := store.Replace(Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{
			{PaneID: "pane-1", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-1", Agent: "bbl", Cwd: "/tmp", Label: "main", LastRev: 1, UpdatedAt: "2026-06-13T00:00:00.000Z"},
		},
	}); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	res, err := r.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if res.Pushed != 0 || res.Pulled != 0 || res.Unchanged != 1 {
		t.Fatalf("expected unchanged=1, got %+v", res)
	}
	if len(fake.upserted) != 0 {
		t.Fatalf("unchanged snapshot should not upsert, got %+v", fake.upserted)
	}
}

func TestRunOnceDoesNotPushInvalidLocalPane(t *testing.T) {
	fake := newFakeNexus(nil)
	r, store := newTestReconciler(t, fake)
	if err := store.Replace(Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{
			{PaneID: "pane-local", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-local-deadbeef", Agent: "bbl", Cwd: "/tmp", Label: "main", LastRev: 0},
			{PaneID: "pane-empty-cwd", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-real", Agent: "bbl", Cwd: "", Label: "main", LastRev: 0},
		},
	}); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	result, err := r.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if result.Pushed != 0 {
		t.Fatalf("invalid local panes should not be pushed, got %+v", result)
	}
	if len(fake.upserted) != 0 {
		t.Fatalf("unexpected upserted panes: %+v", fake.upserted)
	}
}

func TestRunOncePushesLocalOnlyPane(t *testing.T) {
	fake := newFakeNexus(nil)
	r, store := newTestReconciler(t, fake)
	if err := store.Replace(Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{
			{PaneID: "pane-local", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-local", Agent: "bbl", Cwd: "/tmp", LastRev: 1, UpdatedAt: "2026-06-13T00:00:00.000Z"},
		},
	}); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	res, err := r.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if res.Pushed != 1 || res.Unchanged != 0 {
		t.Fatalf("expected pushed=1, got %+v", res)
	}
	if len(fake.upserted) != 1 || fake.upserted[0].PaneID != "pane-local" {
		t.Fatalf("expected upsert pane-local, got %+v", fake.upserted)
	}
}

func TestRunOncePullsServerOnlyPane(t *testing.T) {
	fake := newFakeNexus([]api.LoopPaneState{
		{PaneID: "pane-remote", WorkspaceID: "ws-1", TabID: "ws-1:2", SessionID: "session-remote", Agent: "bbl", Cwd: "/tmp", Label: "remote", LastRev: 2, UpdatedAt: "2026-06-13T00:00:00.000Z"},
	})
	r, store := newTestReconciler(t, fake)
	res, err := r.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if res.Pulled != 1 || res.Unchanged != 0 {
		t.Fatalf("expected pulled=1, got %+v", res)
	}
	if len(fake.upserted) != 0 {
		t.Fatalf("pull-only reconcile should not upsert, got %+v", fake.upserted)
	}
	loaded := store.Snapshot()
	if len(loaded.Panes) != 1 || loaded.Panes[0].PaneID != "pane-remote" {
		t.Fatalf("store should adopt pane-remote, got %+v", loaded.Panes)
	}
}

func TestRunOncePushesWhenLastRevDrifts(t *testing.T) {
	fake := newFakeNexus([]api.LoopPaneState{
		{PaneID: "pane-1", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-1", Agent: "bbl", Cwd: "/tmp", LastRev: 99, UpdatedAt: "2026-06-13T00:00:00.000Z"},
	})
	r, store := newTestReconciler(t, fake)
	if err := store.Replace(Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{
			{PaneID: "pane-1", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-1", Agent: "bbl", Cwd: "/tmp", LastRev: 1, UpdatedAt: "2026-06-13T00:00:00.000Z"},
		},
	}); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	res, err := r.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if res.Pushed != 1 {
		t.Fatalf("expected pushed=1, got %+v", res)
	}
	if len(fake.upserted) != 1 || fake.upserted[0].LastRev != 1 {
		t.Fatalf("expected upsert with lastRev=1, got %+v", fake.upserted)
	}
}

func TestRunOnceHooksFire(t *testing.T) {
	fake := newFakeNexus([]api.LoopPaneState{
		{PaneID: "pane-remote", WorkspaceID: "ws-1", TabID: "ws-1:2", SessionID: "session-remote", Agent: "bbl", Cwd: "/tmp", LastRev: 1, UpdatedAt: "2026-06-13T00:00:00.000Z"},
	})
	r, store := newTestReconciler(t, fake)
	pushed := 0
	pulled := 0
	r.OnPush = func(PaneStateEntry) { pushed++ }
	r.OnPull = func(PaneStateEntry) { pulled++ }
	if err := store.Replace(Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{
			{PaneID: "pane-local", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-local", Agent: "bbl", Cwd: "/tmp", LastRev: 1, UpdatedAt: "2026-06-13T00:00:00.000Z"},
		},
	}); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if _, err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if pushed != 1 || pulled != 1 {
		t.Fatalf("expected pushed=1 pulled=1, got %d/%d", pushed, pulled)
	}
}

func TestReconcilerRejectsNilFields(t *testing.T) {
	if _, err := (&Reconciler{}).RunOnce(context.Background()); err == nil {
		t.Fatal("expected error for nil Store/Client")
	}
}
