// internal/loop/status_test.go
//
// Phase 4a status projection tests.

package loop

import "testing"

func TestColorForStatusMatchesPlan(t *testing.T) {
	cases := []struct {
		status PaneStatus
		want   ColorName
	}{
		{StatusIdle, ColorGray},
		{StatusWorking, ColorBlue},
		{StatusBlocked, ColorRed},
		{StatusWaiting, ColorBlue},
		{StatusDrift, ColorAmber},
		{StatusDone, ColorGreen},
		{PaneStatus(99), ColorNone},
	}
	for _, c := range cases {
		if got := ColorForStatus(c.status); got != c.want {
			t.Errorf("ColorForStatus(%v) = %q, want %q", c.status, got, c.want)
		}
	}
}

func TestSymbolForStatusIsMonospace(t *testing.T) {
	statuses := []PaneStatus{StatusIdle, StatusWorking, StatusBlocked, StatusWaiting, StatusDrift, StatusDone}
	for _, s := range statuses {
		sym := SymbolForStatus(s)
		if sym == "" {
			t.Errorf("SymbolForStatus(%v) returned empty", s)
		}
	}
	// All six statuses should produce distinct symbols so the
	// sidebar can show the indicator without color.
	seen := make(map[string]PaneStatus, len(statuses))
	for _, s := range statuses {
		sym := SymbolForStatus(s)
		if other, dup := seen[sym]; dup {
			t.Errorf("SymbolForStatus(%v) = %q collides with %v", s, sym, other)
		}
		seen[sym] = s
	}
}

func TestFormatStatusBadgeShape(t *testing.T) {
	badge := FormatStatusBadge(StatusBlocked)
	if badge.Symbol == "" || badge.Text == "" {
		t.Fatalf("badge missing fields: %+v", badge)
	}
	if badge.Color != ColorRed {
		t.Fatalf("blocked badge color = %q, want red", badge.Color)
	}
}

func TestFormatStatusBadgeLine(t *testing.T) {
	line := FormatStatusBadgeLine(StatusDrift)
	if line == "" {
		t.Fatal("badge line empty")
	}
	// Plain text rendering should not contain ANSI escapes.
	for _, ch := range line {
		if ch == 0x1b {
			t.Fatalf("badge line should not contain ANSI escapes: %q", line)
		}
	}
}

func TestFormatStatusSummaryEmptyModel(t *testing.T) {
	model := NewLoopModel()
	line := FormatStatusSummary(model)
	if line == "" {
		t.Fatal("empty model summary should still produce a line")
	}
	// NewLoopModel has no panes (the default tab is empty) and
	// no focused pane, so the summary reads "0 panes · no
	// attention · focused=(none)".
	wantContains := []string{"0 panes", "no attention", "focused=(none)"}
	for _, want := range wantContains {
		if !containsAll(line, want) {
			t.Errorf("summary missing %q: %q", want, line)
		}
	}
}

func TestFormatStatusSummaryAggregatesAttention(t *testing.T) {
	model := seedPaneModel(80, 24, 0)
	tab := model.Workspaces[0].Tabs[0]
	statuses := []PaneStatus{StatusBlocked, StatusDrift, StatusDrift, StatusWorking, StatusDone}
	for _, s := range statuses {
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
	// Focus the StatusWorking pane (index 3 in the appended
	// order: blocked, drift, drift, working, done).
	model.Focus.PaneIdx = 3
	line := FormatStatusSummary(model)
	wantContains := []string{"5 panes", "1 blocked", "2 drift", "focused=pane-working"}
	for _, want := range wantContains {
		if !containsAll(line, want) {
			t.Errorf("summary missing %q: %q", want, line)
		}
	}
}

func TestFormatInt(t *testing.T) {
	cases := []struct {
		in   int
		want string
	}{
		{0, "0"},
		{1, "1"},
		{9, "9"},
		{10, "10"},
		{123, "123"},
		{1000, "1000"},
	}
	for _, c := range cases {
		if got := formatInt(c.in); got != c.want {
			t.Errorf("formatInt(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

func containsAll(haystack, needle string) bool {
	if needle == "" {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

// PR-17a: StatusBehaviorHint (7th PaneStatus) per behavior-monitor §6.5.2.
// Verified properties:
//   - Color = Amber (matches doc §6.5.2: yellow border for hint)
//   - Symbol is non-empty + distinct from other 6 statuses
//   - String() returns "behavior_hint" (canonical wire form)
//   - Inherits from default (ColorForStatus with PaneStatus(99) = ColorNone)
func TestStatusBehaviorHintProjection(t *testing.T) {
	// Color
	if got := ColorForStatus(StatusBehaviorHint); got != ColorAmber {
		t.Errorf("ColorForStatus(StatusBehaviorHint) = %q, want %q", got, ColorAmber)
	}
	// Symbol non-empty + distinct
	sym := SymbolForStatus(StatusBehaviorHint)
	if sym == "" {
		t.Error("SymbolForStatus(StatusBehaviorHint) returned empty")
	}
	others := map[string]bool{}
	for _, s := range []PaneStatus{StatusIdle, StatusWorking, StatusBlocked, StatusWaiting, StatusDrift, StatusDone} {
		others[SymbolForStatus(s)] = true
	}
	if others[sym] {
		t.Errorf("SymbolForStatus(StatusBehaviorHint) = %q collides with existing", sym)
	}
	// String
	if got := StatusBehaviorHint.String(); got != "behavior_hint" {
		t.Errorf("StatusBehaviorHint.String() = %q, want %q", got, "behavior_hint")
	}
	// Badge shape
	badge := FormatStatusBadge(StatusBehaviorHint)
	if badge.Text != "behavior_hint" {
		t.Errorf("FormatStatusBadge Text = %q, want behavior_hint", badge.Text)
	}
	if badge.Color != ColorAmber {
		t.Errorf("FormatStatusBadge Color = %q, want %q", badge.Color, ColorAmber)
	}
}

// PR-17a: statusFromString accepts both "behaviorHint" (server wire form)
// and "behavior_hint" (legacy snake_case) per health_merge.go update.
func TestStatusFromStringBehaviorHint(t *testing.T) {
	cases := []struct {
		in   string
		want PaneStatus
	}{
		{"behaviorHint", StatusBehaviorHint},
		{"behavior_hint", StatusBehaviorHint},
		{"unknown_status", StatusIdle}, // default fallback
	}
	for _, c := range cases {
		if got := statusFromString(c.in); got != c.want {
			t.Errorf("statusFromString(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
