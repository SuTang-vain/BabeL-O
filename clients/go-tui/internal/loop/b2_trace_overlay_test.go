// clients/go-tui/internal/loop/b2_trace_overlay_test.go
//
// PR-B2 unit tests for the behavior trace overlay (HandleViewTraceKey,
// BuildTraceLines, RenderTraceOverlay, IsB2TraceOpen).
// Pattern mirrors chrome_features_test.go (direct model construction
// via NewLoopModel + Tab.AddPane).

package loop

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// newTestModelB2 builds a minimal InteractiveModel with a focused
// pane at the given status so we can test HandleViewTraceKey.
// Pattern mirrors chrome_features_test.go:156-172.
func newTestModelB2(status PaneStatus, sessionID string) InteractiveModel {
	model := NewLoopModel()
	tab := model.Workspaces[0].Tabs[0]
	updated, err := tab.AddPane(PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: model.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   sessionID,
		Agent:       "bbl",
		Cwd:         "/tmp/test",
		Label:       "test",
		Status:      status,
	})
	if err != nil {
		panic("AddPane: " + err.Error())
	}
	model.Workspaces[0].Tabs[0] = updated
	model.Focus.WorkspaceIdx = 0
	model.Focus.TabIdx = 0
	model.Focus.PaneIdx = 0
	return InteractiveModel{loop: model}
}

func resetB2Trace() {
	b2Trace.mu.Lock()
	b2Trace.open = false
	b2Trace.loading = false
	b2Trace.err = ""
	b2Trace.entries = nil
	b2Trace.mu.Unlock()
}

func TestHandleViewTraceKeyOpensOnV(t *testing.T) {
	resetB2Trace()
	model := newTestModelB2(StatusBehaviorHint, "session-1")
	msg := tea.KeyPressMsg{Text: "v"}
	handled, _ := HandleViewTraceKey(msg, &model)
	if !handled {
		t.Fatal("expected handled=true for v key with StatusBehaviorHint")
	}
	if !IsB2TraceOpen() {
		t.Error("overlay should be open")
	}
}

func TestHandleViewTraceKeyNoopWhenStatusNotHint(t *testing.T) {
	resetB2Trace()
	model := newTestModelB2(StatusWorking, "session-1")
	msg := tea.KeyPressMsg{Text: "v"}
	handled, _ := HandleViewTraceKey(msg, &model)
	if handled {
		t.Fatal("expected handled=false for v key with StatusWorking")
	}
	if IsB2TraceOpen() {
		t.Error("overlay should not be open")
	}
}

func TestHandleViewTraceKeyNoopWhenNoFocusedPane(t *testing.T) {
	resetB2Trace()
	model := InteractiveModel{loop: NewLoopModel()} // no panes
	msg := tea.KeyPressMsg{Text: "v"}
	handled, _ := HandleViewTraceKey(msg, &model)
	if handled {
		t.Fatal("expected handled=false when no focused pane")
	}
}

func TestHandleViewTraceKeyClosesOnEsc(t *testing.T) {
	b2Trace.mu.Lock()
	b2Trace.open = true
	b2Trace.loading = false
	b2Trace.mu.Unlock()

	model := newTestModelB2(StatusBehaviorHint, "session-1")
	msg := tea.KeyPressMsg{Text: "esc"}
	handled, cmd := HandleViewTraceKey(msg, &model)
	if !handled {
		t.Fatal("esc should be handled when overlay is open")
	}
	if cmd != nil {
		t.Error("esc should return nil cmd for close")
	}
	if IsB2TraceOpen() {
		t.Error("overlay should be closed after esc")
	}
}

func TestHandleViewTraceKeyClosesOnQ(t *testing.T) {
	b2Trace.mu.Lock()
	b2Trace.open = true
	b2Trace.mu.Unlock()

	model := newTestModelB2(StatusBehaviorHint, "session-1")
	msg := tea.KeyPressMsg{Text: "q"}
	handled, _ := HandleViewTraceKey(msg, &model)
	if !handled {
		t.Fatal("q should be handled when overlay is open")
	}
	if IsB2TraceOpen() {
		t.Error("overlay should be closed after q")
	}
}

