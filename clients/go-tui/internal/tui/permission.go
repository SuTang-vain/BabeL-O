package tui

import (
	"strings"
	"time"
)

type pendingPermission struct {
	sessionID       string
	toolUseID       string
	name            string
	risk            string
	input           string
	message         string
	scopeRisk       string
	targetRoot      string
	taskPrimaryRoot string
	scopeReason     string
	// Phase A.1: model-suggested allow rule (e.g. "cd:*",
	// "git:status"). Surfaced from the runtime's
	// `permission_request` event's `suggestedRule` field.
	suggestedRule string
	// Phase 3 of docs/nexus/reference/go-tui-tool-permission-timeout-optimization-plan.md:
	// repeatedRuleCount is the number of times this same suggestedRule
	// has appeared in a short recent window, including the current
	// request. Values >1 nudge the operator toward session approval.
	repeatedRuleCount int
}

type permissionRuleSeen struct {
	count int
	last  time.Time
}

const repeatedPermissionRuleWindow = 2 * time.Minute

func (m *model) inPermissionGracePeriod() bool {
	if m.permissionOpenedAt.IsZero() {
		return false
	}
	if m.graceMaxDelay == 0 {
		return false
	}
	now := time.Now()
	if now.Sub(m.permissionOpenedAt) >= m.graceMaxDelay {
		return false
	}
	if now.Sub(m.permissionLastInputAt) >= m.graceQuietPeriod {
		return false
	}
	return true
}

func (m model) renderPermission(width int) string {
	return newPermissionDialog(m.pending, m.permissionChoice).View(width)
}

// renderPermissionEditor is the Round 2 inline text editor
// reached from the 5-option panel for options 3 (editable rule)
// and 5 (reject-with-feedback). The overlay shows the same
// context as the 5-option panel (tool name, risk, input, the
// suggested rule when editing option 3) and a single-line
// textinput where the operator edits the rule / types feedback.
//
// Visual shape:
//   - Header: "Editing rule for Bash" / "Editing feedback for Bash"
//   - Tool input + reason echo
//   - "Suggested rule: <rule>"  (only when editing option 3 and
//     the runtime surfaced a rule; this is the reference the
//     operator can edit)
//   - Prompt line: "  <m.input.View()>" (input's own Prompt
//     provides the leading "> ")
//   - Keyboard hint: "↵ confirm  esc back to options"
func (m model) renderPermissionEditor(width int) string {
	if m.pending == nil {
		return ""
	}
	if m.inputMode != modePermissionEditRule && m.inputMode != modePermissionEditFeedback {
		return ""
	}
	return newPermissionEditorDialog(m.pending, m.inputMode, m.input.View()).View(width)
}

func (m *model) sendPermissionDecision(approved bool, reason, scope, rule, feedback string) bool {
	if m.pending == nil || m.decisions == nil {
		return false
	}
	decision := permissionDecision{
		sessionID: m.pending.sessionID,
		toolUseID: m.pending.toolUseID,
		approved:  approved,
		reason:    reason,
		scope:     scope,
		rule:      rule,
		feedback:  feedback,
	}
	select {
	case m.decisions <- decision:
		// Permission decisions are mirrored by Nexus as
		// permission_response events and surfaced in /activity.
		// Keep the main transcript focused on user/model/tool
		// content instead of echoing approval bookkeeping.
	default:
		m.appendLine("error", "permission decision queue is full")
		return false
	}
	m.pending = nil
	m.resize()
	// Phase 3: clear the permission input mode so the textinput
	// resumes ownership of subsequent keys.
	m.setMode(modeComposing)
	return true
}

func (m *model) trustPermissionSession(sessionID string) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	if m.trustedPermissionSessions == nil {
		m.trustedPermissionSessions = map[string]struct{}{}
	}
	m.trustedPermissionSessions[sessionID] = struct{}{}
}

