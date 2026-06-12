package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

func formatRuntimeModelConfigSummary(response runtimeModelsResponse) string {
	activeModel := firstNonEmpty(response.DefaultModel, "unknown")
	activeProfile := firstNonEmpty(response.ActiveProfile, "none")
	providerCount := len(response.Providers)
	modelCount := 0
	configuredCount := 0
	for _, provider := range response.Providers {
		modelCount += len(provider.Models)
		if provider.Configured {
			configuredCount++
		}
	}
	prefix := "model config"
	if response.Version > 0 {
		prefix = fmt.Sprintf("model config v=%d", response.Version)
	}
	return fmt.Sprintf("%s active=%s profile=%s providers=%d configured=%d models=%d",
		prefix, activeModel, activeProfile, providerCount, configuredCount, modelCount)
}

func formatModelCapabilityFlags(capabilities runtimeCapabilities) string {
	flags := []string{}
	if capabilities.ToolCalling {
		flags = append(flags, "tool-call")
	}
	if capabilities.JSONOutput {
		flags = append(flags, "json")
	}
	if capabilities.StructuredOutput {
		flags = append(flags, "structured")
	}
	if capabilities.Streaming {
		flags = append(flags, "stream")
	}
	if len(flags) == 0 {
		return "basic"
	}
	return strings.Join(flags, ",")
}

func formatModelProviderStatus(provider registeredProvider) string {
	parts := []string{}
	if provider.Active {
		parts = append(parts, "active")
	}
	if provider.Configured {
		parts = append(parts, "configured")
	} else {
		parts = append(parts, "unconfigured")
	}
	if provider.AuthMode != "" {
		parts = append(parts, "auth="+provider.AuthMode)
	}
	if len(parts) == 0 {
		return "unknown"
	}
	return strings.Join(parts, " · ")
}

func buildModelOverlayLines(response runtimeModelsResponse) []string {
	if len(response.Providers) == 0 {
		return []string{"No providers reported by the current Nexus runtime."}
	}
	lines := []string{
		"Active model: " + firstNonEmpty(response.DefaultModel, "unknown"),
		"Active profile: " + firstNonEmpty(response.ActiveProfile, "none"),
		"",
		"Configuration writes stay CLI-owned in Go TUI:",
		"  bbl config use <modelId>",
		"  bbl chat /model",
		"",
		"Providers:",
	}
	for _, provider := range response.Providers {
		displayName := firstNonEmpty(provider.DisplayName, provider.ID)
		lines = append(lines, fmt.Sprintf("  %s (%s) · %s",
			provider.ID, displayName, formatModelProviderStatus(provider)))
		if provider.DefaultModel != "" {
			lines = append(lines, "    default: "+provider.DefaultModel)
		}
		if len(provider.Models) == 0 {
			lines = append(lines, "    no registered models")
			continue
		}
		for _, model := range provider.Models {
			marker := " "
			if model.ID == response.DefaultModel {
				marker = "*"
			}
			name := firstNonEmpty(model.Name, model.ID)
			lines = append(lines, fmt.Sprintf("    %s %s · ctx=%d · max=%d · %s",
				marker, model.ID, model.ContextWindow, model.DefaultMaxTokens,
				formatModelCapabilityFlags(model.Capabilities)))
			if name != model.ID {
				lines = append(lines, "      "+name)
			}
		}
	}
	return lines
}

func (m model) renderModelOverlay(width int) string {
	if m.inputMode != modeModelOverlay {
		return ""
	}
	header := titleStyle.Render("Model configuration")
	summary := formatRuntimeModelConfigSummary(m.modelCatalog)
	visibleRows := max(1, m.height-10)
	allLines := buildModelOverlayLines(m.modelCatalog)
	maxScroll := max(0, len(allLines)-visibleRows)
	if m.modelOverlayScroll > maxScroll {
		end := maxScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[maxScroll:end]
	} else {
		end := m.modelOverlayScroll + visibleRows
		if end > len(allLines) {
			end = len(allLines)
		}
		allLines = allLines[m.modelOverlayScroll:end]
	}
	lines := []string{header, divider(width), summary}
	lines = append(lines, allLines...)
	lines = append(lines, mutedStyle.Render("↑/↓/Tab scroll · esc/enter/q close"))
	return renderOverlayFrame(width, statusStyle.Render(wrapPlain(strings.Join(lines, "\n"), max(0, width-2))))
}

// openModelRegistry kicks off the /model multi-step flow.
// Reset per-step state (selection index, draft input) so
// re-entering /model from a previous partially-completed
// flow doesn't carry stale state.
func (m *model) openModelRegistry() {
	m.modelPickProviderIdx = 0
	m.modelPickSelectedIdx = 0
	m.modelPickSelectedID = ""
	m.modelPickProviderDraft = ""
	m.modelPickAPIKeyDraft = ""
	m.modelPickBaseURLDraft = ""
	m.setMode(modeModelPickProvider)
}

// currentModelProvider resolves the provider the multi-step
// flow is currently bound to. Returns nil if the operator
// somehow advanced past provider selection without a chosen
// id.
func (m model) currentModelProvider() *registeredProvider {
	if m.modelPickSelectedID == "" {
		return nil
	}
	for i := range m.modelCatalog.Providers {
		if m.modelCatalog.Providers[i].ID == m.modelPickSelectedID {
			return &m.modelCatalog.Providers[i]
		}
	}
	return nil
}

