package tui

import (
	"fmt"
	"strings"
)

// formatToolRiskIcon returns a short, terminal-friendly risk
// marker (e.g. "[read]", "[write]") for the /tools audit row.
// Matches the formatToolAudit column header convention in
// src/cli/toolAuditFormatter.ts (read / write / execute / task).
func formatToolRiskIcon(risk toolRisk) string {
	switch risk {
	case toolRiskRead:
		return "[read]"
	case toolRiskWrite:
		return "[write]"
	case toolRiskExecute:
		return "[execute]"
	case toolRiskTask:
		return "[task]"
	}
	return "[" + fallbackUnknown(string(risk)) + "]"
}

// formatToolSourceTag renders the `source` attribution for
// the audit row. builtin tools get a plain `builtin` tag;
// MCP tools get a `mcp:<serverName>` tag so the user can see
// which MCP server backs each tool. Returns "" when the entry
// has no source attribution.
func formatToolSourceTag(source *toolAuditSource) string {
	if source == nil {
		return ""
	}
	switch source.Type {
	case toolSourceBuiltin:
		return "builtin"
	case toolSourceMCP:
		if server := strings.TrimSpace(source.ServerName); server != "" {
			return "mcp:" + server
		}
		return "mcp"
	}
	return fallbackUnknown(string(source.Type))
}

// formatToolApprovalStatus returns a compact
// "no-approval" / "approval-required" segment for the audit
// row. Matches the formatToolAudit column convention in
// src/cli/toolAuditFormatter.ts.
func formatToolApprovalStatus(requiresApproval bool) string {
	if requiresApproval {
		return "approval-required"
	}
	return "no-approval"
}

// formatToolAuditRow renders a single runtimeToolAuditEntry
// for the /tools audit overlay. The row is one main line +
// optional MCP allow / suggested allow rule second line:
//   - main row: risk + source tag + approval status + name +
//     truncated description
//   - second line (optional): MCP server / allow rule hint
//
// Mirrors the TS TUI toolAuditFormatter formatMcpToolRow +
// formatBuiltinToolRow columns (risk / source / approval /
// name / description / suggested allow rule).
func formatToolAuditRow(entry runtimeToolAuditEntry) []string {
	parts := []string{
		formatToolRiskIcon(entry.Risk),
	}
	if source := formatToolSourceTag(entry.Source); source != "" {
		parts = append(parts, source)
	} else {
		parts = append(parts, "unknown")
	}
	parts = append(parts, formatToolApprovalStatus(entry.RequiresApproval))
	main := strings.Join(parts, " ")
	name := fallbackUnknown(entry.Name)
	// Pad name to a fixed width so the description lines up
	// across rows.
	for len(name) < 14 {
		name += " "
	}
	main += "  " + name
	if description := singleLine(strings.TrimSpace(entry.Description)); description != "" {
		main += "  — " + truncatePlain(description, 80)
	}
	rows := []string{main}
	if entry.MCPServerAllowed {
		rows = append(rows, "  mcp server: allowed")
	}
	if rule := strings.TrimSpace(entry.SuggestedAllowRule); rule != "" {
		rows = append(rows, "  suggested allow rule: "+truncatePlain(rule, 80))
	}
	return rows
}

// buildToolAuditOverlayLines turns the audit snapshot into
// the ordered list of lines the /tools overlay will render.
// Each tool contributes 1-3 lines; the overlay window is
// then clamped in renderToolAuditOverlay. Returns a single
// placeholder line for the empty case. A column header row
// is prepended when the catalog is non-empty so the operator
// can scan the columns at a glance.
func buildToolAuditOverlayLines(entries []runtimeToolAuditEntry) []string {
	if len(entries) == 0 {
		return []string{"No tools registered in the current runtime."}
	}
	lines := []string{formatToolAuditColumnHeader()}
	for _, entry := range entries {
		lines = append(lines, formatToolAuditRow(entry)...)
	}
	return lines
}

// formatToolAuditColumnHeader mirrors the column structure of
// formatToolAuditRow so the header aligns with the data rows.
// The header uses mutedStyle (gray) so it doesn't compete with
// the tool name column.
func formatToolAuditColumnHeader() string {
	return mutedStyle.Render("RISK  SOURCE       APPROVAL          NAME              DESCRIPTION")
}

// summarizeToolAudit is the per-risk count line shown at the
// top of the /tools audit overlay. Returns "no tools" for an
// empty snapshot so the summary line is never blank.
func summarizeToolAudit(entries []runtimeToolAuditEntry) string {
	counts := map[toolRisk]int{}
	for _, entry := range entries {
		counts[entry.Risk]++
	}
	riskOrder := []toolRisk{
		toolRiskExecute,
		toolRiskWrite,
		toolRiskTask,
		toolRiskRead,
	}
	parts := []string{}
	for _, risk := range riskOrder {
		if count := counts[risk]; count > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", risk, count))
		}
	}
	if len(parts) == 0 {
		return "no tools"
	}
	return strings.Join(parts, " · ")
}

// renderToolAuditOverlay paints the multi-line /v1/tools/audit
// view. It is the Phase 4 wire primary UX for the /tools
// slash command. The overlay is composed of:
//   - titleStyle header (Phase 4 wire banner)
//   - summary line (read / write / execute / task counts)
//   - clamped window of buildToolAuditOverlayLines
//   - bottom hint (scroll + close keys)
//
// Outside modeToolAuditOverlay it returns "" so it can be
// unconditionally spliced into the View() parts list.
func (m model) renderToolAuditOverlay(width int) string {
	if m.inputMode != modeToolAuditOverlay {
		return ""
	}
	header := titleStyle.Render("Tools audit")
	summary := summarizeToolAudit(m.toolAuditEntries)
	visibleRows := max(1, m.height-10)
	allLines := buildToolAuditOverlayLines(m.toolAuditEntries)
	maxScroll := max(0, len(allLines)-visibleRows)
	if m.toolAuditScroll > maxScroll {
		end := maxScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[maxScroll:end]
	} else {
		end := m.toolAuditScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[m.toolAuditScroll:end]
	}
	lines := []string{header, divider(width), summary}
	lines = append(lines, allLines...)
	hint := "↑/↓/Tab scroll · esc/enter/q close"
	lines = append(lines, mutedStyle.Render(hint))
	return renderOverlayFrame(width, toolPaletteStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2))))
}
