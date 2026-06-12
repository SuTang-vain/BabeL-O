package tui

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// formatAgentStatusIcon returns a short, terminal-friendly
// status marker (e.g. "[running]", "[done]", "[failed]"). The
// TS TUI uses Unicode icons in chalk colors, but the Go TUI
// keeps it plain text so the cooked-mode PTY harness can
// assert on the literal string without stripping ANSI codes.
// Unknown statuses fall through to the raw text so a
// server-side addition cannot crash the client.
func formatAgentStatusIcon(status agentJobStatus) string {
	switch status {
	case agentStatusQueued:
		return "[queue]"
	case agentStatusRunning:
		return "[run]"
	case agentStatusWaitingPermission:
		return "[perm]"
	case agentStatusCompleted:
		return "[done]"
	case agentStatusFailed:
		return "[fail]"
	case agentStatusCancelled:
		return "[cancel]"
	}
	return "[" + fallbackUnknown(string(status)) + "]"
}

// formatAgentGovernanceSummary returns a compact
// "active N/M · depth D/maxD" segment for the agent overlay
// row. Returns "" when no governance blob is attached so the
// row stays tight for default-nothing jobs.
func formatAgentGovernanceSummary(governance *agentJobGovernance) string {
	if governance == nil {
		return ""
	}
	parts := []string{
		fmt.Sprintf("active %d/%d", governance.ActiveAgents, governance.MaxConcurrentAgents),
	}
	if governance.MaxDepth > 0 || governance.Depth > 0 {
		parts = append(parts, fmt.Sprintf("depth %d/%d", governance.Depth, governance.MaxDepth))
	}
	return strings.Join(parts, " · ")
}

// formatAgentJobRow renders a single agent job for the agent
// status overlay. The row is two physical lines:
//   - main row: status icon + agentType + child=<shortID> +
//     optional governance summary + optional task#<id>
//   - indent row: first 80 chars of the prompt (single line,
//     indent-prefixed) for human-scannability
//
// Mirrors the TS TUI formatMultiAgentRow shape (status + source
// + agentType + depth + title + child + governance + transcript
// path) but collapses the transcriptPath line since the Go
// TUI overlay is read-only and the path is mostly useful for
// `bbl sessions` CLI invocations.
func formatAgentJobRow(job agentJob) []string {
	parts := []string{
		formatAgentStatusIcon(job.Status),
		"job",
		string(fallbackUnknown(string(job.AgentType))),
	}
	if job.Governance != nil && job.Governance.Depth > 0 {
		parts = append(parts, fmt.Sprintf("d%d", job.Governance.Depth))
	}
	main := strings.Join(parts, " ")
	if child := strings.TrimSpace(job.ChildSessionID); child != "" {
		main += "  child=" + shortID(child)
	}
	if gov := formatAgentGovernanceSummary(job.Governance); gov != "" {
		main += "  " + gov
	}
	if taskID := strings.TrimSpace(job.ParentTaskID); taskID != "" {
		main += "  task=#" + taskID
	}
	rows := []string{main}
	if prompt := singleLine(strings.TrimSpace(job.Prompt)); prompt != "" {
		rows = append(rows, "  prompt: "+truncatePlain(prompt, 100))
	}
	return rows
}

// buildAgentOverlayLines turns the agent jobs snapshot into the
// ordered list of lines the agent overlay will render. Each
// job contributes 1-2 lines (main row + optional prompt row);
// the overlay window is then clamped in renderAgentOverlay.
// Returns a single placeholder line for the empty case so the
// caller can show a friendly message.
func buildAgentOverlayLines(jobs []agentJob) []string {
	if len(jobs) == 0 {
		return []string{"No agent jobs for this session."}
	}
	lines := []string{mutedStyle.Render("  job_id · type · status · active/max · depth/max · isolation · fork_mode")}
	for _, job := range jobs {
		lines = append(lines, formatAgentJobRow(job)...)
	}
	return lines
}

