package loop

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

func TestExecuteTerminalEventToTranscriptItem(t *testing.T) {
	result, ok := executeTerminalEventToTranscriptItem(json.RawMessage(`{"type":"result","success":true,"message":"ok"}`))
	if !ok || result.Role != RoleSystem || result.Text != "done" {
		t.Fatalf("result transcript = %+v ok=%v", result, ok)
	}
	errItem, ok := executeTerminalEventToTranscriptItem(json.RawMessage(`{"type":"error","code":"X","message":"bad things"}`))
	if !ok || !strings.Contains(errItem.Text, "bad things") {
		t.Fatalf("error transcript = %+v ok=%v", errItem, ok)
	}
}

func TestHandleSubmitDoneMergesEventsAndClearsQueuedPrompt(t *testing.T) {
	model := seedPaneModel(100, 30, 1)
	pane := model.Workspaces[0].Tabs[0].Panes[0]
	pane.QueuedPrompt = "hello"
	model = model.withPane(pane)
	im := NewInteractiveModel(model)
	im.setSubmitInFlight(pane.PaneID)

	cmd := im.handleSubmitDone(submitDoneMsg{
		PaneID: pane.PaneID,
		Prompt: "hello",
		Resp: api.ExecuteResponse{
			SessionID: "session-from-server",
			Success:   true,
			Events: []json.RawMessage{
				json.RawMessage(`{"type":"user_message","text":"hello"}`),
				json.RawMessage(`{"type":"assistant_delta","text":"hi there"}`),
				json.RawMessage(`{"type":"result","success":true,"message":"done"}`),
			},
		},
	})
	if cmd != nil {
		t.Fatalf("nil loopClient should not start follow-up wait, got %T", cmd)
	}
	pane, ok := im.findPaneByID(pane.PaneID)
	if !ok {
		t.Fatal("pane disappeared")
	}
	if im.isSubmitInFlight(pane.PaneID) {
		t.Fatal("submit in-flight should be cleared")
	}
	if pane.QueuedPrompt != "hello" {
		t.Fatalf("QueuedPrompt = %q, want %q (6d-d: preserved for the drain path; loopClient=nil means drain is a no-op)",
			pane.QueuedPrompt, "hello")
	}
	if pane.SessionID != "session-from-server" {
		t.Fatalf("SessionID = %q, want server id", pane.SessionID)
	}
	if pane.Status != StatusDone {
		t.Fatalf("Status = %s, want done", pane.Status)
	}
	if len(pane.Transcript) != 3 {
		t.Fatalf("Transcript length = %d, want 3: %+v", len(pane.Transcript), pane.Transcript)
	}
	if pane.Transcript[1].Role != RoleAssistant || pane.Transcript[1].Text != "hi there" {
		t.Fatalf("assistant event not shaped: %+v", pane.Transcript)
	}
}

func TestHandleSubmitDoneErrorKeepsQueuedPromptVisible(t *testing.T) {
	model := seedPaneModel(100, 30, 1)
	pane := model.Workspaces[0].Tabs[0].Panes[0]
	pane.QueuedPrompt = "retry me"
	model = model.withPane(pane)
	im := NewInteractiveModel(model)
	im.setSubmitInFlight(pane.PaneID)

	im.handleSubmitDone(submitDoneMsg{
		PaneID: pane.PaneID,
		Prompt: "retry me",
		Err:    errors.New("server down"),
	})
	pane, _ = im.findPaneByID(pane.PaneID)
	if im.isSubmitInFlight(pane.PaneID) {
		t.Fatal("submit in-flight should clear on error")
	}
	if pane.QueuedPrompt != "retry me" {
		t.Fatalf("QueuedPrompt = %q, want retry me", pane.QueuedPrompt)
	}
	if pane.Status != StatusWaiting {
		t.Fatalf("Status = %s, want waiting", pane.Status)
	}
	if !strings.Contains(im.activeToast(), "server down") {
		t.Fatalf("toast should mention server error, got %q", im.activeToast())
	}
}

func TestNewInteractiveModelWithExecuteTimeout(t *testing.T) {
	im := NewInteractiveModel(NewLoopModel())
	im = NewInteractiveModelWithExecuteTimeout(im, 42*time.Second)
	if im.executeTimeout != 42*time.Second {
		t.Fatalf("executeTimeout = %v, want 42s", im.executeTimeout)
	}
}
