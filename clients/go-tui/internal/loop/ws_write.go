// internal/loop/ws_write.go
//
// Phase 6d-c'-B: opt-in WebSocket write path for
// `submit` / `approve` / `deny` / `cancel` over the
// 6d-c'-A stream socket (or a per-call short-lived
// dial — see below). The default is HTTP; this file
// adds a parallel path that the 4 dispatchers
// (submit_prompt.go / permission_decision.go /
// cancel_pane.go) opt into via the `useWsWrite`
// flag.
//
// Why a separate short-lived dial instead of reusing
// the per-pane stream socket:
//
//   - The stream socket (6d-c'-A) is "read-only push"
//     from the client's POV. Sending write frames on
//     it would require either a unified bidi protocol
//     (which the server doesn't yet speak) or two
//     sockets per pane (one read, one write).
//   - Short-lived dial per command keeps the surface
//     simple: dial → write one request → read one
//     response → close. No lifecycle, no channel
//     registry, no cancel plumbing beyond ctx.
//   - The trade-off is one TCP setup per command; for
//     the operator's keystroke rate (a few commands
//     per minute) this is negligible.
//
// Wire protocol (see api/ws_stream.go for full
// contract):
//
//	GET ws://host/v1/sessions/:sessionId/command?action=submit
//	< 101 Switching Protocols
//	> {"type":"command","requestId":"...","action":"submit","sessionId":"...","payload":{...}}
//	< {"type":"command_response","requestId":"...","ok":true,"result":{...}}
//
// The 4 helpers below (DispatchSubmit / DispatchApprove
// / DispatchDeny / DispatchCancel) try the WS path
// first when `useWsWrite` is set, fall back to the
// existing HTTP route on any error. The fallback is
// silent — the operator never sees a "WS write failed,
// fell back to HTTP" toast (matches 6d-c'-A's read
// path fallback contract).

package loop

