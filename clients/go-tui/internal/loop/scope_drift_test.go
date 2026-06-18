// internal/loop/scope_drift_test.go
//
// Phase 6d-g tests: scope_drift overlay (plan §4.5 / §6'
// — the third overlay, ctrl+d). Two layers of coverage:
//
//  1. Pure-data: BuildScopeDriftLines renders the header
//     + drift-pane list with the right shape; placeholder
//     shows when no rows.
//  2. Bridge: BuildScopeDriftInputFromHealth picks the
//     focused pane's taskScope and lifts per-pane
//     counts from the health response.
//  3. Interactive: ctrl+d toggles scopeDriftOpen; dismiss
//     keys (esc/q/ctrl+c) close it; cross-overlay
//     fall-through works (operator can open pane_list /
//     scope_review / help on top of scope_drift); the
//     chrome's View() includes the drift panel header.
//
// What this file does NOT cover:
//   - BuildScopeDriftInputFromHealth integration with a
//     real /v1/runtime/loop/health mock — that's covered
//     by the chrome-side TestScopeDriftOverlayShowsLiveData
//     (with a SetHealthForDriftForTest injection).

package loop

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// TestBuildScopeDriftLinesEmpty: when no drift panes are
// reported, the overlay shows a header + "no drift
// reported" placeholder. The operator can distinguish
// "no drift" from "data lagging" via the next-line hint
// "(drift = pending scope boundary OR out-of-scope
// evidence)".
func TestBuildScopeDriftLinesEmpty(t *testing.T) {
	lines := BuildScopeDriftLines(ScopeDriftInput{Model: NewLoopModel()})
	if len(lines) == 0 {
		t.Fatal("empty input should still produce at least the header line")
	}
	if !strings.HasPrefix(lines[0], "Scope drift") {
		t.Fatalf("first line should be the header, got %q", lines[0])
	}
	if !anyLineContainsLines(lines, "no drift reported") {
		t.Errorf("expected 'no drift reported' placeholder, got:\n%s", joinLines(lines))
	}
}

// TestBuildScopeDriftLinesWithTaskScope: when the input
// carries a focused-pane taskScope, the header line gets
// a `primary root: ...` sub-line for context. Mirrors
// scope_review's primary-root visibility.
func TestBuildScopeDriftLinesWithTaskScope(t *testing.T) {
	in := ScopeDriftInput{
		Model: NewLoopModel(),
		TaskScope: &LoopTaskScope{
			Mode:        "multi_root",
			PrimaryRoot: "/workspace",
		},
	}
	lines := BuildScopeDriftLines(in)
	if !anyLineContainsLines(lines, "primary root: /workspace") {
		t.Errorf("expected primary root sub-line, got:\n%s", joinLines(lines))
	}
}

// TestBuildScopeDriftLinesRows: when the input carries
// drift rows, each row is rendered with id, label, status,
// and the per-pane counts (only when non-zero so a
// "clean drift" line stays short).
func TestBuildScopeDriftLinesRows(t *testing.T) {
	in := ScopeDriftInput{
		Model: NewLoopModel(),
		PaneRows: []ScopeDriftRow{
			{
				PaneID: "pane-a", Label: "alpha", Status: StatusDrift,
				PendingBoundaryCount: 2, OutOfScopeEvidenceCount: 1,
				MemoryCandidateCount: 3,
			},
			{
				PaneID: "pane-b", Label: "beta", Status: StatusDrift,
				// All counts zero — line should be short
				// (no count suffix).
			},
		},
	}
	lines := BuildScopeDriftLines(in)
	wantSubstrings := []string{
		"drift panes (2)",
		"pane-a", "alpha", "2 pending", "1 evidence", "3 memory",
		"pane-b", "beta",
	}
	for _, want := range wantSubstrings {
		if !anyLineContainsLines(lines, want) {
			t.Errorf("missing %q in lines:\n%s", want, joinLines(lines))
		}
	}
	// The "clean drift" row should not have any count
	// suffix. Find the line for pane-b and assert it
	// doesn't contain "pending" or "evidence".
	for _, line := range lines {
		if strings.Contains(line, "pane-b") {
			if strings.Contains(line, "pending") || strings.Contains(line, "evidence") {
				t.Errorf("pane-b line should NOT contain count suffixes when counts are zero, got %q", line)
			}
		}
	}
}

