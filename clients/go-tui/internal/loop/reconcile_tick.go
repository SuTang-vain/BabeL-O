// internal/loop/reconcile_tick.go
//
// Phase 5c': tea.Cmd-driven reconcile tick. The Reconciler
// from Phase 5b owns the actual push/pull loop; here we
// bridge it into the Bubble Tea Update path so the TUI
// re-renders after each reconcile pass. We avoid bare
// goroutines by driving the schedule through tea.Tick /
// tea.Cmd, which already integrate with the program's
// lifecycle (cancel on quit).

package loop

import (
	"context"
	"time"

	tea "charm.land/bubbletea/v2"
)

// reconcileDoneMsg is dispatched to the Update path after
// each reconciler pass. Carries the result so future
// sub-targets (5c” / 6b) can surface pushed / pulled pane
// counts in the status bar without re-running RunOnce.
type reconcileDoneMsg struct {
	result RunOnceResult
	err    error
}

// reconcileTickCmd returns a tea.Cmd that calls
// Reconciler.RunOnce once and posts the result via
// reconcileDoneMsg. The cmd cancels the reconcile pass when
// the bubbletea program is shutting down so we don't leak
// HTTP calls after the user quits.
func reconcileTickCmd(rec *Reconciler) tea.Cmd {
	if rec == nil {
		return nil
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		result, err := rec.RunOnce(ctx)
		return reconcileDoneMsg{result: result, err: err}
	}
}

// scheduleReconcileTick returns a tea.Cmd that fires after
// `interval` and then runs a single reconcile pass. Pair
// with `tea.Sequence` or chain manually from the Update
// path so the next tick is scheduled after each
// reconcileDoneMsg.
func scheduleReconcileTick(interval time.Duration) tea.Cmd {
	if interval <= 0 {
		return nil
	}
	return tea.Tick(interval, func(time.Time) tea.Msg {
		return tickMsg{}
	})
}

// tickMsg is the periodic "time to reconcile" signal the
// Update path consumes to invoke the reconciler. We keep
// it distinct from reconcileDoneMsg so the model can
// distinguish "tick" from "result".
type tickMsg struct{}

// handleReconcileTick applies the next reconcile pass and
// schedules the following tick. Returns the updated model
// (no state change) plus the next tick cmd. The actual
// reconciler call is in reconcileTickCmd; this function
// just chains them.
//
// We flip reconcileInFlight = true so the chrome can render
// a "● syncing..." indicator during the gap between kickoff
// and the reconcileDoneMsg that handleReconcileDone clears
// it with.
func (m *InteractiveModel) handleReconcileTick() tea.Cmd {
	if m.reconciler == nil {
		return nil
	}
	m.reconcileInFlight = true
	return reconcileTickCmd(m.reconciler)
}

// handleReconcileDone updates the reconciler status from
// the most recent pass so the View can surface it (Phase 6b
// will fold this into the status sidebar). It also
// reschedules the next tick; the Bubble Tea runtime
// guarantees the scheduled tick is dropped on program quit.
//
// We stamp lastReconcileAt = time.Now() and clear
// reconcileInFlight so the footer's "synced Ns ago" /
// "syncing..." indicator stays current.
func (m *InteractiveModel) handleReconcileDone(msg reconcileDoneMsg) tea.Cmd {
	m.lastReconcile = msg
	m.lastReconcileAt = time.Now()
	m.reconcileInFlight = false
	// Phase 6a: the reconciler writes server-only / drifted
	// panes into the Store, but the chrome renders from
	// m.loop. Without this re-hydrate, a session the server
	// newly tracks would only appear after a full bbl loop
	// restart (applySnapshotToLoop ran once at construction).
	// Re-applying the snapshot here is safe now that
	// applySnapshotToLoop is upsert-by-paneId, so a pane the
	// reconciler already pulled in is refreshed rather than
	// duplicated. Status is preserved on existing panes;
	// newly discovered panes start idle and get a status on
	// the next health poll (applyHealthToLoop matches by
	// SessionID).
	if m.store != nil {
		m.loop = applySnapshotToLoop(m.loop, m.store.Snapshot())
	}
	// Phase 6c: reconcile just discovered / refreshed panes —
	// start a per-pane waitForEvent poll for any pane that
	// has a SessionID but no wait in flight. Per §6'.3 6c
	// point 10, applyClosePane also cleans up waitInFlight,
	// so a closed pane won't be re-targeted here.
	waitCmds := m.startWaitsForNewPanes()
	if len(waitCmds) == 0 {
		return scheduleReconcileTick(m.reconcileInterval)
	}
	all := append([]tea.Cmd{scheduleReconcileTick(m.reconcileInterval)}, waitCmds...)
	return tea.Batch(all...)
}
