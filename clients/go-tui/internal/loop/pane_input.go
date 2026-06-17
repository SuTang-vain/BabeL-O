// internal/loop/pane_input.go
//
// Phase 6d-a of docs/nexus/reference/go-tui-loop-multipane-plan.md:
// pane-local prompt input. This slice intentionally stops at
// "draft + queued prompt" and does not execute the prompt
// against Nexus yet; the next 6d slice can consume
// PaneModel.QueuedPrompt and wire it to the existing session
// stream/input APIs.

package loop

import (
	"strings"
	"time"
)

// PaneInputResult describes what happened when a key was routed
// to the focused pane's input. Mutated is true when the model
// changed; Submitted is non-empty when Enter promoted the draft
// input into PaneModel.QueuedPrompt.
type PaneInputResult struct {
	Mutated   bool
	Submitted string
}

// ApplyPaneInputEvent applies a pane-targeted key event to the
// focused pane. Printable keys append to PaneModel.Input,
// Backspace deletes one rune, and Enter moves the draft into
// QueuedPrompt while appending a local user transcript row so
// the operator sees their own prompt immediately.
func ApplyPaneInputEvent(model LoopModel, event RawEvent) (LoopModel, PaneInputResult) {
	if event.Kind != "key" {
		return model, PaneInputResult{}
	}
	pane, ok := model.FocusedPane()
	if !ok {
		return model, PaneInputResult{}
	}
	switch event.Key {
	case "enter":
		raw := pane.Input
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			return model, PaneInputResult{}
		}
		pane.Input = ""
		pane.QueuedPrompt = raw
		pane.LastEventAt = time.Now().UTC()
		pane.Transcript = append(pane.Transcript, TranscriptItem{
			Role: RoleUser,
			Text: singleLine(trimmed),
		})
		model = model.withPane(pane)
		return model, PaneInputResult{Mutated: true, Submitted: raw}
	case "backspace":
		if pane.Input == "" {
			return model, PaneInputResult{}
		}
		pane.Input = dropLastRune(pane.Input)
		model = model.withPane(pane)
		return model, PaneInputResult{Mutated: true}
	case "tab":
		return model, PaneInputResult{}
	default:
		if !isPrintableKey(event.Key) {
			return model, PaneInputResult{}
		}
		pane.Input += event.Key
		model = model.withPane(pane)
		return model, PaneInputResult{Mutated: true}
	}
}

func dropLastRune(s string) string {
	if s == "" {
		return ""
	}
	runes := []rune(s)
	if len(runes) == 0 {
		return ""
	}
	return string(runes[:len(runes)-1])
}

func singleLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
