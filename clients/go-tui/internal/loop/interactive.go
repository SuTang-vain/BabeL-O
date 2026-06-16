// internal/loop/interactive.go
//
// Phase 3f: minimal Bubble Tea adapter that brings up the
// `bbl loop` interactive TUI. This is the first sub-target
// that consumes the Phase 2/3 data layer via a real
// `tea.Model`; future sub-targets (3f' / 4 / 5 / 6) will
// layer router dispatch, overlay rendering, status sidebar,
// and scope review on top of the model established here.
//
// Scope of this commit (Phase 3f):
//   - WindowSize → LoopModel.Width / Height + layout reset
//   - KeyMsg: Ctrl+C / Esc / q quit
//   - View: status bar (FormatStatusSummary) + placeholder
//     pane body + footer hint
//
// Phase 3f' added: router dispatch + Apply* mutators.
//
// Phase 5c: hook the local snapshot Store into RunInteractive
// so a snapshot is loaded on startup and saved on every
// mutator dispatch + on shutdown. This makes the Phase 5
// closure criterion "kill -9 nexus && bbl loop" -> restore
// testable end-to-end; the reconciler goroutine that
// syncs with the server is a later sub-target (5c').
//
// Phase 5c' added: tea.Cmd-driven reconcile tick. RunInteractive
// schedules a tick every `reconcileInterval`; each tick fires
// Reconciler.RunOnce and the result lands back in Update as
// reconcileDoneMsg. Phase 6b will surface the last result in
// the status sidebar.
//
// Out of scope (deferred to later sub-targets):
//   - Layout-based pane geometry rendering (Phase 3b)
//   - MouseEventFilter (Phase 3c)
//   - Pane / status / scope overlay splicing (Phase 6b)
//   - Real Nexus streaming + transcript accumulation
package loop

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
	"github.com/sutang-vain/babel-o/clients/go-tui/internal/notifications"
)

// InteractiveModel is the tea.Model the `bbl loop` TUI runs.
// It holds the pure-data LoopModel alongside runtime-only
// state (window dimensions, transcript placeholder, optional
// store, optional reconciler) so the data layer stays free
// of Bubble Tea imports.
type InteractiveModel struct {
	loop              LoopModel
	transcript        []string
	store             *Store
	reconciler        *Reconciler
	reconcileInterval time.Duration
	lastReconcile     reconcileDoneMsg
	// lastReconcileAt stamps when the most recent reconcile
	// pass *landed* in the Update path (not when it was
	// kicked off). The footer uses it to render a "synced
	// 3s ago" hint; without the timestamp the chrome would
	// only know "there was a result" but not how fresh it is.
	lastReconcileAt time.Time
	// reconcileInFlight is set by handleReconcileTick when a
	// reconcile pass is queued and cleared by
	// handleReconcileDone when the result lands. The footer
	// uses it to render a "● syncing..." indicator during
	// the gap between kickoff and completion — useful when
	// the reconciler takes a noticeable fraction of the
	// 5s interval.
	reconcileInFlight bool
	quitting          bool
	// helpOpen toggles the centered keybind overlay. Wired
	// to the `?` key from Update; rendered by chrome.go.
	helpOpen bool
	// toastMessage + toastShownAt drive the transient
	// one-line banner that surfaces ephemeral info (e.g. a
	// successful snapshot save) for a short window. The
	// chrome layer ignores entries older than
	// toastTTL — that's where the "transient" part of the
	// contract lives.
	toastMessage string
	toastShownAt time.Time
	// sidebarCollapsed is the Ctrl+B toggle: when true the
	// sidebar shrinks to a 4-col gutter so the focused pane
	// gets more horizontal space without losing the
	// workspace/tab navigation affordance. The data layer
	// doesn't know about this — it's a chrome concern, so
	// it lives on the InteractiveModel and is passed to the
	// renderer via chromeViewState.Layout.
	sidebarCollapsed bool
	// zoomFocused is the Ctrl+Z toggle: when true the
	// focused pane takes the entire body (sidebar, header
	// breadcrumb, and summary pill are hidden). Distinct
	// from sidebarCollapsed: collapse preserves the chrome
	// at a narrower scale, zoom suppresses it entirely for
	// maximum content width. Both are off by default; the
	// operator presses them as needed and they survive
	// until the next keypress or restart.
	zoomFocused bool
	// loopClient is the Nexus HTTP client used to fetch
	// /v1/runtime/loop/health. When non-nil + healthInterval
	// > 0, the InteractiveModel schedules a periodic poll
	// (see health_tick.go) and merges the response into the
	// LoopModel. nil means in-memory / no-Nexus mode.
	loopClient *api.Client
	// healthInterval is the poll cadence for loopClient;
	// zero means polling is disabled. Kept as a separate
	// field so the constructor signature stays readable
	// even when several periodic loops are wired.
	healthInterval time.Duration
	// toastQueue deduplicates status-change toasts within
	// a 5s window and suppresses toasts for the focused
	// tab. nil means no toast side effects (the chrome
	// still updates, the user just doesn't get a sound /
	// banner). Provided as a field so tests can swap in a
	// fake with a controllable clock.
	toastQueue *notifications.ToastQueue
	// soundPlayer plays the per-status sound (drift → warn,
	// blocked → alert, done → chime). The production wiring
	// uses the platform-specific SoundPlayer
	// (notifications.NewSoundPlayerForPlatform); tests
	// substitute FakeSoundPlayer to capture Play calls.
	soundPlayer notifications.SoundPlayer
	// lastHealthCheckAt stamps the most recent successful
	// (or attempted) loop/health poll. Currently used by
	// the chrome footer / future diagnostics overlay; not
	// part of the user-facing chrome yet.
	lastHealthCheckAt time.Time
	// altScreen and mouseCapture are Bubble Tea view flags
	// configured by cmd/bbl-loop. Keeping them on the model
	// mirrors herdr's runtime/view split: input/render policy
	// is driver-owned, while LoopModel stays pure pane state.
	altScreen    bool
	mouseCapture bool
}

