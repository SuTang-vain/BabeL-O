package tui

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
)

func (m model) renderHeader(width int) string {
	// Header chrome: a quiet guard divider first, then title + run
	// state. Rendering the title below the first row keeps it visible
	// in terminals that clip the very top scanline/row.
	title := titleStyle.Render("BabeL-O · Go TUI")
	if m.connected {
		title = title + " " + statusStyle.Render("✓")
	}
	stateLabel := "idle"
	stateKind := stateStyle(false, nil)
	if m.running {
		// Surface a separate "thinking" state when the model
		// is in its reasoning phase (last event was a
		// thinking_delta) so the operator can tell at a
		// glance that the spinner is for reasoning, not for
		// the final reply. Mirrors the `✻ Sautéed for 26s`
		// pattern in Claude Code: a transient state pill
		// that shows what's actually happening plus the
		// elapsed time so the operator can sanity-check
		// that the reasoning phase is making progress.
		elapsed := ""
		if !m.startedAt.IsZero() {
			elapsed = " " + time.Since(m.startedAt).Round(time.Second).String()
		}
		if m.lastEventType == "thinking_delta" {
			stateLabel = m.spinner.View() + " thinking" + elapsed
			stateKind = thinkingStyle
		} else {
			stateLabel = m.spinner.View() + " running" + elapsed
			stateKind = statusStyle
		}
	}
	if m.pending != nil {
		stateLabel = "permission pending"
		stateKind = permissionStyle
	}
	state := stateKind.Render(stateLabel)
	accentWidth := max(1, min(9, width-lipgloss.Width(title)-lipgloss.Width(state)-36))
	accent := renderHeaderAccent(accentWidth)
	context := m.formatContextUsageLabel()
	toggle := "ctrl+d open"
	if m.topCardOpen {
		toggle = "ctrl+d close"
	}
	metaParts := []string{}
	metaParts = append(metaParts, context, toggle)
	metaPlain := strings.Join(metaParts, " · ")
	stateWidth := lipgloss.Width(state)
	leftBudget := max(0, width-stateWidth-1)
	metaBudget := leftBudget - lipgloss.Width(title) - lipgloss.Width(accent) - 2
	if metaBudget < 0 {
		accentWidth = max(0, leftBudget-lipgloss.Width(title)-1)
		metaBudget = 0
	}
	accent = renderHeaderAccent(accentWidth)
	meta := mutedStyle.Render(truncatePlain(metaPlain, metaBudget))
	left := strings.TrimSpace(title + " " + accent + " " + meta)
	top := joinColumns(width, left, state)

	return strings.Join([]string{
		divider(width),
		top,
		divider(width),
	}, "\n")
}

func renderHeaderAccent(width int) string {
	switch {
	case width >= 9:
		return dividerStyle.Render("─── ") + topCardAccentStyle.Render("◆") + dividerStyle.Render(" ───")
	case width >= 7:
		return dividerStyle.Render("── ") + topCardAccentStyle.Render("◆") + dividerStyle.Render(" ──")
	case width >= 5:
		return dividerStyle.Render("─ ") + topCardAccentStyle.Render("◆") + dividerStyle.Render(" ─")
	case width >= 1:
		return topCardAccentStyle.Render("◆")
	default:
		return ""
	}
}

func (m model) renderTopCard(width int) string {
	if !m.topCardOpen {
		return ""
	}
	innerWidth := max(20, width-4)
	title := focusedLineStyle.Render(truncatePlain(firstNonEmpty(m.input.Value(), "Ready for the next turn"), innerWidth))
	modelLine := strings.TrimSpace(strings.Join([]string{
		firstNonEmpty(m.modelID, "model pending"),
		firstNonEmpty(m.providerID, "provider pending"),
		firstNonEmpty(m.activeProfile, "profile pending"),
	}, " · "))
	if m.sessionID != "" {
		modelLine += " · session " + shortID(m.sessionID)
	}
	usage := m.formatContextUsageDetail()
	columns := joinTopCardColumns(innerWidth,
		"MCPs", m.topCardMCPRows(),
		"Skills", []string{"reserved: runtime skills"},
		"Session to session", m.topCardSessionRows(),
		"Memory", []string{"reserved: memory"},
	)
	content := strings.Join([]string{
		title,
		mutedStyle.Render(truncatePlain(modelLine, innerWidth)),
		statusStyle.Render(truncatePlain(usage, innerWidth)),
		"",
		columns,
		mutedStyle.Render(truncatePlain("ctrl+d close · /tools audit · /context inspect", innerWidth)),
	}, "\n")
	frameWidth := max(0, width-2)
	frame := topCardFrameStyle.Width(frameWidth)
	if m.height > 0 {
		available := m.height - lipgloss.Height(m.renderHeader(width)) - lipgloss.Height(m.renderFooter(width))
		if available > lipgloss.Height(content)+2 {
			frame = frame.Height(available)
		}
	}
	return frame.Render(content)
}

