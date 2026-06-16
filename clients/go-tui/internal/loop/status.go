// internal/loop/status.go
//
// Phase 4a: runtime-owned status projection to color / symbol /
// badge. The Bubble Tea adapter (Phase 4b) maps ColorName to
// actual lipgloss styles; this layer stays pure so status
// semantics can be tested without any TUI dependency.

package loop

import "strings"

// ColorName is a string color token the Bubble Tea adapter
// translates to a real lipgloss color. Keeping this as a
// dedicated type avoids hard-coded ANSI sequences inside the
// loop package and lets tests assert on intent ("red", not
// "\033[31m").
type ColorName string

const (
	ColorNone   ColorName = ""
	ColorGray   ColorName = "gray"
	ColorBlue   ColorName = "blue"
	ColorGreen  ColorName = "green"
	ColorAmber  ColorName = "amber"
	ColorRed    ColorName = "red"
	ColorMagenta ColorName = "magenta"
)

// SymbolForStatus returns the short ASCII indicator for a
// PaneStatus. Symbols are chosen to be readable in monospace
// terminals and align with common chat / IDE conventions.
func SymbolForStatus(status PaneStatus) string {
	switch status {
	case StatusIdle:
		return "·"
	case StatusWorking:
		return "▶"
	case StatusBlocked:
		return "!"
	case StatusWaiting:
		return "⏸"
	case StatusDrift:
		return "✗"
	case StatusDone:
		return "✓"
	default:
		return "?"
	}
}

// ColorForStatus maps each PaneStatus to a color the runtime
// uses to highlight sidebars / status bars / badges. The
// mapping matches the plan's section 4 color table:
//
//	blocked   → red    (needs user action)
//	drift     → amber  (scope boundary unconfirmed)
//	waiting   → blue   (provider latency / grounding)
//	done      → green  (terminal success)
//	working   → blue   (mid-execution, in-progress)
//	idle      → gray   (no recent activity)
func ColorForStatus(status PaneStatus) ColorName {
	switch status {
	case StatusIdle:
		return ColorGray
	case StatusWorking:
		return ColorBlue
	case StatusBlocked:
		return ColorRed
	case StatusWaiting:
		return ColorBlue
	case StatusDrift:
		return ColorAmber
	case StatusDone:
		return ColorGreen
	default:
		return ColorNone
	}
}

// StatusBadge is the structured form of one status pill.
// `Color` is a string the Bubble Tea adapter translates to
// lipgloss; the loop package never emits ANSI codes directly.
type StatusBadge struct {
	Symbol string
	Text   string
	Color  ColorName
}

// FormatStatusBadge returns the structured badge for a status.
// The Bubble Tea adapter renders it (e.g. "▶ working" in
// blue) by combining the symbol + text with the lipgloss
// style matching Color.
func FormatStatusBadge(status PaneStatus) StatusBadge {
	return StatusBadge{
		Symbol: SymbolForStatus(status),
		Text:   status.String(),
		Color:  ColorForStatus(status),
	}
}

// FormatStatusBadgeLine returns the plain-text rendering used
// by tests and the `bbl loop --status` smoke output. The
// Bubble Tea adapter does its own styling and ignores this
// helper.
func FormatStatusBadgeLine(status PaneStatus) string {
	badge := FormatStatusBadge(status)
	return badge.Symbol + " " + badge.Text
}

// FormatStatusSummary renders a one-line summary suitable for
// the bbl loop status bar. The format is:
//
//	<n> panes · <blocked>/<drift>/<waiting> attention · <focused> focused
//
// The summary intentionally avoids color so tests can assert
// on text directly.
func FormatStatusSummary(model LoopModel) string {
	summary := SummarizePaneList(model)
	focused, _ := model.FocusedPane()
	focusedLabel := "(none)"
	if focused.PaneID != "" {
		focusedLabel = focused.PaneID
	}
	parts := []string{
		formatPanesCount(summary.TotalPanes),
		formatAttention(summary.ByStatus[StatusBlocked], summary.ByStatus[StatusDrift], summary.ByStatus[StatusWaiting]),
		"focused=" + focusedLabel,
	}
	return strings.Join(parts, " · ")
}

func formatPanesCount(n int) string {
	if n == 1 {
		return "1 pane"
	}
	return formatInt(n) + " panes"
}

func formatAttention(blocked, drift, waiting int) string {
	parts := []string{}
	if blocked > 0 {
		parts = append(parts, formatInt(blocked)+" blocked")
	}
	if drift > 0 {
		parts = append(parts, formatInt(drift)+" drift")
	}
	if waiting > 0 {
		parts = append(parts, formatInt(waiting)+" waiting")
	}
	if len(parts) == 0 {
		return "no attention"
	}
	return strings.Join(parts, "/")
}

func formatInt(n int) string {
	const digits = "0123456789"
	if n == 0 {
		return "0"
	}
	out := []byte{}
	for n > 0 {
		out = append([]byte{digits[n%10]}, out...)
		n /= 10
	}
	return string(out)
}
