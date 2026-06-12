package tui

import (
	"encoding/base64"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/atotto/clipboard"
)

type selectionMouseAction int

const (
	selectionMousePress selectionMouseAction = iota
	selectionMouseMotion
	selectionMouseRelease
)

type selectionMouseEvent struct {
	action selectionMouseAction
	x      int
	y      int
}

// viewportTopY returns the screen row where the transcript
// viewport begins. Keep this in one place so header chrome
// changes (for example adding the input-style divider) do not
// desync mouse selection coordinates.
func (m *model) viewportTopY() int {
	return lipgloss.Height(m.renderHeader(max(40, m.width)))
}

// selectionInViewport reports whether a screen-relative
// mouse coordinate lands inside the transcript viewport.
// The viewport starts immediately below renderHeader(); the
// horizontal bounds match the rendered content width.
func (m *model) selectionInViewport(x, y int) bool {
	if m.cfg.MouseCapture == false {
		return false
	}
	if m.topCardOpen {
		return false
	}
	vpTopY := m.viewportTopY()
	if y < vpTopY {
		return false
	}
	vpBottomY := vpTopY + m.viewport.Height()
	if y >= vpBottomY {
		return false
	}
	if x < 0 || x > m.viewport.Width() {
		return false
	}
	return true
}

func (m *model) maxSelectionLine() int {
	lines := strings.Split(stripANSICodes(m.fullViewportContent()), "\n")
	return max(0, len(lines)-1)
}

// startSelection anchors a new selection at the given
// viewport-content (line, col) position. (line, col) is
// in the same coord space as the viewport's YOffset —
// i.e. line 0 is the welcome card's first line, col 0
// is the leftmost column. Both bounds are clamped.
func (m *model) startSelection(line, col int) {
	m.selectionStartLine = clamp(line, 0, m.maxSelectionLine())
	m.selectionStartCol = m.clampSelectionCol(m.selectionStartLine, col)
	m.selectionEndLine = m.selectionStartLine
	m.selectionEndCol = m.selectionStartCol
	m.selectionActive = true
}

// extendSelection moves the end-anchor to a new (line, col)
// while a left-button drag is in progress. The selection
// stays anchored to its start; only the end moves.
func (m *model) extendSelection(line, col int) {
	if !m.selectionActive {
		return
	}
	m.selectionEndLine = clamp(line, 0, m.maxSelectionLine())
	m.selectionEndCol = m.clampSelectionCol(m.selectionEndLine, col)
}

// clearSelection resets the selection anchors without
// touching the "lastSelectionCopy" feedback timestamp.
func (m *model) clearSelection() {
	m.selectionActive = false
	m.selectionStartLine = 0
	m.selectionStartCol = 0
	m.selectionEndLine = 0
	m.selectionEndCol = 0
	m.mouseDownInViewport = false
}

// normalizedSelection returns the selection rect in
// top-left → bottom-right order. If start == end the
// selection is empty.
func (m *model) normalizedSelection() (sl, sc, el, ec int, ok bool) {
	if !m.selectionActive {
		return 0, 0, 0, 0, false
	}
	sl, sc = m.selectionStartLine, m.selectionStartCol
	el, ec = m.selectionEndLine, m.selectionEndCol
	if (sl > el) || (sl == el && sc > ec) {
		sl, sc, el, ec = el, ec, sl, sc
	}
	if sl == el && sc == ec {
		return sl, sc, el, ec, false
	}
	return sl, sc, el, ec, true
}

func (m *model) clampSelectionCol(line, col int) int {
	lineWidth := m.selectionLineWidth(line)
	return clamp(col, 0, max(0, lineWidth))
}

func (m *model) selectionLineWidth(line int) int {
	lines := strings.Split(stripANSICodes(m.fullViewportContent()), "\n")
	if line < 0 || line >= len(lines) {
		return m.viewport.Width()
	}
	return min(m.viewport.Width(), visibleWidth(lines[line]))
}

