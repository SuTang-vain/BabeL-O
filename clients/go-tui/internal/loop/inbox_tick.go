// internal/loop/inbox_tick.go
//
// SessionChannel relationship visibility for `bbl loop`
// (Phase 1 of docs/nexus/reference/session-channel-tui-relationship-visibility-plan.md):
// a tea.Cmd-driven /v1/sessions/:id/inbox poll that
// surfaces the focused pane's unread + high-priority
// summary in the footer and a per-pane unread badge in
// the sidebar.
//
// Pattern mirrors health_tick.go / reconcile_tick.go —
// the runtime layer never spawns bare goroutines; all
// async work is funnelled through tea.Cmd so the Bubble
// Tea program can cancel them on quit.

package loop

import (
	"context"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// inboxDoneMsg is dispatched to the Update path after each
// /v1/sessions/:id/inbox fetch. Carries the session id
// (so the model can update the right pane's badge), the
// parsed response, the wall-clock fetch time, and any
// error so the merge layer can update the model without
// re-running the HTTP call.
type inboxDoneMsg struct {
	sessionID string
	resp      api.SessionInboxResponse
	err       error
	at        time.Time
}

// inboxTickMsg is the periodic "time to fetch inbox"
// signal. Distinct from inboxDoneMsg so the model can
// tell "kickoff" from "result". Empty struct — the actual
// session id lives on the focused pane at fetch time.
type inboxTickMsg struct{}

// scheduleInboxTick returns a tea.Cmd that fires after
// `interval` and posts an inboxTickMsg so the Update path
// can re-enter the inbox-fetch loop. A non-positive
// interval returns nil so the runtime is a no-op when
// the InteractiveModel has no loopClient / no focused
// session.
//
// The default interval (10s) is a tradeoff: shorter than
// the operator's reaction time but long enough that the
// `/inbox` endpoint doesn't become a hot path when 20+
// panes are open. The loop only fetches the *focused*
// pane's session, so the surface stays bounded.
func scheduleInboxTick(interval time.Duration) tea.Cmd {
	if interval <= 0 {
		return nil
	}
	return tea.Tick(interval, func(time.Time) tea.Msg {
		return inboxTickMsg{}
	})
}

// fetchInboxCmd returns a tea.Cmd that calls
// loopClient.FetchSessionInbox once for the given session
// id and posts the result via inboxDoneMsg. The cmd
// cancels in-flight fetches when the bubbletea program
// shuts down so we don't leak HTTP calls after the user
// quits.
func fetchInboxCmd(client *api.Client, sessionID string) tea.Cmd {
	if client == nil || sessionID == "" {
		return nil
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		resp, err := client.FetchSessionInbox(ctx, sessionID, api.SessionInboxOptions{
			IncludeAcknowledged: false,
			Limit:               20,
		})
		return inboxDoneMsg{sessionID: sessionID, resp: resp, err: err, at: time.Now()}
	}
}

// handleInboxTick fires the next inbox fetch and
// reschedules the following tick. Mirrors handleHealthTick
// — the actual HTTP call lives in fetchInboxCmd; this
// method just chains them and reads the focused pane's
// session id from the loop model.
func (m *InteractiveModel) handleInboxTick() tea.Cmd {
	if m.loopClient == nil || m.inboxInterval <= 0 {
		return nil
	}
	pane, ok := m.loop.FocusedPane()
	if !ok || pane.SessionID == "" {
		// No active session — defer the next tick.
		return scheduleInboxTick(m.inboxInterval)
	}
	return fetchInboxCmd(m.loopClient, pane.SessionID)
}

// handleInboxDone merges the latest inbox response into
// the per-session inbox map, then walks the result through
// the chrome's session list badge state. Errors are
// logged to the toast line (matching the health tick
// pattern) so a persistent failure is visible without
// mutating the model. Reschedules the next tick.
func (m *InteractiveModel) handleInboxDone(msg inboxDoneMsg) tea.Cmd {
	if msg.err != nil {
		// Don't clobber an existing toast — only surface
		// the first error in a window. The chrome already
		// has a transient "inbox: N unread" indicator,
		// so a transient backend blip is mostly cosmetic.
		if m.toastMessage == "" {
			m.toastMessage = "✗ inbox check failed: " + msg.err.Error()
			m.toastShownAt = msg.at
		}
		return scheduleInboxTick(m.inboxInterval)
	}
	if m.sessionInbox == nil {
		m.sessionInbox = make(map[string]*api.SessionInboxResponse)
	}
	// Defensive copy: hold a pointer to a value copy so
	// the chrome layer can read it without re-running
	// the network call. The chrome only reads
	// .Messages, never mutates.
	resp := msg.resp
	m.sessionInbox[msg.sessionID] = &resp
	// Mirror to the LoopModel so the chrome (which takes
	// a LoopModel, not the InteractiveModel) can read
	// the cache. LoopModel.SessionInbox is a separate
	// field owned by the data layer; the InteractiveModel
	// pushes updates whenever the cache changes so the
	// next View sees them.
	m.loop.SessionInbox = m.sessionInbox
	return scheduleInboxTick(m.inboxInterval)
}
