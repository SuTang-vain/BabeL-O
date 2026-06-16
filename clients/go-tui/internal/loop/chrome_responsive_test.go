// internal/loop/chrome_responsive_test.go
//
// Phase 4 follow-up: tests for the responsive layout layer
// (two-tier layout mode + sidebar collapse + focused-pane
// zoom). Mirrors chrome_features_test.go's approach —
// drive the InteractiveModel via Update, peek at the
// rendered View / chrome, assert on the stripped substrings
// + the chromeLayout geometry.

package loop

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

func TestLayoutModeAtVariousSizes(t *testing.T) {
	// Exercise the layout-mode threshold table: width<40 or
	// height<12 → tooSmall; 40<=width<64 → mobile; else →
	// desktop. Height>=12, width>=40 should never be
	// tooSmall; width<64 should never be desktop.
	cases := []struct {
		name     string
		w, h     int
		wantMode layoutMode
		desc     string
	}{
		{"tiny", 20, 8, layoutTooSmall, "20x8 is unreadable"},
		{"narrow-short", 30, 11, layoutTooSmall, "30x11 below min"},
		{"just-too-small", 39, 24, layoutTooSmall, "39 below 40 threshold"},
		{"mobile-low", 40, 24, layoutMobile, "40 hits mobile band"},
		{"mobile-high", 63, 24, layoutMobile, "63 just below desktop"},
		{"desktop-low", 64, 24, layoutDesktop, "64 hits desktop band"},
		{"desktop-mid", 120, 40, layoutDesktop, "120x40 normal"},
		{"desktop-wide", 240, 60, layoutDesktop, "240x60 wide"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			layout := computeChromeLayout(c.w, c.h, false)
			if layout.Mode != c.wantMode {
				t.Errorf("%s: mode = %d, want %d (%s)", c.name, layout.Mode, c.wantMode, c.desc)
			}
		})
	}
}

func TestTooSmallRendersMessageWithoutChrome(t *testing.T) {
	// Below the min size the chrome should not pretend to
	// render: no "bbl loop" header chrome, no keybinds.
	// The renderer shows a "resize to at least 80x24" hint
	// instead. Note: the renderer does still mention "bbl
	// loop" inside the message itself, so we assert on the
	// hint copy + the absence of the keyboard hint.
	im := NewInteractiveModel(NewLoopModel())
	im.loop.Width = 30
	im.loop.Height = 8
	out := stripANSI(im.View().Content)
	for _, want := range []string{"terminal too small", "resize to at least 80x24", "30x8"} {
		if !strings.Contains(out, want) {
			t.Errorf("too-small view missing %q\nfull:\n%s", want, out)
		}
	}
	// The footer keybind hint should NOT appear because
	// renderTooSmall bypasses the normal chrome pipeline.
	for _, banned := range []string{"ctrl+n", "ctrl+w", "ctrl+b"} {
		if strings.Contains(out, banned) {
			t.Errorf("too-small view should not render keybinds (%q)\nfull:\n%s", banned, out)
		}
	}
}

func TestMobileModeHidesSidebar(t *testing.T) {
	// At <64 cols the sidebar is suppressed — the body is
	// the focused pane at full width. We assert on the
	// layout + on the rendered chrome (no "spaces" header
	// from the sidebar).
	im := NewInteractiveModel(NewLoopModel())
	im.loop.Width = 50
	im.loop.Height = 20
	layout := computeChromeLayout(50, 20, false)
	if layout.Mode != layoutMobile {
		t.Fatalf("expected layoutMobile, got %d", layout.Mode)
	}
	if layout.SidebarW != 0 {
		t.Errorf("mobile sidebar width = %d, want 0", layout.SidebarW)
	}
	out := stripANSI(im.View().Content)
	if strings.Contains(out, "spaces") {
		t.Errorf("mobile chrome should not render the sidebar header\nfull:\n%s", out)
	}
	// The footer should wrap to 2 lines in mobile mode.
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	// Header (1) + body (~17) + footer (2) = ~20 lines for
	// a 20-row terminal. Look for the 2-line footer pattern
	// by counting keybind groups: critical on line N-2 and
	// workflow on line N-1.
	if !strings.Contains(lines[len(lines)-2], "ctrl+n") {
		t.Errorf("expected critical footer on second-to-last line\nfull:\n%s", out)
	}
	if !strings.Contains(lines[len(lines)-1], "ctrl+w") {
		t.Errorf("expected workflow footer on last line\nfull:\n%s", out)
	}
}