func (m model) formatContextUsageLabel() string {
	if c := m.contextUsage; c != nil {
		if c.PercentUsed > 0 || c.TokenEstimate > 0 || c.MaxTokens > 0 {
			if c.PercentUsed > 0 {
				return fmt.Sprintf("context %d%%", clamp(c.PercentUsed, 0, 999))
			}
			if c.MaxTokens > 0 {
				percent := clamp((c.TokenEstimate*100+c.MaxTokens/2)/c.MaxTokens, 0, 999)
				return fmt.Sprintf("context %d%%", percent)
			}
			return fmt.Sprintf("context %s", formatTokenCount(c.TokenEstimate))
		}
	}
	used, _, maxTokens := m.contextUsageFromUsageSnapshot()
	if used <= 0 && maxTokens <= 0 {
		return "context --"
	}
	if maxTokens <= 0 {
		return fmt.Sprintf("context %s", formatTokenCount(used))
	}
	percent := clamp((used*100+maxTokens/2)/maxTokens, 0, 999)
	return fmt.Sprintf("context %d%%", percent)
}

func (m model) formatContextUsageDetail() string {
	if c := m.contextUsage; c != nil {
		used := c.TokenEstimate
		maxTokens := c.MaxTokens
		if used <= 0 && c.PercentUsed > 0 && maxTokens > 0 {
			used = maxTokens * c.PercentUsed / 100
		}
		if maxTokens <= 0 {
			if used > 0 {
				return fmt.Sprintf("context: %s input", formatTokenCount(used))
			}
			return "context: waiting for usage snapshot"
		}
		percent := c.PercentUsed
		if percent <= 0 && used > 0 {
			percent = clamp((used*100+maxTokens/2)/maxTokens, 0, 999)
		}
		remaining := max(0, maxTokens-used)
		detail := fmt.Sprintf("context: %s / %s used · %d%% · %s remaining",
			formatTokenCount(used), formatTokenCount(maxTokens), clamp(percent, 0, 999), formatTokenCount(remaining))
		if c.PolicySource != "" {
			detail += " · " + c.PolicySource
		}
		return detail
	}
	used, cache, maxTokens := m.contextUsageFromUsageSnapshot()
	if used <= 0 && maxTokens <= 0 {
		return "context: waiting for usage snapshot"
	}
	if maxTokens <= 0 {
		if cache > 0 {
			return fmt.Sprintf("context: %s input · %s cache", formatTokenCount(used), formatTokenCount(cache))
		}
		return fmt.Sprintf("context: %s input", formatTokenCount(used))
	}
	percent := clamp((used*100+maxTokens/2)/maxTokens, 0, 999)
	remaining := max(0, maxTokens-used)
	detail := fmt.Sprintf("context: %s / %s used · %d%% · %s remaining",
		formatTokenCount(used), formatTokenCount(maxTokens), percent, formatTokenCount(remaining))
	if cache > 0 {
		detail += " · " + formatTokenCount(cache) + " cache"
	}
	return detail
}

func (m model) contextUsageFromUsageSnapshot() (int, int, int) {
	var usage *usageSnapshot
	if m.latestUsage != nil && m.latestUsage.InputTokens > 0 {
		usage = m.latestUsage
	} else if m.lastUsage != nil && m.lastUsage.InputTokens > 0 {
		usage = m.lastUsage
	}
	if usage == nil {
		return 0, 0, m.contextWindow
	}
	return usage.InputTokens, usage.CacheRead, m.contextWindow
}

