// internal/loop/scope_drift.go
//
// Phase 6d-g: the third overlay (ctrl+d) per plan §4.5 / §6'.
// scope_drift is the operator's "show me every pane that's
// drifting + why" view, distinct from scope_review (which is
// the focused pane's full taskScope / boundaries / evidence /
// memory summary).
//
// What this overlay does:
//   - lists every pane whose status is StatusDrift (and
//     StatusBehaviorHint / StatusBlocked when they have a
//     pending boundary — drift-adjacent states)
//   - each row carries the pane id, label, status pill, and
//     the live counts (pending boundary, out-of-scope
//     evidence) from the most recent health poll
//   - header is fixed ("Scope drift") with a workspace id
//     + the focused pane's id (mirrors scope_review's
//     header contract so the chrome can apply the same
//     style)
//
// What this overlay does NOT do:
//   - render the full taskScope (that's scope_review)
//   - show detail arrays of boundaries / evidence (the
//     live health payload only exposes counts; detail is
//     deferred to a future per-pane expansion)
//   - intercept any decision keys (Enter is a noop; the
//     overlay is informational)

package loop

import (
	"fmt"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// ScopeDriftInput is the data the overlay needs. The
// caller (Phase 6d-g Update path or a future test
// injection) fetches:
//   - the focused pane's health row (for the header
//     focused id and taskScope summary)
//   - the list of all panes whose status indicates drift
//     or a drift-adjacent state (for the rows)
//
// Production code lifts the per-pane health rows from
// `api.LoopHealthResponse`; tests can construct a
// synthetic input directly.
type ScopeDriftInput struct {
	Model     LoopModel
	TaskScope *LoopTaskScope // focused pane's taskScope (for header context)
	// PaneRows is the per-drift-pane slice; one entry per
	// pane the overlay should render. The slice is
	// expected to be in the operator's preferred order
	// (e.g. workspace → tab → pane), but the overlay
	// itself is read-only and doesn't sort.
	PaneRows []ScopeDriftRow
}

// ScopeDriftRow is one pane's drift data.
type ScopeDriftRow struct {
	WorkspaceID             string
	TabID                   string
	PaneID                  string
	Label                   string
	Status                  PaneStatus
	PendingBoundaryCount    int
	OutOfScopeEvidenceCount int
	MemoryCandidateCount    int
}

// BuildScopeDriftLines returns the line buffer for the
// scope_drift overlay. Layout (3 sections):
//
//  1. header: "Scope drift" + workspace id + focused pane
//     id (mirrors scope_review's header contract).
//  2. rows: one line per drift pane, formatted as
//     "  > pane <id> · <label> · <status> · <count> pending
//     · <count> evidence · <count> memory". Empty
//     sections produce a placeholder so the operator
//     knows the overlay is wired but the runtime hasn't
//     reported drift.
//  3. footer hint (rendered by the chrome; not in the
//     line buffer).
//
// Empty / missing data is rendered as a placeholder
// ("no drift reported") so the overlay is always
// meaningful — the operator doesn't have to guess
// whether an empty list means "no drift" or "data
// lagging".
func BuildScopeDriftLines(input ScopeDriftInput) []string {
	lines := []string{}
	// 1. Header.
	workspaceID := ""
	if input.Model.Focus.WorkspaceIdx >= 0 && input.Model.Focus.WorkspaceIdx < len(input.Model.Workspaces) {
		workspaceID = input.Model.Workspaces[input.Model.Focus.WorkspaceIdx].ID
	}
	focusedID := ""
	if focused, ok := input.Model.FocusedPane(); ok {
		focusedID = focused.PaneID
	}
	header := "Scope drift"
	if workspaceID != "" {
		header += " · " + workspaceID
	}
	if focusedID != "" {
		header += " · focused " + focusedID
	}
	lines = append(lines, header)
	if input.TaskScope != nil && input.TaskScope.PrimaryRoot != "" {
		lines = append(lines, fmt.Sprintf("  primary root: %s", input.TaskScope.PrimaryRoot))
	}
	// 2. Rows.
	if len(input.PaneRows) == 0 {
		lines = append(lines, "  no drift reported")
		lines = append(lines, "  (drift = pending scope boundary OR out-of-scope evidence)")
		return lines
	}
	lines = append(lines, fmt.Sprintf("drift panes (%d)", len(input.PaneRows)))
	for _, row := range input.PaneRows {
		label := row.Label
		if label == "" {
			label = row.PaneID
		}
		line := fmt.Sprintf("  - %s · %s · %s",
			row.PaneID, label, row.Status.String())
		// Append counts only when they're non-zero so the
		// line stays short for "clean drift" cases (e.g.
		// a pane that's StatusDrift but has zero
		// boundaries — the status pill is the only signal).
		if row.PendingBoundaryCount > 0 {
			line += fmt.Sprintf(" · %d pending", row.PendingBoundaryCount)
		}
		if row.OutOfScopeEvidenceCount > 0 {
			line += fmt.Sprintf(" · %d evidence", row.OutOfScopeEvidenceCount)
		}
		if row.MemoryCandidateCount > 0 {
			line += fmt.Sprintf(" · %d memory", row.MemoryCandidateCount)
		}
		lines = append(lines, line)
	}
	return lines
}

// CollectDriftPanes walks the model and returns a slice
// of `ScopeDriftRow` for every pane whose status is
// drift-adjacent. "Drift-adjacent" means StatusDrift
// (the primary state) plus StatusBehaviorHint /
// StatusBlocked when the overlay's audience wants to
// know about them — the chrome decides based on the
// signal's character. For the 6d-g first cut, the
// behavior matches plan §2's status machine: drift is
// the dedicated state, and the overlay surfaces it.
//
// The function is pure: it reads the model and returns
// the slice. The caller (production) composes the input
// with the health payload's per-pane counts; tests can
// call BuildScopeDriftLines directly with a synthetic
// ScopeDriftInput.
func CollectDriftPanes(model LoopModel) []ScopeDriftRow {
	rows := []ScopeDriftRow{}
	for _, ws := range model.Workspaces {
		for _, tab := range ws.Tabs {
			for _, pane := range tab.Panes {
				if pane.Status != StatusDrift {
					continue
				}
				rows = append(rows, ScopeDriftRow{
					WorkspaceID: ws.ID,
					TabID:       tab.ID,
					PaneID:      pane.PaneID,
					Label:       pane.Label,
					Status:      pane.Status,
				})
			}
		}
	}
	return rows
}

// BuildScopeDriftInputFromHealth composes a
// `ScopeDriftInput` from a LoopModel + the latest
// health payload. The focused pane's taskScope +
// counts come from the health row matching the
// focused SessionID; the per-pane rows are the
// union of (a) drift panes in the model, lifted
// into ScopeDriftRow with their health counts (b)
// in the response. Falls back to model-only
// information when the health response is missing
// or empty (defensive — overlay should still render
// the model-derived list of drift panes).
func BuildScopeDriftInputFromHealth(model LoopModel, health api.LoopHealthResponse) *ScopeDriftInput {
	input := &ScopeDriftInput{Model: model}
	// Lift focused pane's taskScope.
	if focused, ok := model.FocusedPane(); ok && focused.SessionID != "" {
		for _, hp := range health.Panes {
			if hp.SessionID != focused.SessionID {
				continue
			}
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
			break
		}
	}
	// Build a SessionID → health row index for count lift.
	bySession := make(map[string]api.LoopHealthPane, len(health.Panes))
	for _, hp := range health.Panes {
		if hp.SessionID == "" {
			continue
		}
		bySession[hp.SessionID] = hp
	}
	// Walk the model's drift panes and lift counts when
	// the health response has them.
	for _, row := range CollectDriftPanes(model) {
		// The model pane has its SessionID; look up
		// health by the same key.
		for _, ws := range model.Workspaces {
			for _, tab := range ws.Tabs {
				for _, pane := range tab.Panes {
					if pane.PaneID != row.PaneID {
						continue
					}
					if hp, ok := bySession[pane.SessionID]; ok {
						row.PendingBoundaryCount = hp.PendingScopeBoundaries
						row.OutOfScopeEvidenceCount = hp.OutOfScopeEvidence
						row.MemoryCandidateCount = hp.ActiveMemoryCandidates
					}
					input.PaneRows = append(input.PaneRows, row)
				}
			}
		}
	}
	return input
}
