package tui

import "strings"

func contextUsageSnapshotFromContextUsageEvent(event map[string]any) *contextUsageSnapshot {
	return &contextUsageSnapshot{
		PercentUsed:      anyInt(event["percentUsed"]),
		TokenEstimate:    anyInt(event["tokenEstimate"]),
		MaxTokens:        anyInt(event["maxTokens"]),
		WarningThreshold: anyInt(event["warningThresholdTokens"]),
		CompactThreshold: anyInt(event["compactThresholdTokens"]),
		BlockingLimit:    anyInt(event["blockingLimitTokens"]),
		PolicySource:     stringField(event, "contextPolicySource"),
	}
}

func contextUsageSnapshotFromExecutionMetrics(event map[string]any) *contextUsageSnapshot {
	used := anyInt(event["inputTokens"])
	maxTokens := anyInt(event["effectiveContextCeiling"])
	if maxTokens <= 0 {
		maxTokens = anyInt(event["maxTokens"])
	}
	if maxTokens <= 0 {
		maxTokens = anyInt(event["modelContextWindow"])
	}
	if used <= 0 && maxTokens <= 0 {
		return nil
	}
	percent := anyInt(event["percentUsed"])
	if percent <= 0 && used > 0 && maxTokens > 0 {
		percent = clamp((used*100+maxTokens/2)/maxTokens, 0, 999)
	}
	return &contextUsageSnapshot{
		PercentUsed:      percent,
		TokenEstimate:    used,
		MaxTokens:        maxTokens,
		WarningThreshold: anyInt(event["contextWarningThresholdTokens"]),
		CompactThreshold: anyInt(event["contextCompactThresholdTokens"]),
		BlockingLimit:    anyInt(event["contextBlockingLimitTokens"]),
		PolicySource:     stringField(event, "contextPolicySource"),
	}
}

// recordActivityEvent appends a high-signal event to the
// in-memory activity buffer, dropping the oldest entry once
// the cap is hit. Phase 6 PR5 wires this into consumeNexusEvent
// for tool_started / tool_completed / permission_response /
// context_warning / context_blocking / agent_job_event so the
// /activity overlay has a recent snapshot without an extra
// Nexus round-trip.
func (m *model) recordActivityEvent(kind activityEventKind, summary string, timestamp string) {
	entry := activityEventEntry{
		Kind:      kind,
		Summary:   singleLine(strings.TrimSpace(summary)),
		Timestamp: strings.TrimSpace(timestamp),
	}
	if entry.Summary == "" {
		entry.Summary = "[" + string(kind) + "]"
	}
	m.activityEvents = append(m.activityEvents, entry)
	if len(m.activityEvents) > activityBufferCap {
		// Drop oldest entries. The buffer is small (cap 50)
		// so a plain re-slice is fine.
		m.activityEvents = append([]activityEventEntry(nil), m.activityEvents[len(m.activityEvents)-activityBufferCap:]...)
	}
}

// subAgentStatusFromTaskSessionEvent maps a task_session_event
// eventType to the canonical subAgentStatus enum. Returns
// (status, true) when the eventType is a sub-agent lifecycle
// event; returns ("", false) for unrelated task_session_event
// types so the caller can no-op.
//
// Mirrors the TS TUI isSubAgentLifecycleEvent +
// statusFromSubAgentLifecycleEvent helpers in
// src/cli/renderEvents.ts (Phase 6 PR6).
func subAgentStatusFromTaskSessionEvent(event map[string]any) (subAgentStatus, bool) {
	eventType := stringField(event, "eventType")
	switch eventType {
	case "subagent_started", "sub_agent_session_started":
		return subAgentStatusRunning, true
	case "subagent_completed", "sub_agent_session_completed":
		return subAgentStatusCompleted, true
	case "subagent_failed", "sub_agent_session_failed", "sub_agent_session_error", "subagent_failed_v2":
		return subAgentStatusFailed, true
	case "subagent_cancelled":
		return subAgentStatusCancelled, true
	}
	return "", false
}

// recordSubAgentEvent updates the in-memory subAgents tracker
// from a task_session_event payload. The id is taken from the
// first non-empty field among agentId / subSessionId /
// taskId; the parentTaskId is taken from the payload if
// present; the title is taken from the first non-empty
// title / taskTitle / summary field. Phase 6 PR6 wires this
// into consumeNexusEvent for subagent lifecycle events.
func (m *model) recordSubAgentEvent(event map[string]any, status subAgentStatus) {
	if m.subAgents == nil {
		m.subAgents = map[string]subAgentEntry{}
	}
	payload := asMap(event["payload"])
	// eventType / sessionId / eventId / phase / timestamp
	// live at the top level (TaskSessionEventSchema in
	// src/shared/events.ts).
	agentID := stringField(event, "agentId")
	if agentID == "" {
		agentID = stringField(payload, "agentId")
	}
	if agentID == "" {
		agentID = stringField(payload, "subSessionId")
	}
	if agentID == "" {
		agentID = stringField(payload, "taskId")
	}
	if agentID == "" {
		// The payload sometimes carries a unique id nested
		// one level deeper; fall back to that before
		// giving up.
		agentID = stringField(payload, "id")
	}
	if agentID == "" {
		// Without an id we can't dedupe; skip the event.
		return
	}
	parentTask := stringField(payload, "parentTaskId")
	title := firstNonEmpty(
		stringField(payload, "title"),
		stringField(payload, "taskTitle"),
		stringField(payload, "summary"),
	)
	entry := subAgentEntry{
		ID:         agentID,
		ParentTask: parentTask,
		Title:      singleLine(title),
		Status:     status,
		UpdatedAt:  stringField(event, "timestamp"),
	}
	if entry.Title == "" {
		entry.Title = "sub-agent task"
	}
	m.subAgents[agentID] = entry
}

// subAgentRunningCount returns the number of subAgents
// currently in the running status. Used by the header badge
// (Phase 6 PR6).
func (m *model) subAgentRunningCount() int {
	count := 0
	for _, entry := range m.subAgents {
		if entry.Status == subAgentStatusRunning {
			count++
		}
	}
	return count
}
