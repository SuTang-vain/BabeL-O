// internal/loop/loop_test.go
//
// Phase 2a: smoke tests for cmd/bbl-loop's entry-point skeleton.
// Pure white-box coverage of the package-level plumbing; the
// full LoopModel / API client land in Phase 2b / 2c.

package loop

import (
	"bytes"
	"strings"
	"testing"
)

func TestVersionString(t *testing.T) {
	got := VersionString()
	if !strings.HasPrefix(got, "bbl loop ") {
		t.Fatalf("VersionString() = %q, want prefix %q", got, "bbl loop ")
	}
}

func TestRunSmokePrintsConfigAndDoesNotError(t *testing.T) {
	var buf bytes.Buffer
	cfg := Config{
		BaseURL:        "http://127.0.0.1:3000",
		Cwd:            "/tmp",
		WorkspaceID:    "ws-test",
		StatePath:      "/tmp/bbl-loop-state.json",
		PollIntervalMs: 1000,
		WaitTimeoutMs:  500,
		AltScreen:      true,
		MouseCapture:   true,
	}
	if err := runSmoke(cfg, &buf); err != nil {
		t.Fatalf("runSmoke: %v", err)
	}
	out := buf.String()
	wantSubstrings := []string{
		"bbl loop " + Version,
		"url=http://127.0.0.1:3000",
		"cwd=/tmp",
		"workspace=ws-test",
		"state=/tmp/bbl-loop-state.json",
		"pollIntervalMs=1000",
		"waitTimeoutMs=500",
		"altScreen=true",
		"mouse=true",
	}
	for _, want := range wantSubstrings {
		if !strings.Contains(out, want) {
			t.Fatalf("runSmoke output missing %q\nfull:\n%s", want, out)
		}
	}
}

func TestRunSmokeFallsBackWhenHomeUnset(t *testing.T) {
	t.Setenv("HOME", "")
	got := defaultStatePath()
	if got == "" {
		t.Fatalf("defaultStatePath() = empty when HOME is unset")
	}
	if !strings.Contains(got, "bbl-loop-state.json") {
		t.Fatalf("defaultStatePath() = %q, want path containing bbl-loop-state.json", got)
	}
}

func TestRunSmokeUsesStatePathOverride(t *testing.T) {
	var buf bytes.Buffer
	cfg := Config{
		BaseURL:     "http://127.0.0.1:3000",
		Cwd:         "/tmp",
		WorkspaceID: "ws-test",
		StatePath:   "/custom/state.json",
	}
	if err := runSmoke(cfg, &buf); err != nil {
		t.Fatalf("runSmoke: %v", err)
	}
	if !strings.Contains(buf.String(), "state=/custom/state.json") {
		t.Fatalf("expected override path in output, got:\n%s", buf.String())
	}
}

func TestPaneStatusString(t *testing.T) {
	cases := []struct {
		status PaneStatus
		want   string
	}{
		{StatusIdle, "idle"},
		{StatusWorking, "working"},
		{StatusBlocked, "blocked"},
		{StatusWaiting, "waiting"},
		{StatusDrift, "drift"},
		{StatusDone, "done"},
		{PaneStatus(99), "unknown(99)"},
	}
	for _, c := range cases {
		if got := c.status.String(); got != c.want {
			t.Errorf("PaneStatus(%d).String() = %q, want %q", c.status, got, c.want)
		}
	}
}

func TestNewIDReturnsPrefixedHex(t *testing.T) {
	id := NewID("pane")
	if !strings.HasPrefix(id, "pane-") {
		t.Fatalf("NewID(\"pane\") = %q, want prefix pane-", id)
	}
	if len(id) != len("pane-")+16 {
		t.Fatalf("NewID(\"pane\") = %q, want 16 hex chars", id)
	}
	if NewID("ws") == NewID("ws") {
		t.Fatalf("NewID must produce unique ids")
	}
}

func TestNewWorkspaceProvidesDefaultTab(t *testing.T) {
	ws := NewWorkspace("", "BabeL-O")
	if ws.ID == "" {
		t.Fatalf("NewWorkspace should auto-generate id")
	}
	if len(ws.Tabs) != 1 {
		t.Fatalf("NewWorkspace should provide one default tab, got %d", len(ws.Tabs))
	}
	if ws.Tabs[0].Label != "main" {
		t.Fatalf("default tab label = %q, want main", ws.Tabs[0].Label)
	}
}

func TestAddTabGeneratesTabIDs(t *testing.T) {
	ws := NewWorkspace("ws-1", "ops")
	ws = ws.AddTab("logs")
	ws = ws.AddTab("")
	if len(ws.Tabs) != 3 {
		t.Fatalf("expected 3 tabs, got %d", len(ws.Tabs))
	}
	if ws.Tabs[0].ID != "ws-1:1" {
		t.Fatalf("first tab id = %q, want ws-1:1", ws.Tabs[0].ID)
	}
	if ws.Tabs[1].ID != "ws-1:2" {
		t.Fatalf("second tab id = %q, want ws-1:2", ws.Tabs[1].ID)
	}
	if ws.Tabs[2].ID != "ws-1:3" {
		t.Fatalf("third tab id = %q, want ws-1:3", ws.Tabs[2].ID)
	}
	if ws.Tabs[2].Label != "tab-3" {
		t.Fatalf("default tab label = %q, want tab-3", ws.Tabs[2].Label)
	}
}

