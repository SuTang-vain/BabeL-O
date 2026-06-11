package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// scrollbar glyphs. Crush uses the same pair (┃ / │) — the thumb
// is a heavier vertical bar so it reads as a distinct handle.
const (
	scrollbarThumbGlyph = "┃"
	scrollbarTrackGlyph = "│"
)

var (
	scrollbarThumbStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("6")) // cyan
	scrollbarTrackStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("8")) // grey
)

// Scrollbar returns a multi-line string of `height` lines that
// renders as a vertical scrollbar column.
//
//	total     total content lines (post-wrap), used to size the thumb
//	viewport  number of visible lines (== m.viewport.Height)
//	offset    current YOffset
//	height    number of rows the scrollbar should occupy
//
// Behaviour:
//   - If total <= viewport, returns `height` track-only lines (no thumb).
//     When the content already fits in the viewport there's nothing to
//     scroll to, so the bar shows a static track.
//   - The thumb is `max(1, height * viewport / total)` rows tall, capped at
//     `height`. Clamping to `height` avoids overflow when the thumb would
//     otherwise consume the whole track (extreme zoom-out).
//   - The thumb position is `offset * trackSpace / maxOffset` so the thumb
//     stays at the top when offset=0 and at the bottom when offset=maxOffset.
func Scrollbar(total, viewport, offset, height int) string {
	if height <= 0 {
		return ""
	}
	track := scrollbarTrackStyle.Render(scrollbarTrackGlyph)
	thumb := scrollbarThumbStyle.Render(scrollbarThumbGlyph)

	if total <= viewport {
		lines := make([]string, height)
		for i := range lines {
			lines[i] = track
		}
		return strings.Join(lines, "\n")
	}

	thumbSize := height * viewport / total
	if thumbSize < 1 {
		thumbSize = 1
	}
	if thumbSize > height {
		thumbSize = height
	}
	maxOffset := total - viewport
	if maxOffset < 1 {
		maxOffset = 1
	}
	trackSpace := height - thumbSize
	if trackSpace < 0 {
		trackSpace = 0
	}
	thumbPos := offset * trackSpace / maxOffset
	if thumbPos < 0 {
		thumbPos = 0
	}
	if thumbPos > trackSpace {
		thumbPos = trackSpace
	}

	lines := make([]string, height)
	for i := 0; i < height; i++ {
		if i >= thumbPos && i < thumbPos+thumbSize {
			lines[i] = thumb
		} else {
			lines[i] = track
		}
	}
	return strings.Join(lines, "\n")
}
