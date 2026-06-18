// internal/loop/chrome_reconcile_test.go
//
// Phase 4 follow-up: tests for the footer's reconcile
// status indicator. Mirrors chrome_features_test.go's
// approach — drive the InteractiveModel via Update, peek at
// the rendered footer / View content, assert on the stripped
// substrings. Covers the four indicator shapes:
//   - never run        → no indicator at all
//   - run, success     → "synced Ns ago" + counts
//   - run, error       → "sync failed: <err> Ns ago"
//   - in flight        → "syncing..." (+ "last Ns ago" if any)

package loop

import (
	"errors"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

func TestFooterHidesReconcileWhenNeverRun(t *testing.T) {
	// Fresh model with no reconciler attached and no result
	// stamped yet. The footer should show the keybind hints
	// and *not* any reconcile indicator.
	im := NewInteractiveModel(NewLoopModel())
	im.loop.Width = 200
	im.loop.Height = 24
	out := stripANSI(renderFooter(im.loop, 200, reconcileFooterInfo{}, computeChromeLayout(200, 24, false)))
	if strings.Contains(out, "synced") || strings.Contains(out, "syncing") || strings.Contains(out, "sync failed") {
		t.Errorf("footer should hide reconcile indicator when never run\nfull:\n%s", out)
	}
	// The keybind hint should still be present so the
	// operator's muscle memory doesn't break.
	for _, want := range []string{"ctrl+n", "ctrl+w", "q"} {
		if !strings.Contains(out, want) {
			t.Errorf("footer missing keybind %q\nfull:\n%s", want, out)
		}
	}
}

func TestFooterShowsReconcileCountsAfterSuccess(t *testing.T) {
	// Drive the production handleReconcileDone path: stamp
	// a result with non-zero Pushed/Pulled and confirm the
	// footer surfaces "synced Ns ago · 1 pushed · 2 pulled".
	im := NewInteractiveModelWithReconciler(NewLoopModel(), nil, &Reconciler{}, 100*time.Millisecond)
	im.loop.Width = 200
	im.loop.Height = 24
	im.handleReconcileDone(reconcileDoneMsg{
		result: RunOnceResult{Pushed: 1, Pulled: 2, Unchanged: 5},
	})
	out := stripANSI(renderFooter(im.loop, 200, reconcileFooterInfo{
		InFlight: im.reconcileInFlight,
		At:       im.lastReconcileAt,
		Result:   im.lastReconcile.result,
		Err:      im.lastReconcile.err,
	}, computeChromeLayout(200, 24, false)))
	for _, want := range []string{"synced", "1 pushed", "2 pulled"} {
		if !strings.Contains(out, want) {
			t.Errorf("footer missing %q after success\nfull:\n%s", want, out)
		}
	}
	if strings.Contains(out, "0 pushed") {
		t.Errorf("footer should not show 0 pushed\nfull:\n%s", out)
	}
}

func TestFooterShowsReconcileError(t *testing.T) {
	// After a failed pass the footer should show a red dot
	// + "sync failed: <err>" + the age.
	im := NewInteractiveModelWithReconciler(NewLoopModel(), nil, &Reconciler{}, 100*time.Millisecond)
	im.loop.Width = 200
	im.loop.Height = 24
	im.handleReconcileDone(reconcileDoneMsg{
		err: errors.New("503 from nexus"),
	})
	out := stripANSI(renderFooter(im.loop, 200, reconcileFooterInfo{
		InFlight: im.reconcileInFlight,
		At:       im.lastReconcileAt,
		Result:   im.lastReconcile.result,
		Err:      im.lastReconcile.err,
	}, computeChromeLayout(200, 24, false)))
	for _, want := range []string{"sync failed", "503 from nexus"} {
		if !strings.Contains(out, want) {
			t.Errorf("footer missing %q after error\nfull:\n%s", want, out)
		}
	}
	// Age is shown as either "just now" (sub-second) or
	// "Ns ago" depending on the timestamp's age — accept
	// either so the test isn't flaky on fast machines.
	if !strings.Contains(out, "just now") && !strings.Contains(out, "ago") {
		t.Errorf("footer should show the age (just now / Ns ago) after error\nfull:\n%s", out)
	}
}

func TestFooterShowsReconcilingInFlight(t *testing.T) {
	// A tick that hasn't been answered yet should render
	// "● syncing..." on its own; if a prior result is known
	// the indicator should also surface "(last Ns ago)" so
	// the operator can tell the previous pass's age during
	// the in-flight window.
	im := NewInteractiveModelWithReconciler(NewLoopModel(), nil, &Reconciler{}, 100*time.Millisecond)
	im.loop.Width = 200
	im.loop.Height = 24
	im.handleReconcileDone(reconcileDoneMsg{
		result: RunOnceResult{Unchanged: 3},
	}) // prior successful pass → At is set, in-flight cleared
	if im.reconcileInFlight {
		t.Fatal("handleReconcileDone should clear in-flight flag")
	}
	im.handleReconcileTick() // kick off a new pass
	if !im.reconcileInFlight {
		t.Fatal("handleReconcileTick should set in-flight flag")
	}
	out := stripANSI(renderFooter(im.loop, 200, reconcileFooterInfo{
		InFlight: im.reconcileInFlight,
		At:       im.lastReconcileAt,
		Result:   im.lastReconcile.result,
		Err:      im.lastReconcile.err,
	}, computeChromeLayout(200, 24, false)))
	if !strings.Contains(out, "syncing") {
		t.Errorf("in-flight footer should mention 'syncing'\nfull:\n%s", out)
	}
	if !strings.Contains(out, "last") {
		t.Errorf("in-flight footer with prior pass should mention 'last'\nfull:\n%s", out)
	}
}

func TestFooterShowsReconcilingWithoutPriorPass(t *testing.T) {
	// First tick: no At, no Err. Indicator should still
	// surface "● syncing..." but skip the "(last ...)"
	// suffix.
	im := NewInteractiveModelWithReconciler(NewLoopModel(), nil, &Reconciler{}, 100*time.Millisecond)
	im.loop.Width = 200
	im.loop.Height = 24
	im.handleReconcileTick()
	out := stripANSI(renderFooter(im.loop, 200, reconcileFooterInfo{
		InFlight: im.reconcileInFlight,
		At:       im.lastReconcileAt,
		Result:   im.lastReconcile.result,
		Err:      im.lastReconcile.err,
	}, computeChromeLayout(200, 24, false)))
	if !strings.Contains(out, "syncing") {
		t.Errorf("in-flight footer should mention 'syncing'\nfull:\n%s", out)
	}
	if strings.Contains(out, "last ") {
		t.Errorf("first-tick footer should not mention 'last'\nfull:\n%s", out)
	}
}

func TestRenderChromeReconcileIndicatorAfterUpdate(t *testing.T) {
	// Integration: drive the full View() pipeline through
	// a real reconcileDoneMsg dispatch and confirm the
	// reconciled indicator lands in the rendered chrome.
	im := NewInteractiveModelWithReconciler(NewLoopModel(), nil, &Reconciler{}, 100*time.Millisecond)
	im.loop.Width = 200
	im.loop.Height = 24
	updated, _ := im.Update(tea.WindowSizeMsg{Width: 200, Height: 24})
	im2 := updated.(InteractiveModel)
	updated, _ = im2.Update(reconcileDoneMsg{
		result: RunOnceResult{Pushed: 2, Pulled: 1, Unchanged: 4},
	})
	im3 := updated.(InteractiveModel)
	content := stripANSI(im3.View().Content)
	for _, want := range []string{"synced", "2 pushed", "1 pulled"} {
		if !strings.Contains(content, want) {
			t.Errorf("View missing %q after reconcileDoneMsg\nfull:\n%s", want, content)
		}
	}
}

func TestSetReconcileForTestMirrorsHandleReconcileDone(t *testing.T) {
	// The test helper should produce the same chrome output
	// as driving the production handleReconcileDone path,
	// so smoke commands + tests can preview the indicator
	// without standing up a Reconciler.
	prod := NewInteractiveModelWithReconciler(NewLoopModel(), nil, &Reconciler{}, 100*time.Millisecond)
	prod.loop.Width = 200
	prod.loop.Height = 24
	prod.handleReconcileDone(reconcileDoneMsg{
		result: RunOnceResult{Pushed: 1, Pulled: 2},
	})
	test := NewInteractiveModel(NewLoopModel())
	test.loop.Width = 200
	test.loop.Height = 24
	test.SetReconcileForTest(reconcileFooterInfo{
		At:     prod.lastReconcileAt,
		Result: prod.lastReconcile.result,
	})
	prodOut := stripANSI(renderFooter(prod.loop, 200, reconcileFooterInfo{
		InFlight: prod.reconcileInFlight,
		At:       prod.lastReconcileAt,
		Result:   prod.lastReconcile.result,
		Err:      prod.lastReconcile.err,
	}, computeChromeLayout(200, 24, false)))
	testOut := stripANSI(renderFooter(test.loop, 200, reconcileFooterInfo{
		InFlight: test.reconcileInFlight,
		At:       test.lastReconcileAt,
		Result:   test.lastReconcile.result,
		Err:      test.lastReconcile.err,
	}, computeChromeLayout(200, 24, false)))
	if prodOut != testOut {
		t.Errorf("SetReconcileForTest should mirror handleReconcileDone\nprod:\n%s\ntest:\n%s", prodOut, testOut)
	}
}

func TestChromeReconcileStateBundleBackwardCompatible(t *testing.T) {
	// The empty state bundle (HelpOpen=false, Toast="",
	// Reconcile={}) must render identically to the pre-state
	// shape — no stray "syncing"/"synced" substrings in the
	// chrome when no reconciler is attached.
	model := NewLoopModel()
	model.Width = 120
	model.Height = 24
	out := stripANSI(renderChrome(model, chromeViewState{}))
	for _, banned := range []string{"syncing", "synced", "sync failed"} {
		if strings.Contains(out, banned) {
			t.Errorf("empty state bundle should not render %q\nfull:\n%s", banned, out)
		}
	}
}

func TestReconcileIndicatorVisualSmoke(t *testing.T) {
	// Eyeball check: render the chrome in each of the four
	// indicator states and log the stripped output so the
	// footer alignment can be verified by reading the test
	// log. Run with `go test -v -run VisualSmoke ./...`
	// to see the rendered output.
	cases := []struct {
		name string
		info reconcileFooterInfo
	}{
		{"never-run", reconcileFooterInfo{}},
		{"synced-3s-1p-2u", reconcileFooterInfo{
			At:     time.Now().Add(-3 * time.Second),
			Result: RunOnceResult{Pushed: 1, Pulled: 2, Unchanged: 4},
		}},
		{"syncing-after-prior", reconcileFooterInfo{
			InFlight: true,
			At:       time.Now().Add(-12 * time.Second),
			Result:   RunOnceResult{Unchanged: 4},
		}},
		{"sync-failed", reconcileFooterInfo{
			At:  time.Now().Add(-7 * time.Second),
			Err: errors.New("503 from nexus"),
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			model := NewLoopModel()
			model.Width = 140
			model.Height = 24
			out := stripANSI(renderChrome(model, chromeViewState{Reconcile: c.info}))
			// Only the last 4 lines matter — that's where the
			// footer + (potentially) toast live.
			lines := strings.Split(out, "\n")
			t.Logf("=== %s ===\n%s", c.name, strings.Join(lines[max(0, len(lines)-4):], "\n"))
		})
	}
}