import (
	"context"
	"encoding/json"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// useWsWritePath returns true when the model has the
// opt-in flag set. Mirrors useWsReadPath in ws_read.go.
func (m *InteractiveModel) useWsWritePath() bool {
	if m == nil {
		return false
	}
	return m.useWsWrite
}

// SetUseWsWriteForTest flips the WS write opt-in for
// tests. Mirrors SetUseWsReadForTest. Production code
// wires this from a CLI flag / env var at startup.
func (m *InteractiveModel) SetUseWsWriteForTest(enabled bool) {
	m.useWsWrite = enabled
}

// dispatchWrite is the shared WS-write-with-HTTP-fallback
// helper. It takes the action + payload + an HTTP
// fallback function. When `useWsWrite` is set, it tries
// the WS path first; on any error (dial fail, server
// doesn't speak WS write, response timeout, server-side
// ok=false with an error message) it falls back to the
// HTTP function. The HTTP function's return value is
// passed through unchanged so the caller's existing
// handleXxxDone logic doesn't need to know which path
// was used.
func (m *InteractiveModel) dispatchWrite(
	ctx context.Context,
	client *api.Client,
	sessionID string,
	action api.CommandAction,
	payload json.RawMessage,
	httpFallback func(context.Context) error,
) (usedWS bool, err error) {
	if !m.useWsWritePath() {
		return false, httpFallback(ctx)
	}
	if client == nil || sessionID == "" {
		return false, httpFallback(ctx)
	}
	// WS path. 5s soft timeout (matches permissionDecisionMs
	// + cancelTimeoutMs) so a stuck WS server doesn't
	// stall the operator's keystroke.
	wsCtx, cancel := context.WithTimeout(ctx, 5*time.Second+1*time.Second)
	defer cancel()
	resp, wsErr := client.SendCommand(wsCtx, sessionID, action, payload)
	if wsErr != nil {
		// Dial/read/timeout error — fall back to HTTP.
		return false, httpFallback(ctx)
	}
	if !resp.OK {
		// Server-side error — return a synthetic error
		// so the caller's toast path can surface it.
		// Don't fall back to HTTP (the operator
		// already saw a server response; running the
		// HTTP route would double-execute the action).
		return true, &wsServerError{msg: resp.Error}
	}
	return true, nil
}

// wsServerError is the synthetic error returned when
// the WS server responds with ok=false. Distinct from
// transport errors so the toast can phrase it
// differently if needed.
type wsServerError struct{ msg string }

func (e *wsServerError) Error() string { return e.msg }

// DispatchSubmit is the WS-write entry point for the
// submit_prompt path. The HTTP fallback is the existing
// ExecutePrompt. The caller (handleSubmitDone) treats
// the return values transparently — `usedWS` is logged
// for debugging but doesn't change behavior.
func (m *InteractiveModel) DispatchSubmit(
	ctx context.Context,
	client *api.Client,
	sessionID string,
	prompt string,
) tea.Cmd {
	return func() tea.Msg {
		payload, _ := json.Marshal(map[string]string{"prompt": prompt})
		usedWS, err := m.dispatchWrite(ctx, client, sessionID,
			api.CommandSubmit, payload,
			func(c context.Context) error {
				_, httpErr := client.ExecutePrompt(c, api.ExecutePromptRequest{
					SessionID: sessionID,
					Prompt:    prompt,
				})
				return httpErr
			},
		)
		_ = usedWS
		if err != nil {
			return submitDoneMsg{PaneID: sessionID, Err: err}
		}
		return submitDoneMsg{PaneID: sessionID, Resp: api.ExecuteResponse{
			SessionID: sessionID,
			Success:   true,
		}}
	}
}

// DispatchApprove is the WS-write entry point for the
// permission approve path. The HTTP fallback is the
// existing ApprovePermission. Mirrors DispatchSubmit's
// shape.
func (m *InteractiveModel) DispatchApprove(
	ctx context.Context,
	client *api.Client,
	sessionID, toolUseID, rule string,
) tea.Cmd {
	return func() tea.Msg {
		payload, _ := json.Marshal(map[string]string{
			"toolUseId": toolUseID,
			"rule":      rule,
		})
		usedWS, err := m.dispatchWrite(ctx, client, sessionID,
			api.CommandApprove, payload,
			func(c context.Context) error {
				return client.ApprovePermission(c, sessionID, toolUseID,
					api.ApprovePermissionOptions{Rule: rule})
			},
		)
		_ = usedWS
		if err != nil {
			return permissionDecisionMsg{PaneID: sessionID, Kind: "approve", Err: err}
		}
		return permissionDecisionMsg{PaneID: sessionID, Kind: "approve"}
	}
}

// DispatchDeny is the WS-write entry point for the
// permission deny path. The HTTP fallback is the
// existing DenyPermission.
func (m *InteractiveModel) DispatchDeny(
	ctx context.Context,
	client *api.Client,
	sessionID, toolUseID, reason, feedback string,
) tea.Cmd {
	return func() tea.Msg {
		payload, _ := json.Marshal(map[string]string{
			"toolUseId": toolUseID,
			"reason":    reason,
			"feedback":  feedback,
		})
		usedWS, err := m.dispatchWrite(ctx, client, sessionID,
			api.CommandDeny, payload,
			func(c context.Context) error {
				return client.DenyPermission(c, sessionID, toolUseID, reason, feedback)
			},
		)
		_ = usedWS
		if err != nil {
			return permissionDecisionMsg{PaneID: sessionID, Kind: "deny", Err: err}
		}
		return permissionDecisionMsg{PaneID: sessionID, Kind: "deny"}
	}
}

// DispatchCancel is the WS-write entry point for the
// cancel path. The HTTP fallback is the existing
// CancelSession.
func (m *InteractiveModel) DispatchCancel(
	ctx context.Context,
	client *api.Client,
	sessionID, reason string,
) tea.Cmd {
	return func() tea.Msg {
		payload, _ := json.Marshal(map[string]string{
			"reason": reason,
		})
		usedWS, err := m.dispatchWrite(ctx, client, sessionID,
			api.CommandCancel, payload,
			func(c context.Context) error {
				_, httpErr := client.CancelSession(c, sessionID, reason)
				return httpErr
			},
		)
		_ = usedWS
		if err != nil {
			return cancelDoneMsg{PaneID: sessionID, Err: err}
		}
		return cancelDoneMsg{PaneID: sessionID, ActiveExecutionCancelled: true}
	}
}
