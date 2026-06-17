// internal/loop/ws_read.go
//
// Phase 6d-c'-A: opt-in WebSocket read path for
// `/v1/sessions/:id/stream`. The default read path is
// HTTP `waitForEvent` (6c / wait_tick.go). This file adds
// a parallel read path that opens a single WS per pane
// and reads server-pushed events as they arrive.
//
// Why opt-in (not the default):
//
//   - The Nexus server's `/v1/sessions/:id/stream`
//     endpoint may not be wired yet (plan §3.1 preserves
//     it as a low-level fanout; client adoption drives
//     server wiring). Opt-in lets the client ship and
//     test before the server is fully ready.
//   - WS has its own failure modes (reconnect, half-open
//     sockets) that the HTTP wait path doesn't have. We
//     keep the HTTP path as the proven default and
//     surface WS-specific failures (dial error, abrupt
//     close) as a `✗ ws read disconnected, falling back
//     to http wait` toast so the operator knows.
//
// Wire shape (see api/ws_stream.go for full contract):
//
//	GET ws://host/v1/sessions/:sessionId/stream?since=N
//	< server pushes one JSON object per line
//	  {"type": "...", "rev": N, ...}
//
// The single-event shape (vs waitForEvents' batched
// response) is what makes this file structurally simpler
// than wait_tick.go: each push is one wsEventMsg, the
// handler appends one item, the read loop schedules
// itself for the next event.

package loop

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// wsEventMsg is dispatched to the Update path after each
// server-pushed event. Carries the originating pane + the
// raw JSON event (re-decoded by routeWaitEventToPane to
// keep the routing logic identical to the HTTP path) +
// any read error so handleWsReadEvent can decide between
// "append + read next" and "abort + fall back to wait".
type wsEventMsg struct {
	PaneID    string
	SessionID string
	Raw       json.RawMessage
	Rev       int64
	Err       error
}

// wsHeartbeatRev is the Rev value stamped on a
// "no event arrived, keep going" wsEventMsg from the
// heartbeat timer. The handler (handleWsReadEvent) sees
// this and re-queues a continue read without advancing
// the pane's LastEventRev.
const wsHeartbeatRev = int64(-1)

// wsReadHeartbeat is how often the continue read fires
// a "no event yet" wsEventMsg so the loop knows the read
// is still alive. Deliberately long — the operator can
// be idle for a while; we don't want to churn the worker
// pool. Tests can override by replacing the channels
// directly via registerWsReadChannels.
const wsReadHeartbeat = 30 * time.Second

// errStreamClosed is the sentinel for a clean stream
// close. Distinct from network errors so the toast /
// fallback logic can branch.
var errStreamClosed = &wsStreamClosedError{}

type wsStreamClosedError struct{}

func (e *wsStreamClosedError) Error() string { return "ws stream closed" }

// useWsRead is the opt-in flag that switches the
// per-pane read path from HTTP `waitForEvent` to WS
// stream. Read once at Init time (or via
// SetUseWsReadForTest). Default is false (HTTP wait) so
// existing users see no behavior change.
func (m *InteractiveModel) useWsReadPath() bool {
	if m == nil {
		return false
	}
	return m.useWsRead
}

// SetUseWsReadForTest flips the WS read opt-in for
// tests. Production code wires this from a CLI flag
// or env var at startup; tests inject it after
// construction. Mirrors SetScopeReviewInputForTest in
// spirit.
func (m *InteractiveModel) SetUseWsReadForTest(enabled bool) {
	m.useWsRead = enabled
}

// scheduleWsRead opens a WS stream for one pane and
// returns a tea.Cmd that, on the bubbletea worker, dials
// the stream and returns a wsReadBatchMsg with the
// read-loop handle. Returns nil when client is nil /
// sessionID is empty / the pane already has a read in
// flight — matching scheduleWaitTick's contract.
func (m *InteractiveModel) scheduleWsRead(p PaneModel) tea.Cmd {
	if m.loopClient == nil || p.SessionID == "" {
		return nil
	}
	if m.isWsReadInFlight(p.PaneID) {
		return nil
	}
	m.setWsReadInFlight(p.PaneID)
	return fetchWsReadCmd(m.loopClient, p.PaneID, p.SessionID, p.LastEventRev)
}

// fetchWsReadCmd dials the stream and returns the
// read-loop handle in a wsReadBatchMsg. The Update path's
// handleWsReadStarted stores the handle on the model and
// schedules the first continue read.
func fetchWsReadCmd(client *api.Client, paneID, sessionID string, since int64) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithCancel(context.Background())
		events, errs, closeFn, err := client.StreamSession(ctx, sessionID, api.StreamOptions{
			Since: since,
		})
		if err != nil {
			cancel()
			return wsEventMsg{PaneID: paneID, SessionID: sessionID, Err: err}
		}
		return wsReadBatchMsg{
			PaneID: paneID, SessionID: sessionID,
			Cancel: cancel, Close: closeFn,
			Events: events, Errs: errs,
		}
	}
}

