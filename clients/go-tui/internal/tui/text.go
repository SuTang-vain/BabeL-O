package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/mattn/go-runewidth"
)

// formatCharCount renders a char count in human-friendly form
// (e.g. 1234 -> "1.2k", 12 -> "12", 0 -> "0"). The chat TUI uses
// the same idea in contextView.
func formatCharCount(n int) string {
	switch {
	case n <= 0:
		return "0"
	case n < 1000:
		return fmt.Sprintf("%d", n)
	case n < 10_000:
		return fmt.Sprintf("%.1fk", float64(n)/1000.0)
	case n < 1_000_000:
		return fmt.Sprintf("%dk", n/1000)
	default:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000.0)
	}
}

func formatTokenCount(n int) string {
	switch {
	case n <= 0:
		return "0"
	case n < 1000:
		return fmt.Sprintf("%d", n)
	case n < 10_000:
		return fmt.Sprintf("%.1fk", float64(n)/1000.0)
	case n < 1_000_000:
		return fmt.Sprintf("%dk", n/1000)
	default:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000.0)
	}
}

func shortCwd(cwd string) string {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return ""
	}
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		if cwd == home {
			return "~"
		}
		if strings.HasPrefix(cwd, home+string(os.PathSeparator)) {
			cwd = "~" + strings.TrimPrefix(cwd, home)
		}
	}
	if lipgloss.Width(cwd) <= 28 {
		return cwd
	}
	parts := strings.Split(filepath.ToSlash(cwd), "/")
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			filtered = append(filtered, part)
		}
	}
	if len(filtered) >= 2 {
		return "…/" + strings.Join(filtered[len(filtered)-2:], "/")
	}
	return truncatePlain(cwd, 28)
}

func joinTopCardColumns(width int, headersAndRows ...any) string {
	if width < 72 {
		lines := []string{}
		for i := 0; i+1 < len(headersAndRows); i += 2 {
			header, _ := headersAndRows[i].(string)
			rows, _ := headersAndRows[i+1].([]string)
			lines = append(lines, mutedStyle.Render(header))
			for _, row := range rows {
				lines = append(lines, "  "+truncatePlain(row, max(8, width-2)))
			}
		}
		return strings.Join(lines, "\n")
	}
	columnCount := len(headersAndRows) / 2
	columnWidth := max(12, (width-(columnCount-1)*3)/columnCount)
	maxRows := 0
	for i := 1; i < len(headersAndRows); i += 2 {
		rows, _ := headersAndRows[i].([]string)
		maxRows = max(maxRows, len(rows))
	}
	renderCell := func(text string, cellWidth int) string {
		return padVisible(truncatePlain(text, cellWidth), cellWidth)
	}
	lines := []string{}
	headerCells := make([]string, 0, columnCount)
	for i := 0; i+1 < len(headersAndRows); i += 2 {
		header, _ := headersAndRows[i].(string)
		headerCells = append(headerCells, mutedStyle.Render(renderCell(header, columnWidth)))
	}
	lines = append(lines, strings.Join(headerCells, "   "))
	for rowIdx := 0; rowIdx < maxRows; rowIdx++ {
		cells := make([]string, 0, columnCount)
		for i := 1; i < len(headersAndRows); i += 2 {
			rows, _ := headersAndRows[i].([]string)
			value := ""
			if rowIdx < len(rows) {
				value = rows[rowIdx]
			}
			cells = append(cells, renderCell(value, columnWidth))
		}
		lines = append(lines, strings.Join(cells, "   "))
	}
	return strings.Join(lines, "\n")
}

