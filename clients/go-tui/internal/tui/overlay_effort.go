package tui

import (
	"fmt"
	"strings"
)

var effortLevels = []string{"quick", "balanced", "deep"}

func effortLevelSummary(level string) string {
	switch level {
	case "quick":
		return "fast answer · narrower inspection · lower reasoning budget"
	case "balanced":
		return "normal engineering judgment · current default"
	case "deep":
		return "broader verification · more tool loops · higher reasoning budget"
	default:
		return ""
	}
}

func (m model) renderEffortOverlay(width int) string {
	if m.inputMode != modeEffortOverlay {
		return ""
	}
	current := effectiveThinkingLevel(m.cfg.ThinkingLevel)
	selected := clamp(m.effortSelected, 0, len(effortLevels)-1)
	lines := []string{
		titleStyle.Render("Thinking Effort"),
		divider(width),
		"Choose the execution depth for the next prompt.",
		"",
	}
	for index, level := range effortLevels {
		marker := "  "
		if index == selected {
			marker = "> "
		}
		currentMarker := ""
		if level == current {
			currentMarker = "  current"
		}
		line := fmt.Sprintf("%s%-8s %s%s", marker, level, effortLevelSummary(level), currentMarker)
		if index == selected {
			line = focusedLineStyle.Render(line)
		} else if level == current {
			line = statusStyle.Render(line)
		}
		lines = append(lines, line)
	}
	lines = append(lines, "")
	if m.running {
		lines = append(lines, mutedStyle.Render("Applies after the current run finishes. Permissions and task scope do not change."))
	} else {
		lines = append(lines, mutedStyle.Render("Applies to the next prompt. Permissions and task scope do not change."))
	}
	lines = append(lines, mutedStyle.Render("↑↓/Tab choose · Enter apply · Esc cancel"))
	return renderOverlayFrame(width, strings.Join(lines, "\n"))
}

func (m *model) openEffortOverlay() {
	current := effectiveThinkingLevel(m.cfg.ThinkingLevel)
	m.effortSelected = 1
	for index, level := range effortLevels {
		if level == current {
			m.effortSelected = index
			break
		}
	}
	m.setMode(modeEffortOverlay)
}

func (m *model) applySelectedEffort() {
	level := effortLevels[clamp(m.effortSelected, 0, len(effortLevels)-1)]
	m.cfg.ThinkingLevel = level
	m.setMode(modeComposing)
	if m.running {
		m.appendLine("status", "effort set to "+level+"; applies after the current run")
	} else {
		m.appendLine("status", "effort set to "+level)
	}
}