func TestSidebarCollapseTogglesViaCtrlB(t *testing.T) {
	// Ctrl+B should flip sidebarCollapsed on the model and
	// (re-)render the chrome with a 4-col gutter in place
	// of the full sidebar.
	im := NewInteractiveModel(NewLoopModel())
	im.loop.Width = 120
	im.loop.Height = 40

	// Sanity: initial state has the full sidebar.
	if im.sidebarCollapsed {
		t.Fatal("sidebar should start expanded")
	}
	preCollapse := stripANSI(im.View().Content)
	if !strings.Contains(preCollapse, "spaces") {
		t.Errorf("expanded view missing sidebar 'spaces' header\nfull:\n%s", preCollapse)
	}

	// Ctrl+B → collapsed.
	updated, _ := im.Update(tea.KeyPressMsg(tea.Key{Code: 'b', Mod: tea.ModCtrl, Text: "b"}))
	im2 := updated.(InteractiveModel)
	if !im2.sidebarCollapsed {
		t.Fatal("Ctrl+B should set sidebarCollapsed = true")
	}
	postCollapse := stripANSI(im2.View().Content)
	if strings.Contains(postCollapse, "spaces") {
		t.Errorf("collapsed view should not render sidebar 'spaces' header\nfull:\n%s", postCollapse)
	}
	// The layout should now report SidebarCollapsed = true
	// and SidebarW = 4.
	layout := computeChromeLayout(120, 40, true)
	if !layout.SidebarCollapsed {
		t.Error("layout should report SidebarCollapsed = true")
	}
	if layout.SidebarW != 4 {
		t.Errorf("collapsed sidebar width = %d, want 4", layout.SidebarW)
	}

	// Ctrl+B again → expanded.
	updated, _ = im2.Update(tea.KeyPressMsg(tea.Key{Code: 'b', Mod: tea.ModCtrl, Text: "b"}))
	im3 := updated.(InteractiveModel)
	if im3.sidebarCollapsed {
		t.Fatal("second Ctrl+B should set sidebarCollapsed = false")
	}
	if !strings.Contains(stripANSI(im3.View().Content), "spaces") {
		t.Error("re-expanded view should render sidebar 'spaces' header")
	}
}

func TestZoomTogglesViaCtrlZ(t *testing.T) {
	// Ctrl+Z should flip zoomFocused; the zoomed chrome
	// hides the breadcrumb and the sidebar so the focused
	// pane gets the full body.
	im := NewInteractiveModel(NewLoopModel())
	im.loop.Width = 120
	im.loop.Height = 40

	updated, _ := im.Update(tea.KeyPressMsg(tea.Key{Code: 'z', Mod: tea.ModCtrl, Text: "z"}))
	im2 := updated.(InteractiveModel)
	if !im2.zoomFocused {
		t.Fatal("Ctrl+Z should set zoomFocused = true")
	}
	zoomed := stripANSI(im2.View().Content)
	if strings.Contains(zoomed, "spaces") {
		t.Errorf("zoomed view should not render the sidebar\nfull:\n%s", zoomed)
	}
	// Zoomed chrome should still have the unzoom keybind
	// hint.
	if !strings.Contains(zoomed, "ctrl+z") {
		t.Errorf("zoomed view should mention ctrl+z for unzoom\nfull:\n%s", zoomed)
	}

	// Ctrl+Z again → unzoomed.
	updated, _ = im2.Update(tea.KeyPressMsg(tea.Key{Code: 'z', Mod: tea.ModCtrl, Text: "z"}))
	im3 := updated.(InteractiveModel)
	if im3.zoomFocused {
		t.Fatal("second Ctrl+Z should set zoomFocused = false")
	}
	if !strings.Contains(stripANSI(im3.View().Content), "spaces") {
		t.Error("unzoomed view should render the sidebar again")
	}
}

