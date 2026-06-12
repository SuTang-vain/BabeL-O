package tui

import (
	"fmt"
	"sort"
	"strings"
)

// isKeyInboxMessage mirrors shouldRenderInboxEventCard in
// src/cli/inboxOverlay.ts. Handoff / blocked / request_review /
// request_validation are always key; finding is only key when
// priority=high; memory_candidate is key when its governance
// decision is rejected/requires_approval or approval.status is
// required/rejected. Key messages trigger an event card in the
// main conversation flow and a "high: <type>" tag in the footer.
func isKeyInboxMessage(message sessionMessage) bool {
	switch message.Type {
	case messageTypeHandoff, messageTypeBlocked,
		messageTypeRequestReview, messageTypeRequestValidation:
		return true
	case messageTypeFinding:
		return message.Priority == priorityHigh
	case messageTypeMemoryCandidate:
		governance := asMap(message.Metadata["memoryCandidateGovernance"])
		if governance == nil {
			return false
		}
		decision := stringField(governance, "decision")
		if decision == "rejected" || decision == "requires_approval" {
			return true
		}
		approval := asMap(governance["approval"])
		approvalStatus := stringField(approval, "status")
		return approvalStatus == "required" || approvalStatus == "rejected"
	}
	return false
}

// asMap is a tiny defensive helper that returns its input as a
// generic map. It is used by inbox governance checks that need to
// reach into optional metadata fields without forcing the typed
// sessionMessage struct to grow new optional fields.
func asMap(value any) map[string]any {
	typed, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return typed
}

// formatInboxEvidence renders the evidence list as
// "type:ref (label), type:ref" — same shape as
// formatEvidenceRefs in src/cli/inboxOverlay.ts. Returns "" when
// no evidence is attached.
func formatInboxEvidence(evidence []evidenceRef) string {
	if len(evidence) == 0 {
		return ""
	}
	parts := make([]string, 0, len(evidence))
	for _, ref := range evidence {
		entry := strings.TrimSpace(ref.Type) + ":" + strings.TrimSpace(ref.Ref)
		if label := strings.TrimSpace(ref.Label); label != "" {
			entry += " (" + label + ")"
		}
		parts = append(parts, entry)
	}
	return strings.Join(parts, ", ")
}

// formatInboxGovernanceSummary renders a one-line governance
// summary for memory_candidate messages. Mirrors
// formatGovernanceSummary in src/cli/inboxOverlay.ts. Returns ""
// when the message isn't a memory_candidate or when the optional
// governance blob is missing.
func formatInboxGovernanceSummary(message sessionMessage) string {
	if message.Type != messageTypeMemoryCandidate {
		return ""
	}
	governance := asMap(message.Metadata["memoryCandidateGovernance"])
	if governance == nil {
		return ""
	}
	approval := asMap(governance["approval"])
	parts := []string{
		"decision=" + fallbackUnknown(stringField(governance, "decision")),
		"scope=" + fallbackUnknown(stringField(governance, "scope")),
		"approval=" + fallbackUnknown(stringField(approval, "status")) +
			":" + fallbackUnknown(stringField(approval, "requiredBy")),
	}
	if auto, ok := governance["autoWrite"].(bool); ok {
		parts = append(parts, fmt.Sprintf("auto_write=%v", auto))
	}
	return strings.Join(parts, " ")
}

// fallbackUnknown renders "<x>" for the in-line label when a
// missing or blank string would otherwise leave a bare "=" in the
// summary line. Mirrors the inline `?? "unknown"` behavior in
// formatGovernanceSummary in the TS TUI.
func fallbackUnknown(value string) string {
	if strings.TrimSpace(value) == "" {
		return "unknown"
	}
	return value
}

// formatInboxMessageHeaderRow renders the first row of a message
// inside the inbox overlay. It uses `›` as the selected marker
// (mirroring the TS TUI) and a ` ` pad for unselected rows so the
// column alignment is stable.
func formatInboxMessageHeaderRow(message sessionMessage, selected bool) string {
	marker := " "
	if selected {
		marker = "›"
	}
	status := strings.TrimSpace(string(message.Status))
	if message.AcknowledgedAt != "" && status == "" {
		status = "acknowledged"
	}
	if status == "" {
		status = string(messageStatusDelivered)
	}
	return fmt.Sprintf("%s %s [%s] %s", marker, message.MessageID, message.CreatedAt, status)
}

