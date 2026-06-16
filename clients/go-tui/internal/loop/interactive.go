// internal/loop/interactive.go
//
// Phase 3f: minimal Bubble Tea adapter that brings up the
// `bbl loop` interactive TUI. This is the first sub-target
// that consumes the Phase 2/3 data layer via a real
// `tea.Model`; future sub-targets (3f' / 4 / 5 / 6) will
// layer router dispatch, overlay rendering, status sidebar,
// and scope review on top of the model established here.
//
// Scope of this commit:
//   - WindowSize → LoopModel.Width / Height + layout reset
//   - KeyMsg: Ctrl+C / Esc / q quit
//   - View: status bar (FormatStatusSummary) + placeholder
//     pane body + footer hint
//
// Out of scope (deferred to later sub-targets):
//   - Router dispatch (Phase 3a) for key events other than
//     quit
//   - Layout-based pane geometry rendering (Phase 3b)
//   - MouseEventFilter (Phase 3c)
//   - Pane / status / scope overlay splicing
//   - Real Nexus streaming + transcript accumulation
package loop

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
)

// InteractiveModel is the tea.Model the `bbl loop` TUI runs.
// It holds the pure-data LoopModel alongside runtime-only
// state (window dimensions, transcript placeholder) so the
// data layer stays free of Bubble Tea imports.
type InteractiveModel struct {
	loop       LoopModel
	transcript []string
	quitting    bool
}

// NewInteractiveModel returns a TUI model seeded with the
// provided LoopModel. The transcript is empty; the first
// sub-target that wires Nexus streaming will populate it.
func NewInteractiveModel(model LoopModel) InteractiveModel {
	return InteractiveModel{loop: model}
}

// Init returns the initial tea.Cmd. Phase 3f only requests
// the initial window size; later sub-targets will add
// heartbeat / health-poll timers.
func (m InteractiveModel) Init() tea.Cmd {
	return tea.RequestWindowSize
}

// Update handles Bubble Tea messages. WindowSizeMsg keeps
// the LoopModel dimensions in sync with the terminal;
// KeyMsg routes Ctrl+C / Esc / q to a quit command. All
// other keys are noop until Phase 3a router dispatch lands.
func (m InteractiveModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.loop.Width = msg.Width
		m.loop.Height = msg.Height
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "esc", "q":
			m.quitting = true
			return m, tea.Quit
		}
		return m, nil
	}
	return m, nil
}

// View renders the status bar + focused pane body + footer.
// The pane body is a placeholder until Phase 3f' wires the
// real transcript (which lives in Nexus-driven sub-targets).
func (m InteractiveModel) View() tea.View {
	var v tea.View
	if m.quitting {
		v.SetContent("")
		return v
	}
	var b strings.Builder
	header := VersionString()
	if m.loop.Width > 0 {
		header += " · " + FormatStatusSummary(m.loop)
	}
	b.WriteString(header)
	b.WriteString("\n")
	b.WriteString(strings.Repeat("─", clampWidth(m.loop.Width, 40)))
	b.WriteString("\n")
	b.WriteString(renderFocusedPanePlaceholder(m.loop))
	b.WriteString("\n")
	b.WriteString(strings.Repeat("─", clampWidth(m.loop.Width, 40)))
	b.WriteString("\n")
	footer := "q / esc / ctrl+c quit"
	if m.loop.Width > 0 {
		footer = padFooter(footer, m.loop.Width)
	}
	b.WriteString(footer)
	v.SetContent(b.String())
	return v
}

func renderFocusedPanePlaceholder(model LoopModel) string {
	pane, ok := model.FocusedPane()
	if !ok {
		return "(no pane focused)\n"
	}
	if pane.SessionID == "" {
		return fmt.Sprintf("[%s] %s · no session yet\n", pane.PaneID, pane.Label)
	}
	return fmt.Sprintf(
		"[%s] %s\n  session=%s status=%s lastRev=%d\n  (waiting for stream — Phase 3f')\n",
		pane.PaneID, pane.Label, pane.SessionID, pane.Status, pane.LastEventRev,
	)
}

func clampWidth(width, fallback int) int {
	if width <= 0 {
		return fallback
	}
	return width
}

func padFooter(footer string, width int) string {
	if len(footer) >= width {
		return footer
	}
	return footer + strings.Repeat(" ", width-len(footer))
}

// RunInteractive launches the bbl loop TUI. It is the
// interactive counterpart to Run (which is the Phase 2a
// smoke). Pass the model produced by the launcher; the
// function returns when the user quits or the program
// errors. LoopModel state mutations during the TUI are
// reflected on each Update so a future sub-target can
// apply router decisions into the same model.
func RunInteractive(model LoopModel) error {
	prog := tea.NewProgram(NewInteractiveModel(model))
	finalModel, err := prog.Run()
	if err != nil {
		return fmt.Errorf("loop: bubbletea run: %w", err)
	}
	if _, ok := finalModel.(InteractiveModel); !ok {
		return fmt.Errorf("loop: unexpected final model %T", finalModel)
	}
	return nil
}
