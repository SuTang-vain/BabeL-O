package loop

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestApplyPaneInputEventAppendsToFocusedPaneOnly(t *testing.T) {
	model := seedPaneModel(100, 30, 2)
	model.Focus.PaneIdx = 1

	updated, result := ApplyPaneInputEvent(model, RawEvent{Kind: "key", Key: "x"})
	if !result.Mutated {
		t.Fatal("printable key should mutate focused pane input")
	}
	first := updated.Workspaces[0].Tabs[0].Panes[0]
	second := updated.Workspaces[0].Tabs[0].Panes[1]
	if first.Input != "" {
		t.Fatalf("unfocused pane input = %q, want empty", first.Input)
	}
	if second.Input != "x" {
		t.Fatalf("focused pane input = %q, want x", second.Input)
	}
}

func TestApplyPaneInputEventBackspaceIsRuneAware(t *testing.T) {
	model := seedPaneModel(100, 30, 1)
	model.Workspaces[0].Tabs[0].Panes[0].Input = "go你"

	updated, result := ApplyPaneInputEvent(model, RawEvent{Kind: "key", Key: "backspace"})
	if !result.Mutated {
		t.Fatal("backspace should mutate non-empty input")
	}
	got := updated.Workspaces[0].Tabs[0].Panes[0].Input
	if got != "go" {
		t.Fatalf("input after rune-aware backspace = %q, want go", got)
	}
}

func TestApplyPaneInputEventEnterQueuesPromptAndTranscript(t *testing.T) {
	model := seedPaneModel(100, 30, 1)
	model.Workspaces[0].Tabs[0].Panes[0].Input = "  hello pane  "

	updated, result := ApplyPaneInputEvent(model, RawEvent{Kind: "key", Key: "enter"})
	if !result.Mutated {
		t.Fatal("enter should mutate when input is non-empty")
	}
	if strings.TrimSpace(result.Submitted) != "hello pane" {
		t.Fatalf("Submitted = %q, want hello pane", result.Submitted)
	}
	pane := updated.Workspaces[0].Tabs[0].Panes[0]
	if pane.Input != "" {
		t.Fatalf("Input after submit = %q, want empty", pane.Input)
	}
	if pane.QueuedPrompt != "  hello pane  " {
		t.Fatalf("QueuedPrompt = %q, want raw prompt", pane.QueuedPrompt)
	}
	if len(pane.Transcript) != 1 || pane.Transcript[0].Role != RoleUser || pane.Transcript[0].Text != "hello pane" {
		t.Fatalf("unexpected transcript after submit: %+v", pane.Transcript)
	}
}

func TestInteractiveDispatchRoutesInputWithoutPersistingSnapshot(t *testing.T) {
	model := seedPaneModel(100, 30, 1)
	store, err := NewStore(t.TempDir() + "/state.json")
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer store.Close()
	if err := store.Replace(snapshotFromLoop(model)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	im := NewInteractiveModelWithStore(model, store)

	cmd := im.dispatchEvent(RawEvent{Kind: "key", Key: "a"})
	if cmd != nil {
		t.Fatalf("input dispatch should not return side-effect cmd, got %T", cmd)
	}
	pane := im.loop.Workspaces[0].Tabs[0].Panes[0]
	if pane.Input != "a" {
		t.Fatalf("pane input = %q, want a", pane.Input)
	}
	if snap := store.Snapshot(); len(snap.Panes) != 1 || snap.Panes[0].LastRev != 0 {
		t.Fatalf("input dispatch should not rewrite snapshot, got %+v", snap)
	}
	if im.activeToast() != "" {
		t.Fatalf("input typing should not produce save toast, got %q", im.activeToast())
	}
}

func TestInteractiveEnterQueuesFocusedPanePrompt(t *testing.T) {
	model := seedPaneModel(100, 30, 1)
	im := NewInteractiveModel(model)

	keys := []string{"h", "i", "enter"}
	for _, key := range keys {
		_, cmd := im.Update(tea.KeyPressMsg{Code: rune(key[0]), Text: key})
		if cmd != nil {
			t.Fatalf("Update(%q) returned unexpected cmd %T", key, cmd)
		}
	}
	pane := im.loop.Workspaces[0].Tabs[0].Panes[0]
	if pane.QueuedPrompt != "hi" {
		t.Fatalf("QueuedPrompt = %q, want hi", pane.QueuedPrompt)
	}
	if len(pane.Transcript) != 1 || pane.Transcript[0].Text != "hi" {
		t.Fatalf("submit should append local user transcript, got %+v", pane.Transcript)
	}
}

func TestRenderFocusedPaneBodyShowsInputAndQueuedPrompt(t *testing.T) {
	model := seedPaneModel(100, 30, 1)
	pane := model.Workspaces[0].Tabs[0].Panes[0]
	pane.Input = "draft"
	pane.QueuedPrompt = "queued prompt"
	model = model.withPane(pane)

	body := stripANSI(renderFocusedPaneBody(model, 80, 8))
	for _, want := range []string{"> draft", "queued: queued prompt"} {
		if !strings.Contains(body, want) {
			t.Fatalf("focused body missing %q:\n%s", want, body)
		}
	}
}
