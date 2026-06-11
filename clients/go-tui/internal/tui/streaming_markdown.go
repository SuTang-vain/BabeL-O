package tui

import "strings"

type streamingMarkdownCache struct {
	width          int
	kind           string
	stableText     string
	stableRendered string
}

func (c *streamingMarkdownCache) Render(kind string, text string, width int) string {
	normalized := normalizeStreamingMarkdownText(text)
	boundary := findSafeMarkdownBoundary(normalized)
	if boundary < 0 {
		c.Invalidate()
		return renderAssistantMarkdownNormalized(kind, normalized, width)
	}
	if c.width != width || c.kind != kind || !strings.HasPrefix(normalized, c.stableText) {
		c.Invalidate()
	}
	if boundary > len(c.stableText) {
		newStableText := normalized[:boundary]
		if c.stableText == "" {
			c.stableRendered = renderAssistantMarkdownNormalized(kind, newStableText, width)
		} else {
			segmentStart := len(c.stableText)
			if segmentStart < len(newStableText) && newStableText[segmentStart] == '\n' {
				segmentStart++
			}
			if segmentStart < len(newStableText) {
				segmentRendered := renderAssistantMarkdownNormalized(kind, newStableText[segmentStart:], width)
				c.stableRendered += "\n" + segmentRendered
			}
		}
		c.stableText = newStableText
		c.width = width
		c.kind = kind
	}
	if c.stableRendered == "" {
		return renderAssistantMarkdownNormalized(kind, normalized, width)
	}
	if boundary >= len(normalized)-1 {
		if boundary == len(normalized)-1 {
			return c.stableRendered + "\n"
		}
		return c.stableRendered
	}
	tail := normalized[boundary+1:]
	return c.stableRendered + "\n" + renderAssistantMarkdownNormalized(kind, tail, width)
}

func (c *streamingMarkdownCache) Invalidate() {
	c.width = 0
	c.kind = ""
	c.stableText = ""
	c.stableRendered = ""
}

func normalizeStreamingMarkdownText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return collapseParagraphBreaks(text)
}

func renderAssistantMarkdownText(kind string, text string, width int) string {
	return renderAssistantMarkdownNormalized(kind, normalizeStreamingMarkdownText(text), width)
}

func renderAssistantMarkdownNormalized(kind string, text string, width int) string {
	style := assistantStyle
	if kind == "thinking" {
		style = thinkingStyle
	}
	bodyWidth := max(10, width-2)
	body := wrapNormalizedText(text, bodyWidth)
	bodyLines := strings.Split(body, "\n")
	if len(bodyLines) == 0 {
		bodyLines = []string{""}
	}
	renderAssistantLine := func(line string) string {
		trimmed := strings.TrimLeft(line, " ")
		if strings.HasPrefix(trimmed, "# ") {
			headerLevel := 1
			for strings.HasPrefix(trimmed, "#") {
				headerLevel++
				trimmed = strings.TrimPrefix(trimmed, "#")
			}
			trimmed = strings.TrimPrefix(trimmed, " ")
			_ = headerLevel
			return "  " + titleStyle.Render(renderInlineMarkdown(style, trimmed))
		}
		return "  " + renderInlineMarkdown(style, line)
	}
	out := make([]string, 0, len(bodyLines))
	out = append(out, renderAssistantLine(bodyLines[0]))
	for _, c := range bodyLines[1:] {
		if c == "" {
			out = append(out, "")
			continue
		}
		out = append(out, renderAssistantLine(c))
	}
	return strings.Join(out, "\n")
}

func wrapNormalizedText(text string, width int) string {
	paragraphs := strings.Split(text, "\n")
	out := make([]string, 0, len(paragraphs))
	for _, paragraph := range paragraphs {
		out = append(out, wrapParagraph(paragraph, width)...)
	}
	return strings.Join(out, "\n")
}

func findSafeMarkdownBoundary(s string) int {
	lastSafe := -1
	inCode := false
	inList := false
	inTable := false
	inBlockquote := false
	lines := strings.SplitAfter(s, "\n")
	offset := 0
	for i, rawLine := range lines {
		hasNewline := strings.HasSuffix(rawLine, "\n")
		line := strings.TrimSuffix(rawLine, "\n")
		trimmed := strings.TrimSpace(line)
		nextTrimmed := ""
		if i+1 < len(lines) {
			nextTrimmed = strings.TrimSpace(strings.TrimSuffix(lines[i+1], "\n"))
		}
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inCode = !inCode
		}
		setextPending := !inCode && trimmed != "" && isSetextMarkerLine(nextTrimmed)
		if !inCode {
			if trimmed == "" {
				inList = false
				inTable = false
				inBlockquote = false
			} else {
				inList = isMarkdownListLine(trimmed) || (inList && isIndentedMarkdownContinuation(line))
				inTable = isMarkdownTableLine(trimmed)
				inBlockquote = strings.HasPrefix(trimmed, ">")
			}
		}
		unsafe := inCode || inList || inTable || inBlockquote || setextPending
		if hasNewline && !unsafe {
			lastSafe = offset + len(rawLine) - 1
		}
		offset += len(rawLine)
	}
	return lastSafe
}

func isMarkdownListLine(trimmed string) bool {
	if len(trimmed) >= 2 {
		marker := trimmed[:2]
		if marker == "- " || marker == "* " || marker == "+ " {
			return true
		}
	}
	for i, r := range trimmed {
		if r < '0' || r > '9' {
			return i > 0 && r == '.' && i+1 < len(trimmed) && trimmed[i+1] == ' '
		}
	}
	return false
}

func isMarkdownTableLine(trimmed string) bool {
	return strings.Contains(trimmed, "|")
}

func isIndentedMarkdownContinuation(line string) bool {
	return strings.HasPrefix(line, "  ") || strings.HasPrefix(line, "\t")
}

func isSetextMarkerLine(trimmed string) bool {
	if trimmed == "" {
		return false
	}
	marker := trimmed[0]
	if marker != '=' && marker != '-' {
		return false
	}
	for i := 0; i < len(trimmed); i++ {
		if trimmed[i] != marker {
			return false
		}
	}
	return true
}
