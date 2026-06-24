package tui

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
)

// Skill execution governance plan P3 Layer 4 — Go TUI
// /skill slash command family. The three read-only overlays
// (list / show / validate) render against typed mirrors of
// the Nexus /v1/skills/* responses (declared in tui.go). Each
// render is a viewport over an in-memory snapshot — no
// per-row actions yet, no fuzzy filter yet, no source /
// status filter yet. All three are kept strictly read-only:
// /skill run is deferred to a follow-up PR (see the note on
// modeSkillListOverlay in tui.go).

// buildSkillListOverlayLines turns the loaded skill registry
// snapshot into the ordered list of lines the /skill list
// overlay will render. Each skill occupies exactly one line
// in the form:
//
//   ▸  ●  <id-padded-18>  [<risk>]  <description>
//
// (Selected row: ▸ prefix in focused style. Non-selected
// rows use two spaces as a placeholder so the dot/id/risk/
// description columns line up across the whole list — the
// eye can then track the marker column down the page
// without re-aligning on each row. The same pattern is
// used by /sessions and /memory.)
//
// The dot is colored by risk so the operator can scan the
// list at a glance (green = read, yellow = write, red =
// execute / network, blue = task). The status glyph mirrors
// the dot-list convention from the upstream TS TUI skill
// list (image-ref-2026-06-24-10.46) and gives the overlay
// the same visual rhythm as /agents' agent-list view.
//
// The selected row (by index into entries) is wrapped in
// focusedLineStyle — the same lipgloss foreground("252")
// highlight used by /inbox selected rows and the slash
// palette focus row. Truncation here is column-width
// bounded so the row never wraps to a second line (the
// earlier 8-column grid could overflow terminal width and
// produce the visual breaks visible in
// image-ref-2026-06-24-10.43). Empty snapshots render a
// single placeholder line so the overlay is never blank.
//
// `innerWidth` is the on-screen column budget the caller has
// for one row (typically terminal-width − 2 for the overlay
// frame). The function hard-truncates each description to
// the remaining space after the fixed prefix (marker 2 +
// dot 2 + id 18 + sep 2 + risk ≤9 + sep 2 = ≤35 cells) so
// a long description never wraps to a second visual line.
// A width of 0 (or one that leaves no room for the fixed
// prefix) is clamped to a minimal cap so the row is still
// rendered as one line.
func buildSkillListOverlayLines(entries []runtimeSkillListEntry, diag runtimeSkillListDiagnostics, selected int, innerWidth int) []string {
	if len(entries) == 0 {
		return []string{"No skills registered in the current runtime."}
	}
	summary := fmt.Sprintf("Skills  ·  %d loaded  ·  skipped=%d overlaid=%d duplicates=%d",
		len(entries), diag.SkippedCount, diag.OverlaidCount, diag.DuplicateCount,
	)
	lines := []string{summary, ""}
	const fixedPrefixCells = 35 // marker(2) + dot(2) + id(18) + sep(2) + risk(≤9) + sep(2)
	descCap := innerWidth - fixedPrefixCells
	if descCap < 4 {
		descCap = 4 // minimum so a 1-char description still fits with "..."
	}
	for i, entry := range entries {
		marker := "  "
		if i == selected {
			marker = "▸ "
		}
		row := marker + formatSkillListRow(entry, descCap)
		if i == selected {
			row = focusedLineStyle.Render(row)
		}
		lines = append(lines, row)
	}
	return lines
}

// formatSkillListRow formats a single skill as one line:
//
//   ●  <id-padded-18>  [<risk>]  <description>
//
// The id is padded to 18 columns (long enough for the
// longest built-in id "babel-o-permission-denial-recovery"
// is 36 chars; we truncate at 18 with "…" so a runaway id
// cannot push the risk badge off-screen). The risk badge
// is bracketed and uses lipgloss.Foreground on the bracket
// characters only so the text inside remains the same color
// as the rest of the row (preserves focusedLineStyle
// contrast on the selected row). The description is muted
// gray so the id + risk remain the visual primary signal.
// Empty descriptions fall through to a single "—".
//
// `descCap` is the visible-cell budget for the description
// (computed by the caller from the available inner width).
// The description is hard-truncated to this cap with a
// trailing "..." so the row fits in one terminal line —
// wrapPlain would otherwise break a long description onto
// a second visual line and confuse the reader into thinking
// the list has more rows than it actually does.
func formatSkillListRow(entry runtimeSkillListEntry, descCap int) string {
	dot := formatRiskDot(entry.Risk)
	id := padOrTruncate(entry.ID, 18)
	risk := formatRiskBadge(entry.Risk)
	desc := strings.TrimSpace(entry.Description)
	if desc == "" {
		desc = "—"
	} else if descCap <= 0 {
		desc = "—"
	} else {
		desc = mutedStyle.Render(truncatePlain(desc, descCap))
	}
	return fmt.Sprintf("%s  %s  %s  %s", dot, id, risk, desc)
}