// wsReadBatchMsg is the "WS is open, here's the read
// loop handle" message. The handler (handleWsReadStarted)
// stores the cancel/close + the channels on the model
// and schedules the first continue read.
type wsReadBatchMsg struct {
	PaneID    string
	SessionID string
	Cancel    context.CancelFunc
	Close     func()
	Events    <-chan api.StreamEvent
	Errs      <-chan error
}

// handleWsReadStarted stores the cancel/close handles
// and the channels on the model, then schedules the
// first continue read.
func (m *InteractiveModel) handleWsReadStarted(msg wsReadBatchMsg) tea.Cmd {
	if m == nil {
		return nil
	}
	m.registerWsReadCancel(msg.PaneID, msg.Cancel, msg.Close)
	m.registerWsReadChannels(msg.PaneID, msg.Events, msg.Errs)
	return m.wsReadContinueCmd(msg.PaneID)
}

// handleWsReadEvent is the per-event / per-error
// handler. Mirrors handleWaitDone's structure: append
// the event to the pane's Transcript, advance
// LastEventRev, trim to maxTranscriptItems, reschedule
// the next read.
func (m *InteractiveModel) handleWsReadEvent(msg wsEventMsg) tea.Cmd {
	if m == nil {
		return nil
	}
	// Heartbeat: no event arrived, just re-arm the
	// read. Don't mutate the model.
	if msg.Rev == wsHeartbeatRev && msg.Err == nil {
		if !m.isWsReadInFlight(msg.PaneID) {
			return nil
		}
		return m.wsReadContinueCmd(msg.PaneID)
	}
	if msg.Err != nil {
		// Surface as a toast. Don't mutate the model.
		// The next reconcile tick can fall back to
		// HTTP wait if WS keeps failing (or the
		// operator can re-open with the wait path).
		m.clearWsReadInFlight(msg.PaneID)
		m.toastMessage = "✗ ws read disconnected for " + msg.PaneID + ": " + msg.Err.Error()
		m.toastShownAt = time.Now()
		return nil
	}
	// Real event: append via the same routing helper
	// the wait path uses. Single-event shape mirrors
	// the wait path's "for each raw event" loop.
	pane, ok := m.findPaneByID(msg.PaneID)
	if !ok {
		m.clearWsReadInFlight(msg.PaneID)
		return nil
	}
	if msg.Rev > pane.LastEventRev {
		pane.LastEventRev = msg.Rev
		pane.LastEventAt = time.Now()
	}
	if len(msg.Raw) > 0 {
		routeWaitEventToPane(msg.Raw, &pane)
	}
	if len(pane.Transcript) > maxTranscriptItems {
		drop := len(pane.Transcript) - maxTranscriptItems
		pane.Transcript = pane.Transcript[drop:]
	}
	m.loop = m.loop.withPane(pane)
	return m.wsReadContinueCmd(msg.PaneID)
}

// wsReadContinueCmd is the "read the next event from the
// open stream" tea.Cmd. Looks up the per-pane channels
// on the package-level registry and selects on them. On
// success it posts a wsEventMsg; on clean close it
// stamps a sentinel error; on error it stamps the
// error.
func (m *InteractiveModel) wsReadContinueCmd(paneID string) tea.Cmd {
	return func() tea.Msg {
		events, errs, ok := lookupWsReadChannels(paneID)
		if !ok {
			return wsEventMsg{PaneID: paneID, Err: errStreamClosed}
		}
		timer := time.NewTimer(wsReadHeartbeat)
		defer timer.Stop()
		select {
		case ev, ok := <-events:
			if !ok {
				return wsEventMsg{PaneID: paneID, Err: errStreamClosed}
			}
			return wsEventMsg{
				PaneID: paneID,
				Raw:    ev.Raw, Rev: ev.Rev,
			}
		case err, ok := <-errs:
			if ok {
				return wsEventMsg{PaneID: paneID, Err: err}
			}
			return wsEventMsg{PaneID: paneID, Err: errStreamClosed}
		case <-timer.C:
			return wsEventMsg{PaneID: paneID, Rev: wsHeartbeatRev}
		}
	}
}

// --- In-flight tracking + cancel/close handles ---

func (m *InteractiveModel) setWsReadInFlight(paneID string) {
	if m.wsReadInFlight == nil {
		m.wsReadInFlight = make(map[string]bool)
	}
	m.wsReadInFlight[paneID] = true
}

func (m *InteractiveModel) clearWsReadInFlight(paneID string) {
	delete(m.wsReadInFlight, paneID)
	if cancel, closeFn, ok := m.popWsReadCancel(paneID); ok {
		if cancel != nil {
			cancel()
		}
		if closeFn != nil {
			closeFn()
		}
	}
	// Drop the channel registry entry too so a stale
	// lookup doesn't find a dead channel.
	clearWsReadChannels(paneID)
}

func (m *InteractiveModel) isWsReadInFlight(paneID string) bool {
	return m.wsReadInFlight != nil && m.wsReadInFlight[paneID]
}

