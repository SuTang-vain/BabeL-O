package tui

import (
	"encoding/json"
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
)

func renderTranscript(lines []*transcriptItem, width int) string {
	if len(lines) == 0 {
		return mutedStyle.Render("  No messages yet.")
	}
	rendered := make([]string, 0, len(lines)*2)
	for i, line := range lines {
		// Phase B.2: per-item render cache. The first render
		// populates line.cache; subsequent calls with the same
		// (width, version) pair return the cached string
		// without re-running formatLine. Width changes (terminal
		// resize) and Bump() calls (content mutation) both
		// invalidate the entry.
		formatted := renderTranscriptItemCached(line, width)
		rendered = append(rendered, formatted)
		// Insert a blank line between rows (but not after the
		// last one) to give the chat log the breathing room
		// bbl chat's transcript has — multi-line tool args and
		// wrapped assistant prose no longer run into the next
		// row. Skip the gap when the previous formatted row
		// already ends in a blank line (the source text had
		// its own paragraph break) so we don't produce a
		// double blank.
		if i < len(lines)-1 {
			last := rendered[len(rendered)-1]
			if last != "" && !strings.HasSuffix(last, "\n\n") {
				rendered = append(rendered, "")
			}
		}
	}
	return strings.Join(rendered, "\n")
}

func renderTranscriptItemCached(line *transcriptItem, width int) string {
	if line == nil {
		return ""
	}
	version := uint64(0)
	if line.Versioned != nil {
		version = line.Version()
	}
	return line.cache.GetOrCompute(width, version, func() string {
		return formatTranscriptItem(line, width)
	})
}

func formatTranscriptItem(line *transcriptItem, width int) string {
	if line == nil {
		return ""
	}
	view := ""
	if line.kind == "assistant" || line.kind == "thinking" {
		view = line.markdownCache.Render(line.kind, line.text, width)
	} else if line.kind == "tool_started" {
		if rendered := renderBashToolTranscriptItem(line, width); rendered != "" {
			view = rendered
		} else {
			view = formatLine(line.kind, line.text, width)
		}
	} else {
		view = formatLine(line.kind, line.text, width)
	}
	return line.renderHighlight(view)
}

