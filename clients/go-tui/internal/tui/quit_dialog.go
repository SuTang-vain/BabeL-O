package tui

import (
	"strings"

	tea "charm.land/bubbletea/v2"
)

// quitDialog renders the confirmation panel shown above the editor after
// ctrl+c. The main model owns key routing; this dialog is render-only.
type quitDialog struct {
	selected int
}

func newQuitDialog(selected int) *quitDialog {
	if selected < 0 || selected > 1 {
		selected = 1
	}
	return &quitDialog{selected: selected}
}

func (d *quitDialog) ID() string { return "quitConfirm" }

func (d *quitDialog) HandleMsg(_ tea.Msg) tea.Cmd { return nil }

func (d *quitDialog) View(width int) string {
	rc := NewRenderContext(width)
	rc.SetFrameStyle(overlayFrameStyle)
	rc.Help = "↑↓ choose · enter confirm · esc cancel"
	choices := []struct {
		label string
		help  string
	}{
		{"Quit now", "exit BabeL-O"},
		{"Cancel", "return to chat"},
	}
	rows := []string{
		titleStyle.Render("Quit BabeL-O?"),
		"",
	}
	for i, choice := range choices {
		marker := "  "
		style := mutedStyle
		if i == d.selected {
			marker = "> "
			style = focusedLineStyle
		}
		rows = append(rows, marker+style.Render(padVisible(choice.label, 12))+" "+mutedStyle.Render(choice.help))
	}
	rc.AddPart(strings.Join(rows, "\n"))
	return rc.Render()
}
