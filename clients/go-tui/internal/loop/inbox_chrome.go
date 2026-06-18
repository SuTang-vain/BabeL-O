// internal/loop/inbox_chrome.go
//
// SessionChannel TUI relationship visibility Phase 1:
// chrome-side rendering helpers for the inbox snapshot
// the inbox tick (inbox_tick.go) maintains.
//
// Two surfaces:
//   - Footer: focused pane's unread count + highest-
//     priority type ("inbox: 3 unread · high: blocked"),
//     right-aligned next to the reconcile indicator.
//   - Sidebar: per-pane unread badge on each pane row
//     that has at least one undelivered / unacknowledged
//     SessionChannel message.
//
// Both surfaces are pure functions over the snapshot —
// no I/O, no model mutation. The InteractiveModel passes
// the focused pane's snapshot to the footer and walks
// every pane to the sidebar.

package loop

import (
	"fmt"
	"sort"
	"strings"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// isUnreadInboxMessage reports whether a message should
// count toward the unread indicator. Acknowledged and
// expired messages are skipped; the rest are unread from
// the operator's perspective.
func isUnreadInboxMessage(m api.SessionInboxMessage) bool {
	switch m.Status {
	case "acknowledged", "expired":
		return false
	}
	return true
}

// summarizeInbox returns the unread count and the highest-
// priority type present in the snapshot. Empty strings mean
// "no unread" — the chrome treats that as "no badge".
//
// Priority order: "high" > "normal" > "low". For ties we
// prefer the typed order from the plan doc:
// blocked > handoff > request_review > request_validation >
// finding > question > others. The function returns at most
// one type, and only when the *best* message is at "high"
// priority — the chrome's "high: X" token is reserved
// for the operator-actionable case (per the plan doc, a
// low/normal-priority finding shouldn't surface as a
// "high: finding" badge).
func summarizeInbox(resp *api.SessionInboxResponse) (unread int, topType string) {
	if resp == nil {
		return 0, ""
	}
	// priorityRank: 0 = lowest, 3 = highest.
	priorityRank := func(p string) int {
		switch p {
		case "high":
			return 3
		case "normal":
			return 2
		case "low":
			return 1
		default:
			return 0
		}
	}
	// typeRank returns the relative order in the type
	// priority chain. Higher = more important to surface.
	typeRank := func(t string) int {
		switch t {
		case "blocked":
			return 5
		case "handoff":
			return 4
		case "request_review":
			return 3
		case "request_validation":
			return 2
		case "finding":
			return 1
		default:
			return 0
		}
	}
	bestPriority := -1
	bestTypeRank := -1
	for _, m := range resp.Messages {
		if !isUnreadInboxMessage(m) {
			continue
		}
		unread++
		pr := priorityRank(m.Priority)
		tr := typeRank(m.Type)
		// Compare priority first; ties break on type
		// rank. Equal-everything falls through (no
		// overwrite) so the first "best" wins and the
		// footer stays deterministic.
		if pr > bestPriority || (pr == bestPriority && tr > bestTypeRank) {
			bestPriority = pr
			bestTypeRank = tr
			if m.Type != "" {
				topType = m.Type
			}
		}
	}
	// Per the plan doc, the chrome's "high: X" footer
	// token is reserved for high-priority unread. A
	// low-priority finding with no high-priority unread
	// shouldn't surface as "high: finding" — that would
	// inflate the operator's sense of urgency. Strip the
	// type tag when the best message is low-priority OR
	// when the best type is a generic catch-all (rank 0,
	// e.g. "question" or unknown). "blocked" / "handoff"
	// / "review" / "validation" / "finding" still surface
	// at normal priority because they're operator-
	// actionable; the call site (formatInboxFooterToken)
	// decides whether to prefix the "high:" tag.
	if bestPriority < 2 || bestTypeRank < 1 {
		topType = ""
	}
	return unread, topType
}

// formatInboxFooterToken returns the footer token for the
// focused pane's inbox state. Returns "" when there's
// nothing to surface (nil snapshot / zero unread) so the
// chrome can skip the cell cleanly. The token is short
// (≤ 24 cells in practice) so a 64-col mobile terminal
// still fits critical keybinds + inbox summary on one
// line; truncation is the caller's job.
//
// The "high:" prefix is reserved for high-priority
// unread — the operator-actionable case. Normal-
// priority unread with a high-value type ("blocked" /
// "handoff" / "review" / "validation" / "finding")
// shows the type alone ("in: 2 · blocked") so the
// footer still surfaces the actionable type without
// inflating urgency.
func formatInboxFooterToken(resp *api.SessionInboxResponse) string {
	if resp == nil {
		return ""
	}
	unread, topType := summarizeInbox(resp)
	if unread == 0 {
		return ""
	}
	if topType == "" {
		return fmt.Sprintf("inbox: %d unread", unread)
	}
	if hasHighPriorityUnread(resp) {
		return fmt.Sprintf("inbox: %d unread · high: %s", unread, topType)
	}
	return fmt.Sprintf("inbox: %d unread · %s", unread, topType)
}

// inboxBadgeForSession returns the sidebar badge text for
// a given session. The pane list renders this on rows whose
// session id matches. Returns "" when the session has no
// unread inbox (the sidebar then shows the normal status
// pill with no badge).
//
// Format: "!<N>" for ≤ 99 unread, "!!" for high-priority
// unread (regardless of count), empty otherwise. The
// caller appends it after the pane's status pill so
// narrow terminals can truncate the badge first.
func inboxBadgeForSession(snapshot map[string]*api.SessionInboxResponse, sessionID string) string {
	if snapshot == nil || sessionID == "" {
		return ""
	}
	resp, ok := snapshot[sessionID]
	if !ok || resp == nil {
		return ""
	}
	unread, topType := summarizeInbox(resp)
	if unread == 0 {
		return ""
	}
	if topType != "" && hasHighPriorityUnread(resp) {
		return "!!"
	}
	if unread > 99 {
		return "!99+"
	}
	return fmt.Sprintf("!%d", unread)
}

// hasHighPriorityUnread reports whether the snapshot has
// at least one unread message at "high" priority. Used to
// upgrade the sidebar badge from "!N" to "!!" (the plan
// doc's symbols). Avoids double-counting in summarizeInbox.
func hasHighPriorityUnread(resp *api.SessionInboxResponse) bool {
	if resp == nil {
		return false
	}
	for _, m := range resp.Messages {
		if !isUnreadInboxMessage(m) {
			continue
		}
		if m.Priority == "high" {
			return true
		}
	}
	return false
}

// sortedInboxSessions returns the snapshot keys in
// deterministic order (alphabetical). Helpful for tests
// and any future "show me all linked sessions" UI — the
// current chrome doesn't surface a list yet, but the
// helper is small and keeps the policy in one place.
func sortedInboxSessions(snapshot map[string]*api.SessionInboxResponse) []string {
	if len(snapshot) == 0 {
		return nil
	}
	keys := make([]string, 0, len(snapshot))
	for k := range snapshot {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// formatInboxFooterShort is a narrow-width fallback for
// the footer token. When the desktop footer can't fit the
// full "inbox: N unread · high: X" string, the chrome
// substitutes this shorter form ("!3" or "!!").
func formatInboxFooterShort(resp *api.SessionInboxResponse) string {
	if resp == nil {
		return ""
	}
	unread, topType := summarizeInbox(resp)
	if unread == 0 {
		return ""
	}
	if topType != "" && hasHighPriorityUnread(resp) {
		return "!!"
	}
	if unread > 9 {
		return "!9+"
	}
	return "!" + itoaSmall(unread)
}

// itoaSmall is a tiny zero-alloc int-to-string for the
// footer fallback. Avoids pulling in strconv for what is
// always a single-digit value (we only call it for
// unread < 10 after the "9+" branch).
func itoaSmall(n int) string {
	if n < 0 {
		n = 0
	}
	if n > 9 {
		return "9+"
	}
	return string(rune('0' + n))
}

// formatInboxRowForLog returns a one-line log-friendly
// summary of the snapshot. Used by the inbox tick toast
// and by future tests; not currently rendered in the
// chrome itself.
func formatInboxRowForLog(resp *api.SessionInboxResponse) string {
	if resp == nil {
		return ""
	}
	unread, topType := summarizeInbox(resp)
	parts := []string{fmt.Sprintf("session=%s", resp.SessionID)}
	parts = append(parts, fmt.Sprintf("unread=%d", unread))
	if topType != "" {
		parts = append(parts, "top="+topType)
	}
	return strings.Join(parts, " ")
}