func formatLine(kind string, text string, width int) string {
	// The bbl chat TS TUI renders user prompts, assistant /
	// thinking prose, and tool invocations as flat blocks
	// without a coloured label column:
	//   > <prompt>
	//     <2-space-indented assistant / thinking prose>
	//   ● ToolName(args) (ctrl+o to expand)
	// Mirroring that here keeps the chat log scannable instead
	// of forcing the eye to skip a label column for every row.
	switch kind {
	case "user", "user_message":
		bodyWidth := max(10, width-2)
		body := wrapPlain(text, bodyWidth)
		bodyLines := strings.Split(body, "\n")
		if len(bodyLines) == 0 {
			bodyLines = []string{""}
		}
		out := make([]string, 0, len(bodyLines))
		out = append(out, userStyle.Render("> ")+userStyle.Render(bodyLines[0]))
		for _, c := range bodyLines[1:] {
			// Preserve truly empty lines (paragraph breaks
			// from the source text) so the breathing-room
			// logic in renderTranscript can de-duplicate
			// them — without this, the empty line becomes
			// `  ` (2 spaces) and looks like a blank but
			// isn't recognised as one.
			if c == "" {
				out = append(out, "")
				continue
			}
			out = append(out, "  "+userStyle.Render(c))
		}
		return strings.Join(out, "\n")
	case "assistant", "thinking":
		return renderAssistantMarkdownText(kind, text, width)
	case "tool_started", "tool_denied":
		// Body starts with `● ToolName(...)` from
		// formatNexusEvent. Split the body into three visual
		// parts so each gets its own colour:
		//   `●`        → toolBulletStyle (sky blue, kind marker)
		//   ToolName   → toolStyle (warm orange #ff7a18, accent)
		//   `(args) (ctrl+o to expand)` → default foreground
		//   (no style), so the operator can read the path /
		//   pattern / command without straining through a
		//   saturated colour.
		// Fall back to the all-warm-orange render when the
		// body doesn't match the expected `● Name(` shape
		// (older events, custom tool names, etc.).
		bodyWidth := max(10, width)
		renderToolRow := func(line string) string {
			line = truncateToolTranscriptLine(line, bodyWidth)
			stripped := strings.TrimPrefix(line, "● ")
			if stripped == line || !strings.HasPrefix(line, "● ") {
				return toolStyle.Render(line)
			}
			open := strings.Index(stripped, "(")
			if open < 0 {
				return toolBulletStyle.Render("● ") + toolStyle.Render(stripped)
			}
			name := stripped[:open]
			rest := stripped[open:]
			return toolBulletStyle.Render("● ") + toolStyle.Render(name) + rest
		}
		return renderToolRow(singleLine(text))
	case "result":
		// result events emit just `done` (success) or
		// `failed: <message>` (failure) as body text. Use a
		// muted 2-space indent so it reads as a quiet
		// turn-end marker; the header's running indicator
		// has already flipped back to idle by the time the
		// transcript catches up.
		bodyWidth := max(10, width-2)
		body := wrapPlain(text, bodyWidth)
		bodyLines := strings.Split(body, "\n")
		if len(bodyLines) == 0 {
			bodyLines = []string{""}
		}
		style := mutedStyle
		if strings.HasPrefix(body, "failed") {
			style = errorStyle
		}
		out := make([]string, 0, len(bodyLines))
		out = append(out, "  "+style.Render(bodyLines[0]))
		for _, c := range bodyLines[1:] {
			if c == "" {
				out = append(out, "")
				continue
			}
			out = append(out, "  "+style.Render(c))
		}
		return strings.Join(out, "\n")
	}

	// Default label-style for status, error, hook, agent, task,
	// permission, result, etc. — kinds that still benefit from
	// a short coloured label so the operator can scan the kind
	// without reading the body.
	label, style := linePresentation(kind)
	prefix := style.Render(label)
	bodyWidth := max(10, width-lipgloss.Width(label)-1)
	body := wrapPlain(text, bodyWidth)
	bodyLines := strings.Split(body, "\n")
	if len(bodyLines) == 0 {
		bodyLines = []string{""}
	}

	out := make([]string, 0, len(bodyLines))
	out = append(out, prefix+" "+style.Render(bodyLines[0]))
	indent := strings.Repeat(" ", lipgloss.Width(label)+1)
	for _, continuation := range bodyLines[1:] {
		out = append(out, indent+style.Render(continuation))
	}
	return strings.Join(out, "\n")
}

func truncateToolTranscriptLine(text string, width int) string {
	text = singleLine(text)
	if lipgloss.Width(text) <= width {
		return text
	}
	hint := "  (ctrl+o to expand)"
	if strings.HasSuffix(text, hint) {
		prefix := strings.TrimSuffix(text, hint)
		hintWidth := lipgloss.Width(hint)
		if width > hintWidth+12 {
			return truncatePlainMiddle(prefix, width-hintWidth) + hint
		}
	}
	if strings.HasPrefix(text, "● ") {
		open := strings.Index(text, "(")
		closeIdx := strings.LastIndex(text, ")")
		if open > 0 && closeIdx > open {
			head := text[:open+1]
			tail := text[closeIdx:]
			budget := width - lipgloss.Width(head) - lipgloss.Width(tail)
			if budget > 6 {
				args := text[open+1 : closeIdx]
				return head + truncatePlainMiddle(args, budget) + tail
			}
		}
	}
	return truncatePlain(text, width)
}

