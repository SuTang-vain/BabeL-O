// internal/loop/wait_tick.go
//
// Phase 6c of docs/nexus/reference/go-tui-loop-multipane-plan.md
// (§6'): per-pane waitForEvent long poll. Mirrors health_tick.go
// (the model is funnelled through tea.Cmd so the bubbletea
// program can cancel in-flight HTTP on quit — no bare
// goroutines).
//
// Flow:
//
//	bbl loop start
//	  → Init / handleReconcileDone (post-6a re-hydrate)
//	      for each newly-discovered pane with SessionID != ""
//	      → scheduleWaitTick(client, sessionID, since)
//	          → fetchWaitCmd: GET /v1/sessions/:id/wait?since=N&timeout=5000
//	          → waitDoneMsg posts {Events, NextRev, Err}
//	          → handleWaitDone: append EventToTranscriptItem shapes
//	            to pane.Transcript, advance pane.LastEventRev,
//	            trim to maxTranscriptItems, schedule next wait
//	          → loop
//
// In-flight dedup: InteractiveModel.waitInFlight map tracks
// per-pane state. scheduleWaitTick is a no-op when the pane's
// wait is already in flight (per §6'.3 6c point 3).
//
// Transcript ownership: waitTick is the *only* writer of
// pane.Transcript (after construction). It does NOT touch
// pane.Status — health poll owns that (per §6'.3 6c point 10).
//
// Timeout semantics: matches plan §3.1 — server returns 200 +
// {events: [], nextRevision: <current>} on timeout, which we
// treat as a normal poll tick (nextRev=since means "no new
// events"; we still reschedule, just don't append anything).

package loop

import (
	"context"
	"encoding/json"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// maxTranscriptItems caps the per-pane transcript at 500
// entries (per §6'.3 6c point 7). Older entries are dropped
// on append; the cursor is still LastEventRev, not
// len(Transcript), so dropping old events is safe.
const maxTranscriptItems = 500

// defaultWaitTimeoutMs is the per-call wait timeout. Plan
// §3.1 lets the server interpret timeout; we choose 5000ms so
// the wait poll doesn't starve other cmd traffic and
// reschedules within a reasonable interval.
const defaultWaitTimeoutMs = 5000

// waitDoneMsg is dispatched to the Update path after each
// per-pane wait fetch. Carries the parsed events + the new
// revision cursor + any error so handleWaitDone can update
// the model without re-running the HTTP call.
type waitDoneMsg struct {
	PaneID   string
	SessionID string
	Events   []json.RawMessage
	NextRev  int64
	Err      error
}

// scheduleWaitTick returns a tea.Cmd that fetches one wait
// page for the given session starting at `since`. The cmd is
// a no-op (nil) when client is nil or sessionID is empty,
// matching the convention in health_tick.go. paneID is
// stamped onto the resulting waitDoneMsg so the handler can
// find the originating pane in the model (per §6'.3 6c).
//
// Callers MUST check InteractiveModel.waitInFlight first;
// scheduleWaitTick itself does not enforce single-flight —
// the InteractiveModel layer owns that (it has access to the
// model, scheduleWaitTick is a free function).
func scheduleWaitTick(client *api.Client, paneID, sessionID string, since int64) tea.Cmd {
	if client == nil || sessionID == "" {
		return nil
	}
	return fetchWaitCmd(client, paneID, sessionID, since)
}

// fetchWaitCmd returns a tea.Cmd that calls
// loopClient.WaitForEvents once and posts the result via
// waitDoneMsg. The cmd cancels in-flight fetches when the
// bubbletea program shuts down (ctx.WithTimeout). Timeout is
// the per-call soft budget; server returns empty events on
// expiry per plan §3.1.
func fetchWaitCmd(client *api.Client, paneID, sessionID string, since int64) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), defaultWaitTimeoutMs*time.Millisecond+1*time.Second)
		defer cancel()
		resp, err := client.WaitForEvents(ctx, sessionID, api.WaitOptions{
			Since:     since,
			TimeoutMs: defaultWaitTimeoutMs,
		})
		if err != nil {
			return waitDoneMsg{PaneID: paneID, Err: err}
		}
		return waitDoneMsg{
			PaneID:    paneID,
			SessionID: sessionID,
			Events:    resp.Events,
			NextRev:   parseNextRevision(resp.NextRevision, since),
		}
	}
}

// parseNextRevision normalizes the server's nextRevision
// string. Plan §3.1 says it can be empty (timeout) or a
// decimal rev. We default to `since` when empty / malformed
// so a no-op poll doesn't accidentally rewind the cursor.
func parseNextRevision(s string, fallback int64) int64 {
	if s == "" {
		return fallback
	}
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return fallback
		}
		n = n*10 + int64(c-'0')
	}
	if n < fallback {
		// Server shouldn't go backwards; if it does we keep
		// the higher cursor to avoid re-replaying events.
		return fallback
	}
	return n
}