// TestBuildScopeDriftLinesHeaderIncludesWorkspaceAndFocused:
// the header line carries the workspace id and focused
// pane id (mirrors scope_review's contract).
func TestBuildScopeDriftLinesHeaderIncludesWorkspaceAndFocused(t *testing.T) {
	model := seedPaneModel(80, 24, 1)
	model.Focus.PaneIdx = 0
	lines := BuildScopeDriftLines(ScopeDriftInput{Model: model})
	if !strings.Contains(lines[0], "ws-default") {
		t.Errorf("header should include workspace id, got %q", lines[0])
	}
	if !strings.Contains(lines[0], "focused pane-a") {
		t.Errorf("header should include focused pane id, got %q", lines[0])
	}
}

// TestCollectDriftPanes: the helper walks the model and
// returns one ScopeDriftRow per StatusDrift pane. Non-drift
// panes are skipped.
func TestCollectDriftPanes(t *testing.T) {
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID: defaultTabID,
				Label: "main",
			}},
		}},
	}, PaneModel{
		PaneID: "pane-drift", WorkspaceID: defaultWSID, TabID: defaultTabID,
		SessionID: "session-drift", Agent: "bbl", Label: "drift", Status: StatusDrift,
	})
	seeded, _ = ApplyNewPane(seeded, NewPaneSeed{
		PaneID: "pane-idle", WorkspaceID: defaultWSID, TabID: defaultTabID,
		SessionID: "session-idle", Agent: "bbl", Label: "idle",
	})
	// Force the new pane to StatusIdle (ApplyNewPane may
	// default to something else).
	driftPane, _ := seeded.PaneAt(0, 0, 0)
	driftPane.Status = StatusDrift
	idlePane, _ := seeded.PaneAt(0, 0, 1)
	idlePane.Status = StatusIdle
	tab := seeded.Workspaces[0].Tabs[0]
	tab.Panes[0] = driftPane
	tab.Panes[1] = idlePane
	seeded.Workspaces[0].Tabs[0] = tab

	rows := CollectDriftPanes(seeded)
	if len(rows) != 1 {
		t.Fatalf("expected 1 drift row, got %d", len(rows))
	}
	if rows[0].PaneID != "pane-drift" {
		t.Errorf("expected pane-drift, got %q", rows[0].PaneID)
	}
	if rows[0].Status != StatusDrift {
		t.Errorf("expected StatusDrift, got %v", rows[0].Status)
	}
}

// TestBuildScopeDriftInputFromHealth: the bridge
// function picks the focused pane's taskScope from the
// health response and lifts per-pane counts onto the
// matching drift rows.
func TestBuildScopeDriftInputFromHealth(t *testing.T) {
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID: defaultTabID, Label: "main",
				Panes: []PaneModel{{
					PaneID: "pane-drift", WorkspaceID: defaultWSID, TabID: defaultTabID,
					SessionID: "session-drift", Agent: "bbl", Label: "drift", Status: StatusDrift,
				}},
			}},
		}},
	}, PaneModel{})

	health := api.LoopHealthResponse{
		Type: "loop_health",
		Panes: []api.LoopHealthPane{{
			SessionID: "session-drift", Status: "drift",
			PendingScopeBoundaries: 4, OutOfScopeEvidence: 1,
			ActiveMemoryCandidates: 2,
			TaskScope: api.LoopTaskScope{Mode: "multi_root", PrimaryRoot: "/workspace"},
		}},
	}

	in := BuildScopeDriftInputFromHealth(seeded, health)
	if in == nil {
		t.Fatal("BuildScopeDriftInputFromHealth returned nil")
	}
	if in.TaskScope == nil {
		t.Fatal("expected focused pane's taskScope to be lifted")
	}
	if in.TaskScope.Mode != "multi_root" {
		t.Errorf("TaskScope.Mode = %q, want multi_root", in.TaskScope.Mode)
	}
	if len(in.PaneRows) != 1 {
		t.Fatalf("expected 1 drift row, got %d", len(in.PaneRows))
	}
	row := in.PaneRows[0]
	if row.PendingBoundaryCount != 4 {
		t.Errorf("PendingBoundaryCount = %d, want 4", row.PendingBoundaryCount)
	}
	if row.OutOfScopeEvidenceCount != 1 {
		t.Errorf("OutOfScopeEvidenceCount = %d, want 1", row.OutOfScopeEvidenceCount)
	}
	if row.MemoryCandidateCount != 2 {
		t.Errorf("MemoryCandidateCount = %d, want 2", row.MemoryCandidateCount)
	}
}