// formatSubAgentRow renders a single subAgentEntry (Phase 6
// PR6) for the merged /agents overlay. The source tag is
// "loop" so the user can tell at a glance which rows came
// from the AgentJob REST endpoint vs the AgentLoop event
// aggregator. Status uses the same agentJobStatus icon set
// as formatAgentJobRow so the two sources feel like a single
// list.
func formatSubAgentRow(entry subAgentEntry) []string {
	status := agentJobStatus(entry.Status)
	icon := formatAgentStatusIcon(status)
	parts := []string{
		icon,
		"loop",
		"subagent",
	}
	if entry.ParentTask != "" {
		parts = append(parts, "task=#"+entry.ParentTask)
	}
	main := strings.Join(parts, " ")
	main += "  id=" + shortID(entry.ID)
	if entry.Title != "" {
		main += "  " + truncatePlain(entry.Title, 80)
	}
	rows := []string{main}
	if entry.UpdatedAt != "" {
		rows = append(rows, "  updated="+entry.UpdatedAt)
	}
	return rows
}

// buildMergedAgentOverlayLines merges the AgentJob REST rows
// (Phase 6 PR3) with the in-memory subAgentEntry rows (Phase
// 6 PR6) for the /agents overlay. Jobs come first (they have
// stable session-bound identity); sub-agent rows are appended
// after with a `---` separator so the user can distinguish
// the two sources. The placeholder falls through to the
// "No agent jobs for this session." message when both
// sources are empty.
func buildMergedAgentOverlayLines(jobs []agentJob, subs map[string]subAgentEntry) []string {
	jobLines := buildAgentOverlayLines(jobs)
	if len(subs) == 0 {
		return jobLines
	}
	lines := append([]string{}, jobLines...)
	if len(jobs) > 0 {
		lines = append(lines, mutedStyle.Render("  --- AgentLoop sub-agents (event-aggregated) ---"))
	}
	// Stable order: alphabetical by id. (The map is
	// insertion-ordered, but Go intentionally randomizes
	// iteration; sort for deterministic PTY assertions.)
	ids := make([]string, 0, len(subs))
	for id := range subs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		lines = append(lines, formatSubAgentRow(subs[id])...)
	}
	return lines
}

// renderAgentOverlay paints the multi-line multi-agent status
// view. It is the Phase 6 PR3 primary UX for the /agents slash
// command. The overlay is composed of:
//   - titleStyle header (Phase 6 PR3 banner + session id)
//   - summary line (running / waiting_permission / queued /
//     failed / cancelled / completed counts)
//   - clamped window of buildAgentOverlayLines
//   - bottom hint (scroll + close keys)
//
// Outside modeAgentOverlay it returns "" so it can be
// unconditionally spliced into the View() parts list.
func (m model) renderAgentOverlay(width int) string {
	if m.inputMode != modeAgentOverlay {
		return ""
	}
	header := titleStyle.Render("Agents · " + shortID(m.sessionID))
	summary := summarizeAgentJobs(m.agentJobs)
	if subCount := m.subAgentRunningCount(); subCount > 0 {
		// Phase 6 PR6: include the running sub-agent count in
		// the summary so the user can correlate the running
		// badge with the rows in the overlay.
		summary += " · sub running " + strconv.Itoa(subCount)
	}
	visibleRows := max(1, m.height-10)
	allLines := buildMergedAgentOverlayLines(m.agentJobs, m.subAgents)
	maxScroll := max(0, len(allLines)-visibleRows)
	if m.agentOverlayScroll > maxScroll {
		// View() is read-only; clamp locally for the rendered
		// slice. The next key event will reconcile
		// m.agentOverlayScroll.
		end := maxScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[maxScroll:end]
	} else {
		end := m.agentOverlayScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[m.agentOverlayScroll:end]
	}
	lines := []string{header, divider(width), summary}
	lines = append(lines, allLines...)
	hint := "↑/↓/Tab scroll · esc/enter/q close"
	lines = append(lines, mutedStyle.Render(hint))
	return renderOverlayFrame(width, agentStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2))))
}

// summarizeAgentJobs is the per-status count line shown at the
// top of the agent overlay. Mirrors summarizeMultiAgentRows in
// src/cli/renderEvents.ts. Returns "no agent jobs" for an
// empty snapshot so the summary line is never blank.
func summarizeAgentJobs(jobs []agentJob) string {
	counts := map[agentJobStatus]int{}
	for _, job := range jobs {
		counts[job.Status]++
	}
	statusOrder := []agentJobStatus{
		agentStatusRunning,
		agentStatusWaitingPermission,
		agentStatusQueued,
		agentStatusFailed,
		agentStatusCancelled,
		agentStatusCompleted,
	}
	parts := []string{}
	for _, status := range statusOrder {
		if count := counts[status]; count > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", status, count))
		}
	}
	if len(parts) == 0 {
		return "no agent jobs"
	}
	return strings.Join(parts, " · ")
}