func (m *model) isPermissionSessionTrusted(sessionID string) bool {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || m.trustedPermissionSessions == nil {
		return false
	}
	_, ok := m.trustedPermissionSessions[sessionID]
	return ok
}

func (m *model) recordPermissionRuleSeen(rule string, now time.Time) int {
	rule = strings.TrimSpace(rule)
	if rule == "" {
		return 0
	}
	if m.recentPermissionRules == nil {
		m.recentPermissionRules = map[string]permissionRuleSeen{}
	}
	for key, seen := range m.recentPermissionRules {
		if now.Sub(seen.last) > repeatedPermissionRuleWindow {
			delete(m.recentPermissionRules, key)
		}
	}
	seen := m.recentPermissionRules[rule]
	if seen.count == 0 || now.Sub(seen.last) > repeatedPermissionRuleWindow {
		seen.count = 0
	}
	seen.count++
	seen.last = now
	m.recentPermissionRules[rule] = seen
	return seen.count
}

// confirmPermissionChoice is the Phase A.1 entry point invoked
// when the operator presses enter (or a number key 1-5) on the
// 5-option permission panel. It maps the cursor to the right
// scope/rule/feedback combination and calls sendPermissionDecision.
//
// Mapping (cursor index 0..4 → choice):
//
//	0 — Approve once                       → scope="once",   rule="",    feedback=""
//	1 — Approve for this session           → trust this TUI session and approve current request
//	2 — Approve with editable rule         → scope="session", rule=<edited> (Round 2 inline editor),
//	                                             or scope="once" if the operator cleared the rule
//	3 — Reject                             → scope="once",   rule="",    feedback=""
//	4 — Reject, tell the model what to do  → scope="once",   rule="",    feedback=<typed>
//
// Hard invariants:
//   - "Approve for this session" is a Go TUI process-local trust
//     toggle for the active Nexus session. The current request still
//     carries the suggested rule when one exists so the runtime can
//     preserve its rule-based session behaviour, but future
//     permission_request events for this session are approved by the
//     TUI cache before the panel opens.
//   - Round 2 routes option 2/4 through the inline editor before
//     confirmPermissionChoice ever sees them; the editor calls
//     sendPermissionDecision directly with the edited value.
func (m *model) confirmPermissionChoice() {
	if m.pending == nil {
		return
	}
	suggested := strings.TrimSpace(m.pending.suggestedRule)
	switch m.permissionChoice {
	case 0:
		// Approve once
		m.sendPermissionDecision(true, "Approved from Go TUI", "once", "", "")
	case 1:
		// Approve for this session
		sessionID := m.pending.sessionID
		if m.sendPermissionDecision(true, "Approved (trusted session) from Go TUI", "session", suggested, "") {
			m.trustPermissionSession(sessionID)
		}
	case 2:
		// Approve with editable rule (Round 1: same as option 1
		// with the suggested rule; Round 2 will introduce a
		// dedicated inline editor so the operator can edit the
		// rule before confirming). The key handler routes the
		// 3-key / enter-on-cursor-2 path to the editor, which
		// sends the decision directly with the edited value.
		// Reaching this branch means the editor confirmed without
		// editing, so fall back to the suggested rule.
		if suggested == "" {
			m.sendPermissionDecision(true, "Approved from Go TUI", "once", "", "")
			return
		}
		m.sendPermissionDecision(true, "Approved (rule) from Go TUI", "rule", suggested, "")
	case 3:
		// Reject
		m.sendPermissionDecision(false, "Rejected from Go TUI", "once", "", "")
	case 4:
		// Reject, tell the model what to do instead (Round 1:
		// empty feedback — the runtime still surfaces a
		// `permission_response` event with feedback="" so the
		// wire format is the same as Round 2 will emit; Round 2
		// routes 5-key / enter-on-cursor-4 through the feedback
		// editor, which sends the decision directly with the
		// typed feedback). Reaching this branch means the editor
		// confirmed with empty feedback, which we treat as a
		// plain reject.
		m.sendPermissionDecision(false, "Rejected (with feedback) from Go TUI", "once", "", "")
	default:
		// Should not happen — fall back to the safe default.
		m.sendPermissionDecision(true, "Approved from Go TUI", "once", "", "")
	}
}

