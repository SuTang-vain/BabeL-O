// internal/loop/scope_review.go
//
// Phase 6a: pure-data scope + memory review overlay. The
// function combines LoopModel + taskScope + pending boundaries
// + out-of-scope evidence into a line buffer the Bubble Tea
// adapter splices into the `bbl loop` review pane. No I/O,
// no Bubble Tea dependency; Phase 4 status / Phase 5 reconcile
// surface the data; Phase 6a only formats it.

package loop

import "fmt"

// ScopeReviewInput is the data the review pane needs. The
// caller (Phase 6b Bubble Tea adapter or the reconcile
// worker) fetches taskScope / boundaries / evidence from the
// Phase 1b `/v1/runtime/loop/health` endpoint and forwards the
// focused model alongside.
type ScopeReviewInput struct {
	Model         LoopModel
	TaskScope     *LoopTaskScope
	Boundaries    []LoopPendingBoundary
	Evidence      []LoopOutOfScopeEvidence
	MemoryCandidateCount int
}

// LoopTaskScope mirrors the per-pane taskScope summary from
// `/v1/runtime/loop/health`. We re-declare it here so the
// loop package doesn't grow a new dependency on the API
// client; the caller fills it from the health payload.
type LoopTaskScope struct {
	Cwd                    string
	PrimaryRoot            string
	ExplicitRoots          []string
	ConfirmedExternalRoots []string
	InferredCandidateRoots []string
	Mode                   string
	Source                 string
	LatestDeclaredAt       string
}

// LoopPendingBoundary mirrors one entry of taskScope.pendingBoundaries.
type LoopPendingBoundary struct {
	TargetRoot   string
	BoundaryKind string
	ToolName     string
	ToolUseID    string
	Action       string
	Reason       string
	Timestamp    string
}

// LoopOutOfScopeEvidence mirrors one entry of taskScope.outOfScopeEvidence.
type LoopOutOfScopeEvidence struct {
	ToolUseID  string
	ToolName   string
	TargetRoot string
	Reason     string
	Timestamp  string
}

// BuildScopeReviewLines returns the line buffer for the
// review pane overlay. Layout (5 sections):
//
//   1. header:    "Scope review" + workspace id + focused pane id
//   2. scope:     mode, primaryRoot, confirmedExternalRoots count
//   3. pending:   one line per pending boundary (max 5)
//   4. evidence:  out-of-scope evidence count + first sample
//   5. memory:    candidate count + workspace memory hint
//
// Empty sections are omitted so the overlay stays compact.
func BuildScopeReviewLines(input ScopeReviewInput) []string {
	lines := []string{}
	focused, _ := input.Model.FocusedPane()
	workspaceID := ""
	if input.Model.Focus.WorkspaceIdx >= 0 && input.Model.Focus.WorkspaceIdx < len(input.Model.Workspaces) {
		workspaceID = input.Model.Workspaces[input.Model.Focus.WorkspaceIdx].ID
	}
	focusedID := focused.PaneID

	// 1. Header
	header := "Scope review"
	if workspaceID != "" {
		header += " · " + workspaceID
	}
	if focusedID != "" {
		header += " · focused " + focusedID
	}
	lines = append(lines, header)
	driftCount := countDriftPanes(input.Model)
	if driftCount > 0 {
		lines = append(lines, fmt.Sprintf("  %d pane(s) in drift", driftCount))
	}

	// 2. taskScope
	if input.TaskScope != nil {
		lines = append(lines, "task scope")
		lines = append(lines, fmt.Sprintf("  mode=%s primary=%s", input.TaskScope.Mode, input.TaskScope.PrimaryRoot))
		confirmed := len(input.TaskScope.ConfirmedExternalRoots)
		inferred := len(input.TaskScope.InferredCandidateRoots)
		explicit := len(input.TaskScope.ExplicitRoots)
		if explicit+confirmed+inferred > 0 {
			lines = append(lines, fmt.Sprintf("  roots explicit=%d confirmed=%d inferred=%d", explicit, confirmed, inferred))
		}
		if input.TaskScope.LatestDeclaredAt != "" {
			lines = append(lines, "  declared "+input.TaskScope.LatestDeclaredAt)
		}
	}

	// 3. pending boundaries
	if len(input.Boundaries) > 0 {
		lines = append(lines, fmt.Sprintf("pending boundaries (%d)", len(input.Boundaries)))
		limit := len(input.Boundaries)
		if limit > 5 {
			limit = 5
		}
		for _, b := range input.Boundaries[:limit] {
			lines = append(lines, fmt.Sprintf("  - %s target=%s tool=%s action=%s", b.BoundaryKind, b.TargetRoot, b.ToolName, b.Action))
		}
		if len(input.Boundaries) > 5 {
			lines = append(lines, fmt.Sprintf("  ... %d more", len(input.Boundaries)-5))
		}
	}

	// 4. out-of-scope evidence
	if len(input.Evidence) > 0 {
		lines = append(lines, fmt.Sprintf("out-of-scope evidence (%d)", len(input.Evidence)))
		limit := len(input.Evidence)
		if limit > 3 {
			limit = 3
		}
		for _, e := range input.Evidence[:limit] {
			lines = append(lines, fmt.Sprintf("  - %s target=%s tool=%s", e.TargetRoot, e.ToolName, e.ToolUseID))
		}
		if len(input.Evidence) > 3 {
			lines = append(lines, fmt.Sprintf("  ... %d more", len(input.Evidence)-3))
		}
	}

	// 5. memory candidates
	if input.MemoryCandidateCount > 0 {
		lines = append(lines, fmt.Sprintf("memory candidates: %d (use inbox overlay to review)", input.MemoryCandidateCount))
	}

	return lines
}

func countDriftPanes(model LoopModel) int {
	count := 0
	for _, ws := range model.Workspaces {
		for _, tab := range ws.Tabs {
			for _, pane := range tab.Panes {
				if pane.Status == StatusDrift {
					count++
				}
			}
		}
	}
	return count
}
