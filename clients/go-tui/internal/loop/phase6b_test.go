// internal/loop/phase6b_test.go
//
// Phase 6b tests (docs §6'): PaneModel.Transcript + the
// focused-pane body render path. 6b is render-only: it
// consumes whatever TranscriptItem slice is on the pane and
// formats it. Filling the slice is 6c's job.
//
// Two surfaces under test:
//
//  1. BuildTranscriptLines: pure data shaping, no lipgloss.
//  2. renderFocusedPaneBody: the body branch that picks
//     transcript-vs-placeholder and joins the meta line on
//     top.

package loop

import (
	"strings"
	"testing"
)

// TestBuildTranscriptLinesEmptyReturnsNil asserts the empty
// path: when the transcript is empty (the live-TUI default
// until 6c lands), BuildTranscriptLines returns nil so the
// caller can fall back to the placeholder.
func TestBuildTranscriptLinesEmptyReturnsNil(t *testing.T) {
	pane := PaneModel{Transcript: nil}
	if got := BuildTranscriptLines(pane, 40, 10); got != nil {
		t.Fatalf("nil transcript should produce nil lines, got %v", got)
	}
	pane.Transcript = []TranscriptItem{}
	if got := BuildTranscriptLines(pane, 40, 10); got != nil {
		t.Fatalf("empty transcript should produce nil lines, got %v", got)
	}
}

// TestBuildTranscriptLinesNegativeGeometryReturnsNil ensures
// bad callers don't get garbage from the render path.
func TestBuildTranscriptLinesNegativeGeometryReturnsNil(t *testing.T) {
	pane := PaneModel{Transcript: []TranscriptItem{{Role: RoleUser, Text: "hi"}}}
	if got := BuildTranscriptLines(pane, 0, 5); got != nil {
		t.Fatalf("zero width should produce nil lines, got %v", got)
	}
	if got := BuildTranscriptLines(pane, 40, 0); got != nil {
		t.Fatalf("zero height should produce nil lines, got %v", got)
	}
	if got := BuildTranscriptLines(pane, -1, -1); got != nil {
		t.Fatalf("negative geometry should produce nil lines, got %v", got)
	}
}

// TestBuildTranscriptLinesShowsNewestWithinHeight asserts the
// "tail window" behavior: when the transcript is longer than
// the body, the newest items are shown and the older ones are
// dropped. Bottom = latest is what every chat UI does.
func TestBuildTranscriptLinesShowsNewestWithinHeight(t *testing.T) {
	items := []TranscriptItem{
		{Role: RoleUser, Text: "first"},
		{Role: RoleAssistant, Text: "second"},
		{Role: RoleUser, Text: "third"},
		{Role: RoleAssistant, Text: "fourth"},
	}
	pane := PaneModel{Transcript: items}
	lines := BuildTranscriptLines(pane, 40, 2)
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines (height=2), got %d: %q", len(lines), lines)
	}
	if !strings.Contains(lines[0], "third") {
		t.Fatalf("first shown line should be the third item, got %q", lines[0])
	}
	if !strings.Contains(lines[1], "fourth") {
		t.Fatalf("last shown line should be the fourth item, got %q", lines[1])
	}
}

// TestBuildTranscriptLinesAllFitWhenShort asserts the no-
// truncation path: when the transcript is shorter than the
// body's height, every item appears in order.
func TestBuildTranscriptLinesAllFitWhenShort(t *testing.T) {
	items := []TranscriptItem{
		{Role: RoleUser, Text: "alpha"},
		{Role: RoleAssistant, Text: "beta"},
	}
	pane := PaneModel{Transcript: items}
	lines := BuildTranscriptLines(pane, 40, 10)
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d: %q", len(lines), lines)
	}
	if !strings.Contains(lines[0], "alpha") {
		t.Fatalf("first line should contain alpha, got %q", lines[0])
	}
	if !strings.Contains(lines[1], "beta") {
		t.Fatalf("second line should contain beta, got %q", lines[1])
	}
}

// TestBuildTranscriptLinesPrefixAlignsVertically asserts the
// role label column is the same width for every line so the
// body column lines up. "you", "ai", "tool", "sys" all pad
// to transcriptPrefixWidth columns.
func TestBuildTranscriptLinesPrefixAlignsVertically(t *testing.T) {
	items := []TranscriptItem{
		{Role: RoleUser, Text: "hi"},
		{Role: RoleAssistant, Text: "hi"},
		{Role: RoleTool, Text: "hi"},
		{Role: RoleSystem, Text: "hi"},
	}
	pane := PaneModel{Transcript: items}
	lines := BuildTranscriptLines(pane, 40, 10)
	if len(lines) != 4 {
		t.Fatalf("expected 4 lines, got %d", len(lines))
	}
	// Find the column where the body ("hi") starts on every
	// line — they should all agree.
	bodyCols := make([]int, len(lines))
	for i, line := range lines {
		idx := strings.Index(line, "hi")
		if idx < 0 {
			t.Fatalf("line %d should contain body 'hi', got %q", i, line)
		}
		bodyCols[i] = idx
	}
	for i := 1; i < len(bodyCols); i++ {
		if bodyCols[i] != bodyCols[0] {
			t.Fatalf("body column should align vertically: line 0 starts at %d, line %d at %d",
				bodyCols[0], i, bodyCols[i])
		}
	}
}

