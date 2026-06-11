package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
)

// modelPickApiKeyDialog implements Dialog for /model step 2:
// paste or accept the provider API key. It snapshots the data
// needed for rendering so model.renderModelPickApiKey can stay a
// thin mode guard + View bridge while Update continues to own the
// actual key handling.
type modelPickApiKeyDialog struct {
	provider *registeredProvider
	input    string
}

func newModelPickApiKeyDialog(provider *registeredProvider, input string) *modelPickApiKeyDialog {
	return &modelPickApiKeyDialog{provider: provider, input: input}
}

func (d *modelPickApiKeyDialog) ID() string { return "modelPickApiKey" }

// HandleMsg is intentionally a no-op in C.2. The existing
// modeModelPickApiKey branch in model.Update still handles esc,
// enter, and text input; this phase only migrates rendering.
func (d *modelPickApiKeyDialog) HandleMsg(_ tea.Msg) tea.Cmd { return nil }

func (d *modelPickApiKeyDialog) View(width int) string {
	providerID := ""
	if d.provider != nil {
		providerID = d.provider.ID
	}

	rc := NewRenderContext(width)
	rc.SetFrameStyle(overlayFrameStyle)
	lines := []string{
		titleStyle.Render(fmt.Sprintf("%s API key", firstNonEmpty(providerID, "Provider"))),
		mutedStyle.Render("Paste API key (Press Enter to confirm, esc to go back.)"),
		"",
	}
	if d.provider != nil {
		lines = append(lines, mutedStyle.Render(fmt.Sprintf("  default model: %s", d.provider.DefaultModel)))
		lines = append(lines, "")
	}
	lines = append(lines, "  "+d.input)
	lines = append(lines, "")
	lines = append(lines, mutedStyle.Render("  enter confirm · esc back"))
	rc.AddPart(strings.Join(lines, "\n"))
	return rc.Render()
}

// modelPickBaseURLDialog implements Dialog for /model step 3:
// confirm or override the provider base URL. Like the API-key
// step, rendering is migrated first while Update keeps owning
// esc/enter/text input state transitions.
type modelPickBaseURLDialog struct {
	provider *registeredProvider
	input    string
}

func newModelPickBaseURLDialog(provider *registeredProvider, input string) *modelPickBaseURLDialog {
	return &modelPickBaseURLDialog{provider: provider, input: input}
}

func (d *modelPickBaseURLDialog) ID() string { return "modelPickBaseURL" }

func (d *modelPickBaseURLDialog) HandleMsg(_ tea.Msg) tea.Cmd { return nil }

func (d *modelPickBaseURLDialog) View(width int) string {
	providerID := ""
	defaultURL := ""
	if d.provider != nil {
		providerID = d.provider.ID
		defaultURL = d.provider.DefaultBaseURL
	}

	rc := NewRenderContext(width)
	rc.SetFrameStyle(overlayFrameStyle)
	lines := []string{
		titleStyle.Render(fmt.Sprintf("%s base URL", firstNonEmpty(providerID, "Provider"))),
		mutedStyle.Render(fmt.Sprintf("Press Enter to use %s.", firstNonEmpty(defaultURL, "<provider default>"))),
		"",
		"  " + d.input,
		"",
		mutedStyle.Render("  enter confirm · esc back"),
	}
	rc.AddPart(strings.Join(lines, "\n"))
	return rc.Render()
}

// modelPickModelDialog implements Dialog for /model step 4:
// pick the concrete model. It snapshots render-only picker state
// so the existing Update branch remains the source of truth for
// navigation, selection, and submitting.
type modelPickModelDialog struct {
	provider    *registeredProvider
	liveModels  []registeredModel
	selectedIdx int
	height      int
	loading     bool
	submitting  bool
	spinnerView string
}

func newModelPickModelDialog(provider *registeredProvider, liveModels []registeredModel, selectedIdx, height int, loading, submitting bool, spinnerView string) *modelPickModelDialog {
	return &modelPickModelDialog{
		provider:    provider,
		liveModels:  liveModels,
		selectedIdx: selectedIdx,
		height:      height,
		loading:     loading,
		submitting:  submitting,
		spinnerView: spinnerView,
	}
}

func (d *modelPickModelDialog) ID() string { return "modelPickModel" }

func (d *modelPickModelDialog) HandleMsg(_ tea.Msg) tea.Cmd { return nil }

func (d *modelPickModelDialog) View(width int) string {
	providerID := ""
	if d.provider != nil {
		providerID = d.provider.ID
	}

	rc := NewRenderContext(width)
	rc.SetFrameStyle(overlayFrameStyle)
	lines := []string{
		titleStyle.Render(fmt.Sprintf("%s models", firstNonEmpty(providerID, "Provider"))),
		mutedStyle.Render("Pick a model. enter selects; esc back to base URL."),
		"",
	}

	if d.loading {
		lines = append(lines, "  "+d.spinnerView+"  refreshing model list…")
		lines = append(lines, "")
		lines = append(lines, mutedStyle.Render("  esc back · cancel re-fetch"))
		rc.AddPart(strings.Join(lines, "\n"))
		return rc.Render()
	}

	if d.submitting {
		lines = append(lines, "  "+d.spinnerView+"  saving model…")
		lines = append(lines, "")
		lines = append(lines, mutedStyle.Render("  esc back to base URL (request still in flight)"))
		rc.AddPart(strings.Join(lines, "\n"))
		return rc.Render()
	}

	models := d.liveModels
	if len(models) == 0 && d.provider != nil {
		models = d.provider.Models
	}
	if len(models) == 0 {
		lines = append(lines, mutedStyle.Render("  No models registered for this provider."))
	} else {
		lines = append(lines, mutedStyle.Render("  model"))
		visibleRows := max(1, d.height-12)
		scrollOffset := 0
		if d.selectedIdx >= visibleRows {
			scrollOffset = d.selectedIdx - visibleRows + 1
		}
		if scrollOffset+visibleRows > len(models) {
			scrollOffset = max(0, len(models)-visibleRows)
		}
		if scrollOffset > 0 {
			lines = append(lines, mutedStyle.Render(fmt.Sprintf("  ↑ %d more", scrollOffset)))
		}
		for i := 0; i < visibleRows && scrollOffset+i < len(models); i++ {
			actualIdx := scrollOffset + i
			entry := models[actualIdx]
			marker := "  "
			if actualIdx == d.selectedIdx {
				marker = "> "
			}
			display := firstNonEmpty(entry.Name, entry.ID)
			row := marker + display
			if actualIdx == d.selectedIdx {
				row = focusedLineStyle.Render(row)
			}
			lines = append(lines, "  "+row)
		}
		remainingBelow := len(models) - (scrollOffset + visibleRows)
		if remainingBelow > 0 {
			lines = append(lines, mutedStyle.Render(fmt.Sprintf("  ↓ %d more", remainingBelow)))
		}
	}
	lines = append(lines, "")
	lines = append(lines, mutedStyle.Render("  ↑↓/Tab navigate · enter select · esc back"))
	rc.AddPart(strings.Join(lines, "\n"))
	return rc.Render()
}
