package tui

import (
	"fmt"
	"strings"
)

// formatTaskStatusIcon returns a short, terminal-friendly
// status marker (e.g. "[run]", "[done]", "[fail]") for the
// task board. Mirrors the formatAgentStatusIcon shape so the
// two overlays feel like siblings.
func formatTaskStatusIcon(status taskStatus) string {
	switch status {
	case taskStatusPending:
		return "[pend]"
	case taskStatusInProgress:
		return "[run]"
	case taskStatusBlocked:
		return "[block]"
	case taskStatusCompleted:
		return "[done]"
	case taskStatusFailed:
		return "[fail]"
	case taskStatusCancelled:
		return "[cancel]"
	}
	return "[" + fallbackUnknown(string(status)) + "]"
}

// formatTaskReviewSummary renders a compact
// "review=approved" / "review=pending" / "review=rejected"
// segment for the task row. Returns "" when the task has no
// review row.
func formatTaskReviewSummary(review *taskReview) string {
	if review == nil {
		return ""
	}
	return "review=" + string(fallbackUnknown(string(review.Status)))
}

// formatTaskWorktreeRecoveryAction reads the worktree
// recovery metadata blob (set by the worktree lifecycle hook
// on task metadata) and renders a compact
// "recovery=continue/abandon/keep" segment. Returns "" when
// the task has no worktree recovery metadata. The TS TUI
// worktree flow panel uses the same metadata convention.
func formatTaskWorktreeRecoveryAction(metadata map[string]any) string {
	if metadata == nil {
		return ""
	}
	recovery, ok := metadata["worktreeRecovery"].(map[string]any)
	if !ok {
		return ""
	}
	action := stringField(recovery, "action")
	if action == "" {
		return ""
	}
	preservePath := stringField(recovery, "preservePath")
	if preservePath != "" {
		return "recovery=" + action + " path=" + shortID(preservePath)
	}
	return "recovery=" + action
}

// formatTaskRow renders a single nexusTask for the task board
// overlay. The row is one main line + optional second line
// for the description / worktree recovery hint:
//   - main row: status icon + task#<id> + retry=N + review
//   - second row (optional): source + description or recovery
//
// Mirrors the TS TUI task board UX (status / title /
// retryCount / review / worktree recovery action).
func formatTaskRow(task nexusTask) []string {
	parts := []string{
		formatTaskStatusIcon(task.Status),
		"#" + fallbackUnknown(task.TaskID),
	}
	if task.RetryCount > 0 {
		parts = append(parts, fmt.Sprintf("retry=%d", task.RetryCount))
	}
	if review := formatTaskReviewSummary(task.Review); review != "" {
		parts = append(parts, review)
	}
	main := strings.Join(parts, " ")
	if title := singleLine(strings.TrimSpace(task.Title)); title != "" {
		main += "  " + truncatePlain(title, 80)
	}
	rows := []string{main}
	if recovery := formatTaskWorktreeRecoveryAction(task.Metadata); recovery != "" {
		rows = append(rows, "  "+recovery)
	}
	if source := strings.TrimSpace(string(task.Source)); source != "" {
		rows = append(rows, "  source="+source)
	}
	return rows
}

// buildTaskBoardLines turns the task snapshot into the ordered
// list of lines the task board will render. Each task
// contributes 1-3 lines (main row + optional recovery +
// optional source); the overlay window is then clamped in
// renderTaskBoard. Returns a single placeholder line for the
// empty case so the caller can show a friendly message.
func buildTaskBoardLines(tasks []nexusTask) []string {
	if len(tasks) == 0 {
		return []string{"No tasks for this session."}
	}
	lines := []string{mutedStyle.Render("  task_id · status · source · owner · title")}
	for _, task := range tasks {
		lines = append(lines, formatTaskRow(task)...)
	}
	return lines
}

// summarizeTaskBoard is the per-status count line shown at
// the top of the task board overlay. Returns "no tasks" for
// an empty snapshot so the summary line is never blank.
func summarizeTaskBoard(tasks []nexusTask) string {
	counts := map[taskStatus]int{}
	for _, task := range tasks {
		counts[task.Status]++
	}
	statusOrder := []taskStatus{
		taskStatusInProgress,
		taskStatusBlocked,
		taskStatusPending,
		taskStatusFailed,
		taskStatusCancelled,
		taskStatusCompleted,
	}
	parts := []string{}
	for _, status := range statusOrder {
		if count := counts[status]; count > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", status, count))
		}
	}
	if len(parts) == 0 {
		return "no tasks"
	}
	return strings.Join(parts, " · ")
}

// renderTaskBoard paints the multi-line task board view. It
// is the Phase 6 PR4 primary UX for the /tasks slash command.
// The overlay is composed of:
//   - titleStyle header (Phase 6 PR4 banner + session id)
//   - summary line (in_progress / blocked / pending / failed
//     / cancelled / completed counts)
//   - clamped window of buildTaskBoardLines
//   - bottom hint (scroll + close keys)
//
// Outside modeTaskBoard it returns "" so it can be
// unconditionally spliced into the View() parts list.
func (m model) renderTaskBoard(width int) string {
	if m.inputMode != modeTaskBoard {
		return ""
	}
	header := titleStyle.Render("Tasks · " + shortID(m.sessionID))
	summary := summarizeTaskBoard(m.taskBoard)
	visibleRows := max(1, m.height-10)
	allLines := buildTaskBoardLines(m.taskBoard)
	maxScroll := max(0, len(allLines)-visibleRows)
	if m.taskBoardScroll > maxScroll {
		end := maxScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[maxScroll:end]
	} else {
		end := m.taskBoardScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[m.taskBoardScroll:end]
	}
	lines := []string{header, divider(width), summary}
	lines = append(lines, allLines...)
	hint := "↑/↓/Tab scroll · esc/enter/q close"
	lines = append(lines, mutedStyle.Render(hint))
	return renderOverlayFrame(width, taskBoardStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2))))
}