// TestBuildScopeDriftInputFromHealthNoFocusedMatch: when
// the focused pane's SessionID has no health row, the
// taskScope is nil and rows carry zero counts (defensive
// — overlay should still render model-only data).
func TestBuildScopeDriftInputFromHealthNoFocusedMatch(t *testing.T) {
	seeded, _ := seedPane(LoopModel{
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		Workspaces: []Workspace{{
			ID: defaultWSID,
			Tabs: []Tab{{
				ID: defaultTabID, Label: "main",
				Panes: []PaneModel{{
					PaneID: "pane-1", WorkspaceID: defaultWSID, TabID: defaultTabID,
					SessionID: "session-no-health", Agent: "bbl", Label: "main", Status: StatusIdle,
				}},
			}},
		}},
	}, PaneModel{})

	in := BuildScopeDriftInputFromHealth(seeded, api.LoopHealthResponse{Type: "loop_health"})
	if in == nil {
		t.Fatal("expected non-nil input")
	}
	if in.TaskScope != nil {
		t.Error("expected nil TaskScope when no health match")
	}
}

// TestCtrlDOpensScopeDriftOverlay: pressing ctrl+d flips
// scopeDriftOpen and the chrome's View() shows the
// drift panel header.
func TestCtrlDOpensScopeDriftOverlay(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	newModel := updated.(InteractiveModel)
	if !newModel.scopeDriftOpen {
		t.Fatal("ctrl+d should set scopeDriftOpen")
	}
	body := newModel.View().Content
	if !strings.Contains(stripANSI(body), "bbl loop · scope drift") {
		t.Errorf("View should contain scope drift header, got:\n%s", stripANSI(body))
	}
}

// TestCtrlDAgainClosesScopeDriftOverlay: the toggle key
// is also a dismiss key (mirrors ctrl+j / ctrl+r).
func TestCtrlDAgainClosesScopeDriftOverlay(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	updated, _ = updated.(InteractiveModel).Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	newModel := updated.(InteractiveModel)
	if newModel.scopeDriftOpen {
		t.Fatal("second ctrl+d should close")
	}
}

// TestEscClosesScopeDriftOverlay: the standard dismiss
// key works for the drift overlay too.
func TestEscClosesScopeDriftOverlay(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	updated, _ = updated.(InteractiveModel).Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	newModel := updated.(InteractiveModel)
	if newModel.scopeDriftOpen {
		t.Fatal("esc should close scope drift overlay")
	}
}

// TestRandomKeysAbsorbedWhileScopeDriftOpen: any
// non-dismiss key while the overlay is up is swallowed.
// Mirrors the help / pane_list / scope_review overlay
// contract.
func TestRandomKeysAbsorbedWhileScopeDriftOpen(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	updated, cmd := updated.(InteractiveModel).Update(tea.KeyPressMsg{Code: 'a', Text: "a"})
	if cmd != nil {
		t.Errorf("random key during overlay should be swallowed, got cmd %T", cmd)
	}
}

