// internal/loop/health_merge.go
//
// Phase 4b: pure-function merge of /v1/runtime/loop/health
// responses into the LoopModel. The data layer (this file)
// stays free of Bubble Tea so the merge can be tested as a
// normal Go function: `applyHealthToLoop` returns the new
// model and a slice of status transitions, and the runtime
// adapter (health_tick.go) is responsible for dispatching
// toast / sound side effects on each transition.
//
// Why pure:
//   - tests don't need a real Nexus or tea runtime
//   - the same merge can be replayed from a snapshot for
//     `bbl loop --status` smoke output
//   - status transitions are explicit data the runtime can
//     log / debug / persist

package loop

import (
	"time"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// StatusTransition records one pane's status change between
// two health snapshots. From is the previous PaneStatus,
// To is the new one (server-reported). PaneID + TabID +
// SessionID are the join keys the runtime needs to surface
// the transition in the toast queue / log.
type StatusTransition struct {
	PaneID    string
	TabID     string
	SessionID string
	From      PaneStatus
	To        PaneStatus
}

// applyHealthToLoop returns a new LoopModel with each
// pane's Status, LastEventRev, and LastEventAt updated to
// match the corresponding entry in `health`, plus the list
// of panes whose status changed. The function is pure: it
// never mutates `model` in place and never performs I/O.
//
// Matching strategy: health panes are keyed by SessionID
// (the server-side loop/health shape doesn't carry a PaneID
// field), and LoopModel panes carry both PaneID and
// SessionID. The first match wins; panes that don't appear
// in the health response are left untouched. Panes in the
// health response that don't match any LoopModel pane are
// dropped silently (they likely belong to another session
// / workspace — the next reconcile pass will reconcile
// loop_state and bring the local model in line).
func applyHealthToLoop(model LoopModel, health api.LoopHealthResponse) (LoopModel, []StatusTransition) {
	if len(health.Panes) == 0 {
		return model, nil
	}
	// Build a SessionID -> LoopHealthPane map for O(1) lookup.
	// Duplicate session ids in the health response are
	// unexpected; first write wins, the rest are dropped.
	bySession := make(map[string]api.LoopHealthPane, len(health.Panes))
	for _, hp := range health.Panes {
		if hp.SessionID == "" {
			continue
		}
		if _, dup := bySession[hp.SessionID]; dup {
			continue
		}
		bySession[hp.SessionID] = hp
	}

	transitions := []StatusTransition{}
	for wi := range model.Workspaces {
		ws := model.Workspaces[wi]
		for ti := range ws.Tabs {
			tab := ws.Tabs[ti]
			changed := false
			for pi := range tab.Panes {
				pane := tab.Panes[pi]
				hp, ok := bySession[pane.SessionID]
				if !ok {
					continue
				}
				newStatus := statusFromString(hp.Status)
				if pane.Status != newStatus {
					transitions = append(transitions, StatusTransition{
						PaneID:    pane.PaneID,
						TabID:     tab.ID,
						SessionID: pane.SessionID,
						From:      pane.Status,
						To:        newStatus,
					})
				}
				pane.Status = newStatus
				pane.LastEventRev = hp.LastEventRev
				if hp.LastEventAt != "" {
					if t, ok := parseHealthTimestamp(hp.LastEventAt); ok {
						pane.LastEventAt = t
					}
				}
				tab.Panes[pi] = pane
				changed = true
			}
			if changed {
				ws.Tabs[ti] = tab
			}
		}
		model.Workspaces[wi] = ws
	}
	return model, transitions
}

// statusFromString maps the wire-side status string to the
// PaneStatus enum. Unknown / empty values fall back to
// StatusIdle so a malformed server response doesn't crash
// the render — the pane just renders as idle until the next
// poll fixes the projection.
func statusFromString(s string) PaneStatus {
	switch s {
	case "idle":
		return StatusIdle
	case "working":
		return StatusWorking
	case "blocked":
		return StatusBlocked
	case "waiting":
		return StatusWaiting
	case "drift":
		return StatusDrift
	case "done":
		return StatusDone
	default:
		return StatusIdle
	}
}

// parseHealthTimestamp parses the server's ISO-8601
// timestamp. Returns ok=false when the string is empty or
// unparseable so the caller can leave the pane's
// LastEventAt untouched instead of writing the zero time.
func parseHealthTimestamp(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	// Server sends RFC3339 with millisecond precision and a
	// trailing "Z"; time.Parse(time.RFC3339Nano, ...) handles
	// both with and without fractional seconds.
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, true
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, true
	}
	return time.Time{}, false
}
