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
	welcomeLines := lineCount(m.renderWelcomeCard(max(40, m.viewport.Width())))
	selectionLine := welcomeLines + 2
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