// formatInboxMessageMetaRow renders the second row of a message
// (type / priority / from / target / channel / kind). The target
// is `to=<id>` for direct sends and `broadcast=true` for fan-out.
func formatInboxMessageMetaRow(message sessionMessage, channel sessionChannel) string {
	target := "broadcast=true"
	if to := strings.TrimSpace(message.ToSessionID); to != "" {
		target = "to=" + to
	}
	channelKind := string(channel.Kind)
	if channelKind == "" {
		channelKind = string(channelKindDirect)
	}
	return fmt.Sprintf("  %s · %s · from=%s · %s · kind=%s · channel=%s",
		message.Type, message.Priority, message.FromSessionID,
		target, channelKind, message.ChannelID)
}

// formatInboxMessageContentRow renders the content line, prefixed
// with two spaces for indent. The text is left untouched — the
// overlay scrolls vertically, not horizontally, and the chat TUI
// keeps long content as a single line for grep-ability.
func formatInboxMessageContentRow(message sessionMessage) string {
	return "  " + message.Content
}

// buildInboxMessageRows returns the ordered list of row strings for
// a single message in the inbox overlay. Returns an empty slice
// for the zero-value message so callers can iterate safely.
func buildInboxMessageRows(message sessionMessage, channel sessionChannel, selected bool) []string {
	rows := []string{
		formatInboxMessageHeaderRow(message, selected),
		formatInboxMessageMetaRow(message, channel),
		formatInboxMessageContentRow(message),
	}
	if evidence := formatInboxEvidence(message.Evidence); evidence != "" {
		rows = append(rows, "  evidence: "+evidence)
	}
	if gov := formatInboxGovernanceSummary(message); gov != "" {
		rows = append(rows, "  governance: "+gov)
	}
	return rows
}

