package tui

import (
	"strings"
	"unicode/utf8"
)

const (
	selectionBackgroundStart = "\x1b[48;5;240m"
	selectionBackgroundEnd   = "\x1b[49m"
)

type Highlightable interface {
	SetHighlight(startLine, startCol, endLine, endCol int)
	Highlight() (startLine, startCol, endLine, endCol int)
}

type baseHighlightable struct {
	highlightStartLine int
	highlightStartCol  int
	highlightEndLine   int
	highlightEndCol    int
	highlightActive    bool
}

func (h *baseHighlightable) SetHighlight(startLine, startCol, endLine, endCol int) {
	h.highlightStartLine = startLine
	h.highlightStartCol = startCol
	h.highlightEndLine = endLine
	h.highlightEndCol = endCol
	h.highlightActive = true
}

func (h *baseHighlightable) Highlight() (startLine, startCol, endLine, endCol int) {
	return h.highlightStartLine, h.highlightStartCol, h.highlightEndLine, h.highlightEndCol
}

func (h *baseHighlightable) ClearHighlight() {
	h.highlightStartLine = 0
	h.highlightStartCol = 0
	h.highlightEndLine = 0
	h.highlightEndCol = 0
	h.highlightActive = false
}

func (h *baseHighlightable) renderHighlight(view string) string {
	if !h.highlightActive {
		return view
	}
	return renderHighlightRange(view, h.highlightStartLine, h.highlightStartCol, h.highlightEndLine, h.highlightEndCol)
}

func (item *transcriptItem) SetHighlight(startLine, startCol, endLine, endCol int) {
	if item == nil {
		return
	}
	item.baseHighlightable.SetHighlight(startLine, startCol, endLine, endCol)
	item.cache.Invalidate()
}

func (item *transcriptItem) ClearHighlight() {
	if item == nil {
		return
	}
	item.baseHighlightable.ClearHighlight()
	item.cache.Invalidate()
}

func (m model) highlightedViewportView() string {
	sl, sc, el, ec, ok := m.normalizedSelection()
	m.clearTranscriptHighlights()
	if !ok {
		return m.viewport.View()
	}
	content := m.fullViewportContentWithSelection(sl, sc, el, ec)
	viewport := m.viewport
	viewport.SetContent(content)
	viewport.SetYOffset(m.viewport.YOffset())
	return viewport.View()
}

func (m *model) clearTranscriptHighlights() {
	for _, item := range m.transcript {
		if item != nil && item.highlightActive {
			item.ClearHighlight()
		}
	}
}

func (m model) fullViewportContentWithSelection(sl, sc, el, ec int) string {
	width := max(40, m.viewport.Width())
	welcome := m.renderWelcomeCard(width)
	transcriptStart := transcriptStartLine(welcome)
	m.applySelectionToTranscriptItems(width, transcriptStart, sl, sc, el, ec)
	transcript := renderTranscript(m.transcript, width)
	if transcript == "" {
		return renderHighlightRange(welcome, sl, sc, el, ec)
	}
	if el < transcriptStart {
		welcome = renderHighlightRange(welcome, sl, sc, el, ec)
	}
	return welcome + "\n\n" + transcript
}

func transcriptStartLine(welcome string) int {
	// The first transcript row lives after the exact prefix used
	// by fullViewportContent: `welcome + "\n\n"`. Count newline
	// bytes in that prefix instead of adding a fixed number of
	// logical lines; the welcome card intentionally ends with a
	// trailing blank row, and lineCount(welcome)+2 would land one
	// row too low.
	return strings.Count(welcome+"\n\n", "\n")
}

func (m model) applySelectionToTranscriptItems(width int, transcriptStart int, sl, sc, el, ec int) {
	contentLine := transcriptStart
	for i, item := range m.transcript {
		if item == nil {
			continue
		}
		formatted := renderTranscriptItemCached(item, width)
		itemHeight := lineCount(formatted)
		itemStart := contentLine
		itemEnd := itemStart + itemHeight - 1
		if el >= itemStart && sl <= itemEnd {
			localStartLine := 0
			localStartCol := 0
			if sl > itemStart {
				localStartLine = sl - itemStart
				localStartCol = sc
			} else if sl == itemStart {
				localStartCol = sc
			}
			localEndLine := itemHeight
			localEndCol := 0
			if el <= itemEnd {
				localEndLine = el - itemStart
				localEndCol = ec
			}
			item.SetHighlight(localStartLine, localStartCol, localEndLine, localEndCol)
		}
		contentLine += itemHeight
		if i < len(m.transcript)-1 && formatted != "" && !strings.HasSuffix(formatted, "\n\n") {
			contentLine++
		}
	}
}