func padVisible(text string, width int) string {
	pad := width - lipgloss.Width(text)
	if pad <= 0 {
		return text
	}
	return text + strings.Repeat(" ", pad)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func shortID(id string) string {
	if len(id) <= 16 {
		return id
	}
	return id[:8] + "..." + id[len(id)-6:]
}

func divider(width int) string {
	return dividerStyle.Render(strings.Repeat("-", max(0, width)))
}

// renderOverlayFrame wraps a single block of overlay text in the
// shared overlayFrameStyle border. The inner content is sized to
// width-2 so it fits inside the left/right border columns; lines
// are joined with "\n" so callers can keep returning a string.
func renderOverlayFrame(width int, content string) string {
	return overlayFrameStyle.Width(max(0, width-2)).Render(content)
}

// stateStyle returns the colour for the current run state. Idle
// uses mutedStyle so the header chrome is quiet when nothing is
// happening; running switches to statusStyle (cyan) to mirror the
// spinner colour; a pending permission switches to permissionStyle
// (yellow) so the operator sees the decision is on them.
func formatContextUsageFooter(c *contextUsageSnapshot) string {
	if c == nil || c.MaxTokens <= 0 {
		return ""
	}
	parts := []string{fmt.Sprintf("ctx %d%% %d/%d", c.PercentUsed, c.TokenEstimate, c.MaxTokens)}
	if c.WarningThreshold > 0 || c.CompactThreshold > 0 {
		parts = append(parts, fmt.Sprintf("warn=%d compact=%d", c.WarningThreshold, c.CompactThreshold))
	}
	return strings.Join(parts, " ")
}

// formatUsageFooter renders a one-line token usage summary used
// as a transient footer status while a turn is in flight. The
// snapshot is cleared on result / error, so the line disappears
// when the turn ends — that's how the operator knows the turn
// completed without us re-emitting a "done" transcript row.
func formatUsageFooter(u *usageSnapshot) string {
	if u == nil {
		return ""
	}
	parts := []string{}
	if u.InputTokens > 0 {
		parts = append(parts, fmt.Sprintf("in=%d", u.InputTokens))
	}
	if u.OutputTokens > 0 {
		parts = append(parts, fmt.Sprintf("out=%d", u.OutputTokens))
	}
	if u.CacheRead > 0 {
		parts = append(parts, fmt.Sprintf("cache=%d", u.CacheRead))
	}
	if len(parts) == 0 {
		return "tokens: 0"
	}
	return "tokens " + strings.Join(parts, " ")
}

// formatSoftTimeoutFooter renders a one-line soft-timeout
// indicator for the footer (Phase 4 of
// docs/nexus/reference/task-adaptive-recoverable-timeout-plan.md).
// Returns "" when no soft cycle has fired in the current turn.
// Otherwise mirrors the `tokens in=… out=…` pattern so the
// operator can see at a glance:
//   - that the soft budget exhausted (without a fatal cutoff),
//   - the running budget after any auto-extensions,
//   - the extension count out of the configured cap.
//
// Kept as a pure function over the snapshot so it can be unit
// tested without spinning up the full model.
func formatSoftTimeoutFooter(s *softTimeoutSnapshot) string {
	if s == nil || s.BudgetExceededAt.IsZero() {
		return ""
	}
	running := s.TotalSoftBudgetMs
	if running <= 0 {
		running = s.OriginalBudgetMs
	}
	parts := []string{}
	if running > 0 {
		parts = append(parts, fmt.Sprintf("budget=%dms", running))
	}
	if s.MaxExtensions > 0 || s.ExtensionCount > 0 {
		parts = append(parts, fmt.Sprintf("ext=%d/%d", s.ExtensionCount, s.MaxExtensions))
	}
	if len(parts) == 0 {
		return "soft timeout: budget exceeded"
	}
	return "soft timeout " + strings.Join(parts, " ")
}

func stateStyle(running bool, pending *pendingPermission) lipgloss.Style {
	switch {
	case pending != nil:
		return permissionStyle
	case running:
		return statusStyle
	default:
		return mutedStyle
	}
}

func joinColumns(width int, left string, right string) string {
	gap := width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		return truncateVisible(left+" "+right, width)
	}
	return left + strings.Repeat(" ", gap) + right
}

// renderInlineMarkdown applies a small set of inline markdown
// spans on top of the base style. The walker recognises:
//
//	`code`           → inline code (muted chip with bg 238)
//	**bold** / __bold__ → bold (lipgloss.Bold)
//	*em* / _em_       → italic (lipgloss.Italic)
//
// Headers (`# …`) and code fences (```) are handled at the
// block level in formatLine, not here. CJK is safe: the walker
// only treats ASCII punctuation as markers, so Chinese /
// kana / hangul content never collides with the span
// delimiters.
func renderInlineMarkdown(base lipgloss.Style, text string) string {
	if text == "" {
		return ""
	}
	var out strings.Builder
	runes := []rune(text)
	i := 0
	for i < len(runes) {
		r := runes[i]
		// Inline code: `…` (single backtick). Skip empty
		// matches and unterminated tails. The chip keeps the
		// muted background highlight so the operator can still
		// scan a transcript for `…` to count code spans, but
		// the foreground moves to sky blue (75) — the same
		// brand-aligned tool accent — so the path / identifier
		// inside the chip is easier to read at a glance than
		// the previous near-white (252) on the muted bg.
		if r == '`' {
			end := -1
			for j := i + 1; j < len(runes); j++ {
				if runes[j] == '`' {
					end = j
					break
				}
			}
			if end > i+1 {
				code := string(runes[i+1 : end])
				chip := base.Foreground(lipgloss.Color("75")).Render(code)
				out.WriteString(chip)
				i = end + 1
				continue
			}
		}
		// Bold: **…** or __…__
		if (r == '*' || r == '_') && i+1 < len(runes) && runes[i+1] == r {
			end := -1
			for j := i + 2; j+1 < len(runes); j++ {
				if runes[j] == r && runes[j+1] == r {
					end = j
					break
				}
			}
			if end > i+1 {
				bold := base.Bold(true).Render(string(runes[i+2 : end]))
				out.WriteString(bold)
				i = end + 2
				continue
			}
		}
		// Italic: *…* or _…_ (single, not double).
		if r == '*' || r == '_' {
			end := -1
			for j := i + 1; j < len(runes); j++ {
				if runes[j] == r {
					end = j
					break
				}
			}
			if end > i+1 {
				italic := base.Italic(true).Render(string(runes[i+1 : end]))
				out.WriteString(italic)
				i = end + 1
				continue
			}
		}
		out.WriteRune(r)
		i++
	}
	return out.String()
}

