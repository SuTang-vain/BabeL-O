// internal/loop/permission_decision.go
//
// Phase 6d-c of docs/nexus/reference/go-tui-loop-multipane-plan.md
// (§6'.3 6d-c step 4): turn a pane-local PendingPermission
// into a real Nexus /v1/sessions/:id/approve (or /deny) call.
//
// Mirrors submit_prompt.go in spirit (HTTP-first, tea.Cmd
// driven, no bare goroutines) but the routing here is keyed
// off pane.PendingPermission — the operator's Y/N/Enter
// keypress in interactive.go is what actually fires the
// cmd. The wait stream's permission_response event then
// clears PendingPermission on its way back through
// routeWaitEventToPane (wait_tick.go), which is the only
// way the dialog disappears: the user can't dismiss it by
// pressing N twice in a row, they have to wait for the
// server to acknowledge.
//
// Failure handling: an HTTP error is surfaced as a transient
// toast and the dialog stays up — the operator can retry the
// same Y/N. We deliberately don't clear PendingPermission on
// error because the server-side PendingPermissionRegistry
// may still be waiting for the operator's decision; we'd
// just have to surface it again on the next /wait poll.

package loop

import (
	"context"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// permissionDecisionMs is the per-call budget for the
// approve/deny HTTP request. The runtime usually responds
// in tens of milliseconds (it just looks up the pending
// request in the registry); 5s leaves headroom for a slow
// or contended server.
const permissionDecisionMs = 5 * time.Second

// permissionDecisionMsg is the per-pane result posted back
// to the Update path. Carries the original decision kind
// (approve/deny) so the toast can say "✓ approved toolu_1"
// rather than just "✓ done". The actual PendingPermission
// clearance happens on the *next* permission_response event
// from the wait stream, not here — the HTTP success only
// tells us the server accepted the decision.
type permissionDecisionMsg struct {
	PaneID    string
	Kind      string // "approve" or "deny"
	ToolUseID string
	Err       error
}

// permissionDecisionCmd is the tea.Cmd that fires
// /v1/sessions/:id/approve (or /deny) for the given
// permission. Returns nil when client/perm is missing.
//
// We snapshot perm at cmd-issue time (capturing the
// pointer's referent into the closure) so a fresher
// permission_request that lands while the HTTP call is
// in flight can't rewrite what the user already decided
// on.
func permissionDecisionCmd(client *api.Client, pane PaneModel, perm *PanePermission, kind string) tea.Cmd {
	if client == nil || perm == nil {
		return nil
	}
	// Defensive copy: even though perm is a pointer on the
	// pane, the routeWaitEventToPane call could replace it
	// on the next wait poll. Capturing fields by value
	// keeps the decision bound to the request the operator
	// actually saw.
	toolUseID := perm.ToolUseID
	sessionID := pane.SessionID
	// Approval scope selection (once / session / rule) is
	// not in the 6d-c dialog yet — the operator just hits
	// Y/N. The server's default is scope="once", which is
	// what we want for the simple case. A later slice (6d-e
	// or beyond) can add a "shift-y for session" /
	// "shift-n to deny with feedback" affordance.
	rule := perm.SuggestedRule
	feedback := ""
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), permissionDecisionMs+1*time.Second)
		defer cancel()
		var err error
		switch kind {
		case "approve":
			err = client.ApprovePermission(ctx, sessionID, toolUseID, api.ApprovePermissionOptions{
				Rule: rule,
			})
		case "deny":
			err = client.DenyPermission(ctx, sessionID, toolUseID, "", feedback)
		}
		return permissionDecisionMsg{
			PaneID:    pane.PaneID,
			Kind:      kind,
			ToolUseID: toolUseID,
			Err:       err,
		}
	}
}

// dispatchPermissionDecision is the entry point called from
// interactive.go when Y / Enter / N is pressed while a pane
// has PendingPermission set. It fires the appropriate
// approval / denial cmd and returns it to the caller. The
// caller is responsible for routing the resulting
// permissionDecisionMsg back into the Update path (we
// register it alongside the other done-messages).
//
// Single-flight: we don't guard here. The dialog is a
// modal — only Y/Enter/N are routed to the dialog, and
// while a decision is in flight the operator can still
// press Y again, which fires a second cmd. That's
// intentional: the second cmd hits the server's
// PendingPermissionRegistry, which already accepted the
// first decision and either 200s (idempotent) or 404s
// (request already cleared). Either way the chrome
// surfaces a toast so the operator notices.
func (m *InteractiveModel) dispatchPermissionDecision(pane PaneModel, perm *PanePermission, kind string) tea.Cmd {
	if m == nil || m.loopClient == nil || perm == nil {
		return nil
	}
	return permissionDecisionCmd(m.loopClient, pane, perm, kind)
}

// handlePermissionDecision is the Update-path entry for
// permissionDecisionMsg. On success it stamps a toast and
// leaves PendingPermission in place — the next wait
// poll's permission_response will clear it. On error it
// stamps a different toast and also leaves the dialog up
// (the operator should be able to retry the same Y/N
// without the request vanishing).
func (m *InteractiveModel) handlePermissionDecision(msg permissionDecisionMsg) tea.Cmd {
	if m == nil {
		return nil
	}
	if msg.Err != nil {
		m.toastMessage = "✗ " + msg.Kind + " " + msg.ToolUseID + " failed: " + msg.Err.Error()
		m.toastShownAt = time.Now()
		return nil
	}
	if msg.Kind == "approve" {
		m.toastMessage = "✓ approved " + msg.ToolUseID
	} else {
		m.toastMessage = "✓ denied " + msg.ToolUseID
	}
	m.toastShownAt = time.Now()
	return nil
}
