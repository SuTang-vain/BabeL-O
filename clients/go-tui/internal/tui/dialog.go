package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Dialog is the abstraction a single overlay implements. The
// go-tui dialog system follows crush's pattern (see
// crush/internal/ui/dialog/dialog.go:34-50) but adapted for
// bubbletea v1: HandleMsg returns a tea.Cmd instead of an
// Action any, and View takes a width parameter instead of
// drawing into a uv.Screen.
//
// Lifecycle:
//   - The main model's overlay stack pushes a Dialog when
//     entering the corresponding mode (e.g. modeModelPickApiKey
//     pushes ModelPickApiKeyDialog).
//   - Update() delegates KeyMsg / MouseMsg / custom messages
//     to the top Dialog's HandleMsg.
//   - View() delegates to the top Dialog's View(width) to
//     produce the overlay frame.
//   - The Dialog stays in the stack until its HandleMsg
//     returns a close signal (e.g. via the cmd it returns) or
//     the operator hits Esc (handled by the main model).
type Dialog interface {
	// ID returns a stable identifier for the dialog (used in
	// logs and tests, not for routing). Examples:
	// "modelPickApiKey", "permissionEditor".
	ID() string
	// HandleMsg processes one tea.Msg and returns a follow-up
	// tea.Cmd (or nil). The main model routes messages
	// top-down through the dialog stack; a nil cmd is the
	// "no follow-up action" return.
	HandleMsg(msg tea.Msg) tea.Cmd
	// View renders the dialog at the given width. The main
	// model passes the available terminal width; the dialog
	// is responsible for picking its own height and laying
	// out its parts.
	View(width int) string
}

// RenderContext is a builder for dialog views. It centralises
// the title rendering, the body part list, and the help / hint
// row that appears at the bottom of every overlay.
//
// Pattern (matching crush's RenderContext at
// crush/internal/ui/dialog/common.go:59-171):
//
//	rc := NewRenderContext(width)
//	rc.Title = "Editing rule for Bash"
//	rc.TitleInfo = "step 2 of 3"
//	rc.AddPart(inputView)
//	rc.AddPart(hintView)
//	rc.Help = "↵ confirm  esc back"
//	return rc.Render()
//
// Render joins the parts vertically, surrounds the body with
// the standard permissionFrameStyle (or similar), and
// truncates the help row to fit the width.
type RenderContext struct {
	Title     string
	TitleInfo string // right-aligned chip next to the title (e.g. "step 2/3")
	Width     int
	Parts     []string
	Help      string

	// frameStyle is the lipgloss style applied to the body
	// before joining with the title. Defaults to
	// permissionFrameStyle for backwards compat with the
	// existing 5-option / editor overlays. Callers that want a
	// different frame (e.g. help overlay's plain border) can
	// override it.
	frameStyle lipgloss.Style

	// helpStyle is the lipgloss style applied to the help
	// row. Defaults to mutedStyle so the hints don't compete
	// with the body.
	helpStyle lipgloss.Style
}

// NewRenderContext returns a fresh RenderContext pre-wired
// with the default frame and help styles. Callers can swap
// either via SetFrameStyle / SetHelpStyle before Render().
func NewRenderContext(width int) *RenderContext {
	return &RenderContext{
		Width:      width,
		frameStyle: permissionFrameStyle,
		helpStyle:  mutedStyle,
	}
}

// SetFrameStyle overrides the frame style used to wrap the
// body. Useful for dialogs (like the help overlay) that want
// a different border treatment than the default.
func (rc *RenderContext) SetFrameStyle(s lipgloss.Style) {
	rc.frameStyle = s
}

// SetHelpStyle overrides the help-row style. Defaults to
// mutedStyle (gray) for a low-emphasis hint line.
func (rc *RenderContext) SetHelpStyle(s lipgloss.Style) {
	rc.helpStyle = s
}

// AddPart appends a body part (e.g. a title, an input view, a
// hint line) to the dialog. Parts are joined vertically in
// the order they were added.
func (rc *RenderContext) AddPart(s string) {
	if s == "" {
		return
	}
	rc.Parts = append(rc.Parts, s)
}

// Render produces the final dialog view string: title row +
// body (parts joined vertically, framed) + optional help row.
// The output is the full multi-line string the caller appends
// to the View() output.
func (rc *RenderContext) Render() string {
	body := strings.Join(rc.Parts, "\n")
	if body != "" {
		body = rc.frameStyle.Width(max(0, rc.Width-2)).Render(body)
	}

	lines := []string{}
	if rc.Title != "" {
		title := titleStyle.Render(rc.Title)
		if rc.TitleInfo != "" {
			// Right-align the title info chip on the same
			// row. joinColumns splits the available width
			// between left and right; if the right column
			// is too long for the available space it's
			// truncated.
			title = joinColumns(rc.Width, title, mutedStyle.Render(rc.TitleInfo))
		}
		lines = append(lines, title)
	}
	if body != "" {
		lines = append(lines, body)
	}
	if rc.Help != "" {
		help := rc.helpStyle.Render(truncatePlain(rc.Help, rc.Width))
		lines = append(lines, help)
	}
	return strings.Join(lines, "\n")
}

// InputCursor returns the (x, y) of the input field's cursor
// within a dialog rendered via RenderContext. The caller has
// already produced the dialog's body (typically by calling
// rc.Render()) and is laying the result out at a known
// starting (x0, y0) on the screen. InputCursor adds the
// offset of the title row (1 if Title is set, 0 otherwise) and
// the prompt width of the input box so the cursor lands on
// the first input character.
//
// Crush's InputCursor (crush/internal/ui/dialog/common.go:14-39)
// sums the frame border, padding, margin, and prompt widths.
// go-tui's dialogs use the permissionFrameStyle which has a
// 1-cell border on all sides; the prompt itself is part of
// the body so we don't add a separate prompt-width offset —
// the input view already places the cursor at the right cell.
//
// Returns the absolute (x, y) on the screen.
func InputCursor(x0, y0 int, hasTitle bool, inputView string) (x, y int) {
	x = x0
	y = y0
	if hasTitle {
		y++ // title row
	}
	// The frame style adds 1 cell of top padding before the
	// body content. Even if hasTitle is false, the body
	// still lives inside the frame's top border.
	y++
	// The input's prompt width (e.g. "> " is 2 cells)
	// determines the cursor's x position. We compute the
	// visible prefix length before the cursor cell — for
	// textarea / textinput the placeholder is shown when
	// the value is empty, so the cursor lands right after
	// the prompt.
	x += promptWidth(inputView)
	return x, y
}

// promptWidth returns the visible width of the input's
// leading prompt. It walks the input's rendered view up to
// the first non-prompt character (the placeholder or value
// start). For go-tui's input box this is typically "> "
// (2 cells). We keep it simple here — strip the first
// "prompt-like" prefix using a known prefix length, falling
// back to 2 ("> ") when we can't tell.
func promptWidth(inputView string) int {
	// Strip ANSI escapes for the prefix search.
	plain := stripANSICodes(inputView)
	// Common cases: "> ", "› ", "  " (no prompt).
	if strings.HasPrefix(plain, "> ") {
		return 2
	}
	if strings.HasPrefix(plain, "› ") {
		return 2
	}
	if strings.HasPrefix(plain, "  ") {
		return 2
	}
	return 0
}
