// internal/loop/submit_prompt.go
//
// Phase 6d-b: turn a pane-local QueuedPrompt into a real
// Nexus /v1/execute call. This is intentionally HTTP-first:
// it closes the "Enter submits to Nexus and events appear in
// the pane" loop without pretending to solve bidirectional
// permission decisions. A later 6d slice can swap the
// transport to the single-pane Go TUI's WebSocket stream path.

package loop

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

const defaultExecuteTimeout = 180 * time.Second

type submitDoneMsg struct {
	PaneID string
	Prompt string
	Resp   api.ExecuteResponse
	Err    error
}

func submitPromptCmd(client *api.Client, pane PaneModel, prompt string, cwd string, timeout time.Duration) tea.Cmd {
	if client == nil || strings.TrimSpace(prompt) == "" {
		return nil
	}
	if timeout <= 0 {
		timeout = defaultExecuteTimeout
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), timeout+5*time.Second)
		defer cancel()
		resp, err := client.ExecutePrompt(ctx, api.ExecutePromptRequest{
			Prompt:    prompt,
			SessionID: pane.SessionID,
			Cwd:       firstNonEmpty(pane.Cwd, cwd),
			TimeoutMs: int(timeout / time.Millisecond),
		})
		return submitDoneMsg{
			PaneID: pane.PaneID,
			Prompt: prompt,
			Resp:   resp,
			Err:    err,
		}
	}
}

func (m *InteractiveModel) startSubmitForPane(pane PaneModel) tea.Cmd {
	if m == nil || m.loopClient == nil {
		return nil
	}
	if strings.TrimSpace(pane.QueuedPrompt) == "" {
		return nil
	}
	if m.isSubmitInFlight(pane.PaneID) {
		return nil
	}
	// Snapshot the prompt + clear it on the model so a
	// second call to findPaneByID (e.g. inside the
	// handleSubmitDone that this cmd triggers) doesn't
	// see the same QueuedPrompt and re-fire a drain.
	// Without this, the drain path is a perpetual
	// submit-loop: every submit resolution sees the
	// preserved prompt and starts a new submit.
	prompt := pane.QueuedPrompt
	pane.QueuedPrompt = ""
	m.setSubmitInFlight(pane.PaneID)
	pane.Status = StatusWorking
	m.loop = m.loop.withPane(pane)
	return submitPromptCmd(m.loopClient, pane, prompt, "", m.executeTimeout)
}

func (m *InteractiveModel) handleSubmitDone(msg submitDoneMsg) tea.Cmd {
	if m == nil {
		return nil
	}
	// submitInFlight is cleared on the success / error /
	// pane-not-found paths below. We track whether we
	// already cleared it so the deferred clear (which
	// always runs at return) doesn't wipe a re-set flag
	// from the queued-next drain path. Without this
	// guard, startSubmitForPane's setSubmitInFlight call
	// is undone the moment handleSubmitDone returns.
	clearedInflight := false
	defer func() {
		if !clearedInflight {
			m.clearSubmitInFlight(msg.PaneID)
		}
	}()
	pane, ok := m.findPaneByID(msg.PaneID)
	if !ok {
		return nil
	}
	if msg.Err != nil {
		pane.Status = StatusWaiting
		m.loop = m.loop.withPane(pane)
		m.toastMessage = "✗ submit failed for " + msg.PaneID + ": " + msg.Err.Error()
		m.toastShownAt = time.Now()
		m.clearSubmitInFlight(msg.PaneID)
		clearedInflight = true
		return nil
	}
	if msg.Resp.SessionID != "" {
		pane.SessionID = msg.Resp.SessionID
	}
	// Don't clear pane.QueuedPrompt here. If the operator
	// pressed Enter on a follow-up while the current submit
	// was in flight, ApplyPaneInputEvent overwrote
	// QueuedPrompt with the new draft; startSubmitForPane
	// returned nil because submitInFlight was set. We need
	// to preserve that overwrite for the drain path below.
	pane.LastEventAt = time.Now()
	for _, raw := range msg.Resp.Events {
		if item, ok := EventToTranscriptItem(raw); ok {
			pane.Transcript = append(pane.Transcript, item)
			continue
		}
		if item, ok := executeTerminalEventToTranscriptItem(raw); ok {
			pane.Transcript = append(pane.Transcript, item)
		}
	}
	if len(pane.Transcript) > maxTranscriptItems {
		pane.Transcript = pane.Transcript[len(pane.Transcript)-maxTranscriptItems:]
	}
	if len(msg.Resp.Events) > 0 {
		pane.LastEventRev += int64(len(msg.Resp.Events))
	}
	if msg.Resp.Success {
		pane.Status = StatusDone
	} else {
		pane.Status = StatusWaiting
	}
	m.loop = m.loop.withPane(pane)
	m.persistSnapshot()
	if m.store != nil && pane.PaneID != "" {
		// Best-effort server-side cursor update can be added
		// once PATCH /loop_state is exposed in the loop API
		// client. Local snapshot already has the updated rev.
	}
	m.toastMessage = "submitted prompt: " + truncatePlain(singleLine(msg.Prompt), 80)
	m.toastShownAt = time.Now()

	// 6d-d: drain the queued-next prompt. If the operator
	// typed and Enter'd another prompt while this one was
	// in flight, pane.QueuedPrompt is non-empty here. The
	// dispatch path (Update → dispatchEvent →
	// startSubmitForPane) called it but it returned nil
	// because submitInFlight was set; we re-fire it now
	// that the flag is clear. If the user has cancelled
	// in the meantime (InterruptionActive), we still let
	// the queued prompt submit — the operator's intent
	// at the time of Enter stands. (A later 6d slice can
	// re-stage / drop on cancel if the UX needs it.)
	//
	// We clear submitInFlight *before* the startSubmitForPane
	// call (the deferred clear runs after the return, so it
	// wouldn't be in time). The new submit is what the flag
	// is meant to gate against — a second concurrent submit
	// for the same pane — and we're the one issuing it.
	if pane.QueuedPrompt != "" {
		m.clearSubmitInFlight(pane.PaneID)
		clearedInflight = true
		return m.startSubmitForPane(pane)
	}
	m.clearSubmitInFlight(msg.PaneID)
	clearedInflight = true
	return m.startWaitForPane(pane)
}

func (m *InteractiveModel) setSubmitInFlight(paneID string) {
	if m.submitInFlight == nil {
		m.submitInFlight = make(map[string]bool)
	}
	m.submitInFlight[paneID] = true
}

func (m *InteractiveModel) clearSubmitInFlight(paneID string) {
	delete(m.submitInFlight, paneID)
}

func (m *InteractiveModel) isSubmitInFlight(paneID string) bool {
	return m.submitInFlight[paneID]
}

func executeTerminalEventToTranscriptItem(raw json.RawMessage) (TranscriptItem, bool) {
	var head struct {
		Type    string `json:"type"`
		Success bool   `json:"success"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return TranscriptItem{}, false
	}
	switch head.Type {
	case "result":
		status := "done"
		if !head.Success {
			status = "not successful"
		}
		return TranscriptItem{Role: RoleSystem, Text: status}, true
	case "error":
		text := strings.TrimSpace(head.Message)
		if text == "" {
			text = head.Code
		}
		if text == "" {
			text = "error"
		}
		return TranscriptItem{Role: RoleSystem, Text: fmt.Sprintf("error: %s", clip(text, 160))}, true
	default:
		return TranscriptItem{}, false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
