package tui

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"charm.land/lipgloss/v2"
)

type contextEstimatePayload struct {
	TotalTokens          int `json:"totalTokens"`
	SystemPromptTokens   int `json:"systemPromptTokens"`
	ToolDefinitionTokens int `json:"toolDefinitionTokens"`
	MessageTokens        int `json:"messageTokens"`
}

type contextSectionsPayload struct {
	SystemPromptChars                       int  `json:"systemPromptChars"`
	ProjectMemoryChars                      int  `json:"projectMemoryChars"`
	SessionSummaryChars                     int  `json:"sessionSummaryChars"`
	ActiveSkillsChars                       int  `json:"activeSkillsChars"`
	MessageCount                            int  `json:"messageCount"`
	SelectedEventCount                      int  `json:"selectedEventCount"`
	OmittedEventCount                       int  `json:"omittedEventCount"`
	SnippedEventCount                       int  `json:"snippedEventCount"`
	MicrocompactedEventCount                int  `json:"microcompactedEventCount"`
	MicrocompactEstimatedTokensSaved        int  `json:"microcompactEstimatedTokensSaved"`
	MicrocompactDeduplicatedToolResultCount int  `json:"microcompactDeduplicatedToolResultCount"`
	MemoryTruncated                         bool `json:"memoryTruncated"`
	ToolDefinitionCount                     int  `json:"toolDefinitionCount"`
}

type contextUsageSegment struct {
	marker string
	label  string
	tokens int
}

// renderContextOverlay paints the multi-line context analysis
// (Phase 5 续). It is a read-only scrollable overlay, similar in
// shape to renderHelp: header + divider + clamped line window +
// bottom hint. Outside modeContextOverlay it returns "" so the
// View() parts list can splice it unconditionally.
func (m model) renderContextOverlay(width int) string {
	if m.inputMode != modeContextOverlay {
		return ""
	}
	if len(m.contextOverlayLines) == 0 {
		return ""
	}
	header := titleStyle.Render("Context")
	frameBudget := m.contextOverlayFrameBudget(width)
	contentBudget := max(0, frameBudget-2)
	bodyRows := max(0, contentBudget-3)
	if bodyRows == 0 && frameBudget == 0 {
		bodyRows = max(1, min(len(m.contextOverlayLines), 8))
	}
	maxScroll := max(0, len(m.contextOverlayLines)-max(1, bodyRows))
	if m.contextOverlayScroll > maxScroll {
		m.contextOverlayScroll = maxScroll
	}
	start := m.contextOverlayScroll
	innerWidth := max(10, width-4)
	bodyLines := []string{}
	if bodyRows > 0 {
		for i := start; i < len(m.contextOverlayLines) && len(bodyLines) < bodyRows; i++ {
			wrapped := strings.Split(wrapPlain(m.contextOverlayLines[i], innerWidth), "\n")
			for _, line := range wrapped {
				if len(bodyLines) >= bodyRows {
					break
				}
				bodyLines = append(bodyLines, line)
			}
		}
	}
	scrollHint := fmt.Sprintf("  scroll %d/%d", min(start+1, len(m.contextOverlayLines)), len(m.contextOverlayLines))
	footerHint := "  up/down/tab scroll  esc/enter/q close"
	plainLines := append(bodyLines, scrollHint, footerHint)
	content := strings.Join([]string{header, contextStyle.Render(strings.Join(plainLines, "\n"))}, "\n")
	return renderOverlayFrame(width, content)
}

func (m model) contextOverlayFrameBudget(width int) int {
	if m.height <= 0 {
		return 0
	}
	used := lipgloss.Height(m.renderHeader(width)) + 1
	return max(0, m.height-used)
}