// handleWaitDone merges the latest wait page into the focused
// pane's Transcript, advances the pane's LastEventRev, trims
// to maxTranscriptItems, and returns the next wait cmd.
//
// Signature mirrors handleHealthDone so the Update path can
// dispatch both message types with the same plumbing.
//
// Pane lookup is by PaneID across all workspaces / tabs. If
// the pane was closed (close → ApplyClosePane → cleanup
// waitInFlight) the result is dropped silently — the wait
// cmd was already issued, the pane is just gone now.
func (m *InteractiveModel) handleWaitDone(msg waitDoneMsg) tea.Cmd {
	if m == nil {
		return nil
	}
	defer func() {
		// Always clear in-flight for this pane, even on
		// error, so a future reconcile / reschedule can
		// start a fresh wait. A clean error path doesn't
		// need its own clear — the deferred runs.
		if msg.PaneID != "" {
			m.clearWaitInFlight(msg.PaneID)
		}
	}()

	if msg.Err != nil {
		// Network / timeout error. Don't mutate the model;
		// log to the chrome toast so a persistent failure
		// is visible. We do NOT reschedule here — the next
		// reconcile tick (5s default) will restart the wait
		// for this pane. This bounds the failure window
		// to one reconcile cycle and avoids a hot retry
		// loop on a downed server.
		m.toastMessage = "✗ wait failed for " + msg.PaneID + ": " + msg.Err.Error()
		m.toastShownAt = time.Now()
		return nil
	}

	pane, ok := m.findPaneByID(msg.PaneID)
	if !ok {
		// Pane was closed between schedule and result.
		// Silently drop.
		return nil
	}

	// Advance the cursor first, then walk the events in
	// order. Even on an empty poll (timeout), NextRev
	// might equal since — we don't bump pane.LastEventRev
	// in that case (server didn't report new events).
	if msg.NextRev > pane.LastEventRev {
		pane.LastEventRev = msg.NextRev
		pane.LastEventAt = time.Now()
	}
	for _, raw := range msg.Events {
		routeWaitEventToPane(raw, &pane)
		// ok=false events (or events routed to
		// PendingPermission rather than Transcript)
		// still consumed their rev slot implicitly —
		// we already bumped LastEventRev above, so a
		// future reconcile won't replay them.
	}

	// Trim transcript to maxTranscriptItems (drop oldest).
	if len(pane.Transcript) > maxTranscriptItems {
		drop := len(pane.Transcript) - maxTranscriptItems
		pane.Transcript = pane.Transcript[drop:]
	}

	// Write back to the model.
	m.loop = m.loop.withPane(pane)

	// Reschedule the next wait for this pane — even when
	// no new events arrived (normal poll tick). Use the
	// updated LastEventRev so the server doesn't replay
	// already-seen events.
	if pane.SessionID != "" && m.loopClient != nil {
		m.setWaitInFlight(pane.PaneID)
		return scheduleWaitTick(m.loopClient, pane.PaneID, pane.SessionID, pane.LastEventRev)
	}
	return nil
}

// findPaneByID walks every workspace / tab to find a pane
// by PaneID. Returns the pane and ok=true; zero-value + false
// when not found. Used by the wait handler so it can update
// the right pane regardless of focus path.
func (m *InteractiveModel) findPaneByID(paneID string) (PaneModel, bool) {
	if m == nil || paneID == "" {
		return PaneModel{}, false
	}
	for _, ws := range m.loop.Workspaces {
		for _, tab := range ws.Tabs {
			for _, p := range tab.Panes {
				if p.PaneID == paneID {
					return p, true
				}
			}
		}
	}
	return PaneModel{}, false
}

// withPane returns a copy of the LoopModel with `updated`
// written back into the matching pane. Mirrors the immutability
// style of applySnapshotToLoop (model.go style — return a new
// value, don't mutate the receiver).
func (m LoopModel) withPane(updated PaneModel) LoopModel {
	for wi, ws := range m.Workspaces {
		for ti, tab := range ws.Tabs {
			for pi, p := range tab.Panes {
				if p.PaneID == updated.PaneID {
					m.Workspaces[wi].Tabs[ti].Panes[pi] = updated
					return m
				}
			}
		}
	}
	return m
}

// setWaitInFlight / clearWaitInFlight are tiny map helpers.
// They tolerate a nil map (Initialize lazily on first call).
// Exposed via methods so tests can call them without poking
// the unexported field.
func (m *InteractiveModel) setWaitInFlight(paneID string) {
	if m.waitInFlight == nil {
		m.waitInFlight = make(map[string]bool)
	}
	m.waitInFlight[paneID] = true
}

func (m *InteractiveModel) clearWaitInFlight(paneID string) {
	delete(m.waitInFlight, paneID)
}

// isWaitInFlight reports whether a wait is already scheduled
// for the given pane. Used by reconcile / Init to avoid
// double-scheduling.
func (m *InteractiveModel) isWaitInFlight(paneID string) bool {
	return m.waitInFlight[paneID]
}

