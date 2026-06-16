// internal/loop/health_tick.go
//
// Phase 4b: tea.Cmd-driven /v1/runtime/loop/health poll.
// Mirrors reconcile_tick.go so the pattern stays consistent:
// the runtime layer never spawns bare goroutines; all async
// work is funnelled through tea.Cmd so the Bubble Tea
// program can cancel them on quit.
//
// The poll runs in parallel with the existing reconcile
// pass — they're independent (reconcile syncs loop_state,
// health syncs per-pane status projections) and the chrome
// renders both through the same LoopModel fields.

package loop

import (
	"context"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// healthDoneMsg is dispatched to the Update path after each
// /v1/runtime/loop/health fetch. Carries the parsed response
// and any error so the merge layer can update the model
// without re-running the HTTP call.
type healthDoneMsg struct {
	resp api.LoopHealthResponse
	err  error
	at   time.Time
}

// scheduleHealthTick returns a tea.Cmd that fires after
// `interval` and posts a tickMsg so the Update path can
// re-enter the health-fetch loop. A non-positive interval
// returns nil so the runtime is a no-op when the
// InteractiveModel has no loopClient / health interval
// configured.
func scheduleHealthTick(interval time.Duration) tea.Cmd {
	if interval <= 0 {
		return nil
	}
	return tea.Tick(interval, func(time.Time) tea.Msg {
		return healthTickMsg{}
	})
}

// healthTickMsg is the periodic "time to fetch health"
// signal. Distinct from healthDoneMsg so the model can
// tell "kickoff" from "result".
type healthTickMsg struct{}

// fetchHealthCmd returns a tea.Cmd that calls
// loopClient.FetchLoopHealth once and posts the result via
// healthDoneMsg. The cmd cancels in-flight fetches when
// the bubbletea program shuts down so we don't leak HTTP
// calls after the user quits.
func fetchHealthCmd(client *api.Client, workspaceID string, lastN int) tea.Cmd {
	if client == nil {
		return nil
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		resp, err := client.FetchLoopHealth(ctx, workspaceID, "", "", lastN)
		return healthDoneMsg{resp: resp, err: err, at: time.Now()}
	}
}

// handleHealthTick runs the next health fetch and
// reschedules the following tick. Mirrors
// handleReconcileTick so the two periodic loops share the
// same shape. The actual HTTP call lives in
// fetchHealthCmd; this method just chains them.
func (m *InteractiveModel) handleHealthTick() tea.Cmd {
	if m.loopClient == nil || m.healthInterval <= 0 {
		return nil
	}
	return fetchHealthCmd(m.loopClient, "", 0)
}

// handleHealthDone merges the latest health response into
// the LoopModel, then walks the resulting status
// transitions through the toast queue + sound player so
// drift / blocked / done changes surface in the chrome.
// Reschedules the next tick.
func (m *InteractiveModel) handleHealthDone(msg healthDoneMsg) tea.Cmd {
	m.lastHealthCheckAt = msg.at
	if msg.err != nil {
		// Health fetch failed (server down, transient
		// network). Don't mutate the model; the operator
		// sees the existing status until the next poll
		// succeeds. The error is logged into the chrome
		// toast line so a persistent failure is visible.
		m.toastMessage = "✗ health check failed: " + msg.err.Error()
		m.toastShownAt = msg.at
		return scheduleHealthTick(m.healthInterval)
	}
	newModel, transitions := applyHealthToLoop(m.loop, msg.resp)
	m.loop = newModel
	m.applyTransitions(transitions)
	return scheduleHealthTick(m.healthInterval)
}

// applyTransitions walks each StatusTransition through the
// toast queue + sound player. ToastQueue is responsible
// for dedup + focused-tab suppression, so this method is
// the single place where status changes become user-facing
// events. The toast message is generic ("status changed:
// drift") — full status explanations are left to the
// scope_review overlay (Phase 6).
func (m *InteractiveModel) applyTransitions(transitions []StatusTransition) {
	if m.toastQueue == nil || len(transitions) == 0 {
		return
	}
	for _, t := range transitions {
		if t.From == t.To {
			continue
		}
		message := "pane " + t.PaneID + ": " + t.From.String() + " → " + t.To.String()
		event, ok := m.toastQueue.Play(m.soundPlayer, t.PaneID, t.TabID, t.To.String(), message)
		if !ok {
			// Suppressed (focused tab or dedup window).
			continue
		}
		_ = event // future: hand off to a toast overlay
	}
}
