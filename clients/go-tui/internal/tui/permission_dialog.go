package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
)

// permissionDialog implements Dialog for the 5-option permission
// panel. C.2 migrates only rendering: model.Update remains the
// source of truth for cursor movement, editor entry, cancellation,
// and sendPermissionDecision.
type permissionDialog struct {
	pending *pendingPermission
	choice  int
}

func newPermissionDialog(pending *pendingPermission, choice int) *permissionDialog {
	return &permissionDialog{pending: pending, choice: choice}
}

func (d *permissionDialog) ID() string { return "permission" }

func (d *permissionDialog) HandleMsg(_ tea.Msg) tea.Cmd { return nil }

func (d *permissionDialog) View(width int) string {
	if d.pending == nil {
		return ""
	}

	rc := NewRenderContext(width)
	rows := []string{
		titleStyle.Render("Permission: " + firstNonEmpty(d.pending.name, "tool") +
			"  (" + firstNonEmpty(d.pending.risk, "unknown") + " risk)"),
		permissionStyle.Render("Waiting for permission..."),
	}
	if input := strings.TrimSpace(d.pending.input); input != "" {
		rows = append(rows, "input:")
		rows = append(rows, wrapPlain(input, max(0, width-6)))
	}
	if scopeRisk := strings.TrimSpace(d.pending.scopeRisk); scopeRisk != "" {
		rows = append(rows, permissionStyle.Render("Scope: "+scopeRisk+" outside current task"))
		if target := strings.TrimSpace(d.pending.targetRoot); target != "" {
			rows = append(rows, permissionStyle.Render("Target: "+target))
		}
		if current := strings.TrimSpace(d.pending.taskPrimaryRoot); current != "" {
			rows = append(rows, permissionStyle.Render("Current: "+current))
		}
		if reason := strings.TrimSpace(d.pending.scopeReason); reason != "" {
			rows = append(rows, permissionStyle.Render("Scope reason: "+reason))
		}
	}
	repeatedRuleCount := d.pending.repeatedRuleCount
	if suggested := strings.TrimSpace(d.pending.suggestedRule); suggested != "" {
		rows = append(rows, permissionStyle.Render("Suggested rule: "+suggested))
		if repeatedRuleCount > 1 {
			rows = append(rows, permissionStyle.Render(fmt.Sprintf("Repeated rule seen %d times recently — consider session approval.", repeatedRuleCount)))
		}
	}
	sessionChoice := "Approve for this session"
	if suggested := strings.TrimSpace(d.pending.suggestedRule); suggested != "" && repeatedRuleCount > 1 {
		sessionChoice = fmt.Sprintf("Approve for this session  ← recommended for repeated %s", suggested)
	}
	choices := []string{
		"Approve once",
		sessionChoice,
		"Approve with editable rule",
		"Reject",
		"Reject, tell the model what to do instead",
	}
	for i, choice := range choices {
		marker := " "
		if i == d.choice {
			marker = "~"
		}
		rows = append(rows, fmt.Sprintf(" %s [%d] %s", marker, i+1, choice))
	}
	rows = append(rows, permissionStyle.Render("▲/▼ select   1/2/3/4/5 choose   ↵ confirm   esc cancel"))
	if msg := strings.TrimSpace(d.pending.message); msg != "" {
		rows = append(rows, permissionStyle.Render("reason: "+msg))
	}
	rc.AddPart(strings.Join(rows, "\n"))
	return rc.Render()
}

// permissionEditorDialog implements Dialog for the Round 2 inline
// permission editors: editable allow rule and reject feedback. C.2
// keeps text input and submit/back handling in model.Update and
// exitPermissionEditor; this dialog only renders a state snapshot.
type permissionEditorDialog struct {
	pending *pendingPermission
	mode    inputMode
	input   string
}

func newPermissionEditorDialog(pending *pendingPermission, mode inputMode, input string) *permissionEditorDialog {
	return &permissionEditorDialog{pending: pending, mode: mode, input: input}
}

func (d *permissionEditorDialog) ID() string { return "permissionEditor" }

func (d *permissionEditorDialog) HandleMsg(_ tea.Msg) tea.Cmd { return nil }

func (d *permissionEditorDialog) View(width int) string {
	if d.pending == nil {
		return ""
	}
	if d.mode != modePermissionEditRule && d.mode != modePermissionEditFeedback {
		return ""
	}

	headerText := "Editing feedback for " + firstNonEmpty(d.pending.name, "tool")
	if d.mode == modePermissionEditRule {
		headerText = "Editing rule for " + firstNonEmpty(d.pending.name, "tool")
	}

	rc := NewRenderContext(width)
	rows := []string{titleStyle.Render(headerText)}
	rows = append(rows, permissionStyle.Render(firstNonEmpty(d.pending.risk, "unknown")+" risk"))
	if input := strings.TrimSpace(d.pending.input); input != "" {
		rows = append(rows, "input:")
		rows = append(rows, wrapPlain(input, max(0, width-6)))
	}
	if scopeRisk := strings.TrimSpace(d.pending.scopeRisk); scopeRisk != "" {
		rows = append(rows, permissionStyle.Render("Scope: "+scopeRisk+" outside current task"))
		if target := strings.TrimSpace(d.pending.targetRoot); target != "" {
			rows = append(rows, permissionStyle.Render("Target: "+target))
		}
		if current := strings.TrimSpace(d.pending.taskPrimaryRoot); current != "" {
			rows = append(rows, permissionStyle.Render("Current: "+current))
		}
		if reason := strings.TrimSpace(d.pending.scopeReason); reason != "" {
			rows = append(rows, permissionStyle.Render("Scope reason: "+reason))
		}
	}
	if msg := strings.TrimSpace(d.pending.message); msg != "" {
		rows = append(rows, permissionStyle.Render("reason: "+msg))
	}
	if d.mode == modePermissionEditRule {
		if suggested := strings.TrimSpace(d.pending.suggestedRule); suggested != "" {
			rows = append(rows, permissionStyle.Render("Suggested rule: "+suggested))
		}
		rows = append(rows, "")
		rows = append(rows, "  "+d.input)
		rows = append(rows, permissionStyle.Render("Edit the allow rule. Examples: git:status, bash:*, npm:install. Empty = plain approve (scope=once)."))
	} else {
		rows = append(rows, "")
		rows = append(rows, "  "+d.input)
		rows = append(rows, permissionStyle.Render("Tell the model what to do instead. Empty = plain reject (no follow-up hint)."))
	}
	rows = append(rows, permissionStyle.Render("↵ confirm   esc back to options"))
	rc.AddPart(strings.Join(rows, "\n"))
	return rc.Render()
}