// buildContextOverlayLines turns the raw /v1/sessions/:id/context
// payload into the line buffer that the contextOverlay renders. It
// pulls a stable subset of the diagnostics (sections, compact
// retention, long-term memory, scoped memory, session memory lite,
// auto compact, recovery, repeated tool inputs, working set paths)
// plus the top signals and recommendations. Unknown / missing
// fields are silently skipped so the line count stays bounded.
func buildContextOverlayLines(raw []byte) []string {
	var payload struct {
		Type      string `json:"type"`
		SessionID string `json:"sessionId"`
		Cwd       string `json:"cwd"`
		ModelID   string `json:"modelId"`
		Budget    struct {
			MaxTokens    int `json:"maxTokens"`
			LayerBudgets struct {
				System         int `json:"system"`
				Summary        int `json:"summary"`
				History        int `json:"history"`
				Memory         int `json:"memory"`
				ReservedOutput int `json:"reservedOutput"`
			} `json:"layerBudgets"`
		} `json:"budget"`
		Estimate contextEstimatePayload `json:"estimate"`
		Window   struct {
			MaxTokens              int `json:"maxTokens"`
			TokenEstimate          int `json:"tokenEstimate"`
			WarningThresholdTokens int `json:"warningThresholdTokens"`
			CompactThresholdTokens int `json:"compactThresholdTokens"`
			BlockingLimitTokens    int `json:"blockingLimitTokens"`
		} `json:"window"`
		Sections contextSectionsPayload `json:"sections"`
		Compact  struct {
			HasBoundary            bool   `json:"hasBoundary"`
			Trigger                string `json:"trigger"`
			SummaryChars           int    `json:"summaryChars"`
			RetainedEventCount     int    `json:"retainedEventCount"`
			RetainedSegmentValid   bool   `json:"retainedSegmentValid"`
			RetainedSegmentWarning string `json:"retainedSegmentWarning"`
			BeforeEventCount       int    `json:"beforeEventCount"`
			AfterEventCount        int    `json:"afterEventCount"`
		} `json:"compact"`
		Diagnostics struct {
			RemainingTokens         int `json:"remainingTokens"`
			RemainingPercent        int `json:"remainingPercent"`
			CompactRemainingTokens  int `json:"compactRemainingTokens"`
			BlockingRemainingTokens int `json:"blockingRemainingTokens"`
			UsageSummary            struct {
				InputTokens              int `json:"inputTokens"`
				OutputTokens             int `json:"outputTokens"`
				CacheReadInputTokens     int `json:"cacheReadInputTokens"`
				EstimatedReasoningTokens int `json:"estimatedReasoningTokens"`
			} `json:"usageSummary"`
			CacheEconomics struct {
				PolicySource               string `json:"policySource"`
				ModelContextWindow         int    `json:"modelContextWindow"`
				EffectiveContextCeiling    int    `json:"effectiveContextCeiling"`
				LegacyContextCeiling       int    `json:"legacyContextCeiling"`
				ReservedOutputTokens       int    `json:"reservedOutputTokens"`
				ProviderSafetyBufferTokens int    `json:"providerSafetyBufferTokens"`
				WarningThresholdPercent    int    `json:"warningThresholdPercent"`
				CompactThresholdPercent    int    `json:"compactThresholdPercent"`
				WarningThresholdTokens     int    `json:"warningThresholdTokens"`
				CompactThresholdTokens     int    `json:"compactThresholdTokens"`
				BlockingLimitTokens        int    `json:"blockingLimitTokens"`
				Reason                     string `json:"reason"`
			} `json:"cacheEconomics"`
			Visualization struct {
				Buckets []struct {
					Kind              string `json:"kind"`
					EstimatedTokens   int    `json:"estimatedTokens"`
					ItemCount         int    `json:"itemCount"`
					PercentOfEstimate int    `json:"percentOfEstimate"`
				} `json:"buckets"`
				TopItems []struct {
					Kind            string `json:"kind"`
					Label           string `json:"label"`
					EstimatedTokens int    `json:"estimatedTokens"`
					Source          string `json:"source"`
				} `json:"topItems"`
				NextThreshold struct {
					Name            string `json:"name"`
					ThresholdTokens int    `json:"thresholdTokens"`
					RemainingTokens int    `json:"remainingTokens"`
					Percent         int    `json:"percent"`
				} `json:"nextThreshold"`
				Grounding struct {
					State            string   `json:"state"`
					SummaryDerived   bool     `json:"summaryDerived"`
					DirtyWorkspace   bool     `json:"dirtyWorkspace"`
					ChangedFileCount int      `json:"changedFileCount"`
					ChangedFiles     []string `json:"changedFiles"`
					SuggestedActions []string `json:"suggestedActions"`
					Message          string   `json:"message"`
				} `json:"grounding"`
				Suggestions []string `json:"suggestions"`
			} `json:"visualization"`
			AutoCompact struct {
				ShouldCompact    bool `json:"shouldCompact"`
				ThresholdPercent int  `json:"thresholdPercent"`
				FuseOpen         bool `json:"fuseOpen"`
				FailureCount     int  `json:"failureCount"`
				FailureLimit     int  `json:"failureLimit"`
			} `json:"autoCompact"`
			LongTermMemory struct {
				Provider        string  `json:"provider"`
				Enabled         bool    `json:"enabled"`
				HitCount        int     `json:"hitCount"`
				InjectedChars   int     `json:"injectedChars"`
				BudgetChars     int     `json:"budgetChars"`
				Truncated       bool    `json:"truncated"`
				Scope           string  `json:"scope"`
				NamespaceID     string  `json:"namespaceId"`
				SearchLatencyMs float64 `json:"searchLatencyMs"`
				Error           string  `json:"error"`
			} `json:"longTermMemory"`
			ScopedMemory []struct {
				Scope         string `json:"scope"`
				Provider      string `json:"provider"`
				Enabled       bool   `json:"enabled"`
				HitCount      int    `json:"hitCount"`
				InjectedChars int    `json:"injectedChars"`
				BudgetChars   int    `json:"budgetChars"`
				Truncated     bool   `json:"truncated"`
				NamespaceID   string `json:"namespaceId"`
			} `json:"scopedMemory"`
			SessionMemoryLite struct {
				Enabled    bool `json:"enabled"`
				LastUpdate struct {
					Trigger      string `json:"trigger"`
					Reason       string `json:"reason"`
					SummaryChars int    `json:"summaryChars"`
					EventCount   int    `json:"eventCount"`
				} `json:"lastUpdate"`
				NextDecision struct {
					ShouldUpdate bool   `json:"shouldUpdate"`
					Reason       string `json:"reason"`
				} `json:"nextDecision"`
				CostPolicy struct {
					SummaryMode     string `json:"summaryMode"`
					MaxSummaryChars int    `json:"maxSummaryChars"`
				} `json:"costPolicy"`
			} `json:"sessionMemoryLite"`
			CompactRetention struct {
				HasBoundary            bool   `json:"hasBoundary"`
				RetainedEventCount     int    `json:"retainedEventCount"`
				RetainedSegmentValid   bool   `json:"retainedSegmentValid"`
				RetainedSegmentWarning string `json:"retainedSegmentWarning"`
				FallbackToFullHistory  bool   `json:"fallbackToFullHistory"`
			} `json:"compactRetention"`
			CompactTokenDelta struct {
				HasBoundary          bool `json:"hasBoundary"`
				BeforeEventCount     int  `json:"beforeEventCount"`
				AfterEventCount      int  `json:"afterEventCount"`
				EstimatedTokensSaved int  `json:"estimatedTokensSaved"`
			} `json:"compactTokenDelta"`
			ResumeRecovery struct {
				Active    bool   `json:"active"`
				Code      string `json:"code"`
				Message   string `json:"message"`
				Timestamp string `json:"timestamp"`
			} `json:"resumeRecovery"`
			WorkingSetPaths []struct {
				Path    string `json:"path"`
				Touches int    `json:"touches"`
			} `json:"workingSetPaths"`
			RepeatedToolInputs []struct {
				Name         string `json:"name"`
				Count        int    `json:"count"`
				InputPreview string `json:"inputPreview"`
			} `json:"repeatedToolInputs"`
			LargeToolResults []struct {
				Name         string `json:"name"`
				OutputChars  int    `json:"outputChars"`
				InputPreview string `json:"inputPreview"`
			} `json:"largeToolResults"`
		} `json:"diagnostics"`
		Diagnostic struct {
			Name            string          `json:"name"`
			Status          string          `json:"status"`
			Summary         string          `json:"summary"`
			Signals         []contextSignal `json:"signals"`
			Recommendations []string        `json:"recommendations"`
		} `json:"diagnostic"`
		Recommendations []string `json:"recommendations"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return []string{fmt.Sprintf("context overlay: decode failed: %v", err)}
	}
	lines := []string{}
	// Header.
	modelPart := strings.TrimSpace(payload.ModelID)
	if modelPart == "" {
		modelPart = "default"
	}
	usedTokens := payload.Estimate.TotalTokens
	if usedTokens <= 0 {
		usedTokens = payload.Window.TokenEstimate
	}
	maxTokens := firstPositive(payload.Window.MaxTokens, payload.Budget.MaxTokens)
	if usedTokens <= 0 && maxTokens > 0 && payload.Diagnostics.RemainingTokens > 0 {
		usedTokens = max(0, maxTokens-payload.Diagnostics.RemainingTokens)
	}
	availableTokens := max(0, maxTokens-usedTokens)
	compactThreshold := firstPositive(
		payload.Window.CompactThresholdTokens,
		payload.Diagnostics.CacheEconomics.CompactThresholdTokens,
	)
	compactBufferTokens := 0
	if compactThreshold > 0 && maxTokens > 0 {
		compactBufferTokens = max(0, maxTokens-compactThreshold)
	}
	freeTokens := max(0, availableTokens-compactBufferTokens)
	lines = append(lines, fmt.Sprintf("BABEL Context · %s · %s", shortID(payload.SessionID), contextModelName(modelPart)))
	if maxTokens > 0 {
		lines = append(lines, fmt.Sprintf("  current context %s/%s (%s) · available %s",
			formatTokenCount(usedTokens), formatTokenCount(maxTokens),
			formatContextPercent(usedTokens, maxTokens), formatTokenCount(availableTokens)))
		lines = append(lines, "  "+formatContextUsageBar(contextUsageSegments(payload.Estimate, payload.Sections, compactBufferTokens, freeTokens), maxTokens, 40))
	} else if s := strings.TrimSpace(payload.Diagnostic.Summary); s != "" {
		lines = append(lines, "  "+s)
	}
	lines = append(lines, "")
	lines = append(lines, "  Current context by source")
	segments := contextUsageSegments(payload.Estimate, payload.Sections, compactBufferTokens, freeTokens)
	if len(payload.Diagnostics.Visualization.Buckets) > 0 && contextSegmentsEmpty(segments) {
		for _, bucket := range payload.Diagnostics.Visualization.Buckets {
			lines = append(lines, fmt.Sprintf("    %s · %s · %d%% · items=%d",
				contextBucketLabel(bucket.Kind), formatTokenCount(bucket.EstimatedTokens),
				bucket.PercentOfEstimate, bucket.ItemCount))
		}
	} else {
		for _, segment := range segments {
			if segment.tokens <= 0 && segment.label != "Free space" {
				continue
			}
			lines = append(lines, fmt.Sprintf("    %s %s · %s · %s",
				segment.marker, segment.label, formatTokenCount(segment.tokens),
				formatContextPercent(segment.tokens, maxTokens)))
		}
	}
	lines = append(lines, "")
	lines = append(lines, "  Capacity")
	lines = append(lines, fmt.Sprintf("    remaining %s (%d%%)", formatTokenCount(payload.Diagnostics.RemainingTokens), payload.Diagnostics.RemainingPercent))
	if payload.Diagnostics.CompactRemainingTokens > 0 || payload.Diagnostics.BlockingRemainingTokens > 0 {
		lines = append(lines, fmt.Sprintf("    compact headroom %s · blocking headroom %s",
			formatTokenCount(payload.Diagnostics.CompactRemainingTokens),
			formatTokenCount(payload.Diagnostics.BlockingRemainingTokens)))
	}
	if compactBufferTokens > 0 || freeTokens > 0 {
		lines = append(lines, fmt.Sprintf("    autocompact buffer %s · free space %s",
			formatTokenCount(compactBufferTokens), formatTokenCount(freeTokens)))
	}
	// State.
	lines = append(lines, "")
	lines = append(lines, "  State")
	lines = append(lines, fmt.Sprintf("    assembled events selected=%d omitted=%d messages=%d",
		payload.Sections.SelectedEventCount, payload.Sections.OmittedEventCount, payload.Sections.MessageCount))
	compactState := "none"
	if payload.Compact.HasBoundary {
		compactState = fmt.Sprintf("yes · retained=%d", payload.Compact.RetainedEventCount)
	}
	recoveryState := "none"
	if payload.Diagnostics.ResumeRecovery.Active {
		recoveryState = payload.Diagnostics.ResumeRecovery.Code
	}
	lines = append(lines, fmt.Sprintf("    compact boundary %s · recovery boundary %s", compactState, recoveryState))
	threshold := payload.Diagnostics.Visualization.NextThreshold
	if threshold.Name != "" && threshold.Name != "none" {
		lines = append(lines, fmt.Sprintf("    next threshold %s · %s remaining · %d%%",
			threshold.Name, formatTokenCount(threshold.RemainingTokens), threshold.Percent))
	}
	// Summary + status.
	if status := strings.TrimSpace(payload.Diagnostic.Status); status != "" {
		lines = append(lines, fmt.Sprintf("  status: %s", status))
	}
	// Sections.
	if payload.Sections.MessageCount > 0 || payload.Sections.SelectedEventCount > 0 || payload.Sections.ToolDefinitionCount > 0 {
		lines = append(lines, "  sections:")
		lines = append(lines, fmt.Sprintf("    messages: %d (selected=%d omitted=%d snipped=%d microcompact=%d)",
			payload.Sections.MessageCount, payload.Sections.SelectedEventCount,
			payload.Sections.OmittedEventCount, payload.Sections.SnippedEventCount,
			payload.Sections.MicrocompactedEventCount))
		lines = append(lines, fmt.Sprintf("    chars: system=%s project-memory=%s session-summary=%s skills=%s",
			formatCharCount(payload.Sections.SystemPromptChars),
			formatCharCount(payload.Sections.ProjectMemoryChars),
			formatCharCount(payload.Sections.SessionSummaryChars),
			formatCharCount(payload.Sections.ActiveSkillsChars),
		))
		lines = append(lines, fmt.Sprintf("    tools visible: %d%s",
			payload.Sections.ToolDefinitionCount,
			ternary(payload.Sections.MemoryTruncated, " (memory truncated)", "")))
	}
	// Phase 6B visualization diagnostics.
	if buckets := payload.Diagnostics.Visualization.Buckets; len(buckets) > 0 {
		lines = append(lines, "  token buckets:")
		limit := len(buckets)
		if limit > 8 {
			limit = 8
		}
		for _, bucket := range buckets[:limit] {
			lines = append(lines, fmt.Sprintf("    %s=%d tokens (%d%%, items=%d)", bucket.Kind, bucket.EstimatedTokens, bucket.PercentOfEstimate, bucket.ItemCount))
		}
	}
	if topItems := payload.Diagnostics.Visualization.TopItems; len(topItems) > 0 {
		lines = append(lines, "  top context items:")
		limit := len(topItems)
		if limit > 5 {
			limit = 5
		}
		for _, item := range topItems[:limit] {
			lines = append(lines, fmt.Sprintf("    %s %d tokens · %s", item.Kind, item.EstimatedTokens, truncatePlain(item.Label, 72)))
		}
	}
	detailThreshold := payload.Diagnostics.Visualization.NextThreshold
	if detailThreshold.Name != "" {
		lines = append(lines, fmt.Sprintf("  next threshold: %s at %d tokens (%d%%), remaining=%d", detailThreshold.Name, detailThreshold.ThresholdTokens, detailThreshold.Percent, detailThreshold.RemainingTokens))
	}
	grounding := payload.Diagnostics.Visualization.Grounding
	if grounding.State != "" {
		parts := []string{fmt.Sprintf("state=%s", grounding.State)}
		if grounding.DirtyWorkspace {
			parts = append(parts, fmt.Sprintf("dirty files=%d", grounding.ChangedFileCount))
		}
		if len(grounding.ChangedFiles) > 0 {
			limit := len(grounding.ChangedFiles)
			if limit > 3 {
				limit = 3
			}
			parts = append(parts, "files="+strings.Join(grounding.ChangedFiles[:limit], ", "))
		}
		if len(grounding.SuggestedActions) > 0 {
			parts = append(parts, "actions="+strings.Join(grounding.SuggestedActions, ","))
		}
		lines = append(lines, "  grounding: "+strings.Join(parts, " · "))
	}
	if suggestions := payload.Diagnostics.Visualization.Suggestions; len(suggestions) > 0 {
		lines = append(lines, "  context suggestions:")
		limit := len(suggestions)
		if limit > 6 {
			limit = 6
		}
		for _, suggestion := range suggestions[:limit] {
			lines = append(lines, "    - "+strings.TrimSpace(suggestion))
		}
	}
	// Budget breakdown (only when populated).
	if lb := payload.Budget.LayerBudgets; lb.System+lb.Summary+lb.History+lb.Memory > 0 {
		lines = append(lines, "  budget layers (tokens):")
		lines = append(lines, fmt.Sprintf("    system=%d summary=%d history=%d memory=%d reserved-output=%d",
			lb.System, lb.Summary, lb.History, lb.Memory, lb.ReservedOutput))
	}
	// Compact retention + token delta.
	if payload.Diagnostics.CompactRetention.HasBoundary {
		validity := "valid"
		if !payload.Diagnostics.CompactRetention.RetainedSegmentValid {
			validity = "fallback"
		}
		warning := ""
		if w := strings.TrimSpace(payload.Diagnostics.CompactRetention.RetainedSegmentWarning); w != "" {
			warning = " · " + w
		}
		lines = append(lines, fmt.Sprintf("  compact retention: %s · events=%d%s",
			validity, payload.Diagnostics.CompactRetention.RetainedEventCount, warning))
	}
	if payload.Diagnostics.CompactTokenDelta.HasBoundary {
		lines = append(lines, fmt.Sprintf("  compact delta: events %d→%d · saved≈%d tokens",
			payload.Diagnostics.CompactTokenDelta.BeforeEventCount,
			payload.Diagnostics.CompactTokenDelta.AfterEventCount,
			payload.Diagnostics.CompactTokenDelta.EstimatedTokensSaved,
		))
	}
	// Auto compact.
	if payload.Diagnostics.AutoCompact.ShouldCompact {
		lines = append(lines, fmt.Sprintf("  auto compact: threshold reached at %d%%",
			payload.Diagnostics.AutoCompact.ThresholdPercent))
	}
	if payload.Diagnostics.AutoCompact.FuseOpen {
		lines = append(lines, fmt.Sprintf("  auto compact: fuse open after %d/%d failures",
			payload.Diagnostics.AutoCompact.FailureCount,
			payload.Diagnostics.AutoCompact.FailureLimit))
	}
	// Long-term memory.
	ltm := payload.Diagnostics.LongTermMemory
	ltmProvider := ltm.Provider
	if !ltm.Enabled || ltmProvider == "" {
		ltmProvider = "disabled"
	}
	ltmScopePart := ""
	if ltm.Scope != "" && ltm.Scope != "unknown" {
		ltmScopePart = fmt.Sprintf(" scope=%s%s", ltm.Scope,
			ternary(ltm.NamespaceID != "", " namespace="+ltm.NamespaceID, ""))
	}
	lines = append(lines, fmt.Sprintf("  long-term memory: %s%s · hits=%d injected=%s/%s",
		ltmProvider, ltmScopePart, ltm.HitCount,
		formatCharCount(ltm.InjectedChars), formatCharCount(ltm.BudgetChars)))
	if ltm.Truncated {
		lines = append(lines, "  long-term memory: truncated (budget pressure)")
	}
	if ltm.SearchLatencyMs > 0 {
		lines = append(lines, fmt.Sprintf("  long-term memory: search latency=%dms",
			int(ltm.SearchLatencyMs)))
	}
	if ltm.Error != "" {
		lines = append(lines, "  long-term memory: error="+ltm.Error)
	}
	// Scoped memory.
	for _, sm := range payload.Diagnostics.ScopedMemory {
		if sm.Scope == "unknown" {
			continue
		}
		provider := sm.Provider
		if !sm.Enabled || provider == "" {
			provider = "disabled"
		}
		lines = append(lines, fmt.Sprintf("  scoped memory: %s %s · hits=%d injected=%s/%s%s",
			sm.Scope, provider, sm.HitCount,
			formatCharCount(sm.InjectedChars), formatCharCount(sm.BudgetChars),
			ternary(sm.NamespaceID != "", " namespace="+sm.NamespaceID, "")))
	}
	// Session memory lite.
	sml := payload.Diagnostics.SessionMemoryLite
	if sml.Enabled || sml.LastUpdate.Trigger != "" {
		lastLine := "none"
		if sml.LastUpdate.Trigger != "" {
			lastLine = fmt.Sprintf("%s/%s events=%d summary=%s",
				sml.LastUpdate.Trigger,
				ternary(sml.LastUpdate.Reason == "", "unknown", sml.LastUpdate.Reason),
				sml.LastUpdate.EventCount,
				formatCharCount(sml.LastUpdate.SummaryChars))
		}
		lines = append(lines, fmt.Sprintf("  session memory lite: enabled=%v last=%s next=%s policy=%s",
			sml.Enabled, lastLine,
			ternary(sml.NextDecision.ShouldUpdate, "update", "skip")+"·"+sml.NextDecision.Reason,
			sml.CostPolicy.SummaryMode))
	}
	// Resume recovery.
	if payload.Diagnostics.ResumeRecovery.Active {
		lines = append(lines, fmt.Sprintf("  resume recovery: %s · %s",
			payload.Diagnostics.ResumeRecovery.Code,
			payload.Diagnostics.ResumeRecovery.Message))
	}
	// Working set paths.
	if len(payload.Diagnostics.WorkingSetPaths) > 0 {
		parts := []string{}
		limit := len(payload.Diagnostics.WorkingSetPaths)
		if limit > 3 {
			limit = 3
		}
		for _, entry := range payload.Diagnostics.WorkingSetPaths[:limit] {
			parts = append(parts, fmt.Sprintf("%s×%d", entry.Path, entry.Touches))
		}
		lines = append(lines, "  working set paths: "+strings.Join(parts, ", "))
	}
	// Repeated tool inputs.
	if len(payload.Diagnostics.RepeatedToolInputs) > 0 {
		limit := len(payload.Diagnostics.RepeatedToolInputs)
		if limit > 2 {
			limit = 2
		}
		for _, entry := range payload.Diagnostics.RepeatedToolInputs[:limit] {
			lines = append(lines, fmt.Sprintf("  repeated tool input: %s ×%d · %s",
				entry.Name, entry.Count, entry.InputPreview))
		}
	}
	// Large tool results.
	if len(payload.Diagnostics.LargeToolResults) > 0 {
		limit := len(payload.Diagnostics.LargeToolResults)
		if limit > 2 {
			limit = 2
		}
		for _, entry := range payload.Diagnostics.LargeToolResults[:limit] {
			lines = append(lines, fmt.Sprintf("  large tool result: %s %s · %s",
				entry.Name, formatCharCount(entry.OutputChars), entry.InputPreview))
		}
	}
	// Signals.
	if signals := payload.Diagnostic.Signals; len(signals) > 0 {
		lines = append(lines, "  signals:")
		limit := len(signals)
		if limit > 5 {
			limit = 5
		}
		for _, sig := range signals[:limit] {
			level := strings.TrimSpace(sig.Level)
			if level == "" {
				level = "info"
			}
			lines = append(lines, fmt.Sprintf("    [%s] %s %s",
				level, strings.TrimSpace(sig.Code), strings.TrimSpace(sig.Message)))
		}
		if len(signals) > 5 {
			lines = append(lines, fmt.Sprintf("    ... +%d more", len(signals)-5))
		}
	}
	// Recommendations.
	if recs := payload.Diagnostic.Recommendations; len(recs) > 0 {
		lines = append(lines, "  recommendations:")
		limit := len(recs)
		if limit > 5 {
			limit = 5
		}
		for _, rec := range recs[:limit] {
			lines = append(lines, "    - "+strings.TrimSpace(rec))
		}
		if len(recs) > 5 {
			lines = append(lines, fmt.Sprintf("    ... +%d more", len(recs)-5))
		}
	}
	return lines
}

// ternary is a small inline helper to keep the buildContextOverlayLines
// body readable when picking between two short strings.
func ternary(cond bool, whenTrue, whenFalse string) string {
	if cond {
		return whenTrue
	}
	return whenFalse
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func contextModelName(modelID string) string {
	parts := strings.Split(modelID, "/")
	if len(parts) > 1 && strings.TrimSpace(parts[len(parts)-1]) != "" {
		return parts[len(parts)-1]
	}
	return modelID
}

func formatContextPercent(tokens int, maxTokens int) string {
	if maxTokens <= 0 {
		return "--"
	}
	percent := float64(max(0, tokens)) / float64(maxTokens) * 100
	if percent >= 10 {
		return fmt.Sprintf("%.0f%%", percent)
	}
	return fmt.Sprintf("%.1f%%", percent)
}

func contextUsageSegments(estimate contextEstimatePayload, sections contextSectionsPayload, compactBufferTokens int, freeTokens int) []contextUsageSegment {
	activeSkillsTokens := max(0, (sections.ActiveSkillsChars+3)/4)
	systemPromptTokens := max(0, estimate.SystemPromptTokens-activeSkillsTokens)
	return []contextUsageSegment{
		{marker: "S", label: "System prompt", tokens: systemPromptTokens},
		{marker: "T", label: "System tools", tokens: estimate.ToolDefinitionTokens},
		{marker: "K", label: "Skills", tokens: activeSkillsTokens},
		{marker: "M", label: "Messages", tokens: estimate.MessageTokens},
		{marker: "~", label: "Autocompact buffer", tokens: compactBufferTokens},
		{marker: ".", label: "Free space", tokens: freeTokens},
	}
}

func contextSegmentsEmpty(segments []contextUsageSegment) bool {
	for _, segment := range segments {
		if segment.tokens > 0 && segment.label != "Free space" && segment.label != "Autocompact buffer" {
			return false
		}
	}
	return true
}

func formatContextUsageBar(segments []contextUsageSegment, maxTokens int, width int) string {
	if maxTokens <= 0 || width <= 0 {
		return ""
	}
	counts := make([]int, len(segments))
	used := 0
	for i, segment := range segments {
		if segment.tokens <= 0 {
			continue
		}
		count := segment.tokens * width / maxTokens
		if count == 0 {
			count = 1
		}
		counts[i] = count
		used += count
	}
	for used > width {
		for i := len(counts) - 1; i >= 0 && used > width; i-- {
			if counts[i] > 0 {
				counts[i]--
				used--
			}
		}
	}
	var b strings.Builder
	b.WriteString("[")
	for i, segment := range segments {
		marker := segment.marker
		if marker == "" {
			marker = "■"
		}
		b.WriteString(strings.Repeat(marker, counts[i]))
	}
	if used < width {
		b.WriteString(strings.Repeat(" ", width-used))
	}
	b.WriteString("]")
	return b.String()
}

func contextBucketLabel(kind string) string {
	kind = strings.TrimSpace(strings.ReplaceAll(kind, "_", " "))
	if kind == "" {
		return "Context"
	}
	return strings.Title(kind)
}

func formatRuntimeConfig(config runtimeConfig) string {
	auth := "auth=missing"
	if config.HasAPIKey {
		auth = "auth=configured(" + firstNonEmpty(config.APIKeySource, "unknown") + ")"
	}
	profile := firstNonEmpty(config.ActiveProfile, "none")
	prefix := "config"
	if config.Version > 0 {
		prefix = fmt.Sprintf("config v=%d", config.Version)
	}
	return fmt.Sprintf(
		"%s model=%s provider=%s profile=%s %s context=%d",
		prefix,
		firstNonEmpty(config.ModelID, "unknown"),
		firstNonEmpty(config.ProviderID, "unknown"),
		profile,
		auth,
		config.ContextWindow,
	)
}

func formatRuntimeProfiles(response runtimeProfilesResponse) string {
	prefix := "profiles"
	if response.Version > 0 {
		prefix = fmt.Sprintf("profiles v=%d", response.Version)
	}
	lines := []string{}
	if len(response.Profiles) == 0 {
		lines = append(lines, prefix+": none")
	} else {
		parts := make([]string, 0, len(response.Profiles))
		for _, profile := range response.Profiles {
			name := profile.Name
			if profile.Active {
				name = "*" + name
			}
			model := firstNonEmpty(profile.Model, "default")
			parts = append(parts, fmt.Sprintf("%s=%s", name, model))
		}
		lines = append(lines, prefix+": "+strings.Join(parts, ", "))
	}
	if len(response.Tombstones) > 0 {
		lines = append(lines, fmt.Sprintf("tombstones (%d):", len(response.Tombstones)))
		// Stable ordering by name for human-friendly output.
		names := make([]string, 0, len(response.Tombstones))
		for name := range response.Tombstones {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			t := response.Tombstones[name]
			lines = append(lines, fmt.Sprintf("  %s [tombstoned] deletedAt=%s", name, firstNonEmpty(t.DeletedAt, "?")))
		}
	}
	return strings.Join(lines, "\n")
}

// contextAnalysisDiagnostic mirrors the stable top-level envelope
// from analyzeContext. The Go TUI only renders these fields — the
// rest of the payload is opaque by design.
type contextAnalysisDiagnostic struct {
	Name            string          `json:"name"`
	Status          string          `json:"status"`
	Summary         string          `json:"summary"`
	Signals         []contextSignal `json:"signals"`
	Recommendations []string        `json:"recommendations"`
}

type contextSignal struct {
	Level   string `json:"level"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// formatContextAnalysis turns the raw /v1/sessions/:id/context
// payload into a compact transcript block. The Go TUI keeps this
// small by design: full diagnostics are 200+ lines on a busy
// session, so we surface the summary + status + top 3 signals +
// top 3 recommendations and leave the rest to a future richer
// renderer (e.g. a contextOverlay).
func formatContextAnalysis(raw []byte) string {
	var top struct {
		Type          string                    `json:"type"`
		SessionID     string                    `json:"sessionId"`
		ModelID       string                    `json:"modelId"`
		Diagnostic    contextAnalysisDiagnostic `json:"diagnostic"`
		CompactHasBnd bool                      `json:"-"` // see below
	}
	// We decode the compact.hasBoundary separately because it lives
	// under payload.compact.hasBoundary, not at the top level.
	var compactBlock struct {
		Compact struct {
			HasBoundary bool `json:"hasBoundary"`
		} `json:"compact"`
	}
	if err := json.Unmarshal(raw, &top); err != nil {
		return fmt.Sprintf("context: decode failed: %v", err)
	}
	if err := json.Unmarshal(raw, &compactBlock); err != nil {
		return fmt.Sprintf("context: decode failed: %v", err)
	}
	lines := []string{}
	headerLabel := "context_analysis"
	if model := strings.TrimSpace(top.ModelID); model != "" {
		headerLabel = fmt.Sprintf("context_analysis model=%s", model)
	}
	lines = append(lines, headerLabel)
	if s := strings.TrimSpace(top.Diagnostic.Summary); s != "" {
		lines = append(lines, "  "+s)
	}
	if status := strings.TrimSpace(top.Diagnostic.Status); status != "" {
		lines = append(lines, fmt.Sprintf("  status: %s", status))
	}
	if compactBlock.Compact.HasBoundary {
		lines = append(lines, "  compact: boundary present (post-compact state retained)")
	}
	if signals := top.Diagnostic.Signals; len(signals) > 0 {
		lines = append(lines, "  signals:")
		limit := len(signals)
		if limit > 3 {
			limit = 3
		}
		for _, sig := range signals[:limit] {
			level := strings.TrimSpace(sig.Level)
			if level == "" {
				level = "info"
			}
			lines = append(lines, fmt.Sprintf("    [%s] %s %s",
				level, strings.TrimSpace(sig.Code), strings.TrimSpace(sig.Message)))
		}
		if len(signals) > 3 {
			lines = append(lines, fmt.Sprintf("    ... +%d more", len(signals)-3))
		}
	}
	if recs := top.Diagnostic.Recommendations; len(recs) > 0 {
		lines = append(lines, "  recommendations:")
		limit := len(recs)
		if limit > 3 {
			limit = 3
		}
		for _, rec := range recs[:limit] {
			lines = append(lines, "    - "+strings.TrimSpace(rec))
		}
		if len(recs) > 3 {
			lines = append(lines, fmt.Sprintf("    ... +%d more", len(recs)-3))
		}
	}
	return strings.Join(lines, "\n")
}

// formatCompactResult turns the raw /v1/sessions/:id/compact
// payload into a compact post-compact summary. The Go TUI keeps
// this short — the full retained segment / snipped tool results
// breakdown lives in the response payload and the chat TUI's
// contextView; we surface the most actionable numbers plus the
// boundary event metadata so the user can verify the compact
// actually fired.
func formatCompactResult(raw []byte) string {
	var payload struct {
		Type             string `json:"type"`
		BeforeEventCount int    `json:"beforeEventCount"`
		AfterEventCount  int    `json:"afterEventCount"`
		Event            struct {
			Type               string `json:"type"`
			Code               string `json:"code"`
			Trigger            string `json:"trigger"`
			Summary            string `json:"summary"`
			SummaryChars       int    `json:"summaryChars"`
			SnippedToolResults int    `json:"snippedToolResults"`
			RetainedEvents     []struct {
				Type string `json:"type"`
			} `json:"retainedEvents"`
			RetainedSegment struct {
				Status             string `json:"status"`
				RetainedEventCount int    `json:"retainedEventCount"`
				Warning            string `json:"warning"`
			} `json:"retainedSegment"`
			Budget struct {
				LayerBudgets struct {
					System  int `json:"system"`
					Summary int `json:"summary"`
					History int `json:"history"`
					Memory  int `json:"memory"`
				} `json:"layerBudgets"`
			} `json:"budget"`
		} `json:"event"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Sprintf("compact: decode failed: %v", err)
	}
	lines := []string{
		fmt.Sprintf("compact_result events: %d → %d", payload.BeforeEventCount, payload.AfterEventCount),
	}
	evt := payload.Event
	if evt.Type != "" {
		codePart := ""
		if evt.Code != "" {
			codePart = " " + evt.Code
		}
		triggerPart := ""
		if evt.Trigger != "" {
			triggerPart = " trigger=" + evt.Trigger
		}
		lines = append(lines, "  boundary: "+evt.Type+codePart+triggerPart)
	}
	if summary := strings.TrimSpace(firstLine(evt.Summary, 160)); summary != "" {
		lines = append(lines, "  summary: "+summary)
	}
	if evt.SummaryChars > 0 {
		lines = append(lines, fmt.Sprintf("  summaryChars: %d", evt.SummaryChars))
	}
	if evt.SnippedToolResults > 0 {
		lines = append(lines, fmt.Sprintf("  snippedToolResults: %d", evt.SnippedToolResults))
	}
	if lb := evt.Budget.LayerBudgets; lb.System+lb.Summary+lb.History+lb.Memory > 0 {
		lines = append(lines, fmt.Sprintf("  budget layers: system=%d summary=%d history=%d memory=%d",
			lb.System, lb.Summary, lb.History, lb.Memory))
	}
	if seg := evt.RetainedSegment; seg.Status != "" || seg.RetainedEventCount > 0 {
		warning := ""
		if w := strings.TrimSpace(seg.Warning); w != "" {
			warning = " · " + w
		}
		lines = append(lines, fmt.Sprintf("  retained segment: %s · events=%d%s",
			ternary(seg.Status == "", "n/a", seg.Status),
			seg.RetainedEventCount, warning))
	}
	return strings.Join(lines, "\n")
}

// firstLine trims a string to its first \n and bounds the length
// to maxLen (with a trailing ellipsis when truncated). Used by
// formatCompactResult to keep the summary preview to a single
// transcript line.
func firstLine(s string, maxLen int) string {
	if idx := strings.IndexAny(s, "\r\n"); idx >= 0 {
		s = s[:idx]
	}
	if maxLen > 0 && len(s) > maxLen {
		return s[:maxLen] + "…"
	}
	return s
}

func stringField(value map[string]any, key string) string {
	raw, ok := value[key]
	if !ok || raw == nil {
		return ""
	}
	switch typed := raw.(type) {
	case string:
		return typed
	default:
		return fmt.Sprint(typed)
	}
}

func boolField(value map[string]any, key string) bool {
	raw, ok := value[key]
	if !ok || raw == nil {
		return false
	}
	switch typed := raw.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	default:
		return false
	}
}

func compactJSON(value any) string {
	if value == nil {
		return ""
	}
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	text := string(data)
	if len(text) > 160 {
		return text[:157] + "..."
	}
	return text
}

func (m *model) expandPromptPlaceholders(prompt string) string {
	expanded := prompt
	if m.pastedTextReplacements == nil {
		return expanded
	}
	for placeholder, rawText := range m.pastedTextReplacements {
		expanded = strings.ReplaceAll(expanded, placeholder, rawText)
	}
	return expanded
}

func formatRuntimeModels(response runtimeModelsResponse) []string {
	var lines []string
	lines = append(lines, "models (capability matrix):")
	for _, provider := range response.Providers {
		configuredStr := "unconfigured"
		if provider.Configured {
			configuredStr = "configured"
		}
		activeStr := ""
		if provider.Active {
			activeStr = " (active)"
		}
		lines = append(lines, fmt.Sprintf("  provider %s (%s, %s)%s:", provider.ID, provider.DisplayName, configuredStr, activeStr))
		for _, model := range provider.Models {
			toolSupport := "✗ tool-call"
			if model.Capabilities.ToolCalling {
				toolSupport = "✓ tool-call"
			}
			jsonSupport := "✗ json"
			if model.Capabilities.JSONOutput {
				jsonSupport = "✓ json"
			}
			streamingSupport := "✗ stream"
			if model.Capabilities.Streaming {
				streamingSupport = "✓ stream"
			}
			paddedID := model.ID
			if len(paddedID) < 30 {
				paddedID = paddedID + strings.Repeat(" ", 30-len(paddedID))
			}
			line := fmt.Sprintf("    %s · context=%-7d · %s · %s · %s", paddedID, model.ContextWindow, toolSupport, jsonSupport, streamingSupport)
			lines = append(lines, line)
		}
	}
	return lines
}
