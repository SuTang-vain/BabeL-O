// internal/loop/reconcile_worker.go
//
// Phase 5b: wires Store + api.Client to keep the local
// snapshot in sync with the Nexus `loop_state` table.
// RunOnce is the pure-async entry point used by tests; the
// periodic Run loop is a thin ticker that calls RunOnce on
// a fixed cadence. All callers should pass a context.Context
// so cancellation propagates cleanly.

package loop

import (
	"context"
	"errors"
	"fmt"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// Reconciler is the glue between the local snapshot store
// and the Nexus loop_state REST endpoints.
type Reconciler struct {
	Store  *Store
	Client *api.Client

	// WorkspaceID filters server queries and identifies the
	// default workspace when reconciling fresh snapshots.
	WorkspaceID string

	// OnPush / OnPull are optional hooks used by the worker
	// to surface reconcile actions to the renderer (Phase 4).
	// Either may be nil; tests typically omit them.
	OnPush func(entry PaneStateEntry)
	OnPull func(entry PaneStateEntry)
}

// RunOnceResult captures what RunOnce did so callers can log
// or surface it to the user.
type RunOnceResult struct {
	Pushed     int
	Pulled     int
	Unchanged  int
	ServerPanes int
	LocalPanes  int
}

// RunOnce loads the local snapshot, queries the server, runs
// the pure Reconcile, then upserts push entries and adopts
// pull entries into the local store. Ghost panes (local-only)
// are pushed back to server so the user's open tabs survive
// a server restart; missing panes (server-only) are adopted
// locally so the local snapshot converges.
func (r *Reconciler) RunOnce(ctx context.Context) (RunOnceResult, error) {
	if r == nil {
		return RunOnceResult{}, errors.New("loop: nil Reconciler")
	}
	if r.Store == nil {
		return RunOnceResult{}, errors.New("loop: Reconciler missing Store")
	}
	if r.Client == nil {
		return RunOnceResult{}, errors.New("loop: Reconciler missing Client")
	}

	serverPanes, err := r.Client.ListPanes(ctx, r.WorkspaceID, "")
	if err != nil {
		return RunOnceResult{}, fmt.Errorf("loop reconcile: list server panes: %w", err)
	}

	snap := r.Store.Snapshot()
	out := Reconcile(snap, serverPanes)
	result := RunOnceResult{
		Pushed:      len(out.PushToServer),
		Pulled:      len(out.PullFromServer),
		Unchanged:   len(out.Unchanged),
		ServerPanes: len(serverPanes),
		LocalPanes:  len(snap.Panes),
	}

	// Push: upsert local-only / drifted entries to server so
	// they survive a server restart.
	for _, entry := range out.PushToServer {
		_, err := r.Client.UpsertPane(ctx, api.UpsertPaneParams{
			PaneID:      entry.PaneID,
			WorkspaceID: entry.WorkspaceID,
			TabID:       entry.TabID,
			SessionID:   entry.SessionID,
			Agent:       entry.Agent,
			Cwd:         entry.Cwd,
			Label:       entry.Label,
			LastRev:     entry.LastRev,
		})
		if err != nil {
			return result, fmt.Errorf("loop reconcile: upsert %q: %w", entry.PaneID, err)
		}
		if r.OnPush != nil {
			r.OnPush(entry)
		}
	}

	// Pull: adopt server-only entries into the local store
	// so the next reconcile converges to zero.
	if len(out.PullFromServer) > 0 {
		newPanes := append([]PaneStateEntry(nil), snap.Panes...)
		for _, entry := range out.PullFromServer {
			newPanes = append(newPanes, entry)
			if r.OnPull != nil {
				r.OnPull(entry)
			}
		}
		if err := r.Store.Replace(Snapshot{
			Version:   snap.Version,
			UpdatedAt: snap.UpdatedAt,
			Panes:     newPanes,
		}); err != nil {
			return result, fmt.Errorf("loop reconcile: replace store: %w", err)
		}
	}

	return result, nil
}

// Run ticks RunOnce on the provided interval until ctx is
// done. It blocks; callers should run it in a goroutine.
// Returns the final ctx.Err() when cancelled.
func (r *Reconciler) Run(ctx context.Context, intervalTicks func() <-chan struct{}) error {
	if intervalTicks == nil {
		return errors.New("loop: intervalTicks required")
	}
	for {
		if _, err := r.RunOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-intervalTicks():
		}
	}
}
