package tui

import (
	"fmt"
	"strings"
)

// buildTaskBoardCompactLines renders a condensed task row for the
// Ctrl+D top card task page. Each row shows a status badge + title.
// This is intentionally simpler than the full /tasks overlay
// formatTaskRow to keep the top card compact.
func buildTaskBoardCompactLines(tasks []nexusTask) []string {
	if len(tasks) == 0 {
		return []string{mutedStyle.Render("No tasks for this session.")}
	}
	lines := make([]string, 0, len(tasks))
	for _, task := range tasks {
		badge := renderStatusBadge(string(task.Status))
		title := truncatePlain(task.Title, 60)
		row := fmt.Sprintf("%s %s", badge, title)
		if source := strings.TrimSpace(string(task.Source)); source != "" {
			row += mutedStyle.Render(" · " + source)
		}
		lines = append(lines, row)
	}
	return lines
}

// renderStatusBadge renders a compact 2-char label with inline 24-bit
// ANSI color for the top-card badge.
func renderStatusBadge(status string) string {
	color := statusBadgeColor(status)
	label := statusBadgeLabel(status)
	return ansiFgColor(color) + label + ansiReset()
}

// statusBadgeLabel returns a compact label for the top-card badge.
func statusBadgeLabel(status string) string {
	switch status {
	case "pending":
		return " ◷ pend"
	case "in_progress":
		return " ◉ run "
	case "blocked":
		return " ⊘ blkd"
	case "completed":
		return " ✓ done"
	case "failed":
		return " ✗ fail"
	case "cancelled":
		return " ⊝ canc"
	default:
		return " ? " + status
	}
}

// statusBadgeColor maps a task status to a hex color string.
func statusBadgeColor(status string) string {
	switch status {
	case "pending":
		return "#878787"
	case "in_progress":
		return "#ffaf00"
	case "blocked":
		return "#ff5555"
	case "completed":
		return "#50fa7b"
	case "failed":
		return "#ff5555"
	case "cancelled":
		return "#878787"
	default:
		return "#878787"
	}
}

// ansiFgColor returns an ANSI 24-bit foreground color escape for the
// given hex string (e.g. "#50fa7b").
func ansiFgColor(hex string) string {
	if len(hex) == 7 && hex[0] == '#' {
		r := hexPair(hex[1:3])
		g := hexPair(hex[3:5])
		b := hexPair(hex[5:7])
		return fmt.Sprintf("\033[38;2;%d;%d;%dm", r, g, b)
	}
	return "\033[38;2;135;135;135m"
}

// ansiReset returns the ANSI reset escape.
func ansiReset() string {
	return "\033[0m"
}

// hexPair decodes a 2-character hex string to an integer 0-255.
func hexPair(s string) int {
	if len(s) < 2 {
		return 0
	}
	return hexDigit(s[0])*16 + hexDigit(s[1])
}

func hexDigit(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c - 'a' + 10)
	case c >= 'A' && c <= 'F':
		return int(c - 'A' + 10)
	default:
		return 0
	}
}