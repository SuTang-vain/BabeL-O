package tui

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
)

// askUserOverlayPrefix is the fixed prefix the cursor uses on
// the first visual line of an option row. The frame wraps the
// body with a 1-cell border on each side, so the inner width
// is (frameWidth - 2). We reserve the prefix width before
// wrapping label+description so the marker / digit / first
// letter stays aligned across options.
const askUserOverlayPrefix = " ~ [1] "

// askUserOverlayMultiPrefix is the same prefix shape for the
// multi-select (checkbox) variant: a space, the checkbox
// glyph "[x]" or "[ ]", the digit "[1]", then a trailing
// space before the label. Kept the same width as
// askUserOverlayPrefix so columns line up regardless of mode.
const askUserOverlayMultiPrefix = " [x] [1] "

// renderAskUserOverlay renders the AskUserQuestion selection
// overlay. It displays the question text, a list of
// selectable options, and keyboard hints.
//
// Single-select mode uses a `~` cursor marker; multi-select
// mode uses checkbox markers (`[x]` / `[ ]`) with space to
// toggle and Enter to confirm.
//
// The overlay is rendered through the standard RenderContext
// pipeline (see dialog.go) so its title sits above the
// frame border and the hint row sits below the frame. The
// frame uses permissionFrameStyle (yellow border) so the
// selection panel reads with the same emphasis as the live
// permission_request decision panel — both are operator
// prompts that need a decision before the next turn can
// proceed, so they share the loud yellow frame.
//
// Each option line is wrapped to the inner frame width so a
// long label or description cannot push the cursor past the
// right border of the panel. The marker and digit prefix
// stay on the first wrapped line; continuation lines are
// indented to the same column so the visual cursor reads
// as a column, not a sequence of unaligned markers.
func (m model) renderAskUserOverlay(width int) string {
	if m.inputMode != modeAskUser || m.pendingQuestion == nil {
		return ""
	}

	rc := NewRenderContext(width)
	rc.SetFrameStyle(permissionFrameStyle)
	rc.Title = "AskUserQuestion"

	pq := m.pendingQuestion
	if pq.header != "" {
		if pq.multiSelect {
			rc.TitleInfo = pq.header + "  ·  multi-select"
		} else {
			rc.TitleInfo = pq.header + "  ·  single-select"
		}
	} else if pq.multiSelect {
		rc.TitleInfo = "multi-select"
	} else {
		rc.TitleInfo = "single-select"
	}

	// Inner width = frame total - 2 (1-cell border on each
	// side). RenderContext also pads 1 cell on each side, so
	// subtract another 2 for the body padding before computing
	// the wrap width.
	innerWidth := max(0, width-4)

	body := []string{
		permissionStyle.Render("The model is asking for your input:"),
	}
	if question := strings.TrimSpace(pq.question); question != "" {
		body = append(body, "")
		body = append(body, wrapPlain(question, innerWidth))
	}

	body = append(body, "")

	for i, opt := range pq.options {
		body = append(body, renderAskUserOptionRow(i, opt, pq.multiSelect, m.questionCursor, m.questionSelected, innerWidth))
	}

	rc.AddPart(strings.Join(body, "\n"))

	if pq.multiSelect {
		rc.Help = "▲/↓ select   space toggle   ↵ confirm   esc cancel"
	} else {
		rc.Help = "▲/↓ select   1/2/3/4 quick-pick   ↵ confirm   esc cancel"
	}

	return rc.Render()
}

// askUserOverlayPrefixWidth returns the visible width of the
// fixed prefix on the first line of each option row. The
// multi-select prefix is the same shape as the single-select
// prefix (`[x]`/` ` for the checkbox vs. `~`/` ` for the
// cursor), so the visual column of the label is identical
// regardless of mode.
func askUserOverlayPrefixWidth(multiSelect bool) int {
	if multiSelect {
		return lipgloss.Width(askUserOverlayMultiPrefix)
	}
	return lipgloss.Width(askUserOverlayPrefix)
}

// renderAskUserOptionRow builds the multi-line representation
// of a single option. The first line carries the cursor /
// checkbox marker and the digit prefix; continuation lines
// are indented to the same column so wrapped descriptions
// stay aligned with their label.
//
// `innerWidth` is the total width available inside the
// frame border (including the prefix column). The function
// subtracts the prefix width itself so callers don't need
// to know whether the marker is `~` or `[x]`.
func renderAskUserOptionRow(idx int, opt questionOption, multiSelect bool, cursor int, selected []int, innerWidth int) string {
	var marker string
	if multiSelect {
		marker = "[ ]"
		for _, sel := range selected {
			if sel == idx {
				marker = "[x]"
				break
			}
		}
	} else {
		if idx == cursor {
			marker = "~"
		} else {
			marker = " "
		}
	}

	label := strings.TrimSpace(opt.Label)
	desc := strings.TrimSpace(opt.Description)
	prefix := fmt.Sprintf(" %s [%d] ", marker, idx+1)
	prefixWidth := lipgloss.Width(prefix)
	wrapWidth := max(1, innerWidth-prefixWidth)

	// Build the post-prefix content. label is always
	// present; description is optional and joined with an em
	// dash when present so a long single-line description
	// still wraps cleanly.
	postfix := label
	if desc != "" {
		postfix = label + " — " + desc
	}

	wrapped := wrapPlain(postfix, wrapWidth)
	lines := strings.Split(wrapped, "\n")
	// Continuation rows are indented to the same column as the
	// label (i.e. a run of spaces matching prefixWidth), NOT with
	// the full prefix again. Repeating the marker (~ / [x]) and the
	// digit [1] on every wrapped line made a single long option read
	// as a stack of independent options, which also broke the
	// cursor navigation (the operator thought there were 7 options
	// when there was only one). The indent is whitespace-only so
	// the continuation stays visually grouped under its option.
	indent := strings.Repeat(" ", prefixWidth)
	for i := 1; i < len(lines); i++ {
		lines[i] = indent + lines[i]
	}
	result := prefix + lines[0]
	for i := 1; i < len(lines); i++ {
		result += "\n" + lines[i]
	}
	return result
}