func TestCtrlBAndCtrlZAreNoopsWhileHelpOpen(t *testing.T) {
	// With the help overlay open, Ctrl+B and Ctrl+Z are
	// swallowed (like all non-close keys) so the operator
	// can't accidentally toggle chrome state while reading
	// the help panel. Mirrors the existing
	// TestHelpOverlayBlocksRouterDispatch contract.
	im := NewInteractiveModel(NewLoopModel())
	im.loop.Width = 120
	im.loop.Height = 40
	// Open help.
	updated, _ := im.Update(tea.KeyPressMsg(tea.Key{Code: '?', Text: "?"}))
	im2 := updated.(InteractiveModel)
	if !im2.helpOpen {
		t.Fatal("help should be open")
	}
	// Ctrl+B while help is open: should be ignored.
	updated, _ = im2.Update(tea.KeyPressMsg(tea.Key{Code: 'b', Mod: tea.ModCtrl, Text: "b"}))
	im3 := updated.(InteractiveModel)
	if im3.sidebarCollapsed {
		t.Error("Ctrl+B inside help should not collapse the sidebar")
	}
	// Ctrl+Z while help is open: should be ignored.
	updated, _ = im3.Update(tea.KeyPressMsg(tea.Key{Code: 'z', Mod: tea.ModCtrl, Text: "z"}))
	im4 := updated.(InteractiveModel)
	if im4.zoomFocused {
		t.Error("Ctrl+Z inside help should not zoom the focused pane")
	}
	// Help should still be open.
	if !im4.helpOpen {
		t.Error("help should still be open after ignored keybinds")
	}
}

func TestFooterPriorityKeepsCriticalBinds(t *testing.T) {
	// On a narrow desktop the full footer doesn't fit; the
	// critical group (q ? ctrl+n ctrl+b ctrl+z) wins and
	// the workflow group is dropped. We assert on the
	// single-line footer at width=70 — full list (~80
	// chars) doesn't fit, so the critical-only fallback
	// should engage.
	model := NewLoopModel()
	layout := computeChromeLayout(70, 24, false)
	footer := stripANSI(renderFooter(model, 70, reconcileFooterInfo{}, layout))
	for _, want := range []string{"ctrl+n", "ctrl+b", "ctrl+z", "q", "?"} {
		if !strings.Contains(footer, want) {
			t.Errorf("narrow footer missing critical bind %q\nfull:\n%s", want, footer)
		}
	}
	// Workflow binds should NOT appear because the line
	// doesn't fit them.
	for _, banned := range []string{"ctrl+pgup", "ctrl+t"} {
		if strings.Contains(footer, banned) {
			t.Errorf("narrow footer should not include workflow bind %q\nfull:\n%s", banned, footer)
		}
	}
}

func TestHeaderDropsColumnsProgressively(t *testing.T) {
	// Header columns drop in priority order: summary →
	// breadcrumb → version. We assert that the wide header
	// has all three, the medium header has breadcrumb +
	// title only, the narrow header has title only.
	wide := stripANSI(renderHeader(NewLoopModel(), 140))
	if !strings.Contains(wide, Version) {
		t.Errorf("wide header should include version\nfull:\n%s", wide)
	}
	if !strings.Contains(wide, "panes") {
		t.Errorf("wide header should include summary 'panes'\nfull:\n%s", wide)
	}
	// At 30 cols only the title should remain; version /
	// summary are dropped first because they're the
	// "nice-to-have" columns.
	narrow := stripANSI(renderHeader(NewLoopModel(), 30))
	if !strings.Contains(narrow, "bbl loop") {
		t.Errorf("narrow header should still show title\nfull:\n%s", narrow)
	}
	if strings.Contains(narrow, Version) {
		t.Errorf("narrow header should drop version\nfull:\n%s", narrow)
	}
	if strings.Contains(narrow, "panes") {
		t.Errorf("narrow header should drop summary\nfull:\n%s", narrow)
	}
}

func TestCollapsedSidebarRenders4ColGutter(t *testing.T) {
	// The 4-col gutter shows a `▾` glyph; the focused pane
	// fills the rest of the body. We render the chrome in
	// collapsed mode and assert on the gutter content +
	// the focused pane header.
	im := NewInteractiveModel(NewLoopModel())
	im.loop.Width = 120
	im.loop.Height = 40
	im.SetLayoutForTest(layoutChromeState{SidebarCollapsed: true})
	tab := im.loop.Workspaces[0].Tabs[0]
	updated, _ := tab.AddPane(PaneModel{
		PaneID:      "pane-collapsed",
		WorkspaceID: im.loop.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   "session-collapsed",
		Agent:       "bbl",
	})
	im.loop.Workspaces[0].Tabs[0] = updated
	out := stripANSI(im.View().Content)
	if !strings.Contains(out, "pane-collapsed") {
		t.Errorf("collapsed view should still render the focused pane\nfull:\n%s", out)
	}
	// The sidebar 'spaces' header should be gone.
	if strings.Contains(out, "spaces") {
		t.Errorf("collapsed view should not render sidebar 'spaces' header\nfull:\n%s", out)
	}
}