func lineCount(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(s, "\n") + 1
}

func renderHighlightRange(view string, startLine, startCol, endLine, endCol int) string {
	if (startLine > endLine) || (startLine == endLine && startCol > endCol) {
		startLine, startCol, endLine, endCol = endLine, endCol, startLine, startCol
	}
	if startLine == endLine && startCol == endCol {
		return view
	}
	lines := strings.Split(view, "\n")
	for lineIdx := 0; lineIdx < len(lines); lineIdx++ {
		if lineIdx < startLine || lineIdx > endLine {
			continue
		}
		colStart := 0
		if lineIdx == startLine {
			colStart = startCol
		}
		colEnd := visibleWidth(lines[lineIdx])
		if lineIdx == endLine {
			colEnd = endCol
		}
		if colStart >= colEnd {
			continue
		}
		lines[lineIdx] = paintColumnRange(lines[lineIdx], colStart, colEnd, selectionBackgroundStart, selectionBackgroundEnd)
	}
	return strings.Join(lines, "\n")
}

// paintColumnRange injects a background-color span over the visual
// columns [start, end) of an ANSI-styled string, preserving the
// existing colors. This is column-aware (we skip CSI sequences while
// counting) and byte-aware (we splice at exact byte positions).
func paintColumnRange(s string, start, end int, bgStart, bgEnd string) string {
	if start >= end {
		return s
	}
	if width := visibleWidth(s); width < end {
		s += strings.Repeat(" ", end-width)
	}
	byteStart, _ := columnToByteRange(s, start, -1)
	if byteStart < 0 {
		return s
	}
	byteEnd, _ := columnToByteRange(s[byteStart:], end-start, 0)
	if byteEnd < 0 {
		return s
	}
	byteEnd += byteStart
	if byteEnd > len(s) {
		byteEnd = len(s)
	}
	if byteStart >= byteEnd {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + len(bgStart) + len(bgEnd))
	b.WriteString(s[:byteStart])
	b.WriteString(bgStart)
	b.WriteString(s[byteStart:byteEnd])
	b.WriteString(bgEnd)
	b.WriteString(s[byteEnd:])
	return b.String()
}

// columnToByteRange walks a (potentially ANSI-styled) string and
// returns the byte index corresponding to the Nth visible column. If
// fromCol is non-negative the walk starts at that column (which lets
// callers chain byte-relative walks cheaply). If the column is out of
// range, -1 is returned.
func columnToByteRange(s string, target int, fromCol int) (int, int) {
	col := 0
	if fromCol >= 0 {
		col = fromCol
	}
	i := 0
	for i < len(s) {
		if col == target {
			return i, col
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == 0x1b {
			j := i + 1
			if j < len(s) && s[j] == '[' {
				j++
				for j < len(s) {
					c := s[j]
					j++
					if c >= 0x40 && c <= 0x7e {
						break
					}
				}
				i = j
				continue
			}
			i += 2
			continue
		}
		w := visualWidth(r)
		col += w
		i += size
		if col > target {
			return i - size, col - w
		}
	}
	if col == target {
		return len(s), col
	}
	return -1, col
}

// visibleWidth sums the on-screen column widths of every rune in s,
// skipping CSI sequences. Used to compute the right edge of a
// full-line selection range.
func visibleWidth(s string) int {
	_, col := columnToByteRange(s, 1<<30, 0)
	return col
}

func sliceVisibleColumns(s string, start, end int) string {
	if start < 0 {
		start = 0
	}
	if end <= start {
		return ""
	}
	byteStart, _ := columnToByteRange(s, start, -1)
	if byteStart < 0 {
		return ""
	}
	byteEnd, _ := columnToByteRange(s[byteStart:], end-start, 0)
	if byteEnd < 0 {
		byteEnd = len(s) - byteStart
	}
	byteEnd += byteStart
	if byteEnd > len(s) {
		byteEnd = len(s)
	}
	if byteStart >= byteEnd {
		return ""
	}
	return s[byteStart:byteEnd]
}
