// internal/loop/permission_dialog_editor_test.go
//
// 6d-c'-B-stepC tests (§6'.3 6d-c'-B-stepC): the multi-mode
// permission dialog editor — scope picker (1/2/3), deny
// reason text input (D), and approve rule edit (R).
//
// These tests verify:
//   - Sub-mode entry keys (1/2/3, D, R) set the correct
//     permDialogState
//   - Sub-mode key dispatch: scope picker selection
//     auto-commits, reason/rule draft editing, Enter
//     commits, Esc returns to base
//   - Printable keys are swallowed in sub-mode (don't
//     leak to pane input)
//   - dispatchPermissionDecisionWithState sends correct
//     scope/reason/rule to the server
//   - permDialog is cleared on dispatch and on Esc
//   - Base Y/N still works alongside new sub-mode keys
//
// Important: InteractiveModel.Update returns (tea.Model, tea.Cmd)
// as VALUE types. Every call that expects a mutation must capture
// the returned model and write it back to the pointer:
//
//	updated, cmd := im.Update(msg)
//	*im = updated.(InteractiveModel)

package loop

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// permEditorServer is a minimal httptest server for the
// permission dialog editor tests. Captures the approve/deny
// body so we can assert scope / reason / rule fields.
type permEditorServer struct {
	server         *httptest.Server
	capturedBodies []map[string]any
}

func newPermEditorServer(t *testing.T) *permEditorServer {
	t.Helper()
	s := &permEditorServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/sessions/", s.handleSession)
	mux.HandleFunc("/v1/runtime/loop/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"type":"loop_health","panes":[]}`))
	})
	mux.HandleFunc("/v1/loop/workspaces", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"type":"loop_workspaces","panes":[]}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	})
	s.server = httptest.NewServer(mux)
	t.Cleanup(s.server.Close)
	return s
}

func (s *permEditorServer) URL() string { return s.server.URL }

func (s *permEditorServer) handleSession(w http.ResponseWriter, r *http.Request) {
	if r.Body != nil {
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 0 {
			body := map[string]any{}
			if err := json.Unmarshal(raw, &body); err == nil {
				s.capturedBodies = append(s.capturedBodies, body)
			}
		}
	}
	if strings.HasSuffix(r.URL.Path, "/wait") {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":         "wait",
			"events":       []json.RawMessage{},
			"nextRevision": "0",
		})
		return
	}
	w.WriteHeader(http.StatusOK)
}

// newPermEditorModel builds an InteractiveModel with a single
// pane that has a PendingPermission set.
func newPermEditorModel(t *testing.T, serverURL string) *InteractiveModel {
	t.Helper()
	perm := &PanePermission{
		ToolUseID:     "toolu_1",
		Name:          "Bash",
		Risk:          "execute",
		Message:       "Tool Bash requires user permission to run.",
		SuggestedRule: "Bash(git:*)",
	}
	pane := PaneModel{
		PaneID:            "pane-1",
		WorkspaceID:       defaultWSID,
		TabID:             defaultTabID,
		SessionID:         "session-1",
		Agent:             "bbl",
		Cwd:               "/repo",
		Label:             "main",
		Status:            StatusWaiting,
		LastEventRev:      0,
		PendingPermission: perm,
	}
	client := api.NewClient(serverURL, "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(),
		nil, nil, 0, client, 0, nil, nil,
	)
	seeded, _ := seedPane(im.loop, pane)
	im.loop = seeded
	return &im
}

// updateAndCapture is a helper that calls Update and writes
// the returned model back to the pointer. Every test that
// expects a mutation must use this (or do the same
// assignment manually). InteractiveModel is a value type,
// so the Update return value is a copy.
func updateAndCapture(im *InteractiveModel, msg tea.Msg) tea.Cmd {
	updated, cmd := im.Update(msg)
	*im = updated.(InteractiveModel)
	return cmd
}