// toastTTL is how long a transient toast stays visible on
// screen. Matches herdr's CopyFeedback window (a couple of
// seconds) so the operator has time to register the change
// but the chrome doesn't carry stale state forever.
const toastTTL = 2 * time.Second

// NewInteractiveModel returns a TUI model seeded with the
// provided LoopModel. The transcript is empty; the first
// sub-target that wires Nexus streaming will populate it.
func NewInteractiveModel(model LoopModel) InteractiveModel {
	return InteractiveModel{loop: model, altScreen: true, mouseCapture: true}
}

// NewInteractiveModelWithStore hydrates the model from the
// snapshot persisted in `store`. The returned model is
// ready to use; mutations from the Update path are flushed
// back to the store via the Save-on-dispatch helper that
// RunInteractive wires in. A nil store is tolerated and
// behaves like NewInteractiveModel.
func NewInteractiveModelWithStore(model LoopModel, store *Store) InteractiveModel {
	im := NewInteractiveModel(model)
	im.store = store
	if store == nil {
		return im
	}
	snap := store.Snapshot()
	im.loop = applySnapshotToLoop(im.loop, snap)
	return im
}

// NewInteractiveModelWithReconciler attaches a Reconciler
// and a periodic tick interval. The reconciler runs in the
// background via Update's message loop (no bare goroutine);
// pass `reconciler == nil` to disable background sync.
func NewInteractiveModelWithReconciler(
	model LoopModel,
	store *Store,
	reconciler *Reconciler,
	interval time.Duration,
) InteractiveModel {
	im := NewInteractiveModelWithStore(model, store)
	im.reconciler = reconciler
	im.reconcileInterval = interval
	return im
}

// NewInteractiveModelWithLoopClient attaches the Nexus HTTP
// client + a periodic /v1/runtime/loop/health poll cadence
// to the InteractiveModel. The ToastQueue and SoundPlayer
// are also wired so status transitions surface as
// dedup'd toasts + platform-appropriate sounds. Pass any of
// them as nil to disable the corresponding side effect
// (the chrome still updates from health, the user just
// doesn't get a sound / banner).
//
// The reconciler + store from the previous constructor are
// preserved; the health poll runs in parallel with the
// reconcile pass.
func NewInteractiveModelWithLoopClient(
	model LoopModel,
	store *Store,
	reconciler *Reconciler,
	reconcileInterval time.Duration,
	loopClient *api.Client,
	healthInterval time.Duration,
	toastQueue *notifications.ToastQueue,
	soundPlayer notifications.SoundPlayer,
) InteractiveModel {
	im := NewInteractiveModelWithReconciler(model, store, reconciler, reconcileInterval)
	im.loopClient = loopClient
	im.healthInterval = healthInterval
	im.toastQueue = toastQueue
	im.soundPlayer = soundPlayer
	return im
}

