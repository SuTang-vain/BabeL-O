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
// KeyMsg routes Ctrl+C / Esc / q to a quit command and
// dispatches the rest through the Router (Phase 3f') so
// Ctrl+N / Ctrl+W / Ctrl+H/L / Ctrl+PgUp/PgDn mutate the
// LoopModel via the Phase 3d helpers.
func (m InteractiveModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.loop.Width = msg.Width
		m.loop.Height = msg.Height
		return m, nil

	case tea.KeyPressMsg:
		// Quit keys win over router dispatch.
		switch msg.String() {
		case "ctrl+c", "esc", "q":
			m.quitting = true
			return m, tea.Quit
		}
		event, ok := rawEventFromKey(msg)
		if !ok {
			return m, nil
		}
		return m, m.dispatchEvent(event)

	case tea.KeyReleaseMsg:
		return m, nil
	}
	return m, nil
}

// dispatchEvent runs the Router against the model's loop
// state, then applies the resulting RouteAction to the
// LoopModel via the Phase 3d mutators. Returns a tea.Cmd
// for side effects (sounds + toasts) that a later
// sub-target will populate.
func (m *InteractiveModel) dispatchEvent(event RawEvent) tea.Cmd {
	route, next := NewRouter().Dispatch(event, m.loop)
	m.loop = next
	switch route.Action {
	case RouteClosePane:
		m.loop = ApplyClosePane(m.loop)
	case RouteNewPane:
		m.loop, _ = ApplyNewPane(m.loop, newPaneSeedFor(event))
	case RouteMoveFocus:
		m.loop = ApplyMoveFocus(m.loop, route.Direction)
	case RouteNextTab:
		m.loop = ApplyNextTab(m.loop)
	case RoutePrevTab:
		m.loop = ApplyPrevTab(m.loop)
	case RouteNewWorkspace, RouteCloseWorkspace, RouteFocusPane, RouteResize, RouteNone:
		// No mutation in this sub-target. Workspace creation /
		// destruction will land in Phase 3f''; focus-pane +
		// resize are already handled in the calling Update.
	}
	return nil
}

// newPaneSeedFor builds a NewPaneSeed for the Ctrl+N path.
// The sessionId is generated locally for now; Phase 3f''
// will replace it with a real Nexus session allocation
// via POST /v1/sessions.
func newPaneSeedFor(_ RawEvent) NewPaneSeed {
	return NewPaneSeed{
		PaneID:    NewID("pane"),
		Agent:     "bbl",
		Label:     "main",
		SessionID: "session-" + NewID("local"),
	}
}

// rawEventFromKey maps a bubbletea v2 KeyPressMsg into the
// canonical RawEvent shape the Router understands. Returns
// (event, true) when the key is actionable, (zero, false)
// otherwise. The mapping covers the router's full key set
// (Ctrl+N/W/T/H/L/K/J/PgUp/PgDn/Tab/Enter/Esc/Backspace +
// printable runes).
//
// Named keys (Esc/Tab/Enter/Backspace/PgUp/PgDown/arrows) are
// matched before the Ctrl-modifier check so a Ctrl+PgDown
// becomes "ctrl+pgdn" (the router's expected token) rather
// than "ctrl+pgdown" + stray 'w'.
func rawEventFromKey(msg tea.KeyPressMsg) (RawEvent, bool) {
	switch msg.Code {
	case tea.KeyEsc:
		return RawEvent{Kind: "key", Key: "esc"}, true
	case tea.KeyTab:
		return RawEvent{Kind: "key", Key: "tab"}, true
	case tea.KeyEnter:
		return RawEvent{Kind: "key", Key: "enter"}, true
	case tea.KeyBackspace:
		return RawEvent{Kind: "key", Key: "backspace"}, true
	case tea.KeyPgUp:
		return RawEvent{Kind: "key", Key: "ctrl+pgup"}, true
	case tea.KeyPgDown:
		return RawEvent{Kind: "key", Key: "ctrl+pgdn"}, true
	case tea.KeyLeft:
		return RawEvent{Kind: "key", Key: "ctrl+left"}, true
	case tea.KeyRight:
		return RawEvent{Kind: "key", Key: "ctrl+right"}, true
	case tea.KeyUp:
		return RawEvent{Kind: "key", Key: "ctrl+up"}, true
	case tea.KeyDown:
		return RawEvent{Kind: "key", Key: "ctrl+down"}, true
	}
	if msg.Mod&tea.ModCtrl != 0 {
		lower := msg.Code
		if lower >= 'A' && lower <= 'Z' {
			lower += 'a' - 'A'
		}
		return RawEvent{Kind: "key", Key: "ctrl+" + string(lower)}, true
	}
	if msg.Text != "" {
		return RawEvent{Kind: "key", Key: msg.Text}, true
	}
	return RawEvent{}, false
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