// enterPermissionRuleEditor opens the inline textinput pre-filled
// with the runtime-suggested allow rule. The operator edits the
// rule in-place; Enter confirms option 2 with the edited value
// (scope="rule" if non-empty, falling back to scope="once" if the
// operator cleared the input), Esc returns to the 5-option panel.
// Round 2 of the enhanced permission panel.
func (m *model) enterPermissionRuleEditor() {
	if m.pending == nil {
		return
	}
	m.setInputValue(strings.TrimSpace(m.pending.suggestedRule))
	m.setMode(modePermissionEditRule)
}

// enterPermissionFeedbackEditor opens the inline textinput empty
// so the operator can type what the model should do instead.
// Enter confirms option 4 with the typed feedback (scope="once",
// feedback=<typed>, or plain reject if the operator submitted
// empty), Esc returns to the 5-option panel. Round 2.
func (m *model) enterPermissionFeedbackEditor() {
	if m.pending == nil {
		return
	}
	m.setInputValue("")
	m.setMode(modePermissionEditFeedback)
}

// exitPermissionEditor is the Round 2 close-out for the inline
// editor. When `confirm` is true (Enter), the typed value is
// committed: option 2 sends scope="rule" with the edited rule
// (or scope="once" if cleared), option 4 sends approved=false
// with the typed feedback. When `confirm` is false (Esc), the
// textinput is cleared and the 5-option panel is restored with
// its previous cursor position; no decision is sent.
//
// The textinput is always cleared on exit so the next composing
// prompt starts from an empty value.
func (m *model) exitPermissionEditor(confirm bool) {
	if m.pending == nil {
		// No pending request — just drop the editor mode and
		// fall through to composing so the next operator
		// action isn't swallowed.
		m.setInputValue("")
		m.setMode(modeComposing)
		return
	}
	edited := strings.TrimSpace(m.input.Value())
	m.setInputValue("")
	switch m.inputMode {
	case modePermissionEditRule:
		if confirm {
			if edited == "" {
				// Operator cleared the suggested rule → fall
				// back to plain approve (scope="once") so we
				// never accumulate an empty rule. The
				// alternative — "Approve once" as a separate
				// branch — would require another key; this
				// keeps the wire format consistent.
				m.appendLine("permission", "rule cleared — falling back to approve once")
				m.setMode(modeComposing)
				m.sendPermissionDecision(true, "Approved (rule cleared) from Go TUI", "once", "", "")
				return
			}
			m.setMode(modeComposing)
			m.sendPermissionDecision(true, "Approved (rule) from Go TUI", "rule", edited, "")
			return
		}
		// Esc → back to the 5-option panel, restore cursor 2
		// (where the operator was before opening the editor).
		m.permissionChoice = 2
		m.setMode(modePermission)
	case modePermissionEditFeedback:
		if confirm {
			if edited == "" {
				// Operator submitted empty feedback → treat as
				// a plain reject so the model still sees a
				// denial, just without a follow-up hint.
				m.appendLine("permission", "feedback empty — falling back to plain reject")
				m.setMode(modeComposing)
				m.sendPermissionDecision(false, "Rejected from Go TUI", "once", "", "")
				return
			}
			m.setMode(modeComposing)
			m.sendPermissionDecision(false, "Rejected (with feedback) from Go TUI", "once", "", edited)
			return
		}
		// Esc → back to the 5-option panel, restore cursor 4.
		m.permissionChoice = 4
		m.setMode(modePermission)
	default:
		// Defensive fallback — should not happen, but make sure
		// the operator isn't stuck in an editor mode.
		m.setMode(modeComposing)
	}
}
