// internal/loop/inbox_phase1_test.go
//
// SessionChannel TUI visibility Phase 1 (docs/nexus/
// reference/session-channel-tui-relationship-visibility-plan.md):
// verify the chrome-facing helpers produce the expected
// footer token + sidebar badge for the focused pane.
//
// Pure-function tests — no HTTP, no tea runtime. The
// fetch + tick layer is covered by inbox_tick_test (not
// yet added; the smoke for that lives in PTY).

package loop

import (
	"strings"
	"testing"
	"time"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

func inboxResp(sessionID string, msgs ...api.SessionInboxMessage) *api.SessionInboxResponse {
	return &api.SessionInboxResponse{
		Type:      "session_inbox",
		SessionID: sessionID,
		Messages:  msgs,
	}
}

func msg(id, mtype, priority, status string) api.SessionInboxMessage {
	return api.SessionInboxMessage{
		MessageID:    id,
		ChannelID:    "ch-1",
		FromSessionID: "other-session",
		Type:         mtype,
		Priority:     priority,
		Status:       status,
		CreatedAt:    "2026-06-17T00:00:00Z",
	}
}

// TestSummarizeInboxEmpty: nil snapshot → 0/"".
func TestSummarizeInboxEmpty(t *testing.T) {
	unread, top := summarizeInbox(nil)
	if unread != 0 || top != "" {
		t.Errorf("nil snapshot: unread=%d top=%q, want 0/\"\"", unread, top)
	}
}

// TestSummarizeInboxOnlyAcknowledged: all messages
// acknowledged → 0 unread.
func TestSummarizeInboxOnlyAcknowledged(t *testing.T) {
	resp := inboxResp("s1",
		msg("m1", "blocked", "high", "acknowledged"),
		msg("m2", "finding", "normal", "acknowledged"),
	)
	unread, _ := summarizeInbox(resp)
	if unread != 0 {
		t.Errorf("acked only: unread=%d, want 0", unread)
	}
}

// TestSummarizeInboxCountsUnread: mix of acked + unread
// → unread count excludes the acked ones.
func TestSummarizeInboxCountsUnread(t *testing.T) {
	resp := inboxResp("s1",
		msg("m1", "blocked", "high", "delivered"),
		msg("m2", "handoff", "normal", "acknowledged"),
		msg("m3", "finding", "low", "delivered"),
	)
	unread, top := summarizeInbox(resp)
	if unread != 2 {
		t.Errorf("unread=%d, want 2", unread)
	}
	if top != "blocked" {
		t.Errorf("topType=%q, want \"blocked\"", top)
	}
}

// TestSummarizeInboxPriorityWins: high beats normal, even
// when normal has a higher-priority type.
func TestSummarizeInboxPriorityWins(t *testing.T) {
	resp := inboxResp("s1",
		msg("m1", "handoff", "normal", "delivered"),
		msg("m2", "finding", "high", "delivered"),
	)
	_, top := summarizeInbox(resp)
	if top != "finding" {
		t.Errorf("topType=%q, want \"finding\" (high beats handoff normal)", top)
	}
}

// TestSummarizeInboxTypeOrderWithinSamePriority: when two
// messages share a priority, the plan's type rank order
// picks the more important one.
func TestSummarizeInboxTypeOrderWithinSamePriority(t *testing.T) {
	resp := inboxResp("s1",
		msg("m1", "question", "normal", "delivered"),
		msg("m2", "blocked", "normal", "delivered"),
	)
	_, top := summarizeInbox(resp)
	if top != "blocked" {
		t.Errorf("topType=%q, want \"blocked\" (blocked ranks above question)", top)
	}
}

// TestFormatInboxFooterToken: long form includes high type.
func TestFormatInboxFooterToken(t *testing.T) {
	resp := inboxResp("s1",
		msg("m1", "blocked", "high", "delivered"),
		msg("m2", "finding", "normal", "delivered"),
	)
	got := formatInboxFooterToken(resp)
	want := "inbox: 2 unread · high: blocked"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// TestFormatInboxFooterTokenNoTop: when there's no type tag
// (e.g. only low-priority finding), show the count alone.
func TestFormatInboxFooterTokenNoTop(t *testing.T) {
	resp := inboxResp("s1",
		msg("m1", "question", "low", "delivered"),
	)
	got := formatInboxFooterToken(resp)
	want := "inbox: 1 unread"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// TestFormatInboxFooterTokenEmpty: zero unread → "".
func TestFormatInboxFooterTokenEmpty(t *testing.T) {
	resp := inboxResp("s1",
		msg("m1", "blocked", "high", "acknowledged"),
	)
	if got := formatInboxFooterToken(resp); got != "" {
		t.Errorf("acked only: got %q, want \"\"", got)
	}
}

// TestInboxBadgeForSessionNoSnapshot: nil map / no entry
// → empty badge.
func TestInboxBadgeForSessionNoSnapshot(t *testing.T) {
	if got := inboxBadgeForSession(nil, "s1"); got != "" {
		t.Errorf("nil map: got %q, want \"\"", got)
	}
	if got := inboxBadgeForSession(map[string]*api.SessionInboxResponse{}, "s1"); got != "" {
		t.Errorf("empty map: got %q, want \"\"", got)
	}
	m := map[string]*api.SessionInboxResponse{
		"s1": inboxResp("s1"),
		"s2": inboxResp("s2", msg("m1", "blocked", "high", "delivered")),
	}
	if got := inboxBadgeForSession(m, "s1"); got != "" {
		t.Errorf("snapshot has no unread: got %q, want \"\"", got)
	}
	if got := inboxBadgeForSession(m, "missing"); got != "" {
		t.Errorf("missing session: got %q, want \"\"", got)
	}
}

// TestInboxBadgeForSessionFormat: count badge vs high badge.
func TestInboxBadgeForSessionFormat(t *testing.T) {
	// Count badge.
	countResp := inboxResp("s1",
		msg("m1", "question", "low", "delivered"),
		msg("m2", "finding", "low", "delivered"),
		msg("m3", "question", "low", "delivered"),
	)
	if got := inboxBadgeForSession(map[string]*api.SessionInboxResponse{"s1": countResp}, "s1"); got != "!3" {
		t.Errorf("3 unread: got %q, want \"!3\"", got)
	}
	// High-priority badge.
	highResp := inboxResp("s1",
		msg("m1", "finding", "high", "delivered"),
	)
	if got := inboxBadgeForSession(map[string]*api.SessionInboxResponse{"s1": highResp}, "s1"); got != "!!" {
		t.Errorf("high-priority: got %q, want \"!!\"", got)
	}
	// 99+ badge.
	bigResp := inboxResp("s1")
	for i := 0; i < 150; i++ {
		bigResp.Messages = append(bigResp.Messages, msg("m", "question", "low", "delivered"))
	}
	got := inboxBadgeForSession(map[string]*api.SessionInboxResponse{"s1": bigResp}, "s1")
	if got != "!99+" {
		t.Errorf("150 unread: got %q, want \"!99+\"", got)
	}
}

// TestInboxBadgeForSessionEmptySessionID: empty session id
// → empty badge.
func TestInboxBadgeForSessionEmptySessionID(t *testing.T) {
	m := map[string]*api.SessionInboxResponse{
		"": inboxResp("", msg("m1", "blocked", "high", "delivered")),
	}
	if got := inboxBadgeForSession(m, ""); got != "" {
		t.Errorf("empty session: got %q, want \"\"", got)
	}
}

// TestSortedInboxSessionsDeterministic: alphabetical order
// so tests + log output are reproducible.
func TestSortedInboxSessionsDeterministic(t *testing.T) {
	m := map[string]*api.SessionInboxResponse{
		"charlie": inboxResp("charlie"),
		"alpha":   inboxResp("alpha"),
		"bravo":   inboxResp("bravo"),
	}
	got := sortedInboxSessions(m)
	want := []string{"alpha", "bravo", "charlie"}
	if len(got) != 3 {
		t.Fatalf("len=%d, want 3", len(got))
	}
	for i, s := range want {
		if got[i] != s {
			t.Errorf("[%d]=%q, want %q", i, got[i], s)
		}
	}
	if sortedInboxSessions(nil) != nil {
		t.Error("nil map should return nil")
	}
}

// TestFormatInboxFooterShort: narrow-width fallback.
func TestFormatInboxFooterShort(t *testing.T) {
	// No high-priority unread → "!N".
	resp := inboxResp("s1",
		msg("m1", "question", "low", "delivered"),
		msg("m2", "question", "low", "delivered"),
	)
	if got := formatInboxFooterShort(resp); got != "!2" {
		t.Errorf("2 low-priority: got %q, want \"!2\"", got)
	}
	// High-priority unread → "!!".
	highResp := inboxResp("s1",
		msg("m1", "finding", "high", "delivered"),
	)
	if got := formatInboxFooterShort(highResp); got != "!!" {
		t.Errorf("high: got %q, want \"!!\"", got)
	}
	// > 9 unread → "!9+".
	bigResp := inboxResp("s1")
	for i := 0; i < 20; i++ {
		bigResp.Messages = append(bigResp.Messages, msg("m", "question", "low", "delivered"))
	}
	if got := formatInboxFooterShort(bigResp); got != "!9+" {
		t.Errorf("20 unread: got %q, want \"!9+\"", got)
	}
}

// TestFormatInboxRowForLog: log-friendly one-liner.
func TestFormatInboxRowForLog(t *testing.T) {
	resp := inboxResp("session-1",
		msg("m1", "blocked", "high", "delivered"),
	)
	got := formatInboxRowForLog(resp)
	if !strings.Contains(got, "session=session-1") {
		t.Errorf("missing session: %q", got)
	}
	if !strings.Contains(got, "unread=1") {
		t.Errorf("missing unread: %q", got)
	}
	if !strings.Contains(got, "top=blocked") {
		t.Errorf("missing top: %q", got)
	}
	if formatInboxRowForLog(nil) != "" {
		t.Error("nil snapshot should return empty string")
	}
}

// TestIsUnreadInboxMessageFilters: status gating.
func TestIsUnreadInboxMessageFilters(t *testing.T) {
	// Acknowledged + expired → false.
	if isUnreadInboxMessage(msg("m", "blocked", "high", "acknowledged")) {
		t.Error("acked should be filtered")
	}
	if isUnreadInboxMessage(msg("m", "blocked", "high", "expired")) {
		t.Error("expired should be filtered")
	}
	// Delivered + queued → true.
	if !isUnreadInboxMessage(msg("m", "blocked", "high", "delivered")) {
		t.Error("delivered should count")
	}
	if !isUnreadInboxMessage(msg("m", "blocked", "high", "queued")) {
		t.Error("queued should count")
	}
	// Unknown status → true (defensive default; matches
	// the "any other status is unread" policy).
	if !isUnreadInboxMessage(msg("m", "blocked", "high", "")) {
		t.Error("unknown status should default to unread")
	}
}

// TestRenderFooterLineWithInboxBothPresent: desktop
// footer puts keybinds left, then gap, then inbox + reconcile.
func TestRenderFooterLineWithInboxBothPresent(t *testing.T) {
	binds := []footerKeybind{
		{Keys: []string{"ctrl+n"}, Desc: "new"},
	}
	info := reconcileFooterInfo{InFlight: false, At: nonZeroTime()}
	inbox := "in:2"
	got := renderFooterLineWithInbox(80, binds, info, inbox)
	// Both ends should be present.
	if !strings.Contains(got, "ctrl+n") {
		t.Errorf("missing keybind: %q", got)
	}
	if !strings.Contains(got, "in:2") {
		t.Errorf("missing inbox: %q", got)
	}
	if !strings.Contains(got, "synced") {
		t.Errorf("missing reconcile: %q", got)
	}
	// Inbox should come before reconcile (operator-
	// actionable closer to the hint).
	inboxIdx := strings.Index(got, "in:2")
	recIdx := strings.Index(got, "synced")
	if inboxIdx > recIdx {
		t.Errorf("inbox should precede reconcile, got %q", got)
	}
}

// TestRenderFooterLineWithInboxOnlyInbox: no reconcile
// → just inbox on the right.
func TestRenderFooterLineWithInboxOnlyInbox(t *testing.T) {
	binds := []footerKeybind{{Keys: []string{"q"}, Desc: "quit"}}
	got := renderFooterLineWithInbox(40, binds, reconcileFooterInfo{}, "in:1")
	if !strings.Contains(got, "quit") {
		t.Errorf("missing keybind: %q", got)
	}
	if !strings.Contains(got, "in:1") {
		t.Errorf("missing inbox: %q", got)
	}
}

// TestRenderFooterLineWithInboxOnlyReconcile: no inbox
// → just reconcile on the right.
func TestRenderFooterLineWithInboxOnlyReconcile(t *testing.T) {
	binds := []footerKeybind{{Keys: []string{"q"}, Desc: "quit"}}
	got := renderFooterLineWithInbox(40, binds, reconcileFooterInfo{InFlight: false, At: nonZeroTime()}, "")
	if !strings.Contains(got, "quit") {
		t.Errorf("missing keybind: %q", got)
	}
	if !strings.Contains(got, "synced") {
		t.Errorf("missing reconcile: %q", got)
	}
}

// TestRenderFooterLineWithInboxNeither: neither present
// → no gap, just keybinds.
func TestRenderFooterLineWithInboxNeither(t *testing.T) {
	binds := []footerKeybind{{Keys: []string{"q"}, Desc: "quit"}}
	got := renderFooterLineWithInbox(40, binds, reconcileFooterInfo{}, "")
	if !strings.Contains(got, "quit") {
		t.Errorf("missing keybind: %q", got)
	}
	if strings.Contains(got, "synced") {
		t.Errorf("should not have reconcile: %q", got)
	}
}

// TestRenderInboxIndicatorNoFocused: no focused pane or
// no session id → "".
func TestRenderInboxIndicatorNoFocused(t *testing.T) {
	model := LoopModel{} // no focused pane
	if got := renderInboxIndicator(model, 80); got != "" {
		t.Errorf("no focus: got %q, want \"\"", got)
	}
}

// TestRenderInboxIndicatorEmptySession: focused pane
// has empty session id.
func TestRenderInboxIndicatorEmptySession(t *testing.T) {
	model := LoopModel{
		Workspaces: []Workspace{{
			ID:    "ws-1",
			Label: "ws",
			Tabs: []Tab{{
				ID:    "tab-1",
				Label: "tab",
				Panes: []PaneModel{{PaneID: "p-1", SessionID: ""}},
			}},
		}},
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
	}
	if got := renderInboxIndicator(model, 80); got != "" {
		t.Errorf("empty session: got %q, want \"\"", got)
	}
}

// TestRenderInboxIndicatorNoSnapshot: focused pane but no
// inbox snapshot yet → "".
func TestRenderInboxIndicatorNoSnapshot(t *testing.T) {
	model := LoopModel{
		Workspaces: []Workspace{{
			ID:    "ws-1",
			Label: "ws",
			Tabs: []Tab{{
				ID:    "tab-1",
				Label: "tab",
				Panes: []PaneModel{{PaneID: "p-1", SessionID: "s-1"}},
			}},
		}},
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
	}
	if got := renderInboxIndicator(model, 80); got != "" {
		t.Errorf("no snapshot: got %q, want \"\"", got)
	}
}

// TestRenderInboxIndicatorHappy: focused pane has a
// snapshot with unread → token rendered.
func TestRenderInboxIndicatorHappy(t *testing.T) {
	model := LoopModel{
		Workspaces: []Workspace{{
			ID:    "ws-1",
			Label: "ws",
			Tabs: []Tab{{
				ID:    "tab-1",
				Label: "tab",
				Panes: []PaneModel{{PaneID: "p-1", SessionID: "s-1"}},
			}},
		}},
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		SessionInbox: map[string]*api.SessionInboxResponse{
			"s-1": inboxResp("s-1",
				msg("m1", "blocked", "high", "delivered"),
			),
		},
	}
	got := renderInboxIndicator(model, 80)
	if !strings.Contains(got, "blocked") {
		t.Errorf("missing type: %q", got)
	}
	if !strings.Contains(got, "inbox") {
		t.Errorf("missing 'inbox' prefix: %q", got)
	}
}

// TestRenderInboxIndicatorNarrowWidth: width < 80 →
// short form ("!!" or "!N").
func TestRenderInboxIndicatorNarrowWidth(t *testing.T) {
	model := LoopModel{
		Workspaces: []Workspace{{
			ID:    "ws-1",
			Label: "ws",
			Tabs: []Tab{{
				ID:    "tab-1",
				Label: "tab",
				Panes: []PaneModel{{PaneID: "p-1", SessionID: "s-1"}},
			}},
		}},
		Focus: FocusPath{WorkspaceIdx: 0, TabIdx: 0, PaneIdx: 0},
		SessionInbox: map[string]*api.SessionInboxResponse{
			"s-1": inboxResp("s-1",
				msg("m1", "blocked", "high", "delivered"),
			),
		},
	}
	got := renderInboxIndicator(model, 60)
	// accentStyle wraps the token in ANSI — check for the
	// underlying "!!" string instead of full equality so
	// the test doesn't break on theme tweaks.
	if !strings.Contains(got, "!!") {
		t.Errorf("narrow + high: got %q, want substring \"!!\"", got)
	}
	// Also confirm the "blocked" / "inbox" long form is
	// NOT in the output (we're in narrow-width short mode).
	if strings.Contains(got, "blocked") {
		t.Errorf("narrow mode should not show long form: %q", got)
	}
}

// nonZeroTime is a small helper that returns a non-zero
// time.Time for tests that need the reconcile indicator
// to render the "synced Ns ago" form.
func nonZeroTime() (t time.Time) {
	return time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC)
}