func renderBashToolTranscriptItem(line *transcriptItem, width int) string {
	if line == nil || line.toolName != "Bash" {
		return ""
	}
	bodyWidth := max(20, width)
	command := firstNonEmpty(line.toolInput, strings.TrimPrefix(strings.TrimPrefix(line.text, "● Bash("), ")"))
	hint := "  (ctrl+o to expand)"
	statusHint := ""
	if line.toolStatus == "error" {
		statusHint = " failed"
	}
	headerBudget := max(8, bodyWidth-lipgloss.Width("● ")-lipgloss.Width("Bash")-1-lipgloss.Width(statusHint)-lipgloss.Width(hint))
	header := toolBulletStyle.Render("● ") +
		toolStyle.Render("Bash") +
		statusHint +
		" " +
		mutedStyle.Render(truncatePlain(command, headerBudget)) +
		mutedStyle.Render(hint)
	if line.toolOutput == "" {
		return header
	}
	return header + "\n" + renderBashOutputPreview(line.toolOutput, bodyWidth)
}

func renderBashOutputPreview(output string, width int) string {
	output = strings.TrimRight(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	if output == "" {
		return ""
	}
	lines := strings.Split(output, "\n")
	maxLines := 8
	hidden := 0
	if len(lines) > maxLines {
		hidden = len(lines) - maxLines
		lines = lines[:maxLines]
	}
	contentWidth := max(10, width-4)
	rowStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("245")).
		Background(lipgloss.Color("235")).
		Width(contentWidth)
	out := make([]string, 0, len(lines)+1)
	for _, raw := range lines {
		text := " " + strings.ReplaceAll(raw, "\t", "    ")
		out = append(out, "  "+rowStyle.Render(truncatePlain(text, contentWidth)))
	}
	if hidden > 0 {
		out = append(out, "  "+rowStyle.Render(truncatePlain(fmt.Sprintf(" ... (%d lines hidden) ctrl+o to expand", hidden), contentWidth)))
	}
	return strings.Join(out, "\n")
}

func linePresentation(kind string) (string, lipgloss.Style) {
	switch kind {
	case "assistant":
		return "assistant", assistantStyle
	case "thinking":
		return "thinking ", thinkingStyle
	case "tool_started":
		return "tool >   ", toolStyle
	case "tool_completed":
		return "tool ok  ", toolStyle
	case "tool_denied":
		return "tool no  ", toolStyle
	case "hook_started":
		return "hook >   ", mutedStyle
	case "hook_completed":
		return "hook ok  ", mutedStyle
	case "hook_failed":
		return "hook no  ", errorStyle
	case "task_created":
		return "task +   ", toolStyle
	case "task_session_event":
		return "task     ", toolStyle
	case "agent_job_event":
		return "agent    ", toolStyle
	case "user_message":
		return "you      ", userStyle
	case "user_intake_guidance":
		return "intake   ", mutedStyle
	case "compact_boundary":
		return "compact+ ", statusStyle
	case "context_compact_boundary":
		return "ctx cmp ", statusStyle
	case "context_recovery_attempted":
		return "ctx rec ", statusStyle
	case "context_grounding_required":
		return "ctx grd ", statusStyle
	case "context_grounding_confirmed":
		return "ctx ok  ", statusStyle
	case "workspace_dirty_detected":
		return "git dirty", statusStyle
	case "compact_failure":
		return "compact! ", errorStyle
	case "context_usage":
		return "ctx      ", mutedStyle
	case "context_microcompact":
		return "ctx mini ", mutedStyle
	case "context_warning":
		return "ctx warn ", statusStyle
	case "near_timeout_warning":
		return "timeout ", permissionStyle
	case "timeout_budget_exceeded":
		return "budget!  ", permissionStyle
	case "timeout_extension_granted":
		return "budget+ ", permissionStyle
	case "context_blocking":
		return "ctx stop ", errorStyle
	case "session_memory_updated":
		return "memory   ", mutedStyle
	case "execution_metrics":
		return "metrics  ", mutedStyle
	case "permission", "permission_request", "permission_response":
		return "permit   ", permissionStyle
	case "error":
		return "error    ", errorStyle
	case "user":
		return "you      ", userStyle
	case "session":
		return "session  ", mutedStyle
	case "status":
		return "status   ", mutedStyle
	default:
		if kind == "" {
			return "event    ", mutedStyle
		}
		return padRight(kind, 8), mutedStyle
	}
}

