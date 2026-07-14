package tui

import (
	"fmt"
	"strings"
)

// renderAskUserOverlay renders the AskUserQuestion selection overlay.
// It displays the question text, a list of selectable options, and
// keyboard hints. Single-select mode uses cursor-style selection
// (one choice at a time); multi-select mode uses checkbox-style
// (space toggles, enter confirms all).
func (m model) renderAskUserOverlay(width int) string {
	if m.inputMode != modeAskUser || m.pendingQuestion == nil {
		return ""
	}

	rc := NewRenderContext(width)
	rows := []string{
		titleStyle.Render("AskUserQuestion"),
		permissionStyle.Render("The model is asking for your input:"),
		"",
	}

	// Question text
	pq := m.pendingQuestion
	question := strings.TrimSpace(pq.question)
	if question != "" {
		rows = append(rows, wrapPlain(question, max(0, width-4)))
		rows = append(rows, "")
	}

	// Options list
	for i, opt := range pq.options {
		var marker string
		if pq.multiSelect {
			// Checkbox style
			checked := false
			for _, sel := range m.questionSelected {
				if sel == i {
					checked = true
					break
				}
			}
			if checked {
				marker = "[x]"
			} else {
				marker = "[ ]"
			}
		} else {
			// Radio / cursor style
			if i == m.questionCursor {
				marker = "~"
			} else {
				marker = " "
			}
		}
		line := fmt.Sprintf(" %s [%d] %s", marker, i+1, opt.Label)
		if opt.Description != "" {
			line += " — " + strings.TrimSpace(opt.Description)
		}
		rows = append(rows, line)
	}

	rows = append(rows, "")
	if pq.multiSelect {
		rows = append(rows, permissionStyle.Render("▲/↓ select   space toggle   ↵ confirm   esc cancel"))
	} else {
		rows = append(rows, permissionStyle.Render("▲/↓ select   1/2/3/4 choose   ↵ confirm   esc cancel"))
	}

	rc.AddPart(strings.Join(rows, "\n"))
	return rc.Render()
}

// renderAskUserDialog renders a compact version of the question for
// use in the full-screen overlay stack. It is identical to
// renderAskUserOverlay but is exported for use from other packages.
func renderAskUserDialog(m model, width int) string {
	return m.renderAskUserOverlay(width)
}