// startAllWaits starts a per-pane waitForEvent cmd for every
// pane currently in the model. Used at Init() so a TUI
// launched on top of an existing Store starts streaming
// transcript rows immediately. Pane list is captured at call
// time — if a new pane is added later (Ctrl+N, reconcile
// pull) startWaitsForNewPanes handles it.
//
// Returns nil when the loopClient is nil (no wait possible)
// or when there's nothing to start. Each returned cmd is
// ready to drop into tea.Batch.
func (m *InteractiveModel) startAllWaits() []tea.Cmd {
	if m.loopClient == nil {
		return nil
	}
	var cmds []tea.Cmd
	for _, ws := range m.loop.Workspaces {
		for _, tab := range ws.Tabs {
			for _, p := range tab.Panes {
				cmd := m.startWaitForPane(p)
				if cmd != nil {
					cmds = append(cmds, cmd)
				}
			}
		}
	}
	return cmds
}

// startWaitsForNewPanes starts a wait for any pane that has a
// SessionID but no wait in flight. Called from
// handleReconcileDone after the post-6a re-hydrate has
// discovered / refreshed the pane set — newly visible panes
// need a poll started. Pane list is read at call time.
func (m *InteractiveModel) startWaitsForNewPanes() []tea.Cmd {
	if m.loopClient == nil {
		return nil
	}
	var cmds []tea.Cmd
	for _, ws := range m.loop.Workspaces {
		for _, tab := range ws.Tabs {
			for _, p := range tab.Panes {
				if p.SessionID == "" {
					continue
				}
				if m.isWaitInFlight(p.PaneID) {
					continue
				}
				cmd := m.startWaitForPane(p)
				if cmd != nil {
					cmds = append(cmds, cmd)
				}
			}
		}
	}
	return cmds
}

// startWaitForPane returns a wait cmd for the given pane, or
// nil when the pane has no SessionID / the client is nil / a
// wait is already in flight. The caller is expected to have
// checked isWaitInFlight when looking for "new" panes; this
// helper still re-checks defensively so the caller's
// bookkeeping is the only place that needs to be exact.
//
// Marking the pane in-flight lives next to the cmd issuance
// so a future "schedule but throw away the cmd" path
// (cancelled program etc.) can find the entry to clear.
func (m *InteractiveModel) startWaitForPane(p PaneModel) tea.Cmd {
	if m.loopClient == nil || p.SessionID == "" {
		return nil
	}
	if m.isWaitInFlight(p.PaneID) {
		return nil
	}
	m.setWaitInFlight(p.PaneID)
	return scheduleWaitTick(m.loopClient, p.PaneID, p.SessionID, p.LastEventRev)
}

// clearWaitOnClose removes a pane from waitInFlight. Called
// from ApplyClosePane (and from any other code path that
// retires a pane id) so a stale result that arrives after
// the pane is gone is dropped — handleWaitDone already
// double-checks via findPaneByID, but this is the matching
// cleanup at the close site.
func (m *InteractiveModel) clearWaitOnClose(paneID string) {
	m.clearWaitInFlight(paneID)
}

// routeWaitEventToPane mutates `pane` to reflect the effect
// of a single wait event. It is the 6d-c dispatch point: the
// wait stream carries three kinds of permission-related
// events plus the transcript-shaped events from 6c, and each
// one has a different destination on the pane.
//
// Routing table:
//
//	permission_request   → write pane.PendingPermission
//	                        (the dialog needs the freshest
//	                        request; later requests replace
//	                        earlier ones — runtime never
//	                        asks the user about two at once)
//	permission_response  → clear pane.PendingPermission
//	                        (the operator's decision landed;
//	                        even if it was for a different
//	                        toolUseId we drop the pending
//	                        state — the user has been heard)
//	anything else        → fall through to EventToTranscriptItem
//	                        so 6c's transcript behavior is
//	                        preserved unchanged.
//
// Pure mutator: the function does no I/O, no logging, and
// does not reschedule. The caller (handleWaitDone) is
// responsible for advancing LastEventRev and re-queueing
// the next wait.
func routeWaitEventToPane(raw []byte, pane *PaneModel) {
	if pane == nil || len(raw) == 0 {
		return
	}
	// Fast-path: peek the type only. We don't decode the
	// whole payload here; the dispatchers (EventToPermission
	// / EventToTranscriptItem) re-decode as needed.
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return
	}
	switch head.Type {
	case "permission_request":
		if perm, ok := EventToPermission(raw); ok {
			pane.PendingPermission = perm
		}
	case "permission_response":
		// Server confirmed the operator's decision. We
		// don't match by toolUseId — if a new request
		// has arrived between the response and this
		// event, the next permission_request will
		// overwrite PendingPermission anyway, and the
		// operator has been heard in the meantime.
		pane.PendingPermission = nil
	default:
		if item, ok := EventToTranscriptItem(raw); ok {
			pane.Transcript = append(pane.Transcript, item)
		}
	}
}