// TestBuildTranscriptLinesTruncatesLongText asserts the body
// gets ellipsized when it would overflow the column budget.
// This is the guard that prevents a single very long line from
// breaking chrome.go's padOrTruncate contract downstream.
func TestBuildTranscriptLinesTruncatesLongText(t *testing.T) {
	long := strings.Repeat("a", 200)
	pane := PaneModel{Transcript: []TranscriptItem{{Role: RoleUser, Text: long}}}
	lines := BuildTranscriptLines(pane, 30, 1)
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	// Width 30 minus the 6-col prefix = 24 cols of body.
	// 200 raw chars must be truncated to ~24 cols + ellipsis.
	stripped := stripANSIPrefix(lines[0])
	if len(stripped) > 30 {
		t.Fatalf("line should be truncated to 30 cols, got %d: %q", len(stripped), stripped)
	}
	if !strings.Contains(stripped, "…") {
		t.Fatalf("truncated line should contain ellipsis, got %q", stripped)
	}
}

// TestBuildTranscriptRoleString checks every role has a
// non-empty, distinct label — the chrome relies on these
// labels to map back to colors.
func TestBuildTranscriptRoleString(t *testing.T) {
	cases := []struct {
		role TranscriptRole
		want string
	}{
		{RoleUser, "you"},
		{RoleAssistant, "ai"},
		{RoleTool, "tool"},
		{RoleSystem, "sys"},
	}
	seen := make(map[string]bool)
	for _, c := range cases {
		got := c.role.String()
		if got != c.want {
			t.Errorf("Role(%d).String() = %q, want %q", c.role, got, c.want)
		}
		if seen[got] {
			t.Errorf("role label %q is duplicated", got)
		}
		seen[got] = true
	}
}

// TestRenderFocusedPaneBodyPlaceholderWhenTranscriptEmpty
// asserts the fallback path: a pane with a SessionID but no
// Transcript still renders the "waiting for Nexus events" line so
// the operator knows the pane is real. This is the live-TUI
// fallback for a real pane before replayed or live events arrive.
func TestRenderFocusedPaneBodyPlaceholderWhenTranscriptEmpty(t *testing.T) {
	model := NewLoopModel()
	seeded, _ := seedPane(model, PaneModel{
		PaneID:       "pane-empty",
		WorkspaceID:  defaultWSID,
		TabID:        defaultTabID,
		SessionID:    "session-empty",
		Agent:        "bbl",
		Cwd:          "/repo",
		Label:        "main",
		Status:       StatusIdle,
		LastEventRev: 7,
		Transcript:   nil,
	})
	body := renderFocusedPaneBody(seeded, 60, 6)
	if !strings.Contains(body, "session-empty") {
		t.Fatalf("body should show session id, got %q", body)
	}
	if !strings.Contains(body, "rev=7") {
		t.Fatalf("body should show lastRev=7, got %q", body)
	}
	if !strings.Contains(body, "waiting for Nexus events") {
		t.Fatalf("body should fall back to placeholder when transcript is empty, got %q", body)
	}
}

// TestRenderFocusedPaneBodyRendersTranscript is the
// "user can finally see the active session" assertion: when a
// pane has Transcript entries, the body renders them with the
// role prefix; the placeholder is gone.
func TestRenderFocusedPaneBodyRendersTranscript(t *testing.T) {
	model := NewLoopModel()
	seeded, _ := seedPane(model, PaneModel{
		PaneID:       "pane-active",
		WorkspaceID:  defaultWSID,
		TabID:        defaultTabID,
		SessionID:    "session-active",
		Agent:        "bbl",
		Cwd:          "/repo",
		Label:        "main",
		Status:       StatusWorking,
		LastEventRev: 12,
		Transcript: []TranscriptItem{
			{Role: RoleUser, Text: "explain the diff", Rev: 10},
			{Role: RoleAssistant, Text: "this changes X for Y reasons", Rev: 11},
			{Role: RoleTool, Text: "Bash: pytest -q", Rev: 12},
		},
	})
	body := renderFocusedPaneBody(seeded, 60, 6)
	if !strings.Contains(body, "session-active") {
		t.Fatalf("meta line should still show session id, got %q", body)
	}
	if !strings.Contains(body, "explain the diff") {
		t.Fatalf("body should render the user turn, got %q", body)
	}
	if !strings.Contains(body, "this changes X for Y reasons") {
		t.Fatalf("body should render the assistant turn, got %q", body)
	}
	if !strings.Contains(body, "Bash: pytest -q") {
		t.Fatalf("body should render the tool turn, got %q", body)
	}
	if strings.Contains(body, "waiting for Nexus events") {
		t.Fatalf("body should NOT show placeholder when transcript has content, got %q", body)
	}
}

// stripANSIPrefix removes the leading role label + single
// space from a BuildTranscriptLines output, so tests can
// measure the truncated body without counting the role column.
func stripANSIPrefix(line string) string {
	if i := strings.Index(line, " "); i >= 0 {
		return line[i+1:]
	}
	return line
}
