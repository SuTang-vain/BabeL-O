package tui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

type sessionPanelAction string

const (
	sessionActionCurrent sessionPanelAction = "current"
	sessionActionNew     sessionPanelAction = "new"
	sessionActionSelect  sessionPanelAction = "select"
	sessionActionSwitch  sessionPanelAction = "switch"
)

type sessionPanelRow struct {
	action  sessionPanelAction
	label   string
	summary string
}

func sessionPanelActions() []sessionPanelRow {
	return []sessionPanelRow{
		{action: sessionActionCurrent, label: "session current", summary: "show the active conversation session"},
		{action: sessionActionNew, label: "session new", summary: "start a fresh session on the next prompt"},
		{action: sessionActionSelect, label: "session select", summary: "choose an existing session by id"},
		{action: sessionActionSwitch, label: "session switch", summary: "switch active context to a session id"},
	}
}

func (m *model) openSessionPanel() {
	m.sessionPanelSelected = 0
	m.sessionPendingAction = ""
	m.setInputValue("")
	m.setMode(modeSessionOverlay)
	m.resize()
}

func (m *model) closeSessionPanel(status string) {
	m.sessionPendingAction = ""
	m.sessionPanelSelected = 0
	m.setInputValue("")
	m.setMode(modeComposing)
	if status != "" {
		m.appendLine("status", status)
	}
	m.resize()
}

func (m *model) resetActiveSession() {
	m.sessionID = ""
	m.cfg.SessionID = ""
	m.pending = nil
	m.latestUsage = nil
	m.lastUsage = nil
	m.contextUsage = nil
	m.softTimeoutState = nil
	m.inboxMessages = nil
	m.inboxChannels = nil
	m.contextOverlayLines = nil
}

func (m *model) switchActiveSession(sessionID string) {
	m.sessionID = sessionID
	m.cfg.SessionID = sessionID
	m.pending = nil
	m.latestUsage = nil
	m.lastUsage = nil
	m.contextUsage = nil
	m.softTimeoutState = nil
	m.inboxMessages = nil
	m.inboxChannels = nil
	m.contextOverlayLines = nil
}

func (m *model) enterSessionPanelSelection() tea.Cmd {
	actions := sessionPanelActions()
	if len(actions) == 0 {
		m.closeSessionPanel("session panel closed")
		return nil
	}
	if m.sessionPanelSelected < 0 || m.sessionPanelSelected >= len(actions) {
		m.sessionPanelSelected = 0
	}
	action := actions[m.sessionPanelSelected].action
	switch action {
	case sessionActionCurrent:
		if m.sessionID == "" {
			m.closeSessionPanel("session: none yet; submit a prompt or create a new session")
		} else {
			m.closeSessionPanel("session current: " + m.sessionID)
		}
	case sessionActionNew:
		m.sessionPendingAction = action
		m.setMode(modeSessionConfirm)
		m.resize()
	case sessionActionSelect, sessionActionSwitch:
		m.sessionPendingAction = action
		m.setInputValue("")
		m.setMode(modeSessionInput)
		m.resize()
	default:
		m.closeSessionPanel("session panel closed")
	}
	return nil
}

func (m *model) confirmSessionNew() {
	m.resetActiveSession()
	m.closeSessionPanel("session: new session will be created on next prompt")
}

func (m *model) applySessionInput() {
	sessionID := strings.TrimSpace(m.input.Value())
	if sessionID == "" {
		m.appendLine("error", "session id is required")
		m.setInputValue("")
		m.setMode(modeSessionOverlay)
		m.resize()
		return
	}
	m.switchActiveSession(sessionID)
	verb := "switched"
	if m.sessionPendingAction == sessionActionSelect {
		verb = "selected"
	}
	m.closeSessionPanel("session " + verb + ": " + shortID(sessionID))
}

