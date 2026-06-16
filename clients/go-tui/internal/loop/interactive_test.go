// internal/loop/interactive_test.go
//
// Phase 3f Bubble Tea adapter tests: Update handles
// WindowSize + KeyMsg (quit), View renders status bar + pane
// placeholder. Uses tea.NewProgram with WithInput(nil) so
// the test doesn't hang on stdin.

package loop

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

func TestInteractiveUpdateAppliesWindowSize(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	updated, _ := model.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	im, ok := updated.(InteractiveModel)
	if !ok {
		t.Fatalf("expected InteractiveModel, got %T", updated)
	}
	if im.loop.Width != 120 || im.loop.Height != 40 {
		t.Fatalf("expected 120x40, got %dx%d", im.loop.Width, im.loop.Height)
	}
}

func TestInteractiveUpdateQuitsOnCtrlC(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	_, cmd := model.Update(tea.KeyPressMsg(tea.Key{Code: 'c', Mod: tea.ModCtrl}))
	if cmd == nil {
		t.Fatal("Ctrl+C should produce a quit command")
	}
	// Execute the command in a goroutine with a timeout so a
	// stuck cmd doesn't hang the test.
	done := make(chan struct{})
	go func() {
		_ = cmd()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("tea.Quit command did not return in 2s")
	}
}

func TestInteractiveUpdateQuitsOnEsc(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	_, cmd := model.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEsc}))
	if cmd == nil {
		t.Fatal("Esc should produce a quit command")
	}
}

func TestInteractiveUpdateQuitsOnQ(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	_, cmd := model.Update(tea.KeyPressMsg(tea.Key{Code: 'q'}))
	if cmd == nil {
		t.Fatal("q should produce a quit command")
	}
}

func TestInteractiveUpdateIgnoresOtherKeys(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	_, cmd := model.Update(tea.KeyPressMsg(tea.Key{Code: 'a'}))
	if cmd != nil {
		t.Fatal("non-quit keys should not produce a command")
	}
}

func TestInteractiveViewRendersStatusBarAndPlaceholder(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	model.loop.Width = 80
	model.loop.Height = 24
	view := model.View()
	content := view.Content
	for _, want := range []string{"bbl loop", "no pane focused"} {
		if !strings.Contains(content, want) {
			t.Errorf("View missing %q\nfull:\n%s", want, content)
		}
	}
}

func TestInteractiveViewRendersFocusedPaneMetadata(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	model.loop.Width = 80
	model.loop.Height = 24
	// Add a focused pane.
	tab := model.loop.Workspaces[0].Tabs[0]
	updated, err := tab.AddPane(PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: model.loop.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Cwd:         "/tmp",
		Status:      StatusDrift,
	})
	if err != nil {
		t.Fatalf("AddPane: %v", err)
	}
	model.loop.Workspaces[0].Tabs[0] = updated
	view := model.View()
	content := view.Content
	for _, want := range []string{"pane-1", "session-1", "drift"} {
		if !strings.Contains(content, want) {
			t.Errorf("View missing %q\nfull:\n%s", want, content)
		}
	}
}

func TestInteractiveViewEmptyAfterQuit(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	model.quitting = true
	if got := model.View().Content; got != "" {
		t.Fatalf("quitting model should render empty, got %q", got)
	}
}

func TestClampWidthFallback(t *testing.T) {
	if got := clampWidth(0, 40); got != 40 {
		t.Fatalf("clampWidth(0, 40) = %d, want 40", got)
	}
	if got := clampWidth(120, 40); got != 120 {
		t.Fatalf("clampWidth(120, 40) = %d, want 120", got)
	}
}

func TestPadFooter(t *testing.T) {
	if got := padFooter("q quit", 10); got != "q quit    " {
		t.Fatalf("padFooter short = %q, want padded", got)
	}
	if got := padFooter("very long footer", 5); got != "very long footer" {
		t.Fatalf("padFooter overflow should not truncate, got %q", got)
	}
}