// NewInteractiveModelWithRuntimeOptions applies terminal
// presentation flags that come from cmd/bbl-loop (`--alt`
// and `--mouse`). It intentionally mutates only
// InteractiveModel fields, never LoopModel.
func NewInteractiveModelWithRuntimeOptions(
	model InteractiveModel,
	altScreen bool,
	mouseCapture bool,
) InteractiveModel {
	model.altScreen = altScreen
	model.mouseCapture = mouseCapture
	return model
}

// applySnapshotToLoop returns `loop` updated to reflect the
// panes in `snap`. Pane IDs that don't exist in the
// current model are appended to the focused tab; existing
// panes have their metadata refreshed. The function is
// pure — the caller decides whether to persist.
func applySnapshotToLoop(loop LoopModel, snap Snapshot) LoopModel {
	if len(snap.Panes) == 0 {
		return loop
	}
	if loop.Focus.WorkspaceIdx < 0 || loop.Focus.WorkspaceIdx >= len(loop.Workspaces) {
		return loop
	}
	ws := loop.Workspaces[loop.Focus.WorkspaceIdx]
	if len(ws.Tabs) == 0 {
		ws.Tabs = []Tab{{ID: ws.ID + ":1", Label: "main"}}
	}
	tab := ws.Tabs[loop.Focus.TabIdx]
	for _, entry := range snap.Panes {
		tab, _ = tab.AddPane(PaneModel{
			PaneID:       entry.PaneID,
			WorkspaceID:  entry.WorkspaceID,
			TabID:        entry.TabID,
			SessionID:    entry.SessionID,
			Agent:        entry.Agent,
			Cwd:          entry.Cwd,
			Label:        entry.Label,
			Status:       StatusIdle,
			LastEventRev: entry.LastRev,
		})
	}
	ws.Tabs[loop.Focus.TabIdx] = tab
	loop.Workspaces[loop.Focus.WorkspaceIdx] = ws
	return loop
}

// snapshotFromLoop extracts the pane list from the current
// model in the shape Store.Replace expects. Only the
// focused workspace + tab are persisted; Phase 5c' will
// extend to multi-workspace snapshots.
func snapshotFromLoop(model LoopModel) Snapshot {
	if model.Focus.WorkspaceIdx < 0 || model.Focus.WorkspaceIdx >= len(model.Workspaces) {
		return Snapshot{Version: snapshotVersion, Panes: nil}
	}
	ws := model.Workspaces[model.Focus.WorkspaceIdx]
	if model.Focus.TabIdx < 0 || model.Focus.TabIdx >= len(ws.Tabs) {
		return Snapshot{Version: snapshotVersion, Panes: nil}
	}
	tab := ws.Tabs[model.Focus.TabIdx]
	entries := make([]PaneStateEntry, 0, len(tab.Panes))
	for _, pane := range tab.Panes {
		entries = append(entries, PaneStateEntry{
			PaneID:      pane.PaneID,
			WorkspaceID: pane.WorkspaceID,
			TabID:       pane.TabID,
			SessionID:   pane.SessionID,
			Agent:       pane.Agent,
			Cwd:         pane.Cwd,
			Label:       pane.Label,
			LastRev:     pane.LastEventRev,
		})
	}
	return Snapshot{Version: snapshotVersion, Panes: entries}
}

// persistSnapshot writes the current loop state into the
// attached Store. No-op when the store is nil or empty.
// On a successful write we also stamp a transient toast so
// the chrome can show "✓ state saved" for a couple of
// seconds — gives the operator the same kind of "you did
// something, the system noticed" feedback herdr shows after
// a clipboard copy or a permission decision.
func (m *InteractiveModel) persistSnapshot() {
	if m.store == nil {
		return
	}
	if err := m.store.Replace(snapshotFromLoop(m.loop)); err != nil {
		m.toastMessage = "✗ save failed: " + err.Error()
		m.toastShownAt = time.Now()
		return
	}
	m.toastMessage = "✓ state saved"
	m.toastShownAt = time.Now()
}