// registerWsReadCancel stores the cancel/close funcs
// returned by fetchWsReadCmd so clearWsReadOnClose can
// stop the read.
func (m *InteractiveModel) registerWsReadCancel(paneID string, cancel context.CancelFunc, closeFn func()) {
	if m.wsReadCancels == nil {
		m.wsReadCancels = make(map[string]wsReadHandles)
	}
	m.wsReadCancels[paneID] = wsReadHandles{Cancel: cancel, Close: closeFn}
}

func (m *InteractiveModel) popWsReadCancel(paneID string) (context.CancelFunc, func(), bool) {
	h, ok := m.wsReadCancels[paneID]
	if !ok {
		return nil, nil, false
	}
	delete(m.wsReadCancels, paneID)
	return h.Cancel, h.Close, true
}

// wsReadHandles bundles the per-pane cancel/close
// funcs the WS read loop owns.
type wsReadHandles struct {
	Cancel context.CancelFunc
	Close  func()
}

// clearWsReadOnClose is the close-pane counterpart to
// clearWaitOnClose. Cancels the WS read + closes the
// socket so a stale event that arrives after the pane
// is gone is dropped.
func (m *InteractiveModel) clearWsReadOnClose(paneID string) {
	m.clearWsReadInFlight(paneID)
}

// --- Channel registry ---
//
// The continue read runs inside a tea.Cmd closure that
// doesn't have access to *InteractiveModel. We stash the
// per-pane channels in a package-level map so the closure
// can find them. The map is guarded by a mutex so the
// test suite (which constructs multiple models) stays
// safe. The "package-level" caveat is acceptable here
// because there's exactly one InteractiveModel per
// bubbletea program; the per-pane map keys are unique
// per program instance.

var (
	wsReadChannelsMu sync.Mutex
	wsReadChannels   = make(map[string]wsReadChannelPair)
)

type wsReadChannelPair struct {
	Events <-chan api.StreamEvent
	Errs   <-chan error
}

func registerWsReadChannelsFor(paneID string, events <-chan api.StreamEvent, errs <-chan error) {
	wsReadChannelsMu.Lock()
	defer wsReadChannelsMu.Unlock()
	wsReadChannels[paneID] = wsReadChannelPair{Events: events, Errs: errs}
}

func lookupWsReadChannels(paneID string) (<-chan api.StreamEvent, <-chan error, bool) {
	wsReadChannelsMu.Lock()
	defer wsReadChannelsMu.Unlock()
	pair, ok := wsReadChannels[paneID]
	return pair.Events, pair.Errs, ok
}

func clearWsReadChannels(paneID string) {
	wsReadChannelsMu.Lock()
	defer wsReadChannelsMu.Unlock()
	delete(wsReadChannels, paneID)
}

// (m *InteractiveModel) registerWsReadChannels is the
// method the handler calls; it delegates to the
// package-level registry.
func (m *InteractiveModel) registerWsReadChannels(paneID string, events <-chan api.StreamEvent, errs <-chan error) {
	registerWsReadChannelsFor(paneID, events, errs)
}

// startAllReads starts a per-pane read cmd for every
// pane currently in the model. Used at Init() so a TUI
// launched on top of an existing Store starts streaming
// transcript rows immediately. Dispatches to WS or HTTP
// based on m.useWsRead.
//
// Returns nil when the loopClient is nil or when there's
// nothing to start. Each returned cmd is ready to drop
// into tea.Batch.
func (m *InteractiveModel) startAllReads() []tea.Cmd {
	if m.loopClient == nil {
		return nil
	}
	var cmds []tea.Cmd
	for _, ws := range m.loop.Workspaces {
		for _, tab := range ws.Tabs {
			for _, p := range tab.Panes {
				cmd := m.startReadForPane(p)
				if cmd != nil {
					cmds = append(cmds, cmd)
				}
			}
		}
	}
	return cmds
}

// startReadsForNewPanes starts a read for any pane that
// has a SessionID but no read in flight. Called from
// handleReconcileDone after the post-6a re-hydrate has
// discovered / refreshed the pane set.
func (m *InteractiveModel) startReadsForNewPanes() []tea.Cmd {
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
				if m.isWaitInFlight(p.PaneID) || m.isWsReadInFlight(p.PaneID) {
					continue
				}
				cmd := m.startReadForPane(p)
				if cmd != nil {
					cmds = append(cmds, cmd)
				}
			}
		}
	}
	return cmds
}

// startReadForPane returns a read cmd for the given pane
// (WS or HTTP wait based on m.useWsRead), or nil when
// the pane has no SessionID / the client is nil / a
// read is already in flight.
func (m *InteractiveModel) startReadForPane(p PaneModel) tea.Cmd {
	if m.loopClient == nil || p.SessionID == "" {
		return nil
	}
	if m.useWsReadPath() {
		return m.scheduleWsRead(p)
	}
	return m.startWaitForPane(p)
}