func formatExecuteSummary(event map[string]any) string {
	duration := anyInt(event["executeDurationMs"])
	timeoutMs := anyInt(event["timeoutMs"])
	outcome := firstNonEmpty(stringField(event, "outcome"), "unknown")
	near := event["nearTimeout"] == true
	budget := fmt.Sprintf("dur=%dms timeoutMs=%d", duration, timeoutMs)
	if timeoutMs > 0 {
		pct := duration * 100 / timeoutMs
		budget = fmt.Sprintf("dur=%dms/%dms (%d%%)", duration, timeoutMs, pct)
	}
	hint := ""
	if near {
		hint = " near-timeout"
	}
	return fmt.Sprintf("execute_summary outcome=%s%s %s", outcome, hint, budget)
}

func formatNexusEvent(event map[string]any) string {
	eventType := stringField(event, "type")
	switch eventType {
	case "session_started":
		return fmt.Sprintf("session %s model %s", shortID(stringField(event, "sessionId")), stringField(event, "model"))
	case "thinking_delta":
		return stringField(event, "text")
	case "tool_started":
		// Compact single-line form mirroring the bbl chat TS TUI:
		// "● ToolName(args) (ctrl+o to expand)". The args string
		// comes from formatToolInput so the most useful field
		// (path / pattern / command) is highlighted without the
		// caller scanning raw JSON.
		name := stringField(event, "name")
		args := formatToolInput(name, event["input"])
		return formatToolStartedText(name, args)
	case "tool_completed":
		// Kept here so formatNexusEvent remains callable from
		// tests / future renderers; consumeNexusEvent no longer
		// appends tool_completed to the transcript (the
		// compact tool_started row is the only chat line).
		return strings.TrimSpace(fmt.Sprintf(
			"%s done success=%v %s",
			stringField(event, "name"),
			event["success"],
			summarizeToolOutput(event["output"]),
		))
	case "tool_denied":
		name := stringField(event, "name")
		args := formatToolInput(name, event["input"])
		reason := firstNonEmpty(stringField(event, "message"), stringField(event, "reason"))
		if boolField(event, "recoverable") {
			return fmt.Sprintf("● %s(%s)  blocked recoverable: %s", name, args, reason)
		}
		return fmt.Sprintf("● %s(%s)  denied: %s", name, args, reason)
	case "permission_request":
		return fmt.Sprintf("%s (%s risk)", stringField(event, "name"), stringField(event, "risk"))
	case "permission_response":
		return fmt.Sprintf("approved=%v reason=%s", event["approved"], stringField(event, "reason"))
	case "context_usage":
		return fmt.Sprintf("context usage %d%% tokens=%d/%d", anyInt(event["percentUsed"]), anyInt(event["tokenEstimate"]), anyInt(event["maxTokens"]))
	case "context_microcompact":
		return fmt.Sprintf("context microcompact saved≈%d tokens events=%d dedup=%d", anyInt(event["estimatedTokensSaved"]), anyInt(event["compactedEventCount"]), anyInt(event["deduplicatedToolResultCount"]))
	case "context_compact_boundary":
		return fmt.Sprintf("context compact boundary trigger=%s before=%d after=%d retained=%d tail=%s", stringField(event, "trigger"), anyInt(event["beforeEventCount"]), anyInt(event["afterEventCount"]), anyInt(event["retainedEventCount"]), firstNonEmpty(stringField(event, "preservedTailEventId"), "n/a"))
	case "context_recovery_attempted":
		postTokens := anyInt(event["postTokens"])
		tokens := fmt.Sprintf("tokens=%d", anyInt(event["preTokens"]))
		if postTokens > 0 {
			tokens = fmt.Sprintf("tokens=%d->%d", anyInt(event["preTokens"]), postTokens)
		}
		return fmt.Sprintf("context recovery %d/%d strategy=%s %s retryable=%v", anyInt(event["attempt"]), anyInt(event["maxAttempts"]), stringField(event, "strategy"), tokens, event["retryable"])
	case "context_grounding_required":
		return fmt.Sprintf("context grounding required source=%s state=%s actions=%s", stringField(event, "source"), stringField(event, "state"), stringSliceField(event, "suggestedActions"))
	case "context_grounding_confirmed":
		return fmt.Sprintf("context grounding confirmed kind=%s tool=%s for=%s", stringField(event, "confirmationKind"), stringField(event, "toolName"), stringSliceField(event, "confirmedFor"))
	case "workspace_dirty_detected":
		return fmt.Sprintf("workspace dirty source=%s changed=%d files=%s", stringField(event, "source"), anyInt(event["changedFileCount"]), stringSliceField(event, "changedFiles"))
	case "context_warning", "context_blocking":
		return fmt.Sprintf("%s tokens=%v max=%v", eventType, event["tokenEstimate"], event["maxTokens"])
	case "near_timeout_warning":
		return fmt.Sprintf("near timeout elapsed=%dms/%dms %s", anyInt(event["elapsedMs"]), anyInt(event["timeoutMs"]), stringField(event, "message"))
	case "timeout_budget_exceeded":
		// Phase 2 of task-adaptive-recoverable-timeout: soft budget
		// reached but workflow keeps running (hard watchdog still
		// armed). Render as a budget/status row so the operator
		// can see the model just got a recoverable signal — not a
		// fatal cutoff. Mirrors the near_timeout_warning shape so
		// the transcript stays readable.
		suggested := ""
		if actions, ok := event["suggestedActions"].([]any); ok && len(actions) > 0 {
			parts := make([]string, 0, len(actions))
			for _, action := range actions {
				if s, ok := action.(string); ok && s != "" {
					parts = append(parts, s)
				}
			}
			if len(parts) > 0 {
				suggested = " suggested=" + strings.Join(parts, ",")
			}
		}
		return fmt.Sprintf(
			"soft timeout budget reached elapsed=%dms/%dms (policy=%s)%s %s",
			anyInt(event["elapsedMs"]),
			anyInt(event["timeoutMs"]),
			firstNonEmpty(stringField(event, "policy"), "soft"),
			suggested,
			stringField(event, "message"),
		)
	case "timeout_extension_granted":
		// Phase 3 of task-adaptive-recoverable-timeout: announce
		// that the runtime auto-granted an extension after the
		// previous soft-budget exhaustion. Reads the new running
		// soft budget (totalSoftBudgetMs), the extension index out
		// of the max, the delta (additionalMs), and the reason so
		// the operator can see this is the model's recovery
		// window, not a fatal cutoff.
		return fmt.Sprintf(
			"soft timeout extension granted +%dms (extension %d/%d total=%dms reason=%s) elapsed=%dms %s",
			anyInt(event["additionalMs"]),
			anyInt(event["extensionCount"]),
			anyInt(event["maxExtensions"]),
			anyInt(event["totalSoftBudgetMs"]),
			firstNonEmpty(stringField(event, "reason"), "auto"),
			anyInt(event["elapsedMs"]),
			stringField(event, "message"),
		)
	case "usage":
		return fmt.Sprintf("input=%v output=%v cacheRead=%v", event["inputTokens"], event["outputTokens"], event["cacheReadInputTokens"])
	case "hook_started":
		return fmt.Sprintf("%s %s%s started", stringField(event, "hookName"), stringField(event, "hookEvent"), formatOptionalToolName(event))
	case "hook_completed":
		return strings.TrimSpace(fmt.Sprintf(
			"%s %s%s %s",
			stringField(event, "hookName"),
			stringField(event, "hookEvent"),
			formatOptionalToolName(event),
			summarizeHookOutput(event["output"]),
		))
	case "hook_failed":
		return fmt.Sprintf("%s %s%s failed: %s", stringField(event, "hookName"), stringField(event, "hookEvent"), formatOptionalToolName(event), stringField(event, "message"))
	case "user_message":
		return truncatePlain(singleLine(stringField(event, "text")), 200)
	case "user_intake_guidance":
		return fmt.Sprintf("intent=%s requiresTools=%v reason=%s", stringField(event, "intent"), event["requiresTools"], stringField(event, "reason"))
	case "task_created":
		return fmt.Sprintf("id=%s title=%s", shortID(stringField(event, "taskId")), stringField(event, "title"))
	case "task_session_event":
		return fmt.Sprintf("eventType=%s phase=%s%s", stringField(event, "eventType"), stringField(event, "phase"), summarizeTaskSessionPayload(event["payload"]))
	case "agent_job_event":
		return fmt.Sprintf("eventType=%s jobId=%s status=%s agentType=%s", stringField(event, "eventType"), shortID(stringField(event, "jobId")), stringField(event, "status"), stringField(event, "agentType"))
	case "compact_boundary":
		return fmt.Sprintf("trigger=%s before=%d after=%d summary=%dchars snipped=%d", stringField(event, "trigger"), anyInt(event["beforeEventCount"]), anyInt(event["afterEventCount"]), anyInt(event["summaryChars"]), anyInt(event["snippedToolResults"]))
	case "compact_failure":
		return fmt.Sprintf("trigger=%s failures=%d/%d: %s", stringField(event, "trigger"), anyInt(event["failureCount"]), anyInt(event["maxFailures"]), stringField(event, "message"))
	case "session_memory_updated":
		return fmt.Sprintf("trigger=%s reason=%s chars=%d events=%d", stringField(event, "trigger"), firstNonEmpty(stringField(event, "reason"), "n/a"), anyInt(event["summaryChars"]), anyInt(event["eventCount"]))
	case "execution_metrics":
		return fmt.Sprintf("dur=%dms input=%d output=%d tools=%d firstToken=%dms", anyInt(event["executeDurationMs"]), anyInt(event["inputTokens"]), anyInt(event["outputTokens"]), anyInt(event["toolCallCount"]), anyInt(event["providerFirstTokenMs"]))
	case "execute_summary":
		return formatExecuteSummary(event)
	case "result":
		// On success: return empty so the consumeNexusEvent
		// result branch skips the append entirely (the header
		// already flipped from running back to idle, the
		// streaming deltas already produced the reply). On
		// failure: surface the message so the operator sees
		// why the turn ended with success=false.
		if event["success"] == false {
			return "failed: " + firstNonEmpty(stringField(event, "message"), stringField(event, "text"))
		}
		return ""
	case "error":
		code := stringField(event, "code")
		if hint, ok := friendlyNexusError(code, event); ok {
			return hint
		}
		return strings.TrimSpace(fmt.Sprintf("%s %s", code, stringField(event, "message")))
	default:
		return compactJSON(event)
	}
}