func (m model) topCardMCPRows() []string {
	servers := map[string]int{}
	for _, entry := range m.toolAuditEntries {
		if entry.Source == nil || entry.Source.Type != toolSourceMCP {
			continue
		}
		server := strings.TrimSpace(entry.Source.ServerName)
		if server == "" {
			server = "mcp"
		}
		servers[server]++
	}
	if len(servers) == 0 {
		return []string{"none detected"}
	}
	names := make([]string, 0, len(servers))
	for server := range servers {
		names = append(names, server)
	}
	sort.Strings(names)
	rows := make([]string, 0, min(len(names), 3))
	for _, server := range names {
		rows = append(rows, fmt.Sprintf("● %s (%d)", server, servers[server]))
		if len(rows) == 3 {
			break
		}
	}
	if remaining := len(names) - len(rows); remaining > 0 {
		rows = append(rows, fmt.Sprintf("+%d more", remaining))
	}
	return rows
}

func (m model) topCardSessionRows() []string {
	rows := []string{}
	if m.sessionID != "" {
		rows = append(rows, "session "+shortID(m.sessionID))
	}
	unread := 0
	for _, message := range m.inboxMessages {
		if message.Status != messageStatusAcknowledged {
			unread++
		}
	}
	if len(m.inboxMessages) > 0 {
		rows = append(rows, fmt.Sprintf("inbox %d unread / %d total", unread, len(m.inboxMessages)))
	}
	if len(m.inboxChannels) > 0 {
		rows = append(rows, fmt.Sprintf("channels %d", len(m.inboxChannels)))
	}
	if len(rows) == 0 {
		rows = append(rows, "reserved for session links")
	}
	return rows
}

func (m model) renderInput(width int) string {
	// The /model multi-step flow renders its own inline
	// input box inside the overlay (apiKey + baseURL steps);
	// hide the bottom prompt row to avoid two visible
	// input boxes stacked on top of each other. The
	// provider / picker steps also have no input.
	//
	// Round 2: the permission inline editors
	// (modePermissionEditRule / modePermissionEditFeedback)
	// also render their own prompt inside the overlay so
	// the operator sees one coherent editor panel rather
	// than two stacked input boxes.
	if m.inputMode == modeModelPickProvider ||
		m.inputMode == modeModelPickApiKey ||
		m.inputMode == modeModelPickBaseURL ||
		m.inputMode == modeModelPickModel ||
		m.inputMode == modeSessionInput ||
		m.inputMode == modePermissionEditRule ||
		m.inputMode == modePermissionEditFeedback {
		return divider(width) + "\n"
	}
	inputView := m.input.View()
	prompt := inputBlockStyle.Width(max(0, width)).Render(inputView)
	return strings.Join([]string{
		divider(width),
		prompt,
	}, "\n")
}

func (m model) renderComposerStack(width int) string {
	parts := []string{}
	if palette := m.renderSlashPalette(width); palette != "" {
		parts = append(parts, palette)
	}
	if sessionOverlay := m.renderSessionOverlay(width); sessionOverlay != "" {
		parts = append(parts, sessionOverlay)
	}
	if contextOverlay := m.renderContextOverlay(width); contextOverlay != "" {
		parts = append(parts, contextOverlay)
	}
	if wave := m.renderRuntimeWave(width); wave != "" {
		parts = append(parts, wave)
	}
	parts = append(parts, m.renderInput(width))
	return strings.Join(parts, "\n")
}

func (m model) renderRuntimeWave(width int) string {
	if !m.running {
		return ""
	}
	if m.inputMode == modeModelPickProvider ||
		m.inputMode == modeModelPickApiKey ||
		m.inputMode == modeModelPickBaseURL ||
		m.inputMode == modeModelPickModel ||
		m.inputMode == modeSessionInput ||
		m.inputMode == modePermissionEditRule ||
		m.inputMode == modePermissionEditFeedback {
		return ""
	}
	label, kind := m.runtimeAnimationState()
	available := max(0, width-lipgloss.Width(label)-2)
	waveWidth := clamp(available, 12, 36)
	if waveWidth > available {
		waveWidth = available
	}
	wave := m.gradientSpinner.LightBar(waveWidth, kind)
	if wave == "" {
		return statusStyle.Render(label)
	}
	return statusStyle.Render(label+" ") + wave
}

