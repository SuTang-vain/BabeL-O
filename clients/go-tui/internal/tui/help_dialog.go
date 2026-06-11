package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// helpDialog implements Dialog for the modeHelpOverlay overlay.
// It is a stateless view over a (scroll, height) snapshot taken
// from the main model — see model.renderHelp for the bridge.
//
// Per upgrade-plan.md Phase C.4, this migration is structure-only:
//
//   - Visual layout is identical to the pre-migration renderHelp:
//     title + divider + visible window of helpOverlayLines, all
//     wrapped in the standard overlayFrameStyle. The body parts
//     are joined inside the frame (matching the existing look)
//     instead of using RenderContext.Title above the frame.
//   - HandleMsg is a no-op. The existing m.helpScroll mutation
//     in the modeHelpOverlay case of Update() stays the source of
//     truth. Phase C.3 wires HandleMsg through the overlay stack.
//
// The Dialog interface (see dialog.go) is satisfied without
// holding a *model reference: a fresh helpDialog is built per
// frame by model.renderHelp, so there is no cache or
// invalidation concern.
type helpDialog struct {
	scroll int
	height int
}

// newHelpDialog snapshots the model state needed to render the
// help overlay. Construction is cheap (two ints) so the caller
// can build a fresh one per frame.
func newHelpDialog(scroll, height int) *helpDialog {
	return &helpDialog{scroll: scroll, height: height}
}

// ID returns the stable id "helpOverlay", matching the
// modeHelpOverlay inputMode constant for traceability.
func (d *helpDialog) ID() string { return "helpOverlay" }

// HandleMsg is a no-op for C.2 — the main model continues to
// own m.helpScroll mutation via its inputMode dispatch (see the
// modeHelpOverlay case in Update). C.3 will move the handler
// here so the Dialog stack owns the state.
func (d *helpDialog) HandleMsg(_ tea.Msg) tea.Cmd { return nil }

// View renders the help overlay at the given width. Layout
// mirrors the pre-migration renderHelp exactly:
//
//	┌─────────────────────────────┐
//	│ Help                        │   <- titleStyle
//	│ ----------------------------│   <- divider(width)
//	│ <visible helpOverlayLines>  │
//	└─────────────────────────────┘
//
// All wrapped in overlayFrameStyle. The visible window is the
// helpOverlayLines slice clamped by m.height-12 (12 reserves
// space for header / footer chrome) and m.helpScroll.
func (d *helpDialog) View(width int) string {
	rc := NewRenderContext(width)
	rc.SetFrameStyle(overlayFrameStyle)

	visibleRows := max(0, d.height-12)
	maxScroll := max(0, len(helpOverlayLines)-visibleRows)
	scroll := d.scroll
	if scroll > maxScroll {
		scroll = maxScroll
	}
	if scroll < 0 {
		scroll = 0
	}
	end := scroll + visibleRows
	if end > len(helpOverlayLines) {
		end = len(helpOverlayLines)
	}

	body := make([]string, 0, 2+(end-scroll))
	body = append(body, titleStyle.Render("Help"), divider(width))
	body = append(body, helpOverlayLines[scroll:end]...)
	rc.AddPart(strings.Join(body, "\n"))
	return rc.Render()
}