func wrapPlain(text string, width int) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	// Collapse runs of newlines down to a single space so the
	// model-written paragraph break (\n\n) renders as a soft
	// separator instead of a full blank line. Without this
	// collapse, a sentence like "package.\n\njson 内容" was
	// displayed as "package. [blank] json 内容" — the operator
	// read that as the text being truncated mid-word. Joining
	// the paragraphs with a single space keeps the visible
	// sentence flow continuous while preserving the model's
	// intent that the two halves belong to the same reply.
	text = collapseParagraphBreaks(text)
	paragraphs := strings.Split(text, "\n")
	out := make([]string, 0, len(paragraphs))
	for _, paragraph := range paragraphs {
		out = append(out, wrapParagraph(paragraph, width)...)
	}
	return strings.Join(out, "\n")
}

// collapseParagraphBreaks replaces any run of two-or-more
// newlines with a single space. Single newlines are kept
// intact so the model can still produce hard line breaks.
func collapseParagraphBreaks(text string) string {
	for {
		collapsed := strings.ReplaceAll(text, "\n\n", "\n ")
		if collapsed == text {
			return text
		}
		text = collapsed
	}
}

// visualWidth returns the on-screen column count of a single
// rune. East Asian wide / fullwidth characters (CJK, kana,
// hangul) count as 2; everything else counts as 1. Wraps
// delegated through `wrapParagraph` use this so a Chinese
// character doesn't get treated as half a column.
func visualWidth(r rune) int {
	if w := runewidth.RuneWidth(r); w > 0 {
		return w
	}
	return 1
}

func canBreakAt(runes []rune, idx int) bool {
	if idx <= 0 || idx >= len(runes) {
		return true
	}
	rLeft := runes[idx-1]
	rRight := runes[idx]
	if isBreakRune(rLeft) || rLeft == '\n' || rLeft == '\r' {
		return true
	}
	if isBreakRune(rRight) || rRight == '\n' || rRight == '\r' {
		return true
	}
	if visualWidth(rLeft) == 2 || visualWidth(rRight) == 2 {
		return true
	}
	return false
}

func wrapParagraph(text string, width int) []string {
	if text == "" {
		return []string{""}
	}
	runes := []rune(text)
	lines := make([]string, 0, len(runes)/max(1, width)+1)
	for visualLen(runes) > width {
		cut := len(runes)
		// Walk back until the prefix's visual width fits.
		for cut > 0 && visualLen(runes[:cut]) > width {
			cut--
		}
		// Try to break on a nearby whitespace / punctuation
		// boundary for readability.
		breakAt := cut
		for breakAt > 0 && !canBreakAt(runes, breakAt) {
			breakAt--
		}
		if breakAt > 0 {
			cut = breakAt
		}
		if cut <= 0 {
			cut = len(runes)
		}
		lines = append(lines, strings.TrimRight(string(runes[:cut]), " \t"))
		runes = []rune(strings.TrimLeft(string(runes[cut:]), " \t"))
	}
	lines = append(lines, string(runes))
	return lines
}

// visualLen returns the sum of the on-screen column widths of
// every rune in `rs`. Used by wrapParagraph to decide where to
// cut so a Chinese character doesn't get sliced in half visually.
func visualLen(rs []rune) int {
	total := 0
	for _, r := range rs {
		total += visualWidth(r)
	}
	return total
}

func truncateVisible(text string, width int) string {
	if lipgloss.Width(text) <= width {
		return text
	}
	return truncatePlain(text, width)
}

func truncatePlain(text string, width int) string {
	if width <= 0 {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= width {
		return text
	}
	if width <= 3 {
		return string(runes[:width])
	}
	return string(runes[:width-3]) + "..."
}

func truncatePlainMiddle(text string, width int) string {
	if width <= 0 {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= width {
		return text
	}
	if width <= 3 {
		return string(runes[:width])
	}
	ellipsis := "..."
	keep := width - len([]rune(ellipsis))
	left := keep / 2
	right := keep - left
	if right <= 0 {
		return string(runes[:left]) + ellipsis
	}
	return string(runes[:left]) + ellipsis + string(runes[len(runes)-right:])
}

func padRight(text string, width int) string {
	if len(text) >= width {
		return text[:width]
	}
	return text + strings.Repeat(" ", width-len(text))
}

func isBreakRune(value rune) bool {
	return value == ' ' || value == '\t' || value == '/' || value == ',' || value == ';' || value == ':' || value == '-'
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func clamp(value, lo, hi int) int {
	if value < lo {
		return lo
	}
	if value > hi {
		return hi
	}
	return value
}