func (m model) runtimeAnimationState() (string, runtimeAnimationKind) {
	if m.pending != nil {
		return "  permission needed", runtimeAnimationPermission
	}
	switch m.lastEventType {
	case "thinking_delta":
		return "  agent thinking", runtimeAnimationThinking
	case "assistant_delta":
		return "  agent writing", runtimeAnimationResponding
	case "tool_started", "tool_completed", "tool_denied", "hook_started", "hook_completed", "hook_failed":
		return "  tool activity", runtimeAnimationTool
	case "permission_request":
		return "  permission needed", runtimeAnimationPermission
	default:
		return "  agent runtime", runtimeAnimationDefault
	}
}

func (m model) renderFooter(width int) string {
	// Row 1 follows Crush's status-bar shape: normal operation
	// shows compact keyboard help; transient info messages (like
	// clipboard copy success) temporarily replace that help.
	if msg := strings.TrimSpace(m.copyToastMessage); msg != "" && !m.copyToastShownAt.IsZero() {
		topRow := confirmStyle.Render(truncatePlain("✓ "+msg, width))
		if m.isCompact() {
			return topRow
		}
		if bottomRow := m.renderFooterSummary(width); bottomRow != "" {
			return topRow + "\n" + bottomRow
		}
		return topRow
	}

	hint := strings.Join([]string{
		"/ or ctrl+p commands",
		"ctrl+d panel",
		"ctrl+l models",
		"shift+enter newline",
		"ctrl+c quit",
		"? help",
	}, " · ")
	if m.running {
		hint = "waiting for Nexus events"
	}
	if m.pending != nil {
		hint = "permission decision required"
	}
	elapsed := ""
	if !m.startedAt.IsZero() && m.running {
		elapsed = fmt.Sprintf("  elapsed=%s", time.Since(m.startedAt).Round(time.Second))
	}
	topRow := footerStyle.Render(truncatePlain(
		"  "+strings.TrimSpace(strings.Join([]string{hint, strings.TrimSpace(elapsed)}, " ")), width))

	if bottomRow := m.renderFooterSummary(width); bottomRow != "" {
		return topRow + "\n" + bottomRow
	}
	return topRow
}

func (m model) renderFooterSummary(width int) string {
	// Row 2: side-channel summary — inbox / agents / usage.
	// Kept as a separate muted line so the keyboard hint on row 1
	// stays scannable. The latest usage snapshot is rendered
	// here as a transient counter (the `✻ Sautéed for 26s`
	// pattern): the line updates in place as new usage events
	// arrive, and disappears on result / error when the turn
	// ends.
	//
	// Phase A.4: compact mode (terminal < 120×30) drops this
	// row entirely to free vertical space for the transcript.
	var sideParts []string
	if !m.isCompact() {
		if inbox := formatInboxFooterStatus(m.sessionID, m.inboxMessages, m.inboxChannels); inbox != "" {
			sideParts = append(sideParts, inbox)
		}
		if subRunning := m.subAgentRunningCount(); subRunning > 0 {
			sideParts = append(sideParts, fmt.Sprintf("sub-agents running: %d", subRunning))
		}
		if m.contextUsage != nil {
			sideParts = append(sideParts, formatContextUsageFooter(m.contextUsage))
		}
		if m.latestUsage != nil {
			sideParts = append(sideParts, formatUsageFooter(m.latestUsage))
		}
		// Phase 4: surface soft-timeout cycle state next to the
		// usage counter so the operator sees the workflow is
		// past its soft budget but still running — until the
		// turn ends and the snapshot is cleared.
		if soft := formatSoftTimeoutFooter(m.softTimeoutState); soft != "" {
			sideParts = append(sideParts, soft)
		}
	}
	if len(sideParts) > 0 {
		return mutedStyle.Render(truncatePlain(strings.Join(sideParts, "  · "), width))
	}
	return ""
}
