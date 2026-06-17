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
				// PR-17b: only carry the hint pattern forward when
				// the server still reports StatusBehaviorHint. When
				// the runtime clears the hint (PendingHints→0),
				// Status flips back to the prior state and the
				// pattern resets to "" so chrome doesn't show a
				// stale pattern on a non-hint pane.
				if newStatus == StatusBehaviorHint {
					pane.LastHintPattern = hp.LastHintPattern
				} else {
					pane.LastHintPattern = ""
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
	case "behaviorHint", "behavior_hint":
		// PR-17a: 7th PaneStatus, server uses camelCase "behaviorHint"
		// but tolerate snake_case too in case of older clients.
		return StatusBehaviorHint
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

// BuildScopeReviewInputFromHealth is the bridge between
// the per-pane LoopHealthResponse payload and the
// ScopeReviewInput consumed by the `bbl loop` ctrl+r
// scope_review overlay.
//
// Returns nil when there is no focused pane (empty model
// / early startup). Otherwise returns a non-nil input
// that always carries at least the focused model, so
// `BuildScopeReviewLines` can render a header + drift
// count even when no health row matches.
//
// Strategy:
//
//   - find the focused pane's SessionID in `model`
//   - find the matching health pane by SessionID
//   - lift its full taskScope (server returns the full
//     struct, not a count) + PendingScopeBoundaries /
//     OutOfScopeEvidence / PendingPermissions /
//     ActiveMemoryCandidates counts
//   - if no health pane matches, the input is non-nil but
//     carries no TaskScope / counts — the overlay renders
//     a header + the drift count from the model, which is
//     a useful "health is lagging" signal
//
// The returned input is the *only* place these two data
// shapes meet; tests for scope_review rendering can use
// the array fields, production code reads from the count
// fields.
func BuildScopeReviewInputFromHealth(model LoopModel, health api.LoopHealthResponse) *ScopeReviewInput {
	focused, ok := model.FocusedPane()
	if !ok {
		// No focused pane (empty workspace / tab) —
		// caller renders the existing "no scope data
		// yet" placeholder.
		return nil
	}
	input := &ScopeReviewInput{Model: model}
	if focused.SessionID == "" {
		// Focused pane hasn't been attached to a session
		// yet (typed in /v1/execute but no response) — no
		// health row will match. Caller sees header +
		// drift count.
		return input
	}
	for _, hp := range health.Panes {
		if hp.SessionID != focused.SessionID {
			continue
		}
		// Lift the full taskScope (server returns the
		// struct, not just a count). Field-copy across
		// the api.LoopTaskScope → loop.LoopTaskScope
		// type alias so the overlay can hold a pointer
		// to a loop-package-owned struct.
		scope := LoopTaskScope{
			Cwd:                    hp.TaskScope.Cwd,
			PrimaryRoot:            hp.TaskScope.PrimaryRoot,
			ExplicitRoots:          hp.TaskScope.ExplicitRoots,
			ConfirmedExternalRoots: hp.TaskScope.ConfirmedExternalRoots,
			InferredCandidateRoots: hp.TaskScope.InferredCandidateRoots,
			Mode:                   hp.TaskScope.Mode,
			Source:                 hp.TaskScope.Source,
			LatestDeclaredAt:       hp.TaskScope.LatestDeclaredAt,
		}
		input.TaskScope = &scope
		// Lift counts (server only exposes counts for
		// these — detail arrays are not in /loop/health).
		input.PendingBoundaryCount = hp.PendingScopeBoundaries
		input.OutOfScopeEvidenceCount = hp.OutOfScopeEvidence
		input.PendingPermissionCount = hp.PendingPermissions
		input.MemoryCandidateCount = hp.ActiveMemoryCandidates
		break
	}
	return input
}