func (m *model) copyCurrentSessionID() tea.Cmd {
	sessionID := strings.TrimSpace(firstNonEmpty(m.sessionID, m.cfg.SessionID))
	if sessionID == "" {
		m.appendLine("status", "session: no active session id to copy")
		return nil
	}
	copiedAt := time.Now()
	m.copyToastMessage = "Session id copied to clipboard"
	m.copyToastShownAt = copiedAt
	return tea.Sequence(osC52CopyCmd(sessionID), expireCopyToastCmd(copiedAt))
}

func (m *model) handleSessionCommand(args []string) tea.Cmd {
	if len(args) == 0 {
		m.openSessionPanel()
		return nil
	}
	if args[0] == "current" {
		if m.sessionID == "" {
			m.appendLine("status", "session: none yet — submit a prompt or use /session new")
		} else {
			m.appendLine("status", "session current: "+m.sessionID)
		}
		m.appendLine("status", "session commands: /session new · /session use <sessionId>")
		return nil
	}
	switch args[0] {
	case "new":
		m.resetActiveSession()
		m.appendLine("status", "session: new session will be created on next prompt")
		return nil
	case "use", "switch", "select":
		if len(args) < 2 || strings.TrimSpace(args[1]) == "" {
			m.appendLine("error", "/session use requires a session id")
			return nil
		}
		sessionID := strings.TrimSpace(args[1])
		m.switchActiveSession(sessionID)
		m.appendLine("status", "session switched: "+shortID(sessionID))
		return nil
	default:
		m.appendLine("error", "unknown /session sub-command: "+args[0]+" (supported: current, new, use <sessionId>)")
		return nil
	}
}

func (m model) renderSessionOverlay(width int) string {
	switch m.inputMode {
	case modeSessionOverlay:
		innerWidth := max(24, width-6)
		header := titleStyle.Render("Session Control")
		active := "none"
		if sessionID := strings.TrimSpace(firstNonEmpty(m.sessionID, m.cfg.SessionID)); sessionID != "" {
			active = sessionID
		}
		lines := []string{
			header,
			mutedStyle.Render(truncatePlain("active: "+active, innerWidth)),
			divider(width),
		}
		actions := sessionPanelActions()
		if len(actions) == 0 {
			lines = append(lines, mutedStyle.Render("  No session actions available."))
		}
		for i, action := range actions {
			marker := "  "
			rowStyle := lipgloss.NewStyle()
			if i == m.sessionPanelSelected {
				marker = "> "
				rowStyle = focusedLineStyle
			}
			line := fmt.Sprintf("%s%-16s %s", marker, action.label, action.summary)
			lines = append(lines, "  "+rowStyle.Render(truncatePlain(line, innerWidth)))
		}
		lines = append(lines, "", mutedStyle.Render("  ↑↓/Tab navigate · enter open · ctrl+p copy id · esc close"))
		return renderOverlayFrame(width, strings.Join(lines, "\n"))

	case modeSessionConfirm:
		current := "none"
		if sessionID := strings.TrimSpace(firstNonEmpty(m.sessionID, m.cfg.SessionID)); sessionID != "" {
			current = sessionID
		}
		lines := []string{
			titleStyle.Render("New Session"),
			divider(width),
			"  Current: " + current,
			"  A new server session will be allocated on your next prompt.",
			"",
			focusedLineStyle.Render("  > Start new session"),
			mutedStyle.Render("    Esc cancel"),
			"",
			mutedStyle.Render("  enter confirm · ctrl+p copy id · esc close"),
		}
		return renderOverlayFrame(width, strings.Join(lines, "\n"))

	case modeSessionInput:
		action := "switch"
		if m.sessionPendingAction == sessionActionSelect {
			action = "select"
		}
		lines := []string{
			titleStyle.Render("Session " + strings.Title(action)),
			divider(width),
			mutedStyle.Render("  Paste or type an existing session id."),
			"",
			m.input.View(),
			"",
			mutedStyle.Render("  enter confirm · ctrl+p copy id · esc close"),
		}
		return renderOverlayFrame(width, strings.Join(lines, "\n"))
	default:
		return ""
	}
}
