package tui

import (
	"strings"
	"testing"
)

func containsCellSelectionHighlight(s string) bool {
	return strings.Contains(s, "\x1b[7m") || strings.Contains(s, ";7m")
}

func TestHighlightableSetAndGet(t *testing.T) {
	var h baseHighlightable
	h.SetHighlight(1, 2, 3, 4)
	sl, sc, el, ec := h.Highlight()
	if sl != 1 || sc != 2 || el != 3 || ec != 4 {
		t.Fatalf("Highlight() = (%d,%d,%d,%d), want (1,2,3,4)", sl, sc, el, ec)
	}
	h.ClearHighlight()
	if got := h.renderHighlight("plain"); got != "plain" {
		t.Fatalf("cleared highlight should render unchanged, got %q", got)
	}
}

func TestMessageItemRendersHighlightInView(t *testing.T) {
	item := &transcriptItem{kind: "assistant", text: "hello highlight", Versioned: NewVersioned()}
	plain := renderTranscript([]*transcriptItem{item}, 80)
	if containsCellSelectionHighlight(plain) {
		t.Fatalf("plain render should not contain selection highlight: %q", plain)
	}
	item.SetHighlight(0, 2, 0, 7)
	highlighted := renderTranscript([]*transcriptItem{item}, 80)
	if !containsCellSelectionHighlight(highlighted) {
		t.Fatalf("highlighted render should contain selection background: %q", highlighted)
	}
	if stripANSICodes(highlighted) != stripANSICodes(plain) {
		t.Fatalf("cell-level highlight should preserve visible text, got %q want %q", stripANSICodes(highlighted), stripANSICodes(plain))
	}
	item.ClearHighlight()
	cleared := renderTranscript([]*transcriptItem{item}, 80)
	if containsCellSelectionHighlight(cleared) {
		t.Fatalf("cleared render should not contain selection background: %q", cleared)
	}
}

func TestSelectionFreezeSuppression(t *testing.T) {
	item := &transcriptItem{kind: "assistant", text: "cache should refresh", Versioned: NewVersioned()}
	beforeVersion := item.Version()
	plain := renderTranscript([]*transcriptItem{item}, 80)
	item.SetHighlight(0, 2, 0, 8)
	if item.Version() != beforeVersion {
		t.Fatalf("highlight changes should not bump content version, got %d want %d", item.Version(), beforeVersion)
	}
	highlighted := renderTranscript([]*transcriptItem{item}, 80)
	if highlighted == plain {
		t.Fatalf("highlight should refresh cached render without content version bump")
	}
	if !containsCellSelectionHighlight(highlighted) {
		t.Fatalf("highlighted render should include selection background: %q", highlighted)
	}

	cached := item.cache.view
	item.SetHighlight(0, 2, 0, 8)
	if item.cache.view != cached {
		t.Fatalf("unchanged highlight range should not invalidate the cached render")
	}
	item.ClearHighlight()
	cleared := renderTranscript([]*transcriptItem{item}, 80)
	if containsCellSelectionHighlight(cleared) {
		t.Fatalf("cleared render should not include selection background: %q", cleared)
	}
	cached = item.cache.view
	item.ClearHighlight()
	if item.cache.view != cached {
		t.Fatalf("clearing an already clear highlight should not invalidate the cached render")
	}
}

func TestViewMapsSelectionToTranscriptItems(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	primeSelectionViewport(&m)
	selectionLine := transcriptStartLine(m.renderWelcomeCard(max(40, m.viewport.Width())))
	m.selectionActive = true
	m.selectionStartLine = selectionLine
	m.selectionStartCol = 0
	m.selectionEndLine = selectionLine
	m.selectionEndCol = 8
	m.viewport.SetYOffset(selectionLine)
	view := viewContent(m.View())
	if !containsCellSelectionHighlight(view) {
		t.Fatalf("view should render selection background via transcript item mapping: %q", view)
	}
	if !m.transcript[0].highlightActive {
		t.Fatalf("first transcript item should own the active highlight")
	}
	if m.transcript[1].highlightActive {
		t.Fatalf("second transcript item should not be highlighted")
	}
}

