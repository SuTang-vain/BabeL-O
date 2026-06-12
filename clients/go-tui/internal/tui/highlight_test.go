package tui

import (
	"strings"
	"testing"
)

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
	if strings.Contains(plain, selectionBackgroundStart) {
		t.Fatalf("plain render should not contain selection background: %q", plain)
	}
	item.SetHighlight(0, 2, 0, 7)
	highlighted := renderTranscript([]*transcriptItem{item}, 80)
	if !strings.Contains(highlighted, selectionBackgroundStart) {
		t.Fatalf("highlighted render should contain selection background: %q", highlighted)
	}
	if !strings.Contains(highlighted, selectionBackgroundEnd) {
		t.Fatalf("highlighted render should contain selection background reset: %q", highlighted)
	}
	item.ClearHighlight()
	cleared := renderTranscript([]*transcriptItem{item}, 80)
	if strings.Contains(cleared, selectionBackgroundStart) {
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
	if !strings.Contains(highlighted, selectionBackgroundStart) {
		t.Fatalf("highlighted render should include selection background: %q", highlighted)
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
	if !strings.Contains(view, selectionBackgroundStart) {
		t.Fatalf("view should render selection background via transcript item mapping: %q", view)
	}
	if !m.transcript[0].highlightActive {
		t.Fatalf("first transcript item should own the active highlight")
	}
	if m.transcript[1].highlightActive {
		t.Fatalf("second transcript item should not be highlighted")
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
	if strings.Contains(viewLines[0], selectionBackgroundStart) {
		t.Fatalf("selection display shifted one row up; first visible row was highlighted: %q", viewLines[0])
	}
	if !strings.Contains(viewLines[1], selectionBackgroundStart) {
		t.Fatalf("selected content line should be highlighted on second visible row, got rows:\n%q\n%q",
			viewLines[0], viewLines[1])
	}
}