// Init returns the initial tea.Cmd. Phase 3f requests the
// initial window size; Phase 5c' adds the first reconcile
// tick so the reconciler starts running on launch. Phase
// 4b' adds the first health poll so status projections
// become live as soon as the UI is up. When the
// corresponding client / interval is nil the relevant tick
// is dropped.
func (m InteractiveModel) Init() tea.Cmd {
	cmds := []tea.Cmd{tea.RequestWindowSize}
	if m.reconciler != nil {
		cmds = append(cmds, scheduleReconcileTick(m.reconcileInterval))
	}
	if m.loopClient != nil && m.healthInterval > 0 {
		cmds = append(cmds, scheduleHealthTick(m.healthInterval))
	}
	return tea.Batch(cmds...)
}

// Update handles Bubble Tea messages. WindowSizeMsg keeps
// the LoopModel dimensions in sync with the terminal;
// KeyMsg routes Ctrl+C / Esc / q to a quit command and
// dispatches the rest through the Router (Phase 3f') so
// Ctrl+N / Ctrl+W / Ctrl+H/L / Ctrl+PgUp/PgDn mutate the
// LoopModel via the Phase 3d helpers. tickMsg fires the
// reconciler (Phase 5c'); reconcileDoneMsg stores the
// latest result and reschedules.
func (m InteractiveModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.loop.Width = msg.Width
		m.loop.Height = msg.Height
		return m, nil

	case tickMsg:
		return m, m.handleReconcileTick()

	case reconcileDoneMsg:
		return m, m.handleReconcileDone(msg)

	case healthTickMsg:
		return m, m.handleHealthTick()

	case healthDoneMsg:
		return m, m.handleHealthDone(msg)

	case tea.KeyPressMsg:
		// Help overlay takes priority over quit + router
		// dispatch so `?` toggles it from any state and
		// `esc` inside the help closes the overlay rather
		// than quitting the whole program.
		if m.helpOpen {
			switch chromeKeyName(msg) {
			case "?", "esc", "q", "ctrl+c":
				m.helpOpen = false
				return m, nil
			}
			// Swallow everything else while the overlay
			// is up so the underlying chrome doesn't
			// react to a stray keypress.
			return m, nil
		}
		// Quit keys win over router dispatch.
		switch chromeKeyName(msg) {
		case "ctrl+c", "esc", "q":
			m.quitting = true
			return m, tea.Quit
		case "?":
			m.helpOpen = true
			return m, nil
		case "ctrl+b":
			// Sidebar collapse toggle. Distinct from a
			// router action: the LoopModel is untouched,
			// only the chrome geometry changes.
			m.sidebarCollapsed = !m.sidebarCollapsed
			return m, nil
		case "ctrl+z":
			// Focused-pane zoom toggle. Like Ctrl+B this
			// doesn't touch the LoopModel — the focused
			// pane is still the same LoopModel.Focus
			// entry; the chrome just renders it at full
			// body width.
			m.zoomFocused = !m.zoomFocused
			return m, nil
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
// LoopModel via the Phase 3d mutators. After mutating it
// persists the snapshot to the attached Store (Phase 5c)
// so the next `bbl loop` launch hydrates from disk. Returns
// a tea.Cmd for side effects (sounds + toasts) that a later
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
	m.refreshFocusedTab()
	m.persistSnapshot()
	return nil
}

// refreshFocusedTab updates the toast queue's notion of
// which tab the operator is currently viewing so status
// transitions on that tab don't fire a banner. Called
// after every mutating dispatch; no-op when the toast
// queue is nil or the focus is unset.
func (m *InteractiveModel) refreshFocusedTab() {
	if m.toastQueue == nil {
		return
	}
	if m.loop.Focus.WorkspaceIdx < 0 || m.loop.Focus.TabIdx < 0 {
		m.toastQueue.SetFocusedTab("")
		return
	}
	if m.loop.Focus.WorkspaceIdx >= len(m.loop.Workspaces) {
		m.toastQueue.SetFocusedTab("")
		return
	}
	ws := m.loop.Workspaces[m.loop.Focus.WorkspaceIdx]
	if m.loop.Focus.TabIdx >= len(ws.Tabs) {
		m.toastQueue.SetFocusedTab("")
		return
	}
	m.toastQueue.SetFocusedTab(ws.Tabs[m.loop.Focus.TabIdx].ID)
}

// newPaneSeedFor builds a NewPaneSeed for the Ctrl+N path.
// The sessionId is generated locally for now; Phase 3f”
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

// chromeKeyName returns the canonical key token used by
// the chrome-state keybinds in Update (Ctrl+B sidebar, Ctrl+Z
// zoom, Ctrl+C quit, `?` help, Esc close, `q` quit). It exists
// because bubbletea v2's Key.String() drops the Ctrl prefix —
// a `Ctrl+B` keypress reports as String() == "b" and
// Keystroke() == "ctrl+b". We use a small normalizer so the
// switch in Update can use the same canonical names
// ("ctrl+b", "ctrl+c", "?", "esc", "q") that the existing
// router and help-overlay paths use.
func chromeKeyName(msg tea.KeyPressMsg) string {
	// Modifier prefix first so a Ctrl+C becomes "ctrl+c"
	// rather than "\x03" or "c".
	if msg.Mod&tea.ModCtrl != 0 {
		c := msg.Code
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		// Code 3 is the ASCII ETX control char that real
		// Ctrl+C sends; map it explicitly so the token stays
		// "ctrl+c" rather than "ctrl+\x03".
		if c == 3 {
			c = 'c'
		}
		if c == 0 && msg.Text != "" {
			c = rune(msg.Text[0])
			if c >= 'A' && c <= 'Z' {
				c += 'a' - 'A'
			}
		}
		return "ctrl+" + string(c)
	}
	if msg.Mod&tea.ModAlt != 0 {
		c := msg.Code
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		return "alt+" + string(c)
	}
	// No modifier — use String() which handles named keys
	// (esc, tab, enter, etc) and printable runes.
	return msg.String()
}

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
//
// Phase 4 chrome: the visual layer is owned by chrome.go so
// the data layer (this file) stays focused on input dispatch
// and state hydration. `renderChrome` is pure — it reads
// `m.loop` + the help / toast flags and returns a string,
// never mutates state.
func (m InteractiveModel) View() tea.View {
	var v tea.View
	if m.quitting {
		v.SetContent("")
		return v
	}
	v.AltScreen = m.altScreen
	if m.mouseCapture {
		v.MouseMode = tea.MouseModeCellMotion
	} else {
		v.MouseMode = tea.MouseModeNone
	}
	v.SetContent(renderChrome(m.loop, chromeViewState{
		HelpOpen: m.helpOpen,
		Toast:    m.activeToast(),
		Reconcile: reconcileFooterInfo{
			InFlight: m.reconcileInFlight,
			At:       m.lastReconcileAt,
			Result:   m.lastReconcile.result,
			Err:      m.lastReconcile.err,
		},
		Layout: layoutChromeState{
			SidebarCollapsed: m.sidebarCollapsed,
			ZoomFocused:      m.zoomFocused,
		},
	}))
	return v
}

// chromeViewState is the small bundle of runtime chrome
// flags the renderer needs but the LoopModel shouldn't
// carry. Keeping it as a separate struct means the data
// layer (model.go) stays free of any UI-flavored concept
// (help overlay, transient toast, reconcile indicator,
// layout toggles) — those are properties of the interactive
// driver, not the underlying state.
type chromeViewState struct {
	HelpOpen  bool
	Toast     string
	Reconcile reconcileFooterInfo
	Layout    layoutChromeState
}

// activeToast returns the current toast message if it's
// still inside the visibility window, or "" if it has
// expired. Chrome ignores empty strings, so a nil return
// is the same as "no toast right now".
func (m InteractiveModel) activeToast() string {
	if strings.TrimSpace(m.toastMessage) == "" || m.toastShownAt.IsZero() {
		return ""
	}
	if time.Since(m.toastShownAt) > toastTTL {
		return ""
	}
	return m.toastMessage
}

// SetToastForTest stamps a transient toast directly so
// smoke commands + non-Update tests can preview the
// chrome's toast line without driving a real persist.
// The toast obeys the same toastTTL window as the
// production path.
func (m *InteractiveModel) SetToastForTest(msg string, at time.Time) {
	m.toastMessage = msg
	m.toastShownAt = at
}

// SetHelpOpenForTest toggles the help-overlay flag
// without going through the `?` key handler. Used by the
// chrome smoke command; production code only flips this
// from Update.
func (m *InteractiveModel) SetHelpOpenForTest(open bool) {
	m.helpOpen = open
}

// SetReconcileForTest stamps a reconcile footer snapshot
// directly so chrome tests can exercise the "synced /
// syncing / failed" indicator shapes without driving a
// real reconciler pass. Mirrors SetToastForTest /
// SetHelpOpenForTest in spirit — the production path
// (handleReconcileTick / handleReconcileDone) owns the
// real writes.
func (m *InteractiveModel) SetReconcileForTest(info reconcileFooterInfo) {
	m.reconcileInFlight = info.InFlight
	m.lastReconcileAt = info.At
	m.lastReconcile = reconcileDoneMsg{result: info.Result, err: info.Err}
}

// SetLayoutForTest toggles the sidebar-collapse /
// focused-pane-zoom flags directly so chrome tests can
// exercise the layout variants without driving Ctrl+B /
// Ctrl+Z through Update.
func (m *InteractiveModel) SetLayoutForTest(layout layoutChromeState) {
	m.sidebarCollapsed = layout.SidebarCollapsed
	m.zoomFocused = layout.ZoomFocused
}

// SetHealthForTest injects a precomputed health response
// into the Update path so chrome tests can drive the
// merge + transition logic without standing up a fake
// Nexus. The merge runs synchronously; toast / sound
// side effects fire through whatever ToastQueue +
// SoundPlayer are attached (typically a FakeSoundPlayer
// in tests). Returns the same value as Update so callers
// can chain a follow-up .View() check in a single
// expression.
func (m *InteractiveModel) SetHealthForTest(resp api.LoopHealthResponse) tea.Cmd {
	return m.handleHealthDone(healthDoneMsg{resp: resp, at: time.Now()})
}

// SetLoopClientForTest attaches a loopClient + health
// interval after construction so existing tests can
// exercise the health tick driver without rebuilding the
// InteractiveModel. Mirrors SetReconcileForTest in
// spirit.
func (m *InteractiveModel) SetLoopClientForTest(client *api.Client, interval time.Duration) {
	m.loopClient = client
	m.healthInterval = interval
}

// SetRuntimeOptionsForTest mirrors the cmd/bbl-loop
// terminal flags without launching a real Bubble Tea
// program.
func (m *InteractiveModel) SetRuntimeOptionsForTest(altScreen, mouseCapture bool) {
	m.altScreen = altScreen
	m.mouseCapture = mouseCapture
}

// Store returns the snapshot Store attached at construction
// time (nil when the InteractiveModel was created without
// persistence). Used by cmd/bbl-loop's main() to flush
// pending writes when the bubbletea program exits.
func (m *InteractiveModel) Store() *Store { return m.store }

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
//
// Phase 5c: when store is non-nil, RunInteractive seeds the
// TUI from the persisted snapshot and flushes the store on
// shutdown. A nil store is the in-memory default (tests
// + `bbl loop --check`).
//
// Phase 5c': when reconciler is non-nil, RunInteractive
// schedules a tick every `reconcileInterval`; each tick
// calls Reconciler.RunOnce and posts the result back
// through reconcileDoneMsg. The reconciler shares the
// store with the model so server-pulled panes land in the
// in-memory snapshot the TUI sees.
func RunInteractive(model LoopModel, store *Store) error {
	return RunInteractiveWithReconciler(model, store, nil, 0)
}

// RunInteractiveWithReconciler is the Phase 5c' entry point
// that schedules periodic reconcile passes. Phase 5c / 5c'
// are split so the in-memory default and the background-sync
// default can be wired independently.
func RunInteractiveWithReconciler(
	model LoopModel,
	store *Store,
	reconciler *Reconciler,
	reconcileInterval time.Duration,
) error {
	prog := tea.NewProgram(NewInteractiveModelWithReconciler(model, store, reconciler, reconcileInterval))
	finalModel, err := prog.Run()
	if err != nil {
		if store != nil {
			_ = store.Close()
		}
		return fmt.Errorf("loop: bubbletea run: %w", err)
	}
	im, ok := finalModel.(InteractiveModel)
	if !ok {
		if store != nil {
			_ = store.Close()
		}
		return fmt.Errorf("loop: unexpected final model %T", finalModel)
	}
	if im.store != nil {
		_ = im.store.Close()
	}
	return nil
}
