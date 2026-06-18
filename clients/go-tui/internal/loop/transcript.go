// internal/loop/transcript.go
//
// Phase 6b of docs/nexus/reference/go-tui-loop-multipane-plan.md
// (§6'): per-pane transcript rendering. PaneModel gains a
// Transcript []TranscriptItem field; this file owns the
// pure-data shaping that turns a transcript into the lines the
// chrome draws inside the focused pane body.
//
// 6b is deliberately render-only: it consumes whatever
// TranscriptItem slice is on the pane and formats it. The
// plumbing that *fills* Transcript (per-pane waitForEvent long
// poll) lands in slice 6c. Until 6c lands the slice is empty
// in the live TUI and the body falls back to the placeholder,
// but tests / future callers can seed a transcript directly.
//
// This file is a render helper, not pure domain data: it shares
// chrome.go's lipgloss dependency for visible-width measurement
// (lipgloss.Width — measures columns, emits no ANSI). The
// returned lines themselves carry no ANSI; chrome.go maps each
// line's Role to a color at draw time. Keeping the width math
// here on lipgloss lets transcript rows align with chrome's
// padOrTruncate column accounting instead of diverging.

package loop

import (
	"strings"

	"charm.land/lipgloss/v2"
)

// TranscriptRole classifies a transcript entry so the renderer
// can color it consistently with the single-pane driver's
// transcript view. Mirrors the role split the Nexus event
// stream already carries (user / assistant / tool / system).
type TranscriptRole int

const (
	// RoleUser is a user-authored prompt turn.
	RoleUser TranscriptRole = iota
	// RoleAssistant is model-generated text (assistant_text /
	// assistant_delta).
	RoleAssistant
	// RoleTool is a tool call or its result (tool_started /
	// tool_completed).
	RoleTool
	// RoleSystem is a boundary / status / error line
	// (scope_boundary, permission, result, error).
	RoleSystem
)

// String renders the role as a short label for the transcript
// line prefix. Kept lowercase + single-word so the prefix stays
// narrow even in a 40-col pane.
func (r TranscriptRole) String() string {
	switch r {
	case RoleUser:
		return "you"
	case RoleAssistant:
		return "ai"
	case RoleTool:
		return "tool"
	case RoleSystem:
		return "sys"
	default:
		return "?"
	}
}

// TranscriptItem is one row of a pane's transcript. Text is the
// already-flattened, single-line content to show (the runtime
// layer / future 6c poll is responsible for collapsing
// multi-line payloads before appending). Rev is the Nexus
// event revision the item came from so de-dup / scroll can
// anchor on it; zero means "synthetic / local-only".
type TranscriptItem struct {
	Role TranscriptRole
	Text string
	Rev  int64
}

// transcriptPrefixWidth is the width of the "<role> " prefix
// (label + one space) every transcript line starts with. Kept
// as a constant so BuildTranscriptLines and any future test
// agree on how much horizontal room the text portion gets.
const transcriptPrefixWidth = 6

// BuildTranscriptLines shapes a pane's Transcript into the
// display lines for the focused pane body. It returns the most
// recent items that fit in `height` rows (oldest of the shown
// window first, newest last — bottom = latest, matching every
// other chat UI). Each line is padded/truncated to exactly
// `width` columns so the caller can join them without further
// shaping.
//
// Returns an empty slice when the transcript is empty or the
// geometry is non-positive; the caller falls back to the
// placeholder in that case. Pure / allocation-only: no I/O.
func BuildTranscriptLines(pane PaneModel, width, height int) []string {
	if height <= 0 || width <= 0 || len(pane.Transcript) == 0 {
		return nil
	}
	// Show the newest items that fit. Take a tail window so a
	// long-running pane doesn't re-render ancient history when
	// it only grew by one event.
	start := len(pane.Transcript) - height
	if start < 0 {
		start = 0
	}
	window := pane.Transcript[start:]
	lines := make([]string, 0, len(window))
	textWidth := width - transcriptPrefixWidth
	if textWidth < 1 {
		textWidth = 1
	}
	for _, item := range window {
		prefix := item.Role.String() + " "
		// Pad the prefix to a fixed column so multi-role
		// transcripts align vertically; the text column
		// then starts at the same offset on every line.
		if w := lipgloss.Width(prefix); w < transcriptPrefixWidth {
			prefix += strings.Repeat(" ", transcriptPrefixWidth-w)
		} else if w > transcriptPrefixWidth {
			// Shouldn't happen with the current labels,
			// but keep the invariant defensive.
			prefix = truncatePlain(prefix, transcriptPrefixWidth)
		}
		body := truncatePlain(strings.TrimSpace(item.Text), textWidth)
		if pad := textWidth - lipgloss.Width(body); pad > 0 {
			body += strings.Repeat(" ", pad)
		}
		lines = append(lines, prefix+body)
	}
	return lines
}