func formatOptionalToolName(event map[string]any) string {
	toolName := stringField(event, "toolName")
	if toolName == "" {
		return ""
	}
	return " " + toolName
}

func stringSliceField(event map[string]any, key string) string {
	value := event[key]
	switch typed := value.(type) {
	case []string:
		return strings.Join(typed, ",")
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok && text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, ",")
	default:
		return ""
	}
}

func formatToolStartedText(name, input string) string {
	return fmt.Sprintf("● %s(%s)  (ctrl+o to expand)", name, input)
}

func extractToolOutputText(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	output, ok := value.(map[string]any)
	if !ok {
		return singleLine(fmt.Sprintf("%v", value))
	}
	stdout := strings.TrimRight(stringAnyField(output, "stdout"), "\n")
	stderr := strings.TrimRight(stringAnyField(output, "stderr"), "\n")
	switch {
	case stdout != "" && stderr != "":
		return stdout + "\n" + stderr
	case stdout != "":
		return stdout
	case stderr != "":
		return stderr
	default:
		return ""
	}
}

func summarizeToolOutput(value any) string {
	if value == nil {
		return ""
	}
	if output, ok := value.(map[string]any); ok {
		parts := []string{}
		stdout := strings.TrimSpace(stringAnyField(output, "stdout"))
		stderr := strings.TrimSpace(stringAnyField(output, "stderr"))
		exitCode := output["exitCode"]
		if stdout != "" {
			parts = append(parts, `stdout="`+truncatePlain(singleLine(stdout), 80)+`"`)
		}
		if stderr != "" {
			parts = append(parts, `stderr="`+truncatePlain(singleLine(stderr), 80)+`"`)
		}
		if exitCode != nil {
			parts = append(parts, fmt.Sprintf("exitCode=%v", exitCode))
		}
		if len(parts) > 0 {
			return strings.Join(parts, " ")
		}
	}
	return compactJSON(value)
}