// formatRiskDot returns a colored ● glyph for the /skill
// list overlay. Color mapping:
//
//   read    → green  (42)  — safe, model can lean on it
//   write   → yellow (220) — touches files
//   execute → red    (196) — runs shell / process
//   network → red    (196) — outbound calls
//   task    → blue   (33)  — long-running task delegation
//   <other> → gray   (245) — mutedStyle fallback
//
// The same risk string is also passed to formatRiskBadge
// for the [risk] text column.
func formatRiskDot(risk string) string {
	switch risk {
	case "read":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Render("●")
	case "write":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("220")).Render("●")
	case "execute", "network":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Render("●")
	case "task":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("33")).Render("●")
	default:
		return mutedStyle.Render("●")
	}
}

// formatRiskBadge returns a "[risk]" string with the
// bracket characters colored to match the dot, so the
// reader can pair the badge with the dot at a glance.
// The risk text itself is left uncolored so the row's
// focusedLineStyle wrap (when the row is selected) keeps
// a single coherent foreground across the whole line.
func formatRiskBadge(risk string) string {
	if risk == "" {
		return "—"
	}
	color := "245"
	switch risk {
	case "read":
		color = "42"
	case "write":
		color = "220"
	case "execute", "network":
		color = "196"
	case "task":
		color = "33"
	}
	open := lipgloss.NewStyle().Foreground(lipgloss.Color(color)).Render("[")
	close := lipgloss.NewStyle().Foreground(lipgloss.Color(color)).Render("]")
	return open + risk + close
}

// padOrTruncate returns s padded to width with spaces, or
// truncated with a trailing "…" if it exceeds width.
// Unlike truncatePlain (which uses byte count), this uses
// rune count so a CJK id doesn't get cut in half.
func padOrTruncate(s string, width int) string {
	runes := []rune(s)
	if len(runes) > width {
		if width <= 1 {
			return string(runes[:width])
		}
		return string(runes[:width-1]) + "…"
	}
	if len(runes) < width {
		return s + strings.Repeat(" ", width-len(runes))
	}
	return s
}

// buildSkillShowOverlayLines turns a single skill (or
// SKILL_NOT_FOUND envelope) into the ordered list of lines
// the /skill show overlay will render. The header carries
// the metadata summary, then a blank, then the body. Long
// bodies are clamped to skillShowBodyMaxLines with a
// "[truncated — n more line(s) omitted]" tail so the
// overlay cannot push the user out of the viewport.
const skillShowBodyMaxLines = 60

func buildSkillShowOverlayLines(entry *runtimeSkillShowEntry) []string {
	if entry == nil {
		return []string{"No skill selected."}
	}
	header := []string{
		fmt.Sprintf("Skill: %s", entry.ID),
		fmt.Sprintf("  name:        %s", entry.Name),
		fmt.Sprintf("  description: %s", entry.Description),
		fmt.Sprintf("  source:      %s", entry.Source),
		fmt.Sprintf("  scope:       %s", entry.Scope),
		fmt.Sprintf("  status:      %s", entry.Status),
		fmt.Sprintf("  risk:        %s", entry.Risk),
		fmt.Sprintf("  priority:    %d", entry.Priority),
		fmt.Sprintf("  triggers:    %s", strings.Join(entry.Triggers, ", ")),
	}
	if len(entry.AllowedTools) > 0 {
		header = append(header, fmt.Sprintf("  allowed:     %s", strings.Join(entry.AllowedTools, ", ")))
	}
	if entry.FilePath != "" {
		header = append(header, fmt.Sprintf("  file:        %s", entry.FilePath))
	}
	body := strings.Split(strings.TrimRight(entry.Body, "\n"), "\n")
	if len(body) > skillShowBodyMaxLines {
		omitted := len(body) - skillShowBodyMaxLines
		body = append(body[:skillShowBodyMaxLines],
			fmt.Sprintf("[truncated — %d more line(s) omitted]", omitted),
		)
	}
	lines := append(header, "", "--- body ---")
	lines = append(lines, body...)
	return lines
}

