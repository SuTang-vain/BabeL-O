package tui

import (
	"strings"
)

// ButtonOpt describes a single keyboard-hint "button" used in
// footer/help rows. The hotkey character (at UnderlineIndex) is
// rendered with an underline so the operator can spot it at a
// glance, e.g. "enter submit" with `e` underlined.
type ButtonOpt struct {
	// Text is the full label, e.g. "enter submit".
	Text string
	// UnderlineIndex is the 0-based rune index of the character
	// to underline. Use -1 to skip underlining.
	UnderlineIndex int
}

const (
	buttonHotkeyOpen  = "\x1b[1;4m"
	buttonHotkeyClose = "\x1b[0m"
)

// ButtonGroup renders a row of keyboard-hint buttons separated by
// `spacing`. When `spacing` is empty, defaults to "  " (two
// spaces, matching the look of the existing footer hints).
//
// Used in the footer and the help overlay to mark hotkey
// characters (the leading `q` of "q quit when idle", the `e` of
// "enter submit", etc.) so the operator can find the binding
// without scanning every key in the help card.
func ButtonGroup(buttons []ButtonOpt, spacing string) string {
	if len(buttons) == 0 {
		return ""
	}
	if spacing == "" {
		spacing = "  "
	}
	parts := make([]string, len(buttons))
	for i, b := range buttons {
		parts[i] = renderButton(b)
	}
	return strings.Join(parts, spacing)
}

// renderButton renders a single ButtonOpt, applying the underline
// style to the character at UnderlineIndex. Out-of-range indices
// are a no-op (the label is rendered unchanged) so callers can
// pass a label shorter than expected without panicking.
func renderButton(b ButtonOpt) string {
	text := b.Text
	runes := []rune(text)
	if b.UnderlineIndex < 0 || b.UnderlineIndex >= len(runes) {
		return text
	}
	var out strings.Builder
	out.Grow(len(text) + len(buttonHotkeyOpen) + len(buttonHotkeyClose))
	for i, r := range runes {
		if i == b.UnderlineIndex {
			out.WriteString(buttonHotkeyOpen)
			out.WriteRune(r)
			out.WriteString(buttonHotkeyClose)
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}