// TestPermDialogKey1EntersScopePicker: pressing "1" on the
// base dialog sets permDialog to scope-picker mode with
// scope="once".
func TestPermDialogKey1EntersScopePicker(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: '1', Text: "1"})
	if cmd != nil {
		t.Fatalf("1 should enter scope picker mode, not fire cmd, got %T", cmd)
	}
	if im.permDialog == nil {
		t.Fatal("permDialog should be non-nil after pressing 1")
	}
	if im.permDialog.Mode != permDialogScope {
		t.Errorf("Mode = %v, want permDialogScope", im.permDialog.Mode)
	}
	if im.permDialog.Scope != "once" {
		t.Errorf("Scope = %q, want once", im.permDialog.Scope)
	}
}

// TestPermDialogKey2EntersScopePickerSession: pressing "2"
// sets scope="session".
func TestPermDialogKey2EntersScopePickerSession(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: '2', Text: "2"})
	if cmd != nil {
		t.Fatalf("2 should enter scope picker mode, got %T", cmd)
	}
	if im.permDialog == nil || im.permDialog.Scope != "session" {
		t.Errorf("Scope = %q, want session", im.permDialog.Scope)
	}
}

// TestPermDialogKey3EntersScopePickerRule: pressing "3"
// sets scope="rule".
func TestPermDialogKey3EntersScopePickerRule(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: '3', Text: "3"})
	if cmd != nil {
		t.Fatalf("3 should enter scope picker mode, got %T", cmd)
	}
	if im.permDialog == nil || im.permDialog.Scope != "rule" {
		t.Errorf("Scope = %q, want rule", im.permDialog.Scope)
	}
}

// TestPermDialogScopePickerAutoCommits: in scope-picker mode,
// pressing 1/2/3 auto-commits the approval with the selected
// scope. The server should see the scope in the body.
func TestPermDialogScopePickerAutoCommits(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	// Enter scope-picker mode with "2" (session scope).
	updateAndCapture(im, tea.KeyPressMsg{Code: '2', Text: "2"})
	if im.permDialog == nil {
		t.Fatal("permDialog should be non-nil after 2")
	}

	// In scope-picker mode, pressing "1" changes scope to
	// "once" and auto-commits.
	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: '1', Text: "1"})
	if cmd == nil {
		t.Fatal("1 in scope-picker should auto-commit, producing a cmd")
	}

	msg := cmd()
	dec, ok := msg.(permissionDecisionMsg)
	if !ok {
		t.Fatalf("cmd returned %T, want permissionDecisionMsg", msg)
	}
	if dec.Kind != "approve" {
		t.Errorf("Kind = %q, want approve", dec.Kind)
	}
	if dec.Err != nil {
		t.Errorf("Err = %v, want nil", dec.Err)
	}

	// permDialog should be cleared after commit.
	if im.permDialog != nil {
		t.Error("permDialog should be nil after commit")
	}

	// Verify the server saw scope="once" in the body.
	foundScope := false
	for _, b := range srv.capturedBodies {
		if scope, ok := b["scope"]; ok && scope == "once" {
			foundScope = true
		}
	}
	if !foundScope {
		t.Errorf("server should have received scope=once in approve body, got %v", srv.capturedBodies)
	}
}

// TestPermDialogKeyDEntersReasonInput: pressing D on the
// base dialog sets permDialog to reason-input mode.
func TestPermDialogKeyDEntersReasonInput(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: 'd', Text: "d"})
	if cmd != nil {
		t.Fatalf("D should enter reason mode, got %T", cmd)
	}
	if im.permDialog == nil {
		t.Fatal("permDialog should be non-nil after D")
	}
	if im.permDialog.Mode != permDialogReason {
		t.Errorf("Mode = %v, want permDialogReason", im.permDialog.Mode)
	}
}

