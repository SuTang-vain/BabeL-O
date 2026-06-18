// internal/loop/cancel_pane.go
//
// Phase 6d-d of docs/nexus/reference/go-tui-loop-multipane-plan.md
// (§6'.3 6d-d): per-pane interruption + cancel. The
// operator hits Esc (or another key, see interactive.go)
// while a pane is mid-`/v1/execute`; we set
// pane.InterruptionActive, fire a cancel HTTP request,
// and the server aborts the in-flight activeExecution
// via its abortController. The wait stream's
// permission_response / next events will eventually
// clear PendingPermission and update Status.
//
// Single-flight: if a cancel is already in flight for a
// pane, a second request is dropped (the first cmd is
// still racing the server). The InterruptionActive flag
// stays set until handleCancelDone lands.
//
// Mirrors submit_prompt.go in shape: tea.Cmd-driven HTTP,
// no bare goroutine, ctx.WithTimeout for soft budget,
// 5s ceiling (cancel should return in tens of ms; the
// budget is mostly for a contended server).

package loop

import (
	"context"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// cancelDecisionMs is the per-call budget for
// /v1/sessions/:id/cancel. The server's cancel path is
// just `activeExecution.abortController.abort()` + a
// session close — both should complete in single-digit
// milliseconds. 5s leaves headroom for a slow or
// contended server.
const cancelDecisionMs = 5 * time.Second

// cancelDoneMsg is the per-pane result posted back to the
// Update path after a cancel HTTP call completes.
// Distinguishes "cancelled an active execution" (the
// usual case — operator wants to stop) from "no active
// execution to cancel" (server returns
// ActiveExecutionCancelled=false, which can happen if the
// session finished naturally between the operator hitting
// Esc and the HTTP call landing). Both paths clear
// InterruptionActive; only the first case sets
// Status=waiting.
type cancelDoneMsg struct {
	PaneID                  string
	ActiveExecutionCancelled bool
	Err                     error
}

// cancelPaneCmd fires POST /v1/sessions/:sessionId/cancel
// and posts the result back as a cancelDoneMsg. Returns
// nil when client/pane is missing or there's no session
// to cancel.
//
// We capture sessionID + paneID by value (not pointer) so
// a fresh pane that lands on the same pointer in
// routeWaitEventToPane can't rewrite what the operator
// already asked to cancel.
func cancelPaneCmd(client *api.Client, pane PaneModel) tea.Cmd {
	if client == nil || pane.SessionID == "" {
		return nil
	}
	sessionID := pane.SessionID
	paneID := pane.PaneID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), cancelDecisionMs+1*time.Second)
		defer cancel()
		resp, err := client.CancelSession(ctx, sessionID, "operator interrupt")
		if err != nil {
			return cancelDoneMsg{PaneID: paneID, Err: err}
		}
		return cancelDoneMsg{
			PaneID:                   paneID,
			ActiveExecutionCancelled: resp.ActiveExecutionCancelled,
		}
	}
}

// requestCancelForPane is the InteractiveModel entry point
// for the cancel path. Sets pane.InterruptionActive=true
// (so the chrome can show a "cancelling..." hint) and
// returns the cancel cmd. The caller routes the
// resulting cancelDoneMsg back into Update.
//
// Single-flight: a second call for the same pane while a
// cancel is already in flight is a no-op. The flag is
// cleared on the matching handleCancelDone (success or
// error — we don't want InterruptionActive to stick
// after a network failure).
func (m *InteractiveModel) requestCancelForPane(pane PaneModel) tea.Cmd {
	if m == nil || m.loopClient == nil {
		return nil
	}
	if pane.SessionID == "" {
		return nil
	}
	// Don't stack cancels on the same pane.
	if pane.InterruptionActive {
		return nil
	}
	pane.InterruptionActive = true
	m.loop = m.loop.withPane(pane)
	return cancelPaneCmd(m.loopClient, pane)
}

// handleCancelDone is the Update-path entry for
// cancelDoneMsg. On success (and when an active execution
// was actually cancelled) it flips the pane to
// Status=waiting. On the no-active-execution path it
// still clears InterruptionActive — the cancel call
// completed, even if there was nothing to abort. On HTTP
// error it stamps a failure toast and clears
// InterruptionActive so the operator can retry.
//
// In all paths the submitInFlight flag is cleared, so a
// queued-next prompt (if any) can submit on the next
// dispatch.
func (m *InteractiveModel) handleCancelDone(msg cancelDoneMsg) tea.Cmd {
	if m == nil {
		return nil
	}
	pane, ok := m.findPaneByID(msg.PaneID)
	if !ok {
		return nil
	}
	pane.InterruptionActive = false
	if msg.Err != nil {
		m.toastMessage = "✗ cancel failed for " + msg.PaneID + ": " + msg.Err.Error()
		m.toastShownAt = time.Now()
		m.loop = m.loop.withPane(pane)
		return nil
	}
	if msg.ActiveExecutionCancelled {
		pane.Status = StatusWaiting
		m.toastMessage = "✓ cancelled " + msg.PaneID
	} else {
		// Nothing was running — the cancel completed but
		// the active execution had already finished. Drop
		// the toast; the operator hit Esc on a no-op
		// (e.g. the server returned success while we were
		// in flight) and shouldn't get a celebratory
		// "cancelled" message.
	}
	m.toastShownAt = time.Now()
	m.loop = m.loop.withPane(pane)
	return nil
}