func TestPaintColumnRangeHandlesWideRunesAndEmoji(t *testing.T) {
	in := "ab你好🙂cd"
	start := visibleWidth("ab")
	end := start + visibleWidth("你好🙂")
	got := paintColumnRange(in, start, end, selectionBackgroundStart, selectionBackgroundEnd)
	if !strings.Contains(got, selectionBackgroundStart) || !strings.Contains(got, selectionBackgroundEnd) {
		t.Fatalf("wide-rune highlight should include background spans: %q", got)
	}
	plain := stripANSICodes(got)
	if plain != in {
		t.Fatalf("wide-rune highlight should preserve plain text, got %q want %q", plain, in)
	}
}

func TestPaintColumnRangePreservesNestedANSIText(t *testing.T) {
	in := "pre \x1b[31mred text\x1b[0m post"
	got := paintColumnRange(in, 4, 12, selectionBackgroundStart, selectionBackgroundEnd)
	if !strings.Contains(got, "\x1b[31m") || !strings.Contains(got, "\x1b[0m") {
		t.Fatalf("nested ANSI highlight should preserve original style escapes: %q", got)
	}
	plain := stripANSICodes(got)
	if plain != "pre red text post" {
		t.Fatalf("nested ANSI highlight should preserve visible text, got %q", plain)
	}
}

func TestHighlightedViewportViewDoesNotInvalidateUnchangedHighlight(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	primeSelectionViewport(&m)
	selectionLine := transcriptStartLine(m.renderWelcomeCard(max(40, m.viewport.Width())))
	m.selectionActive = true
	m.selectionStartLine = selectionLine
	m.selectionStartCol = 0
	m.selectionEndLine = selectionLine
	m.selectionEndCol = 8
	m.viewport.SetYOffset(selectionLine)

	first := m.highlightedViewportView()
	if !containsCellSelectionHighlight(first) {
		t.Fatalf("first highlighted view should contain selection background: %q", first)
	}
	cached := m.transcript[0].cache.view
	second := m.highlightedViewportView()
	if !containsCellSelectionHighlight(second) {
		t.Fatalf("second highlighted view should still contain selection background: %q", second)
	}
	if m.transcript[0].cache.view != cached {
		t.Fatalf("unchanged selection range should not invalidate transcript item cache")
	}
}

func TestSelectionHighlightStaysOnVisibleContentLine(t *testing.T) {
	m := newModel(Config{BaseURL: "http://127.0.0.1:1", Cwd: "/workspace", MouseCapture: true})
	m.width = 80
	m.height = 14
	m.resize()
	m.transcript = []*transcriptItem{
		{kind: "status", text: "alpha line"},
		{kind: "status", text: "beta line"},
		{kind: "status", text: "gamma line"},
		{kind: "status", text: "delta line"},
		{kind: "status", text: "epsilon line"},
		{kind: "status", text: "zeta line"},
		{kind: "status", text: "eta line"},
		{kind: "status", text: "theta line"},
	}
	m.refreshViewport()

	lines := strings.Split(stripANSICodes(m.viewport.GetContent()), "\n")
	targetLine := -1
	for i, line := range lines {
		if strings.Contains(line, "beta line") {
			targetLine = i
			break
		}
	}
	if targetLine < 1 {
		t.Fatalf("test setup expected beta line after at least one visible row, got target=%d:\n%s",
			targetLine, strings.Join(lines, "\n"))
	}
	startCol := strings.Index(lines[targetLine], "beta")
	if startCol < 0 {
		t.Fatalf("test setup could not find beta column in %q", lines[targetLine])
	}
	m.selectionActive = true
	m.selectionStartLine = targetLine
	m.selectionStartCol = startCol
	m.selectionEndLine = targetLine
	m.selectionEndCol = startCol + len("beta")
	m.viewport.SetYOffset(targetLine - 1)
	if got := m.viewport.YOffset(); got != targetLine-1 {
		t.Fatalf("test setup expected viewport offset %d, got %d", targetLine-1, got)
	}

	viewLines := strings.Split(m.highlightedViewportView(), "\n")
	if len(viewLines) < 2 {
		t.Fatalf("expected at least two visible viewport rows, got %d: %q", len(viewLines), viewLines)
	}
	if containsCellSelectionHighlight(viewLines[0]) {
		t.Fatalf("selection display shifted one row up; first visible row was highlighted: %q", viewLines[0])
	}
	if !containsCellSelectionHighlight(viewLines[1]) {
		t.Fatalf("selected content line should be highlighted on second visible row, got rows:\n%q\n%q",
			viewLines[0], viewLines[1])
	}
}
