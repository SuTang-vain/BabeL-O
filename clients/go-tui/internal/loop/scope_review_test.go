// internal/loop/scope_review_test.go
//
// Phase 6a scope review line builder tests.

package loop

import (
	"strings"
	"testing"
)

func TestBuildScopeReviewLinesEmpty(t *testing.T) {
	lines := BuildScopeReviewLines(ScopeReviewInput{Model: NewLoopModel()})
	if len(lines) == 0 {
		t.Fatal("empty input should still produce a header line")
	}
	if !strings.HasPrefix(lines[0], "Scope review") {
		t.Fatalf("header should start with 'Scope review', got %q", lines[0])
	}
}

func TestBuildScopeReviewLinesHeaderIncludesWorkspaceAndFocused(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	model.Focus.PaneIdx = 0
	lines := BuildScopeReviewLines(ScopeReviewInput{Model: model})
	if !strings.Contains(lines[0], "ws-default") {
		t.Fatalf("header should include workspace id, got %q", lines[0])
	}
	if !strings.Contains(lines[0], "focused pane-a") {
		t.Fatalf("header should include focused pane id, got %q", lines[0])
	}
}

func TestBuildScopeReviewLinesTaskScopeSection(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	scope := &LoopTaskScope{
		Mode: "multi_root",
		PrimaryRoot: "/workspace",
		ExplicitRoots: []string{"/tmp/a"},
		ConfirmedExternalRoots: []string{"/external/x", "/external/y"},
		InferredCandidateRoots: []string{"/inferred/z"},
		LatestDeclaredAt: "2026-06-16T00:00:00.000Z",
	}
	lines := BuildScopeReviewLines(ScopeReviewInput{Model: model, TaskScope: scope})
	wantSubstrings := []string{
		"task scope",
		"mode=multi_root primary=/workspace",
		"roots explicit=1 confirmed=2 inferred=1",
		"declared 2026-06-16T00:00:00.000Z",
	}
	for _, want := range wantSubstrings {
		if !anyLineContainsLines(lines, want) {
			t.Errorf("scope review missing %q\nfull:\n%s", want, joinLines(lines))
		}
	}
}

func TestBuildScopeReviewLinesTaskScopeWithoutRoots(t *testing.T) {
	model := NewLoopModel()
	scope := &LoopTaskScope{Mode: "single_root", PrimaryRoot: "/workspace"}
	lines := BuildScopeReviewLines(ScopeReviewInput{Model: model, TaskScope: scope})
	// When no roots are set, the roots sub-line should be omitted
	// (don't print "explicit=0 confirmed=0 inferred=0" noise).
	for _, line := range lines {
		if strings.Contains(line, "roots explicit=") {
			t.Fatalf("expected no roots line when none set, got %q", line)
		}
	}
}

func TestBuildScopeReviewLinesPendingBoundariesTruncated(t *testing.T) {
	model := NewLoopModel()
	boundaries := make([]LoopPendingBoundary, 0, 7)
	for i := 0; i < 7; i++ {
		boundaries = append(boundaries, LoopPendingBoundary{
			BoundaryKind: "sibling_repo",
			TargetRoot:   "/sibling",
			ToolName:     "Bash",
			ToolUseID:    "tool-" + string(rune('a'+i)),
			Action:       "require_confirmation",
		})
	}
	lines := BuildScopeReviewLines(ScopeReviewInput{Model: model, Boundaries: boundaries})
	if !anyLineContainsLines(lines, "pending boundaries (7)") {
		t.Fatalf("expected header to show count=7, full:\n%s", joinLines(lines))
	}
	if !anyLineContainsLines(lines, "... 2 more") {
		t.Fatalf("expected overflow marker, full:\n%s", joinLines(lines))
	}
	// Count detail lines: header + 5 detail + overflow = 7
	detail := 0
	for _, line := range lines {
		if strings.HasPrefix(line, "  - ") {
			detail++
		}
	}
	if detail != 5 {
		t.Fatalf("expected 5 detail lines, got %d:\n%s", detail, joinLines(lines))
	}
}

func TestBuildScopeReviewLinesEvidenceSection(t *testing.T) {
	model := NewLoopModel()
	evidence := []LoopOutOfScopeEvidence{
		{TargetRoot: "/external", ToolName: "Read", ToolUseID: "tool-1"},
		{TargetRoot: "/other", ToolName: "Bash", ToolUseID: "tool-2"},
	}
	lines := BuildScopeReviewLines(ScopeReviewInput{Model: model, Evidence: evidence})
	if !anyLineContainsLines(lines, "out-of-scope evidence (2)") {
		t.Fatalf("expected evidence count, full:\n%s", joinLines(lines))
	}
}

func TestBuildScopeReviewLinesMemoryCandidateHint(t *testing.T) {
	model := NewLoopModel()
	lines := BuildScopeReviewLines(ScopeReviewInput{Model: model, MemoryCandidateCount: 3})
	if !anyLineContainsLines(lines, "memory candidates: 3") {
		t.Fatalf("expected memory candidate count, full:\n%s", joinLines(lines))
	}
	if !anyLineContainsLines(lines, "inbox overlay") {
		t.Fatalf("expected hint to use inbox overlay, full:\n%s", joinLines(lines))
	}
}

func TestBuildScopeReviewLinesDriftPaneCount(t *testing.T) {
	model := seedPaneModel(80, 24, 0)
	tab := model.Workspaces[0].Tabs[0]
	for _, s := range []PaneStatus{StatusWorking, StatusDrift, StatusDrift, StatusDone} {
		updated, err := tab.AddPane(PaneModel{
			PaneID:      "pane-" + s.String(),
			WorkspaceID: model.Workspaces[0].ID,
			TabID:       tab.ID,
			SessionID:   "session-" + s.String(),
			Status:      s,
		})
		if err != nil {
			t.Fatalf("AddPane: %v", err)
		}
		tab = updated
	}
	model.Workspaces[0].Tabs[0] = tab
	lines := BuildScopeReviewLines(ScopeReviewInput{Model: model})
	if !anyLineContainsLines(lines, "2 pane(s) in drift") {
		t.Fatalf("expected drift count = 2, full:\n%s", joinLines(lines))
	}
}

func anyLineContainsLines(lines []string, needle string) bool {
	for _, line := range lines {
		if strings.Contains(line, needle) {
			return true
		}
	}
	return false
}

func joinLines(lines []string) string {
	out := ""
	for _, line := range lines {
		out += line + "\n"
	}
	return out
}