// buildSkillValidateOverlayLines turns the typed
// SkillValidateResponse mirror into the ordered list of lines
// the /skill validate overlay will render. The first line is
// the OK/FAIL summary with error + warning counts; the rest
// is one line per diagnostic with a severity glyph so the
// operator can scan severity at a glance. Empty diagnostics
// on a passing validation render a single "no diagnostics"
// line so the overlay is never blank.
func buildSkillValidateOverlayLines(result *runtimeSkillValidateEntry) []string {
	if result == nil {
		return []string{"No validation result available."}
	}
	summary := fmt.Sprintf("Validation: %s  · errors=%d warnings=%d",
		firstNonEmpty(result.SkillID, "?"),
		result.ErrorCount, result.WarningCount,
	)
	statusGlyph := "✓"
	if !result.OK {
		statusGlyph = "✗"
	}
	lines := []string{summary, fmt.Sprintf("Overall: %s %s", statusGlyph, boolStatusLabel(result.OK))}
	if len(result.Diagnostics) == 0 {
		lines = append(lines, mutedStyle.Render("(no diagnostics)"))
		return lines
	}
	lines = append(lines, "")
	for _, d := range result.Diagnostics {
		lines = append(lines, formatSkillDiagnosticLine(d))
	}
	return lines
}

// formatSkillDiagnosticLine renders a single diagnostic as
// "G  [field] code: message" where G is the severity glyph
// (✗ error, ⚠ warning, ⓘ info). Field is omitted when empty
// to keep clean diagnostics compact. Returns a single line;
// multi-line cases are folded into a single joined string
// because the /skill validate overlay is column-aligned and
// does not indent follow-up lines.
func formatSkillDiagnosticLine(d runtimeSkillDiagnostic) string {
	glyph := "ⓘ"
	switch d.Severity {
	case "error":
		glyph = "✗"
	case "warning":
		glyph = "⚠"
	}
	head := fmt.Sprintf("%s %s", glyph, d.Code)
	if field := strings.TrimSpace(d.Field); field != "" {
		head = fmt.Sprintf("%s [%s]", head, field)
	}
	return head + ": " + d.Message
}

// boolStatusLabel maps a bool to a human label for the
// /skill validate summary. Kept inline (rather than via
// mutedStyle.Render) so the glyph remains the visual
// primary signal and the text label is a redundant
// secondary signal.
func boolStatusLabel(ok bool) string {
	if ok {
		return "passed"
	}
	return "failed"
}

// --- render() methods (called from model.viewString in tui.go) ---
//
// The three renderers below mirror renderToolAuditOverlay's
// shape: title + divider + summary + clamped allLines +
// bottom hint, wrapped in renderOverlayFrame. The list
// renderer threads m.skillListSelected through to
// buildSkillListOverlayLines so the focused row is
// highlighted with focusedLineStyle (matching /inbox's
// selected row convention).