func summarizeHookOutput(value any) string {
	if value == nil {
		return ""
	}
	if output, ok := value.(map[string]any); ok {
		parts := []string{}
		if summary := strings.TrimSpace(stringAnyField(output, "summary")); summary != "" {
			parts = append(parts, truncatePlain(singleLine(summary), 100))
		}
		if decision, ok := output["permissionDecision"]; ok {
			parts = append(parts, fmt.Sprintf("decision=%v", decision))
		}
		if updatedInput, ok := output["updatedInput"]; ok {
			parts = append(parts, "updatedInput="+compactJSON(updatedInput))
		}
		if len(parts) > 0 {
			return strings.Join(parts, " ")
		}
	}
	return compactJSON(value)
}

func stringAnyField(value map[string]any, key string) string {
	raw, ok := value[key]
	if !ok || raw == nil {
		return ""
	}
	if text, ok := raw.(string); ok {
		return text
	}
	return fmt.Sprint(raw)
}

func singleLine(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func anyInt(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int32:
		return int(typed)
	case int64:
		return int(typed)
	case float32:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	default:
		return 0
	}
}

func summarizeTaskSessionPayload(payload any) string {
	if payload == nil {
		return ""
	}
	m, ok := payload.(map[string]any)
	if !ok {
		return ""
	}
	parts := []string{}
	if sub := stringAnyField(m, "subagent"); sub != "" {
		parts = append(parts, "subagent="+sub)
	}
	if subId := stringAnyField(m, "subSessionId"); subId != "" {
		parts = append(parts, "subSessionId="+shortID(subId))
	}
	if parent := stringAnyField(m, "parentTaskId"); parent != "" {
		parts = append(parts, "parentTaskId="+parent)
	}
	if depth := m["depth"]; depth != nil {
		parts = append(parts, fmt.Sprintf("depth=%d", anyInt(depth)))
	}
	if status := stringAnyField(m, "status"); status != "" {
		parts = append(parts, "status="+status)
	}
	if len(parts) == 0 {
		return ""
	}
	return " " + strings.Join(parts, " ")
}

// formatToolInput returns a one-line preview of the most relevant
// field for a permission_request payload. The TUI needs this so the
// user can see what they are about to approve.
func formatToolInput(name string, input any) string {
	if input == nil {
		return ""
	}
	m, ok := input.(map[string]any)
	if !ok {
		return singleLine(truncatePlain(fmt.Sprintf("%v", input), 120))
	}
	switch name {
	case "Bash":
		if cmd := stringAnyField(m, "command"); cmd != "" {
			return singleLine(truncatePlain(cmd, 120))
		}
	case "Read", "Write", "Edit":
		if path := stringAnyField(m, "path"); path != "" {
			return path
		}
	case "Grep":
		if pattern := stringAnyField(m, "pattern"); pattern != "" {
			return "pattern=" + pattern
		}
	case "Glob":
		if pattern := stringAnyField(m, "pattern"); pattern != "" {
			return "pattern=" + pattern
		}
	case "ListDir":
		if path := stringAnyField(m, "path"); path != "" {
			return path
		}
	case "TaskCreate":
		if title := stringAnyField(m, "title"); title != "" {
			return "title=" + title
		}
	}
	return singleLine(truncatePlain(compactJSON(input), 120))
}
