package tui

import (
	"os"
	"strings"

	"charm.land/lipgloss/v2"
)

func (m model) renderWelcomeCard(width int) string {
	formattedCwd := m.cfg.Cwd
	home := os.Getenv("HOME")
	if home != "" {
		if formattedCwd == home {
			formattedCwd = "~"
		} else if strings.HasPrefix(formattedCwd, home+"/") {
			formattedCwd = "~/" + formattedCwd[len(home)+1:]
		}
	}

	mode := "Embedded (Local)"
	if m.cfg.BaseURL != "" && !strings.Contains(m.cfg.BaseURL, "127.0.0.1") && !strings.Contains(m.cfg.BaseURL, "localhost") {
		mode = "Service (" + m.cfg.BaseURL + ")"
	}

	defaultModel := m.modelID
	if defaultModel == "" {
		defaultModel = "local/coding-runtime"
	}

	sessionVal := m.sessionID
	if sessionVal == "" {
		sessionVal = m.cfg.SessionID
	}
	if sessionVal == "" {
		sessionVal = "new session"
	}

	pixelRows := []string{
		"    M    ",
		"   M M   ",
		"    R    ",
		"   R R   ",
		"  R   R  ",
		"O O P V V",
	}

	colors := map[rune]string{
		'M': "#ff006e",
		'P': "#ff4f9a",
		'R': "#c72d68",
		'O': "#ff7a18",
		'V': "#8b5cf6",
	}

	renderLogoRow := func(row string) string {
		var sb strings.Builder
		for _, r := range row {
			if r == ' ' {
				sb.WriteByte(' ')
			} else {
				hex, ok := colors[r]
				if !ok {
					hex = "#ff006e"
				}
				style := lipgloss.NewStyle().Foreground(lipgloss.Color(hex))
				sb.WriteString(style.Render("█"))
			}
		}
		return sb.String()
	}

	modelSummary := truncatePlain(defaultModel, 42)
	cwdSummary := truncatePlain(formattedCwd, 42)
	sessionSummary := truncatePlain(shortID(sessionVal), 42)
	modeSummary := truncatePlain(mode, 42)
	titleLine := titleStyle.Render("v"+Version) + mutedStyle.Render("  Welcome back!")
	authValue := "ready"
	authMarker := statusStyle.Render("●")
	if m.authMode != "" && m.authMode != "none" && !m.hasAPIKey {
		authValue = "setup /model"
		authMarker = errorStyle.Render("!")
	}
	metadataLines := []string{
		titleLine,
		welcomeMetaLine("model", modelSummary, statusStyle.Render("●")),
		welcomeMetaLine("auth", authValue, authMarker),
		welcomeMetaLine("session", sessionSummary, mutedStyle.Render("•")),
		welcomeMetaLine("mode", modeSummary, mutedStyle.Render("•")),
		welcomeMetaLine("work", cwdSummary, contextStyle.Render("○")),
	}
	infoGap := 10
	infoOffset := 1 + lipgloss.Width(pixelRows[0]) + infoGap

	var cardLines []string
	for i := 0; i < 6; i++ {
		logoCol := renderLogoRow(pixelRows[i])
		metaCol := ""
		if i < len(metadataLines) {
			metaCol = metadataLines[i]
		}
		combined := " " + logoCol + strings.Repeat(" ", infoGap) + metaCol
		cardLines = append(cardLines, combined)
	}

	maxCardWidth := 0
	for _, line := range cardLines {
		w := lipgloss.Width(line)
		if w > maxCardWidth {
			maxCardWidth = w
		}
	}

	navLine := strings.Join([]string{
		lipgloss.NewStyle().Foreground(lipgloss.Color("#ff7a18")).Render("◆") + " chat",
		lipgloss.NewStyle().Foreground(lipgloss.Color("51")).Render("◆") + " nexus",
		lipgloss.NewStyle().Foreground(lipgloss.Color("99")).Render("◆") + " config",
		lipgloss.NewStyle().Foreground(lipgloss.Color("#ff4f9a")).Render("◆") + " models",
	}, "   ")
	cardLines = append(cardLines, strings.Repeat(" ", infoOffset)+focusedLineStyle.Render(navLine))
	maxCardWidth = max(maxCardWidth, lipgloss.Width(cardLines[len(cardLines)-1]))

	hPad := max(0, (width-maxCardWidth)/2)
	hSpace := strings.Repeat(" ", hPad)

	var outputLines []string
	outputLines = append(outputLines, "", "")
	for _, line := range cardLines {
		outputLines = append(outputLines, hSpace+line)
	}
	outputLines = append(outputLines, "")

	return strings.Join(outputLines, "\n")
}

func welcomeMetaLine(label string, value string, marker string) string {
	labelStyle := mutedStyle.Width(8)
	valueStyle := contextStyle
	if marker == "" {
		marker = mutedStyle.Render("•")
	}
	return marker + " " + labelStyle.Render(label) + " " + valueStyle.Render(value)
}