func TestHandleViewTraceKeyClosesOnQuestionMark(t *testing.T) {
	b2Trace.mu.Lock()
	b2Trace.open = true
	b2Trace.mu.Unlock()

	model := newTestModelB2(StatusBehaviorHint, "session-1")
	msg := tea.KeyPressMsg{Text: "?"}
	handled, _ := HandleViewTraceKey(msg, &model)
	if !handled {
		t.Fatal("? should be handled when overlay is open")
	}
	if IsB2TraceOpen() {
		t.Error("overlay should be closed after ?")
	}
}

func TestHandleViewTraceKeyClosesOnCtrlC(t *testing.T) {
	b2Trace.mu.Lock()
	b2Trace.open = true
	b2Trace.mu.Unlock()

	model := newTestModelB2(StatusBehaviorHint, "session-1")
	msg := tea.KeyPressMsg{Text: "ctrl+c"}
	handled, _ := HandleViewTraceKey(msg, &model)
	if !handled {
		t.Fatal("ctrl+c should be handled when overlay is open")
	}
	if IsB2TraceOpen() {
		t.Error("overlay should be closed after ctrl+c")
	}
}

func TestHandleViewTraceKeyTogglesWithV(t *testing.T) {
	b2Trace.mu.Lock()
	b2Trace.open = true
	b2Trace.mu.Unlock()

	model := newTestModelB2(StatusBehaviorHint, "session-1")
	// v key while open → close
	msg := tea.KeyPressMsg{Text: "v"}
	handled, _ := HandleViewTraceKey(msg, &model)
	if !handled {
		t.Fatal("v should be handled when overlay is open (toggle close)")
	}
	if IsB2TraceOpen() {
		t.Error("overlay should be closed after v toggle")
	}
}

func TestBuildTraceLinesFormatsEntries(t *testing.T) {
	entries := []api.BehaviorTraceEntry{
		{
			Timestamp: "2026-06-17T12:00:00.000Z",
			Trigger:   "error",
			Anomaly:   api.BehaviorTraceAnomaly{ErrorCode: "E_TIMEOUT", ErrorMessage: "tool timed out"},
		},
		{
			Timestamp: "2026-06-17T14:30:00.000Z",
			Trigger:   "scope-drift",
			Anomaly:   api.BehaviorTraceAnomaly{DriftPath: "src/nexus/app.ts", ExpectedScope: "tool surface"},
		},
	}
	lines := BuildTraceLines(entries)
	if len(lines) != 2 {
		t.Fatalf("len(lines) = %d, want 2", len(lines))
	}
	if !strings.Contains(lines[0], "E_TIMEOUT") {
		t.Errorf("line 0 missing E_TIMEOUT: %s", lines[0])
	}
	if !strings.Contains(lines[1], "src/nexus/app.ts") {
		t.Errorf("line 1 missing path: %s", lines[1])
	}
	// Time extraction: should show "12:00:00" not full ISO.
	if !strings.Contains(lines[0], "12:00:00") {
		t.Errorf("line 0 missing short time: %s", lines[0])
	}
}

func TestBuildTraceLinesEmpty(t *testing.T) {
	lines := BuildTraceLines(nil)
	if len(lines) != 1 {
		t.Fatalf("len(lines) = %d, want 1", len(lines))
	}
	if !strings.Contains(lines[0], "no trace entries") {
		t.Errorf("unexpected empty line: %s", lines[0])
	}
}

func TestRenderTraceOverlayLoading(t *testing.T) {
	b2Trace.mu.Lock()
	b2Trace.loading = true
	b2Trace.err = ""
	b2Trace.mu.Unlock()
	// Multi-line content so splicePanel has rows to work with.
	content := strings.Repeat("chrome row\n", 30)
	out := RenderTraceOverlay(content, 80, 30, nil)
	if !strings.Contains(out, "loading") {
		t.Errorf("loading overlay should show 'loading'\noutput:\n%s", out)
	}
}

func TestRenderTraceOverlayError(t *testing.T) {
	b2Trace.mu.Lock()
	b2Trace.loading = false
	b2Trace.err = "fetch failed"
	b2Trace.mu.Unlock()
	content := strings.Repeat("chrome row\n", 30)
	out := RenderTraceOverlay(content, 80, 30, nil)
	if !strings.Contains(out, "fetch failed") {
		t.Errorf("error overlay should show error message\noutput:\n%s", out)
	}
}
