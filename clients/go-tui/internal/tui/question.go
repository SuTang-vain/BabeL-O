package tui

import (
	"fmt"
	"net/http"
	"net/url"

	tea "charm.land/bubbletea/v2"
)

type questionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type pendingQuestion struct {
	sessionID   string
	toolUseID   string
	question    string
	header      string
	options     []questionOption
	multiSelect bool
}

// pendingQuestionMsg is the response from the question response HTTP
// POST. It carries the result of sending the user's selection back to
// Nexus.
type pendingQuestionMsg struct {
	err error
}

// questionSelectedLabels returns the labels for the currently
// selected option indices. Used by sendQuestionDecision to send
// human-readable labels alongside the numeric indices.
func (m *model) questionSelectedLabels() []string {
	if m.pendingQuestion == nil {
		return nil
	}
	labels := make([]string, 0, len(m.questionSelected))
	for _, idx := range m.questionSelected {
		if idx >= 0 && idx < len(m.pendingQuestion.options) {
			labels = append(labels, m.pendingQuestion.options[idx].Label)
		}
	}
	return labels
}

// sendQuestionDecision sends the user's selection(s) to the Nexus
// question response endpoint. Mirrors the sendPermissionDecision
// pattern but uses the HTTP API instead of the WebSocket channel,
// since question responses are not tied to the streaming channel.
func (m *model) sendQuestionDecision(selectedIndices []int, selectedLabels []string) tea.Cmd {
	if m.pendingQuestion == nil {
		return nil
	}

	pq := m.pendingQuestion
	body := map[string]any{
		"toolUseId":       pq.toolUseID,
		"selectedIndices": selectedIndices,
		"selectedLabels":  selectedLabels,
	}
	path := "/v1/sessions/" + url.PathEscape(pq.sessionID) +
		"/questions/" + url.PathEscape(pq.toolUseID) + "/response"

	return func() tea.Msg {
		var result map[string]any
		err := nexusJSON(m.cfg, http.MethodPost, path, body, &result)
		if err != nil {
			m.appendLine("error", "question response: "+err.Error())
		} else {
			m.pendingQuestion = nil
			m.setMode(modeComposing)
			m.appendLine("status", fmt.Sprintf("question answered: %d option(s) selected", len(selectedIndices)))
		}
		return pendingQuestionMsg{err: err}
	}
}