// TestPermDialogKeyREntersRuleEdit: pressing R on the base
// dialog sets permDialog to rule-edit mode with the
// suggested rule pre-filled.
func TestPermDialogKeyREntersRuleEdit(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: 'r', Text: "r"})
	if cmd != nil {
		t.Fatalf("R should enter rule edit mode, got %T", cmd)
	}
	if im.permDialog == nil {
		t.Fatal("permDialog should be non-nil after R")
	}
	if im.permDialog.Mode != permDialogRule {
		t.Errorf("Mode = %v, want permDialogRule", im.permDialog.Mode)
	}
	if im.permDialog.Rule != "Bash(git:*)" {
		t.Errorf("Rule = %q, want Bash(git:*)", im.permDialog.Rule)
	}
	if im.permDialog.Scope != "rule" {
		t.Errorf("Scope = %q, want rule", im.permDialog.Scope)
	}
}

// TestPermDialogReasonDraftEditing: in reason mode,
// printable keys append to Reason, backspace deletes.
func TestPermDialogReasonDraftEditing(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	// Enter reason mode.
	updateAndCapture(im, tea.KeyPressMsg{Code: 'd', Text: "d"})

	// Type "no".
	updateAndCapture(im, tea.KeyPressMsg{Code: 'n', Text: "n"})
	updateAndCapture(im, tea.KeyPressMsg{Code: 'o', Text: "o"})
	if im.permDialog.Reason != "no" {
		t.Errorf("Reason = %q, want no", im.permDialog.Reason)
	}

	// Backspace deletes last rune.
	updateAndCapture(im, tea.KeyPressMsg{Code: tea.KeyBackspace})
	if im.permDialog.Reason != "n" {
		t.Errorf("Reason after backspace = %q, want n", im.permDialog.Reason)
	}
}

// TestPermDialogRuleDraftEditing: in rule mode, printable
// keys append to Rule, backspace deletes.
func TestPermDialogRuleDraftEditing(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	// Enter rule edit mode.
	updateAndCapture(im, tea.KeyPressMsg{Code: 'r', Text: "r"})

	// Append "!" to the pre-filled rule.
	updateAndCapture(im, tea.KeyPressMsg{Code: '!', Text: "!"})
	expected := "Bash(git:*)!"
	if im.permDialog.Rule != expected {
		t.Errorf("Rule = %q, want %q", im.permDialog.Rule, expected)
	}

	// Backspace deletes the "!".
	updateAndCapture(im, tea.KeyPressMsg{Code: tea.KeyBackspace})
	if im.permDialog.Rule != "Bash(git:*)" {
		t.Errorf("Rule after backspace = %q, want Bash(git:*)", im.permDialog.Rule)
	}
}

// TestPermDialogReasonEnterCommitsDeny: Enter in reason
// mode commits a deny with the drafted reason.
func TestPermDialogReasonEnterCommitsDeny(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	// Enter reason mode, type a reason.
	updateAndCapture(im, tea.KeyPressMsg{Code: 'd', Text: "d"})
	updateAndCapture(im, tea.KeyPressMsg{Code: 'n', Text: "n"})
	updateAndCapture(im, tea.KeyPressMsg{Code: 'o', Text: "o"})

	// Enter commits the deny.
	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("Enter in reason mode should commit deny")
	}
	msg := cmd()
	dec := msg.(permissionDecisionMsg)
	if dec.Kind != "deny" {
		t.Errorf("Kind = %q, want deny", dec.Kind)
	}
	if im.permDialog != nil {
		t.Error("permDialog should be nil after commit")
	}

	// Server should have received the reason.
	foundReason := false
	for _, b := range srv.capturedBodies {
		if reason, ok := b["reason"]; ok && reason == "no" {
			foundReason = true
		}
	}
	if !foundReason {
		t.Errorf("server should have received reason=no in deny body, got %v", srv.capturedBodies)
	}
}

// TestPermDialogRuleEnterCommitsApprove: Enter in rule mode
// commits an approve with the drafted rule.
func TestPermDialogRuleEnterCommitsApprove(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	// Enter rule edit mode, edit the rule.
	updateAndCapture(im, tea.KeyPressMsg{Code: 'r', Text: "r"})
	updateAndCapture(im, tea.KeyPressMsg{Code: '!', Text: "!"})

	// Enter commits the approve.
	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("Enter in rule mode should commit approve")
	}
	msg := cmd()
	dec := msg.(permissionDecisionMsg)
	if dec.Kind != "approve" {
		t.Errorf("Kind = %q, want approve", dec.Kind)
	}

	// Server should have received the rule + scope.
	foundRule := false
	foundScope := false
	for _, b := range srv.capturedBodies {
		if rule, ok := b["rule"]; ok && strings.Contains(rule.(string), "Bash(git:*)!") {
			foundRule = true
		}
		if scope, ok := b["scope"]; ok && scope == "rule" {
			foundScope = true
		}
	}
	if !foundRule {
		t.Errorf("server should have received the edited rule, got %v", srv.capturedBodies)
	}
	if !foundScope {
		t.Errorf("server should have received scope=rule, got %v", srv.capturedBodies)
	}
}

// TestPermDialogEscReturnsToBase: Esc in any sub-mode
// returns to the base (Y/N) dialog.
func TestPermDialogEscReturnsToBase(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	// Enter scope-picker mode, then Esc back.
	updateAndCapture(im, tea.KeyPressMsg{Code: '1', Text: "1"})
	if im.permDialog == nil {
		t.Fatal("permDialog should be set after 1")
	}
	updateAndCapture(im, tea.KeyPressMsg{Code: tea.KeyEscape})
	if im.permDialog != nil {
		t.Error("permDialog should be nil after Esc from scope picker")
	}

	// Enter reason mode, then Esc back.
	updateAndCapture(im, tea.KeyPressMsg{Code: 'd', Text: "d"})
	if im.permDialog == nil {
		t.Fatal("permDialog should be set after D")
	}
	updateAndCapture(im, tea.KeyPressMsg{Code: tea.KeyEscape})
	if im.permDialog != nil {
		t.Error("permDialog should be nil after Esc from reason mode")
	}

	// Enter rule mode, then Esc back.
	updateAndCapture(im, tea.KeyPressMsg{Code: 'r', Text: "r"})
	if im.permDialog == nil {
		t.Fatal("permDialog should be set after R")
	}
	updateAndCapture(im, tea.KeyPressMsg{Code: tea.KeyEscape})
	if im.permDialog != nil {
		t.Error("permDialog should be nil after Esc from rule mode")
	}

	// Base Y/N still works after Esc.
	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: 'y', Text: "y"})
	if cmd == nil {
		t.Fatal("Y should still dispatch approve after Esc")
	}
	msg := cmd()
	dec := msg.(permissionDecisionMsg)
	if dec.Kind != "approve" {
		t.Errorf("Kind = %q, want approve", dec.Kind)
	}
}

// TestPermDialogBaseYStillWorks: the legacy Y/N/Enter
// dispatch still works alongside the new sub-mode keys.
func TestPermDialogBaseYStillWorks(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	// Base Y dispatches approve.
	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: 'y', Text: "y"})
	if cmd == nil {
		t.Fatal("Y should dispatch approve")
	}
	msg := cmd()
	dec := msg.(permissionDecisionMsg)
	if dec.Kind != "approve" {
		t.Errorf("Kind = %q, want approve", dec.Kind)
	}

	// permDialog should stay nil after base Y dispatch.
	if im.permDialog != nil {
		t.Error("permDialog should be nil after base Y dispatch")
	}
}

// TestPermDialogBaseNStillWorks: N in base mode still
// dispatches deny.
func TestPermDialogBaseNStillWorks(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: 'n', Text: "n"})
	if cmd == nil {
		t.Fatal("N should dispatch deny")
	}
	msg := cmd()
	dec := msg.(permissionDecisionMsg)
	if dec.Kind != "deny" {
		t.Errorf("Kind = %q, want deny", dec.Kind)
	}
}

// TestPermDialogSubModeKeysSwallowed: keys in sub-mode that
// aren't recognized are swallowed (don't leak to pane input
// or router dispatch).
func TestPermDialogSubModeKeysSwallowed(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	// In scope-picker mode, "x" is swallowed.
	updateAndCapture(im, tea.KeyPressMsg{Code: '1', Text: "1"})
	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: 'x', Text: "x"})
	if cmd != nil {
		t.Errorf("unrecognized key in scope-picker should be swallowed, got %T", cmd)
	}
	// Pane input should not have been affected.
	pane, _ := im.loop.PaneAt(0, 0, 0)
	if pane.Input != "" {
		t.Errorf("pane.Input should be empty, got %q", pane.Input)
	}

	// In reason mode, "y" appends to reason, doesn't
	// dispatch approve.
	updateAndCapture(im, tea.KeyPressMsg{Code: tea.KeyEscape}) // back to base
	updateAndCapture(im, tea.KeyPressMsg{Code: 'd', Text: "d"}) // reason mode
	cmd = updateAndCapture(im, tea.KeyPressMsg{Code: 'y', Text: "y"})
	if cmd != nil {
		t.Errorf("y in reason mode should append to draft, not dispatch, got %T", cmd)
	}
	if im.permDialog.Reason != "y" {
		t.Errorf("Reason should be 'y', got %q", im.permDialog.Reason)
	}
}

// TestPermDialogRenderBaseKeys: renderPermDialogBaseKeys
// produces a non-empty string containing the key hints.
func TestPermDialogRenderBaseKeys(t *testing.T) {
	result := renderPermDialogBaseKeys(80)
	if result == "" {
		t.Fatal("renderPermDialogBaseKeys should return non-empty string")
	}
	if !strings.Contains(result, "Y/Enter") {
		t.Error("base keys should contain Y/Enter")
	}
	if !strings.Contains(result, "1/2/3") {
		t.Error("base keys should contain 1/2/3 sub-mode hint")
	}
	if !strings.Contains(result, "D") {
		t.Error("base keys should contain D sub-mode hint")
	}
	if !strings.Contains(result, "R") {
		t.Error("base keys should contain R sub-mode hint")
	}
}

// TestPermDialogRenderScopePicker: the scope picker UI
// renders with the correct highlight marker.
func TestPermDialogRenderScopePicker(t *testing.T) {
	state := &permDialogState{
		Mode:  permDialogScope,
		Scope: "session",
	}
	lines := renderPermDialogScopePicker(state, 80)
	if len(lines) == 0 {
		t.Fatal("scope picker should return lines")
	}
	joined := strings.Join(lines, "\n")
	// "session" should have the selected marker "●".
	if !strings.Contains(joined, "●") {
		t.Error("scope picker should contain selection marker")
	}
	if !strings.Contains(joined, "session") {
		t.Error("scope picker should contain 'session'")
	}
	if !strings.Contains(joined, "1/2/3") {
		t.Error("scope picker should contain key hints")
	}
}

// TestPermDialogRenderReasonInput: the reason input UI
// renders with the draft text and cursor.
func TestPermDialogRenderReasonInput(t *testing.T) {
	state := &permDialogState{
		Mode:   permDialogReason,
		Reason: "not allowed",
	}
	lines := renderPermDialogReasonInput(state, 80)
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "not allowed") {
		t.Error("reason input should show the draft")
	}
	if !strings.Contains(joined, "Enter") {
		t.Error("reason input should show Enter hint")
	}
}

// TestPermDialogRenderRuleEdit: the rule edit UI renders
// with the draft rule and cursor.
func TestPermDialogRenderRuleEdit(t *testing.T) {
	state := &permDialogState{
		Mode: permDialogRule,
		Rule: "Bash(git:*)",
	}
	lines := renderPermDialogRuleEdit(state, 80)
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "Bash(git:*)") {
		t.Error("rule edit should show the draft rule")
	}
	if !strings.Contains(joined, "Enter") {
		t.Error("rule edit should show Enter hint")
	}
}

// TestPermDialogFullRenderWithState: renderPermissionDialog
// with a non-nil state renders the sub-mode instead of the
// base Y/N keys.
func TestPermDialogFullRenderWithState(t *testing.T) {
	perm := &PanePermission{
		ToolUseID:     "toolu_1",
		Name:          "Bash",
		Risk:          "execute",
		Message:       "test message",
		SuggestedRule: "Bash(git:*)",
	}

	// Base dialog (state=nil) shows Y/N hint.
	base := renderPermissionDialog(perm, 80, 20, nil)
	if !strings.Contains(base, "Y/Enter") {
		t.Error("base dialog should contain Y/Enter")
	}
	if !strings.Contains(base, "approve") {
		t.Error("base dialog should contain approve")
	}

	// Scope picker mode (state=scope) shows scope UI.
	scopeState := &permDialogState{
		Mode:  permDialogScope,
		Perm:  perm,
		Scope: "once",
	}
	scoped := renderPermissionDialog(perm, 80, 20, scopeState)
	if !strings.Contains(scoped, "approval scope") {
		t.Error("scope dialog should contain 'approval scope'")
	}
	if !strings.Contains(scoped, "once") {
		t.Error("scope dialog should contain 'once'")
	}

	// Reason mode shows reason input.
	reasonState := &permDialogState{
		Mode:   permDialogReason,
		Perm:   perm,
		Reason: "not safe",
	}
	reasoned := renderPermissionDialog(perm, 80, 20, reasonState)
	if !strings.Contains(reasoned, "deny reason") {
		t.Error("reason dialog should contain 'deny reason'")
	}
	if !strings.Contains(reasoned, "not safe") {
		t.Error("reason dialog should show draft reason")
	}

	// Rule mode shows rule edit.
	ruleState := &permDialogState{
		Mode:  permDialogRule,
		Perm:  perm,
		Rule:  "Bash(git:*)",
		Scope: "rule",
	}
	ruled := renderPermissionDialog(perm, 80, 20, ruleState)
	if !strings.Contains(ruled, "approve rule") {
		t.Error("rule dialog should contain 'approve rule'")
	}
	if !strings.Contains(ruled, "Bash(git:*)") {
		t.Error("rule dialog should show draft rule")
	}
}

// TestPermDialogNilGuard: nil perm returns empty space.
func TestPermDialogNilGuard(t *testing.T) {
	result := renderPermissionDialog(nil, 80, 20, nil)
	if result == "" {
		t.Fatal("nil perm should return whitespace, not empty")
	}
	trimmed := strings.TrimSpace(result)
	if trimmed != "" {
		t.Errorf("nil perm should return all spaces, got non-space: %q", trimmed)
	}
}

// TestPermDialogZeroHeight: zero height returns empty.
func TestPermDialogZeroHeight(t *testing.T) {
	perm := &PanePermission{Name: "Bash"}
	result := renderPermissionDialog(perm, 80, 0, nil)
	if result != "" {
		t.Errorf("zero height should return empty, got %q", result)
	}
}

// TestPermDialogScopePickerAutoCommitWireShape: verify the
// server sees the correct wire shape when committing from
// scope picker.
func TestPermDialogScopePickerAutoCommitWireShape(t *testing.T) {
	srv := newPermEditorServer(t)
	im := newPermEditorModel(t, srv.URL())

	// 3 → rule scope, then 2 in scope-picker → session
	// scope auto-commit.
	updateAndCapture(im, tea.KeyPressMsg{Code: '3', Text: "3"})
	cmd := updateAndCapture(im, tea.KeyPressMsg{Code: '2', Text: "2"})
	if cmd == nil {
		t.Fatal("2 in scope-picker should auto-commit")
	}
	msg := cmd()
	dec := msg.(permissionDecisionMsg)
	if dec.Err != nil {
		t.Fatalf("Err = %v, want nil", dec.Err)
	}
	// Apply the result to stamp the toast.
	updated, _ := im.Update(dec)
	*im = updated.(InteractiveModel)
	if !strings.Contains(im.toastMessage, "approved") {
		t.Errorf("toast should say approved, got %q", im.toastMessage)
	}

	// Server should have seen scope="session" (the 2 key
	// in scope-picker overrides the initial 3 entry).
	foundScope := false
	for _, b := range srv.capturedBodies {
		if scope, ok := b["scope"]; ok && scope == "session" {
			foundScope = true
		}
	}
	if !foundScope {
		t.Errorf("server should have received scope=session, got %v", srv.capturedBodies)
	}
}
