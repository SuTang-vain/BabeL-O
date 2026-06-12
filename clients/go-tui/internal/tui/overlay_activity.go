package tui

import (
	"fmt"
	"strings"
)

// formatActivityKindIcon returns a short, terminal-friendly
// marker for each activity event kind. The icon list is
// deliberately smaller than the event type list so the
// /activity overlay rows stay scannable.
func formatActivityKindIcon(kind activityEventKind) string {
	switch kind {
	case activityKindToolStarted:
		return "[tool>]"
	case activityKindToolCompleted:
		return "[toolok]"
	case activityKindPermission:
		return "[perm]"
	case activityKindAgentJob:
		return "[agent]"
	case activityKindContextWarning:
		return "[ctx-warn]"
	case activityKindContextBlocking:
		return "[ctx-stop]"
	}
	return "[" + fallbackUnknown(string(kind)) + "]"
}

// buildActivityOverlayLines turns the in-memory activity
// buffer into the ordered list of lines the /activity
// overlay will render. Newest entries are shown first
// (the buffer is appended chronologically). The overlay
// window is then clamped in renderActivityOverlay.
// Returns a single placeholder line for the empty case.
func buildActivityOverlayLines(entries []activityEventEntry) []string {
	if len(entries) == 0 {
		return []string{"No recent activity recorded yet."}
	}
	lines := []string{mutedStyle.Render("  kind · summary · timestamp")}
	// Newest first.
	for index := len(entries) - 1; index >= 0; index-- {
		entry := entries[index]
		row := formatActivityKindIcon(entry.Kind) + "  " + truncatePlain(entry.Summary, 100)
		if entry.Timestamp != "" {
			row += "  " + mutedStyle.Render(entry.Timestamp)
		}
		lines = append(lines, row)
	}
	return lines
}

// summarizeActivityEvents is the per-kind count line shown
// at the top of the activity overlay. Returns "no recent
// activity" for an empty buffer.
func summarizeActivityEvents(entries []activityEventEntry) string {
	counts := map[activityEventKind]int{}
	for _, entry := range entries {
		counts[entry.Kind]++
	}
	order := []activityEventKind{
		activityKindToolStarted,
		activityKindToolCompleted,
		activityKindPermission,
		activityKindAgentJob,
		activityKindContextWarning,
		activityKindContextBlocking,
	}
	parts := []string{}
	for _, kind := range order {
		if count := counts[kind]; count > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", kind, count))
		}
	}
	if len(parts) == 0 {
		return "no recent activity"
	}
	return strings.Join(parts, " · ")
}

// renderActivityOverlay paints the multi-line recent-activity
// view. It is the Phase 6 PR5 primary UX for the /activity
// slash command. The overlay is composed of:
//   - titleStyle header (Phase 6 PR5 banner)
//   - summary line (per-kind count)
//   - clamped window of buildActivityOverlayLines (newest
//     first)
//   - bottom hint (scroll + close keys)
//
// Outside modeActivityOverlay it returns "" so it can be
// unconditionally spliced into the View() parts list.
func (m model) renderActivityOverlay(width int) string {
	if m.inputMode != modeActivityOverlay {
		return ""
	}
	header := titleStyle.Render("Activity")
	summary := summarizeActivityEvents(m.activityEvents)
	visibleRows := max(1, m.height-10)
	allLines := buildActivityOverlayLines(m.activityEvents)
	maxScroll := max(0, len(allLines)-visibleRows)
	if m.activityOverlayScroll > maxScroll {
		end := maxScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[maxScroll:end]
	} else {
		end := m.activityOverlayScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[m.activityOverlayScroll:end]
	}
	lines := []string{header, divider(width), summary}
	lines = append(lines, allLines...)
	hint := "↑/↓/Tab scroll · esc/enter/q close"
	lines = append(lines, mutedStyle.Render(hint))
	return renderOverlayFrame(width, activityStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2))))
}