// formatInboxFooterStatus mirrors formatInboxFooterStatus in
// src/cli/inboxOverlay.ts. Renders a compact
// "linked sessions: N [...]; inbox: N unread; channels: kind1 N/kind2 M; high: <type>"
// summary used both by the persistent footer status line and the
// "summary" line at the top of the overlay. Returns "" when there
// is nothing to surface, so callers can no-op.
func formatInboxFooterStatus(sessionID string, messages []sessionMessage, channels []sessionChannel) string {
	unread := 0
	for _, message := range messages {
		if message.Status == messageStatusAcknowledged || message.AcknowledgedAt != "" {
			continue
		}
		unread++
	}
	linked := map[string]struct{}{}
	for _, channel := range channels {
		found := false
		for _, participant := range channel.ParticipantSessionIDs {
			if participant == sessionID {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		for _, participant := range channel.ParticipantSessionIDs {
			if participant == sessionID {
				continue
			}
			linked[participant] = struct{}{}
		}
	}
	if len(linked) == 0 {
		for _, message := range messages {
			if message.FromSessionID == sessionID {
				continue
			}
			linked[message.FromSessionID] = struct{}{}
		}
	}
	parts := []string{}
	if linkedSummary := formatLinkedSessionSummary(linked); linkedSummary != "" {
		parts = append(parts, linkedSummary)
	}
	if len(linked) > 0 || unread > 0 {
		parts = append(parts, fmt.Sprintf("inbox: %d unread", unread))
	}
	if kinds := summarizeChannelKinds(channels, sessionID); kinds != "" {
		parts = append(parts, "channels: "+kinds)
	}
	for _, message := range messages {
		if isKeyInboxMessage(message) {
			parts = append(parts, "high: "+string(message.Type))
			break
		}
	}
	return strings.Join(parts, " · ")
}

// formatLinkedSessionSummary renders the
// "linked sessions: N [s1, s2, s3 +X more]" segment used by
// formatInboxFooterStatus. Caps at 3 short IDs and trims with
// "+N" so the footer status stays on one line in narrow widths.
func formatLinkedSessionSummary(linked map[string]struct{}) string {
	if len(linked) == 0 {
		return ""
	}
	ids := make([]string, 0, len(linked))
	for id := range linked {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	limit := 3
	if len(ids) < limit {
		limit = len(ids)
	}
	shown := make([]string, 0, limit+1)
	for _, id := range ids[:limit] {
		shown = append(shown, shortID(id))
	}
	extra := ""
	if len(ids) > limit {
		extra = fmt.Sprintf(" +%d", len(ids)-limit)
	}
	return fmt.Sprintf("linked sessions: %d [%s%s]", len(ids), strings.Join(shown, ", "), extra)
}

// summarizeChannelKinds returns a stable
// "direct 1/group 2/parent_child 1" segment for the channels the
// current session participates in. The order is sorted by kind so
// the footer string is stable across runs (mirrors the TS
// summarizeChannelKinds helper).
func summarizeChannelKinds(channels []sessionChannel, sessionID string) string {
	counts := map[sessionChannelKind]int{}
	for _, channel := range channels {
		found := false
		for _, participant := range channel.ParticipantSessionIDs {
			if participant == sessionID {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		counts[channel.Kind]++
	}
	if len(counts) == 0 {
		return ""
	}
	keys := make([]string, 0, len(counts))
	for kind := range counts {
		keys = append(keys, string(kind))
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, kind := range keys {
		parts = append(parts, fmt.Sprintf("%s %d", kind, counts[sessionChannelKind(kind)]))
	}
	return strings.Join(parts, "/")
}

// buildInboxOverlayLines turns the inbox response into the ordered
// list of lines the inbox overlay will render. Each message
// contributes 3-5 lines (header / meta / content / optional
// evidence / optional governance); the overlay window is then
// clamped in renderInboxOverlay. Returns an empty slice for the
// "no messages" case so the caller can show a friendly placeholder.
func buildInboxOverlayLines(messages []sessionMessage, channels []sessionChannel, selected int, includeAck bool) []string {
	if len(messages) == 0 {
		placeholder := "No unread inbox messages."
		if includeAck {
			placeholder = "No inbox messages."
		}
		return []string{placeholder}
	}
	channelByID := make(map[string]sessionChannel, len(channels))
	for _, channel := range channels {
		channelByID[channel.ChannelID] = channel
	}
	lines := []string{mutedStyle.Render("  message_id · created_at · status · type · priority · from · target · kind · channel")}
	for index, message := range messages {
		channel := channelByID[message.ChannelID]
		isSelected := index == selected
		lines = append(lines, buildInboxMessageRows(message, channel, isSelected)...)
	}
	return lines
}

// renderInboxOverlay paints the multi-line SessionChannel inbox
// view. It is the Phase 6 §1 primary UX for the inbox slash
// command. The overlay is composed of:
//   - titleStyle header (Phase 6 banner + session id)
//   - persistent footer status summary (linked / unread / channels / high)
//   - clamped window of buildInboxOverlayLines
//   - bottom hint (selection marker, scroll, close, ack keys)
//
// Outside modeInboxOverlay it returns "" so it can be
// unconditionally spliced into the View() parts list.
func (m model) renderInboxOverlay(width int) string {
	if m.inputMode != modeInboxOverlay {
		return ""
	}
	banner := "Inbox"
	if m.inboxOverlayIncludeAck {
		banner = "Inbox · all"
	}
	header := titleStyle.Render(banner)
	summary := formatInboxFooterStatus(m.sessionID, m.inboxMessages, m.inboxChannels)
	if summary == "" {
		summary = "(no inbox summary available)"
	}
	lines := []string{header, divider(width), summary}
	visibleRows := max(1, m.height-10)
	allLines := buildInboxOverlayLines(m.inboxMessages, m.inboxChannels, m.inboxOverlaySelected, m.inboxOverlayIncludeAck)
	maxScroll := max(0, len(allLines)-visibleRows)
	if m.inboxOverlayScroll > maxScroll {
		// View() is read-only; clamp locally for the rendered slice.
		// The next key event will reconcile m.inboxOverlayScroll.
		end := maxScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		lines = append(lines, allLines[maxScroll:end]...)
	} else {
		end := m.inboxOverlayScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		lines = append(lines, allLines[m.inboxOverlayScroll:end]...)
	}
	hint := "↑/↓/Tab move · a ack selected · esc/enter/q close"
	lines = append(lines, mutedStyle.Render(hint))
	return renderOverlayFrame(width, inboxStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2))))
}

// quoteInboxMessageContent renders a multi-line block that can be
// pre-filled into the textinput when the user chooses to quote a
// SessionChannel message into the current prompt. Mirrors
// quoteInboxMessage in src/cli/inboxOverlay.ts. The block always
// starts with the "verify evidence" guard line so the user is
// reminded not to act on the inbox context blindly. Missing
// optional fields (evidence / governance) are dropped; required
// fields fall back to "unknown" via fallbackUnknown so a
// server-side addition cannot break the rendering.
func quoteInboxMessageContent(message sessionMessage) string {
	header := fmt.Sprintf("message=%s type=%s priority=%s from=%s channel=%s",
		fallbackUnknown(message.MessageID),
		fallbackUnknown(string(message.Type)),
		fallbackUnknown(string(message.Priority)),
		fallbackUnknown(message.FromSessionID),
		fallbackUnknown(message.ChannelID),
	)
	parts := []string{
		"Use this SessionChannel inbox context only after verifying evidence:",
		header,
		"content: " + fallbackUnknown(message.Content),
	}
	if evidence := formatInboxEvidence(message.Evidence); evidence != "" {
		parts = append(parts, "evidence: "+evidence)
	}
	if gov := formatInboxGovernanceSummary(message); gov != "" {
		parts = append(parts, "memory_candidate "+gov)
	}
	return strings.Join(parts, "\n")
}

// renderInboxEventCard is the main-flow event card for a single
// key SessionChannel message. It is intentionally compact (a
// short banner + metadata + the "open inbox / ack / quote" hint)
// so the user's main transcript stays readable. Returns "" for
// non-key messages so callers can route through it unconditionally.
func renderInboxEventCard(message sessionMessage, channel sessionChannel) string {
	if !isKeyInboxMessage(message) {
		return ""
	}
	target := "broadcast=true"
	if to := strings.TrimSpace(message.ToSessionID); to != "" {
		target = "to=" + to
	}
	channelKind := string(channel.Kind)
	if channelKind == "" {
		channelKind = string(channelKindDirect)
	}
	rows := []string{
		fmt.Sprintf("SessionChannel %s · %s · from=%s · %s",
			message.Type, message.Priority, message.FromSessionID, target),
		fmt.Sprintf("channel=%s kind=%s message=%s", message.ChannelID, channelKind, message.MessageID),
		"collaboration context only; verify evidence before acting",
	}
	if evidence := formatInboxEvidence(message.Evidence); evidence != "" {
		rows = append(rows, "evidence: "+evidence)
	}
	rows = append(rows, fmt.Sprintf("[open inbox: /inbox] [ack: /inbox ack %s] [quote: /inbox then q]", message.MessageID))
	body := strings.Join(rows, "\n")
	return strings.Join([]string{divider(80), inboxStyle.Render(wrapPlain(body, 78)), divider(80)}, "\n")
}

// renderNewInboxEventCards walks the current inbox snapshot and
// pushes a compact event card into the transcript for every key
// message that hasn't been rendered yet. Mirrors
// renderNewInboxEventCards in src/cli/commands/chat.ts. The set
// of seen message IDs is kept on the model so the next /inbox
// call (or any future refresh trigger) only surfaces fresh
// messages, not the historical ones the user already saw.
func (m *model) renderNewInboxEventCards() {
	if m.seenInboxCardMessageIDs == nil {
		m.seenInboxCardMessageIDs = map[string]struct{}{}
	}
	channelByID := map[string]sessionChannel{}
	for _, channel := range m.inboxChannels {
		channelByID[channel.ChannelID] = channel
	}
	for _, message := range m.inboxMessages {
		if _, seen := m.seenInboxCardMessageIDs[message.MessageID]; seen {
			continue
		}
		if !isKeyInboxMessage(message) {
			continue
		}
		if card := renderInboxEventCard(message, channelByID[message.ChannelID]); card != "" {
			m.appendLine("inbox", card)
		}
		m.seenInboxCardMessageIDs[message.MessageID] = struct{}{}
	}
}