func TestAddPaneRejectsInvalidPanes(t *testing.T) {
	tab := Tab{ID: "ws-1:1", Label: "main"}
	if _, err := tab.AddPane(PaneModel{
		SessionID:   "session-1",
		WorkspaceID: "ws-1",
		TabID:       "ws-1:1",
	}); err == nil {
		t.Fatalf("AddPane without PaneID should error")
	}
	if _, err := tab.AddPane(PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: "ws-1",
		TabID:       "ws-1:1",
	}); err == nil {
		t.Fatalf("AddPane without SessionID should error")
	}
	if _, err := tab.AddPane(PaneModel{
		PaneID:      "pane-1",
		SessionID:   "session-1",
		WorkspaceID: "ws-other",
		TabID:       "ws-1:1",
	}); err == nil {
		t.Fatalf("AddPane with mismatched workspaceId should error")
	}
}

func TestNewLoopModelHasDefaultWorkspaceAndTab(t *testing.T) {
	m := NewLoopModel()
	if err := m.AssertInvariantsForTest(); err != nil {
		t.Fatalf("NewLoopModel invariants: %v", err)
	}
	if _, ok := m.FocusedPane(); ok {
		t.Fatalf("FocusedPane should not resolve for default LoopModel (no panes)")
	}
	if m.Focus.WorkspaceIdx != 0 || m.Focus.TabIdx != 0 || m.Focus.PaneIdx != 0 {
		t.Fatalf("default focus = %+v, want all zero", m.Focus)
	}
}

func TestPaneAtBoundsChecking(t *testing.T) {
	m := NewLoopModel()
	if _, ok := m.PaneAt(-1, 0, 0); ok {
		t.Fatalf("PaneAt(-1,0,0) should be ok=false")
	}
	if _, ok := m.PaneAt(0, -1, 0); ok {
		t.Fatalf("PaneAt(0,-1,0) should be ok=false")
	}
	if _, ok := m.PaneAt(0, 0, -1); ok {
		t.Fatalf("PaneAt(0,0,-1) should be ok=false")
	}
	if _, ok := m.PaneAt(99, 0, 0); ok {
		t.Fatalf("PaneAt(99,0,0) should be ok=false")
	}
}

func TestAddPaneAndInvariants(t *testing.T) {
	m := NewLoopModel()
	tab := m.Workspaces[0].Tabs[0]
	updated, err := tab.AddPane(PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: m.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   "session-1",
		Cwd:         "/tmp",
		Agent:       "bbl",
		Status:      StatusWorking,
	})
	if err != nil {
		t.Fatalf("AddPane: %v", err)
	}
	m.Workspaces[0].Tabs[0] = updated
	if err := m.AssertInvariantsForTest(); err != nil {
		t.Fatalf("invariants after AddPane: %v", err)
	}
	pane, ok := m.PaneAt(0, 0, 0)
	if !ok {
		t.Fatalf("PaneAt(0,0,0) should resolve after AddPane")
	}
	if pane.PaneID != "pane-1" || pane.Status != StatusWorking {
		t.Fatalf("pane = %+v", pane)
	}
}

func TestAssertInvariantsForTestRejectsBadModel(t *testing.T) {
	m := NewLoopModel()
	m.Workspaces[0].Tabs[0].Panes = []PaneModel{
		{PaneID: "pane-x", WorkspaceID: "ws-other", TabID: "ws-default:1", SessionID: "session-1"},
	}
	if err := m.AssertInvariantsForTest(); err == nil {
		t.Fatalf("expected invariant violation when pane workspaceId mismatches parent")
	}
}

func TestSetFocusClampsAndResolves(t *testing.T) {
	m := NewLoopModel()
	tab := m.Workspaces[0].Tabs[0]
	updated, err := tab.AddPane(PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: m.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   "session-1",
	})
	if err != nil {
		t.Fatalf("AddPane: %v", err)
	}
	m.Workspaces[0].Tabs[0] = updated
	m = m.SetFocus(0, 0, 0)
	if m.Focus.PaneIdx != 0 {
		t.Fatalf("SetFocus(0,0,0) = %+v", m.Focus)
	}
	m = m.SetFocus(0, 0, 99)
	if m.Focus.PaneIdx != 0 {
		t.Fatalf("SetFocus should clamp overflow, got %+v", m.Focus)
	}
	m = m.SetFocus(99, 0, 0)
	if m.Focus.WorkspaceIdx != 0 {
		t.Fatalf("SetFocus should clamp workspace overflow, got %+v", m.Focus)
	}
}

func TestLoopModelStringIsCompact(t *testing.T) {
	m := NewLoopModel()
	s := m.String()
	if !strings.HasPrefix(s, "loop(") {
		t.Fatalf("LoopModel.String() = %q, want prefix loop(", s)
	}
}