func TestZoomedChromeHidesBreadcrumbAndSummary(t *testing.T) {
	// The zoomed chrome is just a centered title + the
	// focused pane at full body width. No breadcrumb (the
	// "ws › tab › pane" middle column), no summary pill.
	im := NewInteractiveModel(NewLoopModel())
	im.loop.Width = 120
	im.loop.Height = 40
	im.SetLayoutForTest(layoutChromeState{ZoomFocused: true})
	tab := im.loop.Workspaces[0].Tabs[0]
	updated, _ := tab.AddPane(PaneModel{
		PaneID:      "pane-zoomed",
		WorkspaceID: im.loop.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   "session-zoomed",
		Agent:       "bbl",
	})
	im.loop.Workspaces[0].Tabs[0] = updated
	out := stripANSI(im.View().Content)
	if !strings.Contains(out, "pane-zoomed") {
		t.Errorf("zoomed view should still render the focused pane\nfull:\n%s", out)
	}
	// Breadcrumb separator "›" is the strongest tell that
	// the breadcrumb row is showing.
	if strings.Contains(out, "›") {
		t.Errorf("zoomed view should not render the breadcrumb (› separator)\nfull:\n%s", out)
	}
	if strings.Contains(out, "panes") {
		t.Errorf("zoomed view should not render the summary pill\nfull:\n%s", out)
	}
}

func TestResponsiveLayoutVisualSmoke(t *testing.T) {
	// Eyeball check: render the chrome at 5 representative
	// terminal sizes and log the last 6 lines (header +
	// focused pane box + footer) so the responsive layout
	// can be verified by reading the test log. Run with
	// `go test -v -run VisualSmoke ./...`.
	cases := []struct {
		name   string
		w, h   int
		layout layoutChromeState
	}{
		{"tiny-30x8", 30, 8, layoutChromeState{}},
		{"mobile-50x20", 50, 20, layoutChromeState{}},
		{"narrow-desktop-70x24", 70, 24, layoutChromeState{}},
		{"normal-120x40", 120, 40, layoutChromeState{}},
		{"collapsed-120x40", 120, 40, layoutChromeState{SidebarCollapsed: true}},
		{"zoomed-120x40", 120, 40, layoutChromeState{ZoomFocused: true}},
		{"wide-200x60", 200, 60, layoutChromeState{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			model := NewLoopModel()
			model.Width = c.w
			model.Height = c.h
			tab := model.Workspaces[0].Tabs[0]
			updated, _ := tab.AddPane(PaneModel{
				PaneID:      "pane-smoke",
				WorkspaceID: model.Workspaces[0].ID,
				TabID:       tab.ID,
				SessionID:   "session-smoke",
				Agent:       "bbl",
				Status:      StatusWorking,
			})
			model.Workspaces[0].Tabs[0] = updated
			out := stripANSI(renderChrome(model, chromeViewState{Layout: c.layout}))
			lines := strings.Split(out, "\n")
			from := max(0, len(lines)-6)
			t.Logf("=== %s (%dx%d, layout=%+v) ===\n%s",
				c.name, c.w, c.h, c.layout,
				strings.Join(lines[from:], "\n"))
		})
	}
}

func TestResponsiveChromeDoesNotExceedViewport(t *testing.T) {
	cases := []struct {
		name   string
		w, h   int
		layout layoutChromeState
		toast  string
	}{
		{"mobile", 50, 20, layoutChromeState{}, ""},
		{"mobile-toast", 50, 20, layoutChromeState{}, "✓ state saved"},
		{"desktop", 120, 40, layoutChromeState{}, ""},
		{"desktop-toast", 120, 40, layoutChromeState{}, "✓ state saved"},
		{"collapsed", 120, 40, layoutChromeState{SidebarCollapsed: true}, ""},
		{"zoomed", 120, 40, layoutChromeState{ZoomFocused: true}, ""},
		{"wide", 200, 60, layoutChromeState{}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			model := seedPaneModel(c.w, c.h, 2)
			out := renderChrome(model, chromeViewState{Layout: c.layout, Toast: c.toast})
			lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
			if len(lines) > c.h {
				t.Fatalf("rendered %d lines for viewport height %d\n%s", len(lines), c.h, stripANSI(out))
			}
			for i, line := range lines {
				if got := lipgloss.Width(line); got > c.w {
					t.Fatalf("line %d width = %d, want <= %d\nline: %q\nfull:\n%s",
						i, got, c.w, stripANSI(line), stripANSI(out))
				}
			}
		})
	}
}
