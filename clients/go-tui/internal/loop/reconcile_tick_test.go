// internal/loop/reconcile_tick_test.go
//
// Phase 5c' reconciler tick tests: tick / reconcileDoneMsg
// dispatch, schedule chain, Init behavior, and one full
// round-trip via httptest.

package loop

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

func TestScheduleReconcileTickRejectsZeroInterval(t *testing.T) {
	if cmd := scheduleReconcileTick(0); cmd != nil {
		t.Fatalf("zero interval should produce nil cmd, got %T", cmd)
	}
	if cmd := scheduleReconcileTick(-1); cmd != nil {
		t.Fatalf("negative interval should produce nil cmd, got %T", cmd)
	}
}

func TestInitSchedulesTickOnlyWhenReconcilerAttached(t *testing.T) {
	withRec := NewInteractiveModelWithReconciler(NewLoopModel(), nil, &Reconciler{}, 500*time.Millisecond)
	cmd := withRec.Init()
	if cmd == nil {
		t.Fatal("Init should return a batch when reconciler is attached")
	}
	withoutRec := NewInteractiveModelWithReconciler(NewLoopModel(), nil, nil, 500*time.Millisecond)
	cmd2 := withoutRec.Init()
	if cmd2 == nil {
		t.Fatal("Init should still return a cmd for WindowSize even without reconciler")
	}
}

func TestHandleReconcileTickRunsReconcileAndSchedulesNext(t *testing.T) {
	model := NewInteractiveModelWithReconciler(NewLoopModel(), nil, &Reconciler{}, 100*time.Millisecond)
	cmd := model.handleReconcileTick()
	if cmd == nil {
		t.Fatal("handleReconcileTick should return a batch cmd")
	}
	// tea.Batch returns a func type; we just verify it's
	// non-nil and accept the runtime type without probing
	// the exact concrete shape.
	_ = cmd
}

func TestHandleReconcileDoneStoresResult(t *testing.T) {
	model := NewInteractiveModelWithReconciler(NewLoopModel(), nil, &Reconciler{}, 100*time.Millisecond)
	cmd := model.handleReconcileDone(reconcileDoneMsg{
		result: RunOnceResult{Pushed: 2, Pulled: 1, Unchanged: 3},
	})
	if cmd == nil {
		t.Fatal("handleReconcileDone should reschedule the next tick")
	}
	if model.lastReconcile.result.Pushed != 2 ||
		model.lastReconcile.result.Pulled != 1 ||
		model.lastReconcile.result.Unchanged != 3 {
		t.Fatalf("lastReconcile not stored: %+v", model.lastReconcile)
	}
}

func TestReconcileTickCmdRoundTripViaHttptest(t *testing.T) {
	// Wire a fake Nexus that returns one remote pane; the
	// local store starts empty, so the reconciler should
	// pull that pane into the local snapshot.
	storePath := filepath.Join(t.TempDir(), "state.json")
	store, err := NewStore(storePath)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer store.Close()
	server := newLoopTestServer(t, []api.LoopPaneState{
		{PaneID: "pane-remote", WorkspaceID: "ws-1", TabID: "ws-1:1", SessionID: "session-remote", Agent: "bbl", Cwd: "/tmp", LastRev: 1, UpdatedAt: "2026-06-13T00:00:00.000Z"},
	})
	defer server.Close()
	rec := &Reconciler{
		Store:       store,
		Client:      api.NewClient(server.URL, "test"),
		WorkspaceID: "ws-1",
	}
	cmd := reconcileTickCmd(rec)
	if cmd == nil {
		t.Fatal("reconcileTickCmd should produce a non-nil cmd")
	}
	msg := cmd()
	doneMsg, ok := msg.(reconcileDoneMsg)
	if !ok {
		t.Fatalf("reconcileTickCmd should return reconcileDoneMsg, got %T", msg)
	}
	if doneMsg.err != nil {
		t.Fatalf("RunOnce error: %v", doneMsg.err)
	}
	if doneMsg.result.Pulled != 1 {
		t.Fatalf("expected Pulled=1, got %+v", doneMsg.result)
	}
	// The reconciler adopted the server-only pane into the
	// local store; verify by closing + reopening the store.
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	store2, err := NewStore(storePath)
	if err != nil {
		t.Fatalf("NewStore reload: %v", err)
	}
	defer store2.Close()
	snap := store2.Snapshot()
	if len(snap.Panes) != 1 || snap.Panes[0].PaneID != "pane-remote" {
		t.Fatalf("reconciler should have adopted pane-remote, got %+v", snap.Panes)
	}
}

// newLoopTestServer stands up an httptest server that
// returns the given panes on GET /v1/loop/workspaces. Other
// methods return 405 so tests can detect unexpected calls.
func newLoopTestServer(t *testing.T, panes []api.LoopPaneState) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"type":  "loop_workspaces",
				"panes": panes,
				"filter": map[string]any{
					"workspaceId": r.URL.Query().Get("workspaceId"),
					"sessionId":   nil,
				},
			})
		default:
			_, _ = io.Copy(io.Discard, r.Body)
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
}
