package tui

import (
	"encoding/json"
	"fmt"
	"strings"
)

func buildMemoryOverlayLines(raw []byte) []string {
	if len(raw) == 0 {
		return []string{"No memory status payload available."}
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return []string{"Unable to decode memory status: " + err.Error()}
	}
	switch stringField(payload, "type") {
	case "memory_search_result":
		return buildMemorySearchOverlayLines(payload)
	case "memory_candidates":
		return buildMemoryCandidatesOverlayLines(payload)
	case "memory_action_approval_required":
		return buildMemoryApprovalOverlayLines(payload)
	case "memory_note_saved", "memory_session_flushed":
		return buildMemoryMutationOverlayLines(payload)
	case "error":
		return buildMemoryErrorOverlayLines(payload)
	}
	everCore := asMap(payload["everCore"])
	capability := asMap(payload["capability"])
	guidance := asMap(payload["guidance"])
	summary := "unavailable"
	if anyBool(capability["available"]) {
		summary = "available"
	} else if anyBool(everCore["enabled"]) && !anyBool(everCore["healthy"]) {
		summary = "unhealthy"
	} else if !anyBool(everCore["enabled"]) {
		summary = "disabled"
	}
	lines := []string{
		mutedStyle.Render("  memory status · runtime-owned management surface"),
		"Status: " + summary,
		fmt.Sprintf("EverCore: enabled=%v healthy=%v mode=%s", anyBool(everCore["enabled"]), anyBool(everCore["healthy"]), fallbackUnknown(stringField(everCore, "mode"))),
	}
	if url := stringField(everCore, "url"); url != "" {
		lines = append(lines, "Endpoint: "+url)
	}
	if appID := stringField(everCore, "appId"); appID != "" {
		lines = append(lines, "App: "+appID)
	}
	if projectID := stringField(everCore, "projectId"); projectID != "" {
		lines = append(lines, "Project: "+projectID)
	}
	if agentID := stringField(everCore, "agentId"); agentID != "" {
		lines = append(lines, "Agent: "+agentID)
	}
	if method := stringField(everCore, "retrieveMethod"); method != "" {
		lines = append(lines, fmt.Sprintf("Retrieval: method=%s topK=%d", method, anyInt(everCore["topK"])))
	}
	namespace := asMap(everCore["namespace"])
	if len(namespace) > 0 {
		parts := []string{
			"Namespace:",
			"layer=" + fallbackUnknown(stringField(namespace, "layer")),
			"isolation=" + fallbackUnknown(stringField(namespace, "isolationKey")),
			"source=" + fallbackUnknown(stringField(namespace, "projectIdSource")),
		}
		if warning := stringField(namespace, "warningCode"); warning != "" {
			parts = append(parts, "warning="+warning)
		}
		lines = append(lines, strings.Join(parts, " "))
	}
	sidecar := asMap(everCore["sidecar"])
	if len(sidecar) > 0 {
		parts := []string{
			"Sidecar:",
			"managed=" + fmt.Sprint(anyBool(sidecar["managed"])),
			"running=" + fmt.Sprint(anyBool(sidecar["running"])),
			"healthy=" + fmt.Sprint(anyBool(sidecar["healthy"])),
		}
		if dataDir := stringField(sidecar, "dataDir"); dataDir != "" {
			parts = append(parts, "dataDir="+dataDir)
		}
		if pid := anyInt(sidecar["pid"]); pid > 0 {
			parts = append(parts, fmt.Sprintf("pid=%d", pid))
		}
		lines = append(lines, strings.Join(parts, " "))
	}
	if errorCode := stringField(everCore, "errorCode"); errorCode != "" {
		lines = append(lines, "Error: "+errorCode+" "+stringField(everCore, "errorMessage"))
	}
	lines = append(lines,
		"Capability: auto-search="+fallbackUnknown(stringField(capability, "autoSearch"))+" save="+fallbackUnknown(stringField(capability, "save")),
		fmt.Sprintf("Boundaries: memoryIsHint=%v workspaceEvidenceRequired=%v candidatesAutoWrite=%v", anyBool(guidance["memoryIsHint"]), anyBool(guidance["projectFactsRequireWorkspaceEvidence"]), anyBool(guidance["candidatesAutoWrite"])),
		"Actions: status/search/candidates are read-only; save/flush/restart require permission.",
	)
	return lines
}

func buildMemorySearchOverlayLines(payload map[string]any) []string {
	lines := []string{
		mutedStyle.Render("  memory search · read-only hints"),
		"Query: " + fallbackUnknown(stringField(payload, "query")),
		fmt.Sprintf("Result: hits=%d extracted=%d truncated=%v method=%s topK=%d", anyInt(payload["hitCount"]), anyInt(payload["totalExtractedHits"]), anyBool(payload["truncated"]), fallbackUnknown(stringField(payload, "method")), anyInt(payload["topK"])),
		fmt.Sprintf("Budget: injectedChars=%d budgetChars=%d maxHitChars=%d latencyMs=%d", anyInt(payload["injectedChars"]), anyInt(payload["budgetChars"]), anyInt(payload["maxHitChars"]), anyInt(payload["searchLatencyMs"])),
		"Guidance: memory hints are not workspace facts; verify project facts with workspace/session evidence.",
	}
	if content := stringField(payload, "content"); content != "" {
		lines = append(lines, "Hits:")
		lines = append(lines, strings.Split(content, "\n")...)
	}
	return lines
}

