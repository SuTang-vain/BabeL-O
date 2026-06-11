package tui

import (
	"strings"
	"testing"
)

func TestFindSafeMarkdownBoundaryUsesHardLineBreak(t *testing.T) {
	text := "first paragraph\nsecond paragraph"
	if got := findSafeMarkdownBoundary(text); got != strings.Index(text, "\n") {
		t.Fatalf("boundary = %d, want first newline index", got)
	}
}

func TestFindSafeMarkdownBoundarySkipsOpenCodeFence(t *testing.T) {
	text := "```go\nfmt.Println(1)"
	if got := findSafeMarkdownBoundary(text); got != -1 {
		t.Fatalf("open code fence should not expose safe boundary, got %d", got)
	}
}

func TestFindSafeBoundaryInsideListReturnsEarlierBoundary(t *testing.T) {
	text := "intro\n- first\n- second"
	if got := findSafeMarkdownBoundary(text); got != strings.Index(text, "\n") {
		t.Fatalf("list should keep earlier boundary, got %d", got)
	}
}

func TestFindSafeBoundaryInsideTableReturnsEarlierBoundary(t *testing.T) {
	text := "intro\n| name | value |\n| --- | --- |"
	if got := findSafeMarkdownBoundary(text); got != strings.Index(text, "\n") {
		t.Fatalf("table should keep earlier boundary, got %d", got)
	}
}

func TestFindSafeBoundaryInsideBlockquoteReturnsEarlierBoundary(t *testing.T) {
	text := "intro\n> quoted\n> still quoted"
	if got := findSafeMarkdownBoundary(text); got != strings.Index(text, "\n") {
		t.Fatalf("blockquote should keep earlier boundary, got %d", got)
	}
}

func TestFindSafeBoundaryInsideSetextHeaderReturnsEarlierBoundary(t *testing.T) {
	text := "intro\nHeading\n---"
	if got := findSafeMarkdownBoundary(text); got != strings.Index(text, "\n") {
		t.Fatalf("setext header should keep earlier boundary, got %d", got)
	}
}

func TestFindSafeBoundaryNoSafePointReturnsNegative(t *testing.T) {
	if got := findSafeMarkdownBoundary("single unfinished line"); got != -1 {
		t.Fatalf("text without hard break should have no safe point, got %d", got)
	}
}

func TestStreamingMarkdownFinalOutputMatchesFullRender(t *testing.T) {
	text := strings.Join([]string{
		"# Heading",
		"Assistant line with `code` and **bold** text.",
		"Another line after the stable boundary grows here.",
	}, "\n")
	item := &transcriptItem{kind: "assistant", Versioned: NewVersioned()}
	for _, chunk := range []string{text[:10], text[10:35], text[35:]} {
		item.text += chunk
		item.Bump()
		_ = formatTranscriptItem(item, 80)
	}
	got := formatTranscriptItem(item, 80)
	want := formatLine("assistant", text, 80)
	if got != want {
		t.Fatalf("stream render should match full render\nwant:\n%q\ngot:\n%q", want, got)
	}
}

func TestStreamingMarkdownCacheReusesStablePrefix(t *testing.T) {
	item := &transcriptItem{
		kind:      "assistant",
		text:      "stable line\nstreaming tail",
		Versioned: NewVersioned(),
	}
	first := formatTranscriptItem(item, 80)
	if item.markdownCache.stableText != "stable line" {
		t.Fatalf("stable prefix = %q, want %q", item.markdownCache.stableText, "stable line")
	}
	item.text += " grows"
	item.Bump()
	second := formatTranscriptItem(item, 80)
	if item.markdownCache.stableText != "stable line" {
		t.Fatalf("stable prefix should be reused, got %q", item.markdownCache.stableText)
	}
	want := formatLine("assistant", item.text, 80)
	if second != want {
		t.Fatalf("cached render diverged from full render\nwant:\n%q\ngot:\n%q", want, second)
	}
	if first == second {
		t.Fatalf("tail append should change rendered output")
	}
}

func TestStreamingMarkdownCacheInvalidatesOnWidthChange(t *testing.T) {
	item := &transcriptItem{
		kind:      "assistant",
		text:      "stable line\nstreaming tail",
		Versioned: NewVersioned(),
	}
	_ = formatTranscriptItem(item, 80)
	if item.markdownCache.width != 80 {
		t.Fatalf("cache width = %d, want 80", item.markdownCache.width)
	}
	_ = formatTranscriptItem(item, 60)
	if item.markdownCache.width != 60 {
		t.Fatalf("cache width should update after resize, got %d", item.markdownCache.width)
	}
}

func BenchmarkStreamingRenderCold(b *testing.B) {
	text := benchmarkStreamingMarkdownText()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		item := &transcriptItem{kind: "assistant", text: text, Versioned: NewVersioned()}
		_ = formatTranscriptItem(item, 100)
	}
}

func BenchmarkStreamingRenderWarm(b *testing.B) {
	chunks := benchmarkStreamingMarkdownChunks(50)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		item := &transcriptItem{kind: "assistant", Versioned: NewVersioned()}
		for _, chunk := range chunks {
			item.text += chunk
			item.Bump()
			_ = formatTranscriptItem(item, 100)
		}
	}
}

func benchmarkStreamingMarkdownText() string {
	paragraph := "This paragraph has `inline code`, **bold text**, _emphasis_, and enough words to exercise wrapping without changing semantics."
	parts := make([]string, 0, 80)
	for i := 0; i < 80; i++ {
		parts = append(parts, paragraph)
	}
	return strings.Join(parts, "\n")
}

func benchmarkStreamingMarkdownChunks(count int) []string {
	text := benchmarkStreamingMarkdownText()
	chunkSize := max(1, len(text)/count)
	chunks := make([]string, 0, count)
	for start := 0; start < len(text); start += chunkSize {
		end := start + chunkSize
		if end > len(text) {
			end = len(text)
		}
		chunks = append(chunks, text[start:end])
	}
	return chunks
}
