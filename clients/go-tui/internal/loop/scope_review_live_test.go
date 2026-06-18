// internal/loop/scope_review_live_test.go
//
// Phase 6d-e tests: the scope_review overlay's data
// bundle is now auto-populated from /v1/runtime/loop/health
// responses by handleHealthDone. This file covers the
// production wire path: BuildScopeReviewInputFromHealth +
// the count-fallback lines in BuildScopeReviewLines (live
// data has only counts, not detail arrays).
//
// What this file covers:
//   - BuildScopeReviewInputFromHealth picks the focused
//     pane by SessionID
//   - field-copies the full taskScope (server returns the
//     struct, not a count)
//   - lifts PendingScopeBoundaries / OutOfScopeEvidence /
//     PendingPermissions / ActiveMemoryCandidates counts
//   - returns a non-nil header-only input when the focused
//     pane has no health match (early startup / health lag)
//   - returns nil only when there is no focused pane
//   - BuildScopeReviewLines renders the count-fallback
//     lines for live data
//   - count fallback is suppressed when the detail array
//     is also set (array wins)
//
// What this file does NOT cover:
//   - handleHealthDone integration (scope_review_live_integration_test.go)
//   - chrome overlay rendering with live data
//     (overlay_splice_test.go covers placeholder +
//     injected-data paths)

package loop

import (
	"strings"
	"testing"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// TestBuildScopeReviewInputFromHealthPicksFocusedPane:
// when the health response has multiple panes, only the
// one matching the focused pane's SessionID is lifted
// into the ScopeReviewInput.
func TestBuildScopeReviewInputFromHealthPicksFocusedPane(t *testing.T) {
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 1},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID: defaultTabID,
				Label: "main",
				Panes: []PaneModel{
					{
						PaneID: "pane-other", WorkspaceID: defaultWSID, TabID: defaultTabID,
						SessionID: "session-other", Agent: "bbl", Label: "other", Status: StatusIdle,
					},
					{
						PaneID: "pane-focused", WorkspaceID: defaultWSID, TabID: defaultTabID,
						SessionID: "session-focused", Agent: "bbl", Label: "focused", Status: StatusWorking,
					},
				},
			}},
		}},
	}, PaneModel{})

	health := api.LoopHealthResponse{
		Type: "loop_health",
		Panes: []api.LoopHealthPane{
			{
				SessionID: "session-other", Status: "idle",
				TaskScope: api.LoopTaskScope{Mode: "single_root", PrimaryRoot: "/other"},
			},
			{
				SessionID: "session-focused", Status: "working",
				PendingScopeBoundaries: 2,
				OutOfScopeEvidence:     1,
				PendingPermissions:     1,
				ActiveMemoryCandidates: 3,
				TaskScope: api.LoopTaskScope{
					Mode: "multi_root", PrimaryRoot: "/workspace",
					ConfirmedExternalRoots: []string{"/external/x"},
				},
			},
		},
	}

	in := BuildScopeReviewInputFromHealth(seeded, health)
	if in == nil {
		t.Fatal("BuildScopeReviewInputFromHealth returned nil for a model with a focused pane")
	}
	if in.TaskScope == nil {
		t.Fatal("TaskScope should be lifted from the focused pane's health row")
	}
	if in.TaskScope.Mode != "multi_root" {
		t.Errorf("TaskScope.Mode = %q, want multi_root", in.TaskScope.Mode)
	}
	if in.TaskScope.PrimaryRoot != "/workspace" {
		t.Errorf("TaskScope.PrimaryRoot = %q, want /workspace", in.TaskScope.PrimaryRoot)
	}
	if got := len(in.TaskScope.ConfirmedExternalRoots); got != 1 {
		t.Errorf("ConfirmedExternalRoots len = %d, want 1", got)
	}
	if in.PendingBoundaryCount != 2 {
		t.Errorf("PendingBoundaryCount = %d, want 2", in.PendingBoundaryCount)
	}
	if in.OutOfScopeEvidenceCount != 1 {
		t.Errorf("OutOfScopeEvidenceCount = %d, want 1", in.OutOfScopeEvidenceCount)
	}
	if in.PendingPermissionCount != 1 {
		t.Errorf("PendingPermissionCount = %d, want 1", in.PendingPermissionCount)
	}
	if in.MemoryCandidateCount != 3 {
		t.Errorf("MemoryCandidateCount = %d, want 3", in.MemoryCandidateCount)
	}
}

// TestBuildScopeReviewInputFromHealthMissingHealthRow:
// when the focused pane's SessionID has no match in the
// health payload (e.g. health is lagging behind a
// newly-attached session), the input is non-nil but
// carries no TaskScope / counts. The overlay should
// still render a header + drift count from the model.
func TestBuildScopeReviewInputFromHealthMissingHealthRow(t *testing.T) {
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID:    defaultTabID,
				Label: "main",
				Panes: []PaneModel{{
					PaneID: "pane-fresh", WorkspaceID: defaultWSID, TabID: defaultTabID,
					SessionID: "session-just-attached", Agent: "bbl", Label: "fresh", Status: StatusIdle,
				}},
			}},
		}},
	}, PaneModel{})

	health := api.LoopHealthResponse{
		Type: "loop_health",
		// Health response has a different session — the
		// focused pane's session isn't there yet.
		Panes: []api.LoopHealthPane{
			{SessionID: "session-other", Status: "idle"},
		},
	}

	in := BuildScopeReviewInputFromHealth(seeded, health)
	if in == nil {
		t.Fatal("input should be non-nil even with no health match (header-only fallback)")
	}
	if in.TaskScope != nil {
		t.Error("TaskScope should be nil when no health row matches")
	}
	if in.PendingBoundaryCount != 0 || in.OutOfScopeEvidenceCount != 0 ||
		in.PendingPermissionCount != 0 || in.MemoryCandidateCount != 0 {
		t.Error("counts should be zero when no health row matches")
	}
}

