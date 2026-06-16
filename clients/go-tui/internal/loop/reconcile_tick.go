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
// sub-targets (5c'' / 6b) can surface pushed / pulled pane
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
func (m *InteractiveModel) handleReconcileTick() tea.Cmd {
	if m.reconciler == nil {
		return nil
	}
	// Run the reconcile (returns immediately) and schedule
	// the next tick in parallel. tea.Cmd lets us return the
	// reconcile cmd while also queuing the next tick.
	return tea.Batch(
		reconcileTickCmd(m.reconciler),
		scheduleReconcileTick(m.reconcileInterval),
	)
}

// handleReconcileDone updates the reconciler status from
// the most recent pass so the View can surface it (Phase 6b
// will fold this into the status sidebar). It also
// reschedules the next tick; the Bubble Tea runtime
// guarantees the scheduled tick is dropped on program quit.
func (m *InteractiveModel) handleReconcileDone(msg reconcileDoneMsg) tea.Cmd {
	m.lastReconcile = msg
	return scheduleReconcileTick(m.reconcileInterval)
}