// renderSkillListOverlay paints the /skill list full-screen
// overlay. The selected row index (m.skillListSelected) is
// re-clamped to the entry range here so a stale selection
// (e.g. an empty registry arrived after a non-empty one)
// cannot produce an out-of-range index that would silently
// drop the highlight.
func (m model) renderSkillListOverlay(width int) string {
	if m.inputMode != modeSkillListOverlay {
		return ""
	}
	header := titleStyle.Render("Skills")
	summary := summarizeSkillList(m.skillListEntries, m.skillListDiagnostics)
	visibleRows := max(1, m.height-10)
	selected := m.skillListSelected
	if selected < 0 || selected >= len(m.skillListEntries) {
		selected = 0
	}
	allLines := buildSkillListOverlayLines(m.skillListEntries, m.skillListDiagnostics, selected, max(0, width-2))
	maxScroll := max(0, len(allLines)-visibleRows)
	if m.skillListScroll > maxScroll {
		m.skillListScroll = maxScroll
	}
	end := m.skillListScroll + visibleRows
	if end > len(allLines) {
		end = len(allLines)
	}
	lines := []string{header, divider(width), summary}
	lines = append(lines, allLines[m.skillListScroll:end]...)
	hint := "↑/↓/Tab navigate · enter show · v validate · esc/q close"
	lines = append(lines, mutedStyle.Render(hint))
	// NB: we deliberately do NOT call wrapPlain here. wrapPlain's
	// visualLen helper counts ANSI escape bytes as visible width
	// (it skips the ESC byte itself but counts the trailing
	// "[38;5;42m" digits as 8 visible cells per ANSI sequence).
	// A skill row carries 4+ ANSI sequences for the dot + risk
	// bracket SGRs + the muted description, so its raw width is
	// 50-100+ bytes larger than its displayed width — wrapPlain
	// then thinks the row overflows the inner width and breaks
	// the description onto a second visual line, making the list
	// look like it has twice as many rows (image-ref-2026-06-24-
	// 11.14 / -11.24). Each row in allLines is already hard-
	// truncated by buildSkillListOverlayLines against the inner
	// width, so joining them with "\n" is safe. The divider and
	// summary lines are short and don't need wrapping.
	return renderOverlayFrame(width, toolPaletteStyle.Render(strings.Join(lines, "\n")))
}

// renderSkillShowOverlay paints the /skill show <id>
// full-screen overlay. m.skillShowEntry is populated by
// skillShowMsg; a nil entry means the overlay opened without
// a body (e.g. caller navigated here without going through
// the list) and we render a single placeholder line.
func (m model) renderSkillShowOverlay(width int) string {
	if m.inputMode != modeSkillShowOverlay {
		return ""
	}
	header := titleStyle.Render("Skill detail")
	allLines := buildSkillShowOverlayLines(m.skillShowEntry)
	visibleRows := max(1, m.height-6)
	maxScroll := max(0, len(allLines)-visibleRows)
	if m.skillShowScroll > maxScroll {
		m.skillShowScroll = maxScroll
	}
	end := m.skillShowScroll + visibleRows
	if end > len(allLines) {
		end = len(allLines)
	}
	lines := []string{header, divider(width)}
	lines = append(lines, allLines[m.skillShowScroll:end]...)
	hint := "↑/↓/Tab scroll · esc/enter/q close"
	lines = append(lines, mutedStyle.Render(hint))
	return renderOverlayFrame(width, toolPaletteStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2))))
}

// renderSkillValidateOverlay paints the /skill validate <id>
// full-screen overlay. m.skillValidateResult is populated by
// skillValidateMsg; nil renders a single placeholder line
// (the show overlay follows the same defensive default).
func (m model) renderSkillValidateOverlay(width int) string {
	if m.inputMode != modeSkillValidateOverlay {
		return ""
	}
	header := titleStyle.Render("Skill validation")
	allLines := buildSkillValidateOverlayLines(m.skillValidateResult)
	visibleRows := max(1, m.height-6)
	maxScroll := max(0, len(allLines)-visibleRows)
	if m.skillValidateScroll > maxScroll {
		m.skillValidateScroll = maxScroll
	}
	end := m.skillValidateScroll + visibleRows
	if end > len(allLines) {
		end = len(allLines)
	}
	lines := []string{header, divider(width)}
	lines = append(lines, allLines[m.skillValidateScroll:end]...)
	hint := "↑/↓/Tab scroll · esc/enter/q close"
	lines = append(lines, mutedStyle.Render(hint))
	return renderOverlayFrame(width, toolPaletteStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2))))
}

// summarizeSkillList produces the one-line summary at the
// top of the /skill list overlay (mirrors summarizeToolAudit).
// Returns "no skills" for the empty case so the summary
// line is never blank.
func summarizeSkillList(entries []runtimeSkillListEntry, diag runtimeSkillListDiagnostics) string {
	if len(entries) == 0 {
		return "no skills"
	}
	return fmt.Sprintf("%d skill(s) · skipped=%d overlaid=%d duplicates=%d",
		len(entries), diag.SkippedCount, diag.OverlaidCount, diag.DuplicateCount,
	)
}