// TestBuildScopeReviewInputFromHealthFocusedWithoutSession:
// a focused pane without a SessionID (just attached,
// waiting for /v1/execute response) returns a non-nil
// input — the overlay can still render its header.
func TestBuildScopeReviewInputFromHealthFocusedWithoutSession(t *testing.T) {
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID:    defaultTabID,
				Label: "main",
				Panes: []PaneModel{{
					PaneID: "pane-empty", WorkspaceID: defaultWSID, TabID: defaultTabID,
					// SessionID intentionally empty.
					Agent: "bbl", Label: "empty", Status: StatusIdle,
				}},
			}},
		}},
	}, PaneModel{})

	in := BuildScopeReviewInputFromHealth(seeded, api.LoopHealthResponse{Type: "loop_health"})
	if in == nil {
		t.Fatal("input should be non-nil even with empty SessionID")
	}
	if in.TaskScope != nil {
		t.Error("TaskScope should be nil when focused pane has no SessionID")
	}
}

// TestBuildScopeReviewInputFromHealthNoFocusedPane: an
// empty model (no focused pane) returns nil so the
// caller can short-circuit.
func TestBuildScopeReviewInputFromHealthNoFocusedPane(t *testing.T) {
	empty := NewLoopModel()
	in := BuildScopeReviewInputFromHealth(empty, api.LoopHealthResponse{Type: "loop_health"})
	if in != nil {
		t.Errorf("expected nil for model without focused pane, got %+v", in)
	}
}

// TestBuildScopeReviewLinesCountFallback: when only the
// count fields are set (live from /v1/runtime/loop/health)
// the renderer still surfaces the drift signal.
func TestBuildScopeReviewLinesCountFallback(t *testing.T) {
	model := NewLoopModel()
	in := ScopeReviewInput{
		Model:                    model,
		PendingBoundaryCount:     4,
		OutOfScopeEvidenceCount:  2,
		PendingPermissionCount:   1,
		MemoryCandidateCount:     5,
	}
	lines := BuildScopeReviewLines(in)
	wantSubstrings := []string{
		"pending boundaries: 4",
		"out-of-scope evidence: 2",
		"pending permissions: 1",
		"memory candidates: 5",
	}
	for _, want := range wantSubstrings {
		if !anyLineContainsLines(lines, want) {
			t.Errorf("count fallback line missing %q\nfull:\n%s", want, joinLines(lines))
		}
	}
}

// TestBuildScopeReviewLinesArrayWinsOverCount: when
// both the detail array and the count are set, the array
// is rendered (richer). This protects the contract that
// the live count path and the synthetic detail array
// path don't both fire and produce duplicate lines.
func TestBuildScopeReviewLinesArrayWinsOverCount(t *testing.T) {
	model := NewLoopModel()
	in := ScopeReviewInput{
		Model: model,
		Boundaries: []LoopPendingBoundary{{
			BoundaryKind: "sibling_repo", TargetRoot: "/sib",
			ToolName: "Bash", Action: "require_confirmation",
		}},
		PendingBoundaryCount: 7, // count higher than array — array should win
	}
	lines := BuildScopeReviewLines(in)
	if !anyLineContainsLines(lines, "pending boundaries (1)") {
		t.Errorf("array line should be rendered, got:\n%s", joinLines(lines))
	}
	if anyLineContainsLines(lines, "pending boundaries: 7") {
		t.Errorf("count fallback should NOT be rendered when array is non-empty, got:\n%s", joinLines(lines))
	}
	if anyLineContainsLines(lines, "live from health") {
		t.Errorf("'live from health' marker should NOT be rendered when array is non-empty, got:\n%s", joinLines(lines))
	}
}

// TestBuildScopeReviewInputFromHealthEmptyHealth:
// an empty health response returns a non-nil header-only
// input (defensive — the operator can still open the
// overlay and see "no scope data" / drift count from
// the model).
func TestBuildScopeReviewInputFromHealthEmptyHealth(t *testing.T) {
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID: defaultTabID,
				Label: "main",
				Panes: []PaneModel{{
					PaneID: "pane-1", WorkspaceID: defaultWSID, TabID: defaultTabID,
					SessionID: "session-1", Agent: "bbl", Label: "main", Status: StatusWorking,
				}},
			}},
		}},
	}, PaneModel{})

	in := BuildScopeReviewInputFromHealth(seeded, api.LoopHealthResponse{Type: "loop_health"})
	if in == nil {
		t.Fatal("input should be non-nil for empty health response")
	}
	if in.TaskScope != nil {
		t.Error("TaskScope should be nil for empty health response")
	}
	if !strings.HasPrefix(BuildScopeReviewLines(*in)[0], "Scope review") {
		t.Error("overlay header should still render for empty health response")
	}
}