// enterModelPicker transitions into the Step 4 model
// picker. Resets the cursor, clears the prior live list,
// marks the picker as loading, fires a fresh
// `/v1/runtime/models` request, and switches the input
// mode. The runtimeModelsMsg handler routes the response
// back into `modelPickerLive` and clears the loading flag.
func (m *model) enterModelPicker() tea.Cmd {
	m.modelPickSelectedIdx = 0
	m.modelPickerLive = nil
	m.modelPickerLoading = true
	m.setMode(modeModelPickModel)
	return fetchRuntimeModels(m.cfg, "model-picker")
}

// renderModelPickProvider is step 1 of the /model flow: a
// scrollable list of providers, each row tagged with the
// configured / needs-API-key status. enter advances to the
// API key step (or to the picker directly when the provider
// is already configured and the operator chooses to skip
// the key / base URL steps via the hint chip).
func (m model) renderModelPickProvider(width int) string {
	if m.inputMode != modeModelPickProvider {
		return ""
	}
	header := titleStyle.Render("BABEL Model Registry")
	subtitle := mutedStyle.Render("Select provider, configure API access, then choose a model.")
	lines := []string{header, subtitle, ""}
	if len(m.modelCatalog.Providers) == 0 {
		lines = append(lines, mutedStyle.Render("  No providers reported by the current Nexus runtime."))
	} else {
		// Single-column layout: just the provider name. The
		// configured / needs-api-key state is implied by
		// the next step's prompt (step 2 asks for an API
		// key when the provider is unconfigured, skips
		// straight to step 4 when it's already configured),
		// so the list itself doesn't need a status column.
		lines = append(lines, mutedStyle.Render("  provider"))
		visibleRows := max(1, m.height-12)
		scrollOffset := 0
		if m.modelPickProviderIdx >= visibleRows {
			scrollOffset = m.modelPickProviderIdx - visibleRows + 1
		}
		if scrollOffset+visibleRows > len(m.modelCatalog.Providers) {
			scrollOffset = max(0, len(m.modelCatalog.Providers)-visibleRows)
		}
		if scrollOffset > 0 {
			lines = append(lines, mutedStyle.Render(fmt.Sprintf("  ↑ %d more", scrollOffset)))
		}
		for i := 0; i < visibleRows && scrollOffset+i < len(m.modelCatalog.Providers); i++ {
			actualIdx := scrollOffset + i
			p := m.modelCatalog.Providers[actualIdx]
			marker := "  "
			if actualIdx == m.modelPickProviderIdx {
				marker = "> "
			}
			row := marker + p.DisplayName
			if actualIdx == m.modelPickProviderIdx {
				row = focusedLineStyle.Render(row)
			}
			lines = append(lines, "  "+row)
		}
		remainingBelow := len(m.modelCatalog.Providers) - (scrollOffset + visibleRows)
		if remainingBelow > 0 {
			lines = append(lines, mutedStyle.Render(fmt.Sprintf("  ↓ %d more", remainingBelow)))
		}
	}
	lines = append(lines, "")
	lines = append(lines, mutedStyle.Render("  ↑↓/Tab navigate · enter select · esc cancel"))
	return renderOverlayFrame(width, strings.Join(lines, "\n"))
}

// renderModelPickApiKey is step 2: paste the API key. The
// key is echoed in plaintext for parity with the bbl chat
// TS TUI (operator sees what they type) and cleared from
// memory after the picker step resolves.
func (m model) renderModelPickApiKey(width int) string {
	if m.inputMode != modeModelPickApiKey {
		return ""
	}
	return newModelPickApiKeyDialog(m.currentModelProvider(), m.input.View()).View(width)
}

// renderModelPickBaseURL is step 3: confirm or override the
// base URL. The provider's default URL is pre-filled into
// the input box; pressing Enter without editing accepts the
// default.
func (m model) renderModelPickBaseURL(width int) string {
	if m.inputMode != modeModelPickBaseURL {
		return ""
	}
	return newModelPickBaseURLDialog(m.currentModelProvider(), m.input.View()).View(width)
}

// renderModelPickModel is step 4: pick a model from the
// refreshed catalog after provider credentials have been saved.
func (m model) renderModelPickModel(width int) string {
	if m.inputMode != modeModelPickModel {
		return ""
	}
	return newModelPickModelDialog(
		m.currentModelProvider(),
		m.modelPickerLive,
		m.modelPickSelectedIdx,
		m.height,
		m.modelPickerLoading,
		m.modelPickSubmitting,
		m.spinner.View(),
	).View(width)
}

// padRightPlain pads a string with spaces to the given
// visible width. Truncates with a trailing `…` when the
// input already exceeds the target so the column never
// overflows.
func padRightPlain(s string, width int) string {
	if len(s) >= width {
		if width <= 1 {
			return s[:width]
		}
		return s[:width-1] + "…"
	}
	return s + strings.Repeat(" ", width-len(s))
}

// visibleLen returns the on-screen column width of a
// string, stripping ANSI / using lipgloss.Width so a model
// id with embedded CJK or escape codes doesn't inflate the
// calculated column width.
func visibleLen(s string) int {
	return lipgloss.Width(s)
}