// TestScopeDriftOverlayCrossOpenOtherOverlays: when
// scope_drift is open, the operator can press ctrl+j /
// ctrl+r / ? to layer pane_list / scope_review / help
// on top — they should all open without dismissing
// scope_drift first.
func TestScopeDriftOverlayCrossOpenOtherOverlays(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	updated, _ = updated.(InteractiveModel).Update(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})
	updated, _ = updated.(InteractiveModel).Update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	updated, _ = updated.(InteractiveModel).Update(tea.KeyPressMsg{Code: '?'})
	newModel := updated.(InteractiveModel)
	if !newModel.scopeDriftOpen {
		t.Error("scope_drift should stay open after layering other overlays")
	}
	if !newModel.scopeReviewOpen {
		t.Error("ctrl+r should open scope_review on top of scope_drift")
	}
	if !newModel.paneListOpen {
		t.Error("ctrl+j should open pane_list on top of scope_drift")
	}
	if !newModel.helpOpen {
		t.Error("? should open help on top of scope_drift")
	}
}

// TestScopeDriftOverlayShowsLiveData: when the model
// has a drift pane and the test setter has injected a
// matching health response, the chrome's View() shows
// the live counts (per-pane pending / evidence).
func TestScopeDriftOverlayShowsLiveData(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	seeded, _ := seedPane(im.loop, PaneModel{
		PaneID: "pane-drift", WorkspaceID: defaultWSID, TabID: defaultTabID,
		SessionID: "session-drift", Agent: "bbl", Label: "drift", Status: StatusDrift,
	})
	im.loop = seeded

	health := &api.LoopHealthResponse{
		Type: "loop_health",
		Panes: []api.LoopHealthPane{{
			SessionID: "session-drift", Status: "drift",
			PendingScopeBoundaries: 5, OutOfScopeEvidence: 2,
		}},
	}
	im.SetHealthForDriftForTest(health)

	updated, _ := im.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	im2 := updated.(InteractiveModel)
	im2.loop = seeded
	updated, _ = im2.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	newModel := updated.(InteractiveModel)

	body := stripANSI(newModel.View().Content)
	if !strings.Contains(body, "scope drift") {
		t.Errorf("View should contain scope drift header, got:\n%s", body)
	}
	if !strings.Contains(body, "pane-drift") {
		t.Errorf("View should list pane-drift, got:\n%s", body)
	}
	if !strings.Contains(body, "5 pending") {
		t.Errorf("View should show live pending count, got:\n%s", body)
	}
	if !strings.Contains(body, "2 evidence") {
		t.Errorf("View should show live evidence count, got:\n%s", body)
	}
}

// TestScopeDriftOverlayPlaceholderWhenNoData: opening
// ctrl+d without injected data shows the "no drift
// reported" placeholder so the operator knows the
// overlay is wired but the runtime hasn't reported. The
// chrome's center-splice may chop the leading characters
// of inner panel lines (the splice overwrites from
// startX onward), so we look for a stable substring
// ("drift reported") that survives the splice artifact.
func TestScopeDriftOverlayPlaceholderWhenNoData(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	updated, _ := im.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	im2 := updated.(InteractiveModel)
	updated, _ = im2.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	newModel := updated.(InteractiveModel)
	body := stripANSI(newModel.View().Content)
	if !strings.Contains(body, "scope drift") {
		t.Errorf("expected scope drift header, got:\n%s", body)
	}
	if !strings.Contains(body, "drift reported") {
		t.Errorf("expected 'drift reported' placeholder (splice-safe), got:\n%s", body)
	}
}

// TestScopeDriftOverlayIndependentOfOtherOverlays:
// opening scope_drift doesn't toggle pane_list or
// scope_review; the operator gets drift-only.
func TestScopeDriftOverlayIndependentOfOtherOverlays(t *testing.T) {
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(), nil, nil, 0, nil, 0, nil, nil,
	)
	updated, _ := im.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	newModel := updated.(InteractiveModel)
	if newModel.paneListOpen {
		t.Error("ctrl+d should NOT open pane_list")
	}
	if newModel.scopeReviewOpen {
		t.Error("ctrl+d should NOT open scope_review")
	}
	if newModel.helpOpen {
		t.Error("ctrl+d should NOT open help")
	}
}