func buildMemoryCandidatesOverlayLines(payload map[string]any) []string {
	lines := []string{
		mutedStyle.Render("  memory candidates · review-only governance"),
		fmt.Sprintf("Candidates: count=%d limit=%d includeRejected=%v", len(anySlice(payload["candidates"])), anyInt(payload["limit"]), anyBool(payload["includeRejected"])),
		"Guidance: autoWrite=false; save requires explicit approval.",
	}
	candidates := anySlice(payload["candidates"])
	if len(candidates) == 0 {
		return append(lines, "No memory candidates found.")
	}
	for _, item := range candidates {
		candidate := asMap(item)
		governance := asMap(candidate["governance"])
		approval := asMap(governance["approval"])
		lines = append(lines,
			fmt.Sprintf("- %s scope=%s decision=%s approval=%s:%s autoWrite=%v evidence=%d", fallbackUnknown(stringField(candidate, "messageId")), fallbackUnknown(stringField(governance, "scope")), fallbackUnknown(stringField(governance, "decision")), fallbackUnknown(stringField(approval, "status")), fallbackUnknown(stringField(approval, "requiredBy")), anyBool(governance["autoWrite"]), len(anySlice(candidate["evidence"]))),
		)
		if content := stringField(candidate, "content"); content != "" {
			lines = append(lines, "  "+truncateMemoryLine(content, 160))
		}
		if blocked := anyStringSlice(governance["blockedReasons"]); len(blocked) > 0 {
			lines = append(lines, "  blocked="+strings.Join(blocked, ","))
		}
		if review := anyStringSlice(governance["reviewReasons"]); len(review) > 0 {
			lines = append(lines, "  review="+strings.Join(review, ","))
		}
	}
	return lines
}

func buildMemoryApprovalOverlayLines(payload map[string]any) []string {
	return []string{
		mutedStyle.Render("  memory action · approval required"),
		"Action: " + fallbackUnknown(stringField(payload, "action")),
		"Risk: " + fallbackUnknown(stringField(payload, "risk")),
		"Required confirmation: " + fallbackUnknown(stringField(payload, "requiredConfirmation")),
		"Guidance: " + fallbackUnknown(stringField(payload, "guidance")),
		"No memory write/lifecycle operation was executed.",
	}
}

func buildMemoryMutationOverlayLines(payload map[string]any) []string {
	lines := []string{
		mutedStyle.Render("  memory action · completed"),
		"Type: " + fallbackUnknown(stringField(payload, "type")),
		"Provider: " + fallbackUnknown(stringField(payload, "provider")),
	}
	if sessionID := stringField(payload, "sessionId"); sessionID != "" {
		lines = append(lines, "Session: "+sessionID)
	}
	if saved := anyInt(payload["savedMessages"]); saved > 0 {
		lines = append(lines, fmt.Sprintf("Saved: messages=%d chars=%d", saved, anyInt(payload["savedChars"])))
	}
	if anyBool(payload["flushed"]) {
		lines = append(lines, "Flushed: true")
	}
	lines = append(lines, "Guidance: search cache invalidated; memory remains a hint, not a fact source.")
	return lines
}

func buildMemoryErrorOverlayLines(payload map[string]any) []string {
	return []string{
		mutedStyle.Render("  memory action · error"),
		"Code: " + fallbackUnknown(stringField(payload, "code")),
		"Message: " + fallbackUnknown(stringField(payload, "message")),
	}
}

func renderMemoryOverlayLines(lines []string, scroll int, height int) []string {
	if len(lines) == 0 {
		lines = []string{"No memory status loaded yet."}
	}
	visibleRows := max(1, height-10)
	maxScroll := max(0, len(lines)-visibleRows)
	if scroll > maxScroll {
		scroll = maxScroll
	}
	end := scroll + visibleRows
	if end > len(lines) {
		end = len(lines)
	}
	return lines[scroll:end]
}

func (m model) renderMemoryOverlay(width int) string {
	if m.inputMode != modeMemoryOverlay {
		return ""
	}
	header := titleStyle.Render("Memory")
	lines := []string{header, divider(width)}
	lines = append(lines, renderMemoryOverlayLines(m.memoryOverlayLines, m.memoryOverlayScroll, m.height)...)
	lines = append(lines, mutedStyle.Render("↑/↓/Tab scroll · esc/enter/q close"))
	return renderOverlayFrame(width, contextStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2))))
}

func anyBool(value any) bool {
	if v, ok := value.(bool); ok {
		return v
	}
	return false
}

func anySlice(value any) []any {
	if v, ok := value.([]any); ok {
		return v
	}
	return nil
}

func anyStringSlice(value any) []string {
	items := anySlice(value)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			result = append(result, strings.TrimSpace(text))
		}
	}
	return result
}

func truncateMemoryLine(value string, maxChars int) string {
	trimmed := strings.TrimSpace(value)
	if maxChars <= 0 || len(trimmed) <= maxChars {
		return trimmed
	}
	return trimmed[:maxChars] + "..."
}