// handleSelectionMouse routes a left-button MouseMsg to
// the in-app selection state machine. Returns the model
// and an optional OSC 52 copy command.
//
// Coord mapping: msg.X / msg.Y are screen-relative. We translate
// to viewport-content (line, col) by subtracting the current
// header height, mirroring Crush's layout-relative mouse routing.
func (m *model) handleSelectionMouse(msg selectionMouseEvent) (model, tea.Cmd) {
	// Only the transcript viewport accepts selection; an
	// overlay / permission / editor / input has its own
	// single-input-owner and we don't want a stray drag to
	// bleed into the transcript behind it.
	if m.inputMode != modeComposing {
		m.mouseDownInViewport = false
		return *m, nil
	}
	if !m.selectionInViewport(msg.x, msg.y) {
		// A press / motion / release outside the viewport
		// ends any in-progress drag without committing a
		// copy.
		m.mouseDownInViewport = false
		return *m, nil
	}
	contentLine := m.viewport.YOffset() + (msg.y - m.viewportTopY())
	contentCol := msg.x
	switch {
	case msg.action == selectionMousePress:
		m.mouseDownInViewport = true
		m.startSelection(contentLine, contentCol)
		return *m, nil
	case msg.action == selectionMouseMotion && m.mouseDownInViewport:
		m.extendSelection(contentLine, contentCol)
		return *m, nil
	case msg.action == selectionMouseRelease && m.mouseDownInViewport:
		m.mouseDownInViewport = false
		m.extendSelection(contentLine, contentCol)
		sl, sc, el, ec, ok := m.normalizedSelection()
		if !ok {
			// Empty / one-cell click: clear, no copy.
			m.clearSelection()
			return *m, nil
		}
		text := m.extractSelectedText(sl, sc, el, ec)
		if text == "" {
			m.clearSelection()
			return *m, nil
		}
		m.lastSelectionCopy = text
		m.lastSelectionCopyAt = time.Now()
		m.copyToastMessage = "Selected text copied to clipboard"
		m.copyToastShownAt = m.lastSelectionCopyAt
		m.clearSelection()
		return *m, tea.Sequence(osC52CopyCmd(text), expireCopyToastCmd(m.copyToastShownAt))
	}
	return *m, nil
}

func expireCopyToastCmd(copiedAt time.Time) tea.Cmd {
	return tea.Tick(3*time.Second, func(time.Time) tea.Msg {
		return copyToastExpiredMsg{copiedAt: copiedAt}
	})
}

// extractSelectedText walks the viewport's plain-text
// content and pulls the substring inside the given
// (line, col) rect. ANSI escape sequences are stripped
// from the source so what gets copied matches what the
// operator saw (modulo any leading whitespace padding
// baked in by the welcome card).
func (m *model) extractSelectedText(sl, sc, el, ec int) string {
	full := m.fullViewportContent()
	plain := stripANSICodes(full)
	lines := strings.Split(plain, "\n")
	if sl < 0 || sl >= len(lines) {
		return ""
	}
	if el < 0 || el >= len(lines) {
		el = len(lines) - 1
	}
	if sl == el {
		return sliceVisibleColumns(lines[sl], sc, ec)
	}
	var b strings.Builder
	for i := sl; i <= el && i < len(lines); i++ {
		line := lines[i]
		switch i {
		case sl:
			b.WriteString(sliceVisibleColumns(line, sc, visibleWidth(line)))
			b.WriteByte('\n')
		case el:
			b.WriteString(sliceVisibleColumns(line, 0, ec))
		default:
			b.WriteString(line)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// fullViewportContent reconstructs the same content string
// that refreshViewport() feeds to the viewport. We do not
// re-call refreshViewport() here because that would also
// re-position the scroll; the operator's selection must
// stay anchored to the same text even if they release the
// mouse on a frame that hasn't been refreshed.
func (m *model) fullViewportContent() string {
	welcome := m.renderWelcomeCard(max(40, m.viewport.Width()))
	transcript := renderTranscript(m.transcript, max(40, m.viewport.Width()))
	if transcript != "" {
		return welcome + "\n\n" + transcript
	}
	return welcome
}

// stripANSICodes removes CSI (\x1b[...m) and OSC (\x1b]...BEL
// or \x1b\\ ) sequences from `s`. Used by the OSC 52
// copy path so the clipboard receives the operator's text
// without terminal control bytes attached.
func stripANSICodes(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	i := 0
	for i < len(s) {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == 0x1b {
			j := i + 1
			if j < len(s) {
				switch s[j] {
				case '[':
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
				case ']':
					j++
					// OSC terminates on BEL (0x07) or
					// ST (ESC \). Skip until terminator.
					for j < len(s) {
						if s[j] == 0x07 {
							j++
							break
						}
						if s[j] == 0x1b && j+1 < len(s) && s[j+1] == '\\' {
							j += 2
							break
						}
						j++
					}
					i = j
					continue
				}
			}
			i += size
			continue
		}
		b.WriteString(s[i : i+size])
		i += size
	}
	return b.String()
}

// buildOSC52Sequence returns the raw OSC 52 byte stream
// for `text`. Most modern terminals (iTerm2, WezTerm,
// recent gnome-terminal, Windows Terminal, kitty,
// alacritty) honor OSC 52 even when the app is in
// alternate-screen mode. The sequence uses BEL as the
// string terminator, which is the widely-supported
// default.
func buildOSC52Sequence(text string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(text))
	return "\x1b]52;c;" + encoded + "\x07"
}

// osC52CopyCmd builds a tea.Cmd that pushes `text` to the
// system clipboard via the OSC 52 escape sequence. We
// use tea.Printf so the byte stream goes through the
// bubbletea renderer and reaches stdout in a single
// redraw cycle; printing via os.Stdout would corrupt the
// current frame.
func osC52CopyCmd(text string) tea.Cmd {
	return tea.Sequence(
		tea.Printf("%s", buildOSC52Sequence(text)),
		func() tea.Msg {
			_ = clipboard.WriteAll(text)
			return nil
		},
	)
}

func (m *model) handleMouseEscapeString(raw string) bool {
	if raw == "" {
		return false
	}
	if m.mouseEscapeBuffer != "" {
		m.mouseEscapeBuffer += raw
		if m.completeMouseEscapeBuffer() {
			return true
		}
		if len(m.mouseEscapeBuffer) > 32 || !looksLikeMouseEscapePrefix(m.mouseEscapeBuffer) {
			m.mouseEscapeBuffer = ""
		}
		return true
	}
	// Some terminals can leak mouse reports as ordinary key
	// fragments when mouse tracking toggles around focus/scroll.
	// Bubble Tea normally parses these as MouseMsg; when it does not,
	// swallowing them here prevents protocol bytes from landing in the
	// textarea. Wheel reports still scroll the active view.
	if startsMouseEscape(raw) {
		m.mouseEscapeBuffer = raw
		if m.completeMouseEscapeBuffer() {
			return true
		}
		return true
	}
	start := strings.Index(raw, "<")
	x10Start := strings.Index(raw, "[M")
	if start < 0 && x10Start < 0 {
		return false
	}
	if x10Start >= 0 && (start < 0 || x10Start < start) {
		m.mouseEscapeBuffer = raw[x10Start:]
		_ = m.completeMouseEscapeBuffer()
		return true
	}
	report := raw[start:]
	if !strings.HasSuffix(report, "M") && !strings.HasSuffix(report, "m") {
		if strings.HasPrefix(report, "<64;") || strings.HasPrefix(report, "<65;") || looksLikeMouseEscapePrefix(report) {
			m.mouseEscapeBuffer = report
			return true
		}
		return false
	}
	if strings.HasPrefix(report, "<64;") {
		m.scrollByMouseEscape(-mouseWheelStepLines)
		return true
	}
	if strings.HasPrefix(report, "<65;") {
		m.scrollByMouseEscape(mouseWheelStepLines)
		return true
	}
	return strings.HasPrefix(report, "<")
}

func (m *model) completeMouseEscapeBuffer() bool {
	report := m.mouseEscapeBuffer
	if idx := strings.Index(report, "[M"); idx >= 0 {
		x10 := report[idx:]
		if len([]rune(x10)) < 5 {
			return false
		}
		m.mouseEscapeBuffer = ""
		m.scrollByX10MouseEscape(x10)
		return true
	}
	if idx := strings.Index(report, "<"); idx >= 0 {
		report = report[idx:]
	}
	if !(strings.HasSuffix(report, "M") || strings.HasSuffix(report, "m")) {
		return false
	}
	m.mouseEscapeBuffer = ""
	if strings.HasPrefix(report, "<64;") {
		m.scrollByMouseEscape(-mouseWheelStepLines)
		return true
	}
	if strings.HasPrefix(report, "<65;") {
		m.scrollByMouseEscape(mouseWheelStepLines)
		return true
	}
	return true
}

func startsMouseEscape(raw string) bool {
	return raw == "[" ||
		raw == "\x1b[" ||
		raw == "\x1b[<" ||
		raw == "[<" ||
		raw == "\x1b[M" ||
		raw == "[M" ||
		strings.HasPrefix(raw, "\x1b[<") ||
		strings.HasPrefix(raw, "[<") ||
		strings.HasPrefix(raw, "\x1b[M") ||
		strings.HasPrefix(raw, "[M")
}

func looksLikeMouseEscapePrefix(raw string) bool {
	if raw == "" {
		return false
	}
	if strings.HasPrefix(raw, "\x1b[") {
		raw = strings.TrimPrefix(raw, "\x1b[")
	}
	if strings.HasPrefix(raw, "[") {
		raw = strings.TrimPrefix(raw, "[")
	}
	if strings.HasPrefix(raw, "M") {
		return true
	}
	if strings.HasPrefix(raw, "<") {
		raw = strings.TrimPrefix(raw, "<")
	}
	if raw == "" {
		return true
	}
	for _, r := range raw {
		if (r >= '0' && r <= '9') || r == ';' {
			continue
		}
		return r == 'M' || r == 'm'
	}
	return true
}

func (m *model) scrollByX10MouseEscape(report string) {
	runes := []rune(report)
	if len(runes) < 5 {
		return
	}
	button := int(runes[2]) - 32
	if button&0b01_000000 == 0 {
		return
	}
	if button&1 == 0 {
		m.scrollByMouseEscape(-mouseWheelStepLines)
	} else {
		m.scrollByMouseEscape(mouseWheelStepLines)
	}
}

func (m *model) scrollByMouseEscape(delta int) {
	if m.inputMode == modeComposing {
		if delta < 0 {
			m.viewport.ScrollUp(-delta)
		} else {
			m.viewport.ScrollDown(delta)
		}
		return
	}
	m.scrollOverlay(delta)
}

func decodeUnknownCSIString(raw string) (string, bool) {
	if !strings.HasPrefix(raw, "?CSI[") || !strings.HasSuffix(raw, "]?") {
		return "", false
	}
	body := strings.TrimSuffix(strings.TrimPrefix(raw, "?CSI["), "]?")
	fields := strings.Fields(body)
	bytes := make([]byte, 0, len(fields)+2)
	bytes = append(bytes, '\x1b', '[')
	for _, field := range fields {
		value, err := strconv.Atoi(field)
		if err != nil || value < 0 || value > 255 {
			return "", false
		}
		bytes = append(bytes, byte(value))
	}
	return string(bytes), true
}

func isUnknownShiftEnterCSI(raw string) bool {
	if raw == "" {
		return false
	}
	if strings.Contains(raw, "13;2u") ||
		strings.Contains(raw, "13;2~") ||
		strings.Contains(raw, "27;2;13~") {
		return true
	}
	if decoded, ok := decodeUnknownCSIString(raw); ok {
		return isUnknownShiftEnterCSI(decoded)
	}
	return false
}

func (m *model) handleUnknownCSIMessage(raw string) bool {
	decoded, ok := decodeUnknownCSIString(raw)
	if !ok {
		return false
	}
	if isUnknownShiftEnterCSI(decoded) {
		m.insertInputNewline()
		return true
	}
	return m.handleMouseEscapeString(decoded)
}
