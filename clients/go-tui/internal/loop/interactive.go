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
	"context"
	"fmt"
	"os"
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
	defaultCwd        string
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
	// waitInFlight tracks per-pane wait poll state for
	// 6c (per-pane waitForEvent). A pane id is in the
	// map while a /v1/sessions/:id/wait call is
	// outstanding; scheduleWaitTick callers must check
	// first to avoid stacking concurrent polls on the
	// same pane. Cleared by handleWaitDone (deferred).
	waitInFlight map[string]bool
	// wsReadInFlight tracks per-pane WS stream read state
	// for 6d-c'-A (the opt-in WS read path). A pane id is
	// in the map while the /v1/sessions/:id/stream
	// connection is open; scheduleWsRead callers must
	// check first to avoid stacking concurrent streams
	// on the same pane. Cleared by handleWsReadEvent /
	// handleWsReadStarted on error / clean close. Mutually
	// exclusive with waitInFlight — a pane is on EITHER
	// the HTTP wait path OR the WS read path, not both.
	wsReadInFlight map[string]bool
	// wsReadCancels stores the per-pane cancel/close
	// funcs returned by api.StreamSession. close-pane
	// calls clearWsReadOnClose to stop the read so a
	// stale event that arrives after the pane is gone is
	// dropped.
	wsReadCancels map[string]wsReadHandles
	// useWsRead is the opt-in flag that switches the
	// per-pane read path from HTTP `waitForEvent` to WS
	// stream (6d-c'-A). Default false (HTTP wait) so
	// existing users see no behavior change. Production
	// wiring: a CLI flag / env var; tests use
	// SetUseWsReadForTest.
	useWsRead bool
	// useWsWrite is the opt-in flag that switches the
	// per-pane write path (submit / approve / deny /
	// cancel) from HTTP to WS command (6d-c'-B). Default
	// false (HTTP) so existing users see no behavior
	// change. When true, the 4 dispatchers
	// (submit/approve/deny/cancel) prefer
	// `client.SendCommand(action, payload)` and fall
	// back to the existing HTTP route on any
	// dial/read/write error (server doesn't yet speak
	// WS write, dial timeout, response timeout).
	useWsWrite bool
	// submitInFlight tracks per-pane HTTP /v1/execute
	// submissions (Phase 6d-b). It prevents Enter from
	// launching concurrent turns for the same pane while the
	// previous queued prompt is still running.
	submitInFlight map[string]bool
	quitting       bool
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
	// inboxInterval is the poll cadence for the
	// SessionChannel inbox tick (SessionChannel TUI
	// visibility Phase 1). Zero means polling is
	// disabled. The loop only fetches the *focused*
	// pane's session, so the surface stays bounded
	// regardless of how many panes are open.
	inboxInterval time.Duration
	// sessionInbox caches the most recent inbox snapshot
	// per session id, keyed by session id (not pane id —
	// a session may have multiple panes during its
	// lifetime). The chrome footer reads the focused
	// pane's entry; the sidebar reads every entry to
	// render unread badges. nil means "no snapshot yet";
	// the chrome treats nil as "no data, no badge".
	sessionInbox map[string]*api.SessionInboxResponse
	// executeTimeout is the HTTP /v1/execute timeout used
	// when a pane-local QueuedPrompt is submitted. Zero
	// falls back to defaultExecuteTimeoutMs.
	executeTimeout time.Duration
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
	// paneListOpen / scopeReviewOpen are 6d-overlay
	// flags: when true, the chrome splices the matching
	// overlay panel over the focused pane body. Lines
	// for the overlays are computed once at open time
	// (and re-computed on every View while the overlay
	// is open) so the chrome's render path stays free
	// of I/O. The flags mirror helpOpen's contract —
	// any key (esc/q/?/ctrl+c) closes the overlay.
	paneListOpen bool
	// paneListCursor is the row index into the structured
	// BuildPaneListRows output for the ctrl+j pane_list
	// overlay. 0 when no row is selected (e.g. the overlay
	// is closed). Reset to 0 every time the overlay is
	// toggled open so the operator lands on the first row
	// (the focused pane row is at index 1 in the typical
	// ws/tab/pane tree, but starting at 0 keeps the
	// "wherever I last navigated" out of the picture and
	// makes the up/down math trivial: clamp + wrap).
	//
	// 6d-f: row highlight + Enter-to-jump. The cursor
	// persists across View re-renders so the chrome can
	// apply the highlight consistently.
	paneListCursor  int
	scopeReviewOpen bool
	// scopeDriftOpen is the 6d-g toggle for the
	// scope_drift overlay (ctrl+d). The third overlay
	// per plan §4.5 / §6' — surfaces the list of panes
	// currently in StatusDrift with their live
	// boundary / evidence / memory counts.
	scopeDriftOpen bool
	// lastHealthForDrift captures the most recent
	// successful health response so the scope_drift
	// overlay can read live counts on every View. nil
	// when health hasn't polled yet — the overlay falls
	// back to a model-only "no drift reported" / rows.
	// This is the 6d-g counterpart to m.scopeReviewInput
	// for the 6d-e overlay.
	lastHealthForDrift *api.LoopHealthResponse
	// scopeReviewInput is the data bundle for the
	// scope_review overlay. nil means "no data yet"
	// (placeholder rendered). A later 6d slice will
	// populate this from the focused pane's last health
	// response; for now tests can inject it via
	// SetScopeReviewInputForTest.
	scopeReviewInput *ScopeReviewInput
	// permDialog is the 6d-c'-B-stepC multi-mode editor
	// state for the permission dialog. nil when the dialog
	// is in its base (Y/N only) mode or when no
	// PendingPermission is active. When non-nil, the
	// dialog renders in the sub-mode dictated by
	// permDialog.Mode, and key dispatch is intercepted
	// accordingly (1/2/3 for scope, D for deny reason,
	// R for rule edit). Cleared when PendingPermission
	// is cleared or when the dialog is dismissed.
	permDialog *permDialogState
	// wsObserver is the PR-17c (B1) per-CWD working-set
	// WS observer. nil means the observer is disabled
	// (e.g. in-memory / no-Nexus mode). The observer is
	// auto-started from Init via Start() and the
	// Update switch handles wsObserverConnectMsg /
	// wsObserverReconnectMsg / wsObserverEventMsg.
	// Stored on the model rather than passed around as
	// a side argument so the Add/Remove plumbing stays
	// symmetric with loopClient / reconciler.
	wsObserver *WorkingSetObserver
}

type createPaneSessionDoneMsg struct {
	PaneID    string
	SessionID string
	Cwd       string
	Err       error
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
	// SessionChannel TUI visibility Phase 1: default
	// the inbox poll to 10s — long enough that 20+ open
	// panes don't make /v1/sessions/:id/inbox a hot path,
	// short enough that an operator's reaction time isn't
	// gated on the next reconcile cycle. Set 0 to disable.
	im.inboxInterval = 10 * time.Second
	im.executeTimeout = defaultExecuteTimeout
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

// NewInteractiveModelWithExecuteTimeout applies the pane
// prompt submission timeout used by the 6d-b HTTP execute
// bridge. Non-positive values leave the existing default in
// place.
func NewInteractiveModelWithExecuteTimeout(model InteractiveModel, timeout time.Duration) InteractiveModel {
	if timeout > 0 {
		model.executeTimeout = timeout
	}
	return model
}

func NewInteractiveModelWithDefaultCwd(model InteractiveModel, cwd string) InteractiveModel {
	model.defaultCwd = cwd
	return model
}

// NewInteractiveModelWithWorkingSetObserver attaches the
// PR-17c (B1) per-CWD working-set WS observer to the
// InteractiveModel. The observer is auto-started from
// Init() so the operator gets the live working-set
// stream as soon as the TUI comes up. Pass `nil` to
// disable the observer (e.g. in-memory / no-Nexus
// mode). The reconciler pointer is captured on the
// observer itself (constructed in cmd/bbl-loop) — the
// model just stores the field; it does not call
// RunOnce directly.
func NewInteractiveModelWithWorkingSetObserver(model InteractiveModel, observer *WorkingSetObserver) InteractiveModel {
	model.wsObserver = observer
	return model
}

// applySnapshotToLoop returns `loop` updated to reflect the
// panes in `snap`. It is upsert-by-paneId: panes whose PaneID
// already exists in the focused tab have their metadata
// refreshed in place (Agent / Cwd / Label / LastEventRev, plus
// WorkspaceID/TabID if the snapshot disagrees); panes that
// don't exist are appended via AddPane. Status is preserved on
// existing panes (health poll owns status projection) and
// defaults to StatusIdle on fresh panes. The function is pure
// — the caller decides whether to persist.
//
// Upsert (rather than append-only) is what makes this safe to
// call repeatedly from handleReconcileDone: a pane the
// reconciler already pulled into the Store is refreshed, not
// duplicated, so periodic reconcile no longer causes the pane
// list to grow on every tick.
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
	if loop.Focus.TabIdx < 0 || loop.Focus.TabIdx >= len(ws.Tabs) {
		return loop
	}
	tab := ws.Tabs[loop.Focus.TabIdx]
	for _, entry := range filterValidPaneEntries(snap.Panes) {
		// Refresh metadata on an existing pane (matched by
		// PaneID) without touching its Status — the health
		// poll owns status projection, and a reconcile tick
		// must not clobber a live working/drift state back
		// to idle.
		updated := false
		for i := range tab.Panes {
			if tab.Panes[i].PaneID != entry.PaneID {
				continue
			}
			tab.Panes[i].WorkspaceID = entry.WorkspaceID
			tab.Panes[i].TabID = entry.TabID
			tab.Panes[i].SessionID = entry.SessionID
			tab.Panes[i].Agent = entry.Agent
			tab.Panes[i].Cwd = entry.Cwd
			tab.Panes[i].Label = entry.Label
			tab.Panes[i].LastEventRev = entry.LastRev
			updated = true
			break
		}
		if updated {
			continue
		}
		// New pane — append through AddPane so the
		// invariant checks (non-empty ids, parent match)
		// still run. A mismatched WorkspaceID/TabID from a
		// stale snapshot is dropped rather than corrupting
		// the tab; AddPane returns an error we swallow.
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
	// SessionChannel TUI visibility Phase 1: start the
	// inbox tick so the focused pane's unread / high-
	// priority summary lands in the footer + sidebar as
	// soon as the UI is up. Mirrors the health-tick
	// startup contract — nil client / zero interval
	// drops the tick.
	if m.loopClient != nil && m.inboxInterval > 0 {
		cmds = append(cmds, scheduleInboxTick(m.inboxInterval))
	}
	// Phase 6c / 6d-c'-A: start a per-pane read cmd for
	// every pane already in the model at startup. The
	// dispatcher (startAllReads) picks HTTP wait or WS
	// stream based on m.useWsRead (default HTTP wait for
	// backwards compatibility). This covers the case
	// where the user's Store has panes from a previous
	// bbl loop run (Phase 5a persistence) and we want
	// their transcripts to start filling in immediately.
	// Newly discovered panes are picked up by
	// handleReconcileDone after their first reconcile
	// tick.
	cmds = append(cmds, m.startAllReads()...)
	// PR-17c (B1): auto-start the working-set WS
	// observer. Default-on (no --ws-observe flag). The
	// observer manages its own backoff on read errors so
	// the TUI stays responsive when the server endpoint
	// isn't reachable; the reconciler REST polling
	// continues to keep the UI functional in that case.
	if m.wsObserver != nil {
		cmds = append(cmds, m.wsObserver.Start(context.Background()))
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

	case inboxTickMsg:
		return m, m.handleInboxTick()

	case inboxDoneMsg:
		return m, m.handleInboxDone(msg)

	case waitDoneMsg:
		return m, m.handleWaitDone(msg)

	case createPaneSessionDoneMsg:
		return m, m.handleCreatePaneSessionDone(msg)

	case wsReadBatchMsg:
		// 6d-c'-A: WS read handle arrived. Store the
		// channels + cancel/close funcs and schedule
		// the first continue read.
		return m, m.handleWsReadStarted(msg)

	case wsEventMsg:
		// 6d-c'-A: a per-event / per-error message from
		// the open WS stream. Append / heartbeat / error
		// branch lives in handleWsReadEvent.
		return m, m.handleWsReadEvent(msg)

	case wsObserverConnectMsg:
		// PR-17c (B1): the working-set WS dial
		// finished. On success we kick off a per-event
		// drain cmd and remember the close fn for
		// shutdown. On dial failure we schedule a
		// backoff reconnect.
		return m, m.handleWsObserverConnect(msg)

	case wsObserverReconnectMsg:
		// PR-17c (B1): a previously scheduled backoff
		// reconnect fired. Re-dial.
		if msg.observer == nil {
			return m, nil
		}
		return m, msg.observer.ConnectCmd()

	case wsObserverEventMsg:
		// PR-17c (B1): one server-pushed working-set
		// frame. The handle dispatches by Type (snapshot
		// / updated / reset / error) and schedules the
		// next read so the same channel keeps flowing.
		return m, m.handleWsObserverEvent(msg)

	case wsObserverErrMsg:
		// PR-17c (B1): a read error / clean close from
		// the observer's stream. Schedules a backoff
		// reconnect and (if the observer was previously
		// connected) a Reconciler.RunOnce drift repair.
		return m, m.handleWsObserverErr(msg)

	case wsObserverReconcileDoneMsg:
		// PR-17c (B1): post-reconnect reconciler pass
		// finished. The store + model are already
		// updated; the message is currently a no-op,
		// reserved for future toasts / diagnostics.
		return m, nil

	case b2TraceLoadedMsg:
		// PR-B2: fetch trace response arrived. The overlay
		// state has already been updated by the fetch
		// goroutine; we just need a re-render tick.
		return m, HandleB2TraceLoaded(msg)

	case submitDoneMsg:
		return m, m.handleSubmitDone(msg)

	case permissionDecisionMsg:
		return m, m.handlePermissionDecision(msg)

	case cancelDoneMsg:
		return m, m.handleCancelDone(msg)

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
		// 6d-overlay: pane_list (ctrl+j) and
		// scope_review (ctrl+r) overlays. Each opens
		// until the operator dismisses with esc/q/?/
		// ctrl+c. We close on the same keys as help so
		// the dismissal muscle memory is consistent
		// across overlays. The toggle key is also a
		// dismiss key (pressing ctrl+j while pane_list
		// is open closes it). Other keys while the
		// overlay is up are swallowed (mirrors
		// helpOpen), BUT the other overlay's toggle
		// key is allowed through so the operator can
		// switch between overlays without dismissing
		// first.
		if m.paneListOpen {
			switch chromeKeyName(msg) {
			case "esc", "q", "ctrl+c", "ctrl+j":
				m.paneListOpen = false
				m.paneListCursor = 0
				return m, nil
			case "ctrl+r", "ctrl+d", "?":
				// Allow scope_review / scope_drift /
				// help to open on top of pane_list —
				// fall through to the main switch.
				break
			case "up":
				m.paneListCursor = m.movePaneListCursor(-1)
				return m, nil
			case "down":
				m.paneListCursor = m.movePaneListCursor(+1)
				return m, nil
			case "enter":
				// Enter on a pane row jumps focus to
				// that pane and dismisses the overlay;
				// Enter on a workspace / tab row is a
				// noop (the cursor stays put, the
				// overlay stays open — operator can
				// keep navigating).
				if jumped := m.jumpPaneListCursorToFocus(); jumped {
					m.paneListOpen = false
					m.paneListCursor = 0
				}
				return m, nil
			}
			key := chromeKeyName(msg)
			if key != "ctrl+r" && key != "ctrl+d" && key != "?" {
				return m, nil
			}
		}
		if m.scopeReviewOpen {
			switch chromeKeyName(msg) {
			case "esc", "q", "ctrl+c", "ctrl+r":
				m.scopeReviewOpen = false
				return m, nil
			case "ctrl+j", "ctrl+d", "?":
				// Allow pane_list / scope_drift / help
				// to open on top of scope_review — fall
				// through.
				break
			}
			key := chromeKeyName(msg)
			if key != "ctrl+j" && key != "ctrl+d" && key != "?" {
				return m, nil
			}
		}
		if m.scopeDriftOpen {
			switch chromeKeyName(msg) {
			case "esc", "q", "ctrl+c", "ctrl+d":
				m.scopeDriftOpen = false
				return m, nil
			case "ctrl+j", "ctrl+r", "?":
				// Allow pane_list / scope_review / help
				// to open on top of scope_drift — fall
				// through.
				break
			}
			key := chromeKeyName(msg)
			if key != "ctrl+j" && key != "ctrl+r" && key != "?" {
				return m, nil
			}
		}
		// 6d-c: pending permission dialog intercepts Y/Enter
		// (approve) and N (deny) BEFORE the quit-key block
		// and the router dispatch. The dialog is modal — the
		// operator can't drive other UI until they decide.
		// We deliberately keep the quit keys alive
		// (ctrl+c/esc/q still quit) so a misbehaving
		// permission_request can't trap the operator in
		// the TUI.
		//
		// 6d-c'-B-stepC: sub-mode keybinds extend the
		// modal block. 1/2/3 enter scope-picker mode,
		// D enters deny-reason mode, R enters rule-edit
		// mode. In sub-modes, printable keys edit the
		// draft, backspace deletes, Enter commits, Esc
		// returns to base.
		if pane, ok := m.loop.FocusedPane(); ok && pane.PendingPermission != nil {
			key := chromeKeyName(msg)
			// Sub-mode key dispatch.
			if m.permDialog != nil {
				switch m.permDialog.Mode {
				case permDialogScope:
					switch key {
					case "1":
						m.permDialog.Scope = "once"
						return m, m.dispatchPermissionDecisionWithState(pane, "approve")
					case "2":
						m.permDialog.Scope = "session"
						return m, m.dispatchPermissionDecisionWithState(pane, "approve")
					case "3":
						m.permDialog.Scope = "rule"
						return m, m.dispatchPermissionDecisionWithState(pane, "approve")
					case "esc":
						m.permDialog = nil
						return m, nil
					}
					return m, nil
				case permDialogReason:
					switch key {
					case "enter":
						return m, m.dispatchPermissionDecisionWithState(pane, "deny")
					case "esc":
						m.permDialog = nil
						return m, nil
					case "backspace":
						m.permDialog.Reason = dropLastRune(m.permDialog.Reason)
						return m, nil
					default:
						if isPrintableKey(key) {
							m.permDialog.Reason += key
						}
						return m, nil
					}
				case permDialogRule:
					switch key {
					case "enter":
						return m, m.dispatchPermissionDecisionWithState(pane, "approve")
					case "esc":
						m.permDialog = nil
						return m, nil
					case "backspace":
						m.permDialog.Rule = dropLastRune(m.permDialog.Rule)
						return m, nil
					default:
						if isPrintableKey(key) {
							m.permDialog.Rule += key
						}
						return m, nil
					}
				default:
					m.permDialog = nil
					return m, nil
				}
			}
			// Base mode key dispatch.
			switch key {
			case "y", "enter":
				return m, m.dispatchPermissionDecision(pane, pane.PendingPermission, "approve")
			case "n":
				return m, m.dispatchPermissionDecision(pane, pane.PendingPermission, "deny")
			// 6d-c'-B-stepC: sub-mode entry keys.
			case "1", "2", "3":
				scope := "once"
				switch key {
				case "2":
					scope = "session"
				case "3":
					scope = "rule"
				}
				m.permDialog = &permDialogState{
					Mode:  permDialogScope,
					Perm:  pane.PendingPermission,
					Scope: scope,
				}
				return m, nil
			case "d":
				m.permDialog = &permDialogState{
					Mode: permDialogReason,
					Perm: pane.PendingPermission,
				}
				return m, nil
			case "r":
				rule := pane.PendingPermission.SuggestedRule
				m.permDialog = &permDialogState{
					Mode:  permDialogRule,
					Perm:  pane.PendingPermission,
					Rule:  rule,
					Scope: "rule",
				}
				return m, nil
			}
			// Swallow other keys while the dialog is up
			// so they don't trigger input / router actions
			// underneath.
			return m, nil
		}
		// 6d-d: Esc on a pane with an in-flight submit
		// becomes a cancel instead of a quit. The
		// operator's "Esc to bail out of the current
		// thing" muscle memory maps cleanly: if there's
		// something running, Esc cancels it; if there
		// isn't, Esc still quits the program.
		if chromeKeyName(msg) == "esc" {
			if pane, ok := m.loop.FocusedPane(); ok {
				if pane.SessionID != "" &&
					(m.isSubmitInFlight(pane.PaneID) || pane.InterruptionActive) {
					return m, m.requestCancelForPane(pane)
				}
			}
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
		case "ctrl+j":
			// 6d-overlay: pane_list overlay. Lists every
			// workspace / tab / pane in the LoopModel
			// using BuildPaneListLines — the data is
			// already on the model so opening the
			// overlay doesn't trigger any I/O. Same
			// dismiss contract as help (`esc` / `q` /
			// `ctrl+c` / `ctrl+j` again). 6d-f: when
			// opening, reset the cursor to 0 so the
			// operator lands on the first row.
			m.paneListOpen = !m.paneListOpen
			if m.paneListOpen {
				m.paneListCursor = 0
			}
			return m, nil
		case "ctrl+r":
			// 6d-overlay: scope review overlay. Pulls
			// the task scope / pending boundaries /
			// out-of-scope evidence from the focused
			// pane's last health response (or shows a
			// "no scope data yet" placeholder when the
			// data hasn't been fetched — health is
			// best-effort, the overlay degrades
			// gracefully).
			m.scopeReviewOpen = !m.scopeReviewOpen
			return m, nil
		case "ctrl+d":
			// 6d-g: scope_drift overlay. The third
			// overlay per plan §4.5 / §6'. Lists every
			// pane currently in StatusDrift (and the
			// live boundary / evidence / memory counts
			// from the most recent health poll).
			// Distinct from scope_review which zooms
			// into the focused pane's full taskScope.
			// Dismiss contract mirrors help / pane_list
			// (esc / q / ctrl+c / the toggle key).
			m.scopeDriftOpen = !m.scopeDriftOpen
			return m, nil
		case "v":
			// PR-B2: behavior trace overlay. Opens the
			// centered trace panel for the focused pane
			// when Status == StatusBehaviorHint; dismiss
			// contract mirrors other overlays (esc/q/
			// ctrl+c / the toggle key). Falls through
			// to the router when the precondition is
			// not met (e.g. focused pane is idle).
			if handled, cmd := HandleViewTraceKey(msg, &m); handled {
				return m, cmd
			}
			// else fall through to router
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
		// Phase 6c: capture the closing pane id BEFORE
		// mutating m.loop, then clear its wait in-flight
		// state. ApplyClosePane is pure (it just
		// manipulates the LoopModel), so the InteractiveModel
		// bookkeeping has to happen at the call site.
		if closed, ok := m.loop.FocusedPane(); ok {
			m.clearWaitOnClose(closed.PaneID)
			// 6d-c'-A: also clear the WS read in-flight
			// state + cancel the WS connection. The
			// close-pane site owns both so a stale
			// event that arrives after the pane is gone
			// is dropped.
			m.clearWsReadOnClose(closed.PaneID)
		}
		m.loop = ApplyClosePane(m.loop)
	case RouteNewPane:
		if m.loopClient != nil {
			paneID := NewID("pane")
			m.toastMessage = "creating pane session..."
			m.toastShownAt = time.Now()
			return createPaneSessionCmd(m.loopClient, paneID, firstNonEmpty(m.defaultCwd, defaultPaneCwd(event)))
		}
		m.loop, _ = ApplyNewPane(m.loop, newPaneSeedFor(event))
	case RouteMoveFocus:
		m.loop = ApplyMoveFocus(m.loop, route.Direction)
	case RouteNextTab:
		m.loop = ApplyNextTab(m.loop)
	case RoutePrevTab:
		m.loop = ApplyPrevTab(m.loop)
	case RouteFocusPane:
		var result PaneInputResult
		m.loop, result = ApplyPaneInputEvent(m.loop, route.Payload)
		if !result.Mutated {
			return nil
		}
		if submitted := strings.TrimSpace(result.Submitted); submitted != "" {
			m.toastMessage = "queued prompt: " + truncatePlain(singleLine(submitted), 80)
			m.toastShownAt = time.Now()
			if pane, ok := m.loop.FocusedPane(); ok {
				return m.startSubmitForPane(pane)
			}
		}
		return nil
	case RouteNewWorkspace, RouteCloseWorkspace, RouteResize, RouteNone:
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

// newPaneSeedFor builds a NewPaneSeed for the Ctrl+N fallback
// path used only when no Nexus client is attached. Real bbl
// loop panes allocate a canonical server-side session through
// POST /v1/sessions before calling ApplyNewPane.
func newPaneSeedFor(_ RawEvent) NewPaneSeed {
	return NewPaneSeed{
		PaneID:    NewID("pane"),
		Agent:     "bbl",
		Cwd:       defaultPaneCwd(RawEvent{}),
		Label:     "main",
		SessionID: "offline-" + NewID("pane"),
	}
}

func defaultPaneCwd(_ RawEvent) string {
	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}
	return ""
}

func createPaneSessionCmd(client *api.Client, paneID string, cwd string) tea.Cmd {
	if client == nil || paneID == "" {
		return nil
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		resp, err := client.CreateSession(ctx, api.CreateSessionRequest{
			Cwd:             cwd,
			ClientSessionID: paneID,
			Metadata: map[string]any{
				"client":     "bbl-loop",
				"entrypoint": "bbl loop",
				"paneId":     paneID,
			},
		})
		if err != nil {
			return createPaneSessionDoneMsg{PaneID: paneID, Cwd: cwd, Err: err}
		}
		return createPaneSessionDoneMsg{PaneID: paneID, SessionID: resp.SessionID, Cwd: cwd}
	}
}

func (m *InteractiveModel) handleCreatePaneSessionDone(msg createPaneSessionDoneMsg) tea.Cmd {
	if msg.Err != nil {
		m.toastMessage = "✗ create pane session failed: " + msg.Err.Error()
		m.toastShownAt = time.Now()
		return nil
	}
	if msg.SessionID == "" {
		m.toastMessage = "✗ create pane session failed: empty session id"
		m.toastShownAt = time.Now()
		return nil
	}
	seed := NewPaneSeed{
		PaneID:    msg.PaneID,
		SessionID: msg.SessionID,
		Agent:     "bbl",
		Cwd:       msg.Cwd,
		Label:     "main",
	}
	var err error
	m.loop, err = ApplyNewPane(m.loop, seed)
	if err != nil {
		m.toastMessage = "✗ add pane failed: " + err.Error()
		m.toastShownAt = time.Now()
		return nil
	}
	m.refreshFocusedTab()
	m.persistSnapshot()
	m.toastMessage = "created pane session: " + shortSessionID(msg.SessionID)
	m.toastShownAt = time.Now()
	if pane, ok := m.loop.FocusedPane(); ok {
		return m.startReadForPane(pane)
	}
	return nil
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
// The pane body renders Nexus-backed transcript rows when
// available and otherwise falls back to a neutral wait-state
// placeholder.
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
	traceOpen, traceLines := B2TraceViewState()
	v.SetContent(renderChrome(m.loop, chromeViewState{
		HelpOpen:        m.helpOpen,
		Toast:           m.activeToast(),
		PaneListOpen:    m.paneListOpen,
		ScopeReviewOpen: m.scopeReviewOpen,
		// 6d-g: third overlay flag + line buffer for
		// scope_drift (ctrl+d). The chrome layer reads
		// these as part of its overlay splice path.
		ScopeDriftOpen: m.scopeDriftOpen,
		PaneListLines:  m.activePaneListLines(),
		// 6d-f: pass the structured rows + cursor so the
		// chrome can apply a `▸ ` highlight to the row at
		// index `paneListCursor`. The legacy `PaneListLines`
		// path stays for tests + non-overlay renderers.
		PaneListCursor:   m.cursorForChrome(),
		ScopeReviewLines: m.activeScopeReviewLines(),
		ScopeDriftLines:  m.activeScopeDriftLines(),
		// PR-B2: behavior trace overlay (v key).
		// State is package-level via B2TraceViewState.
		TraceOverlayOpen:  traceOpen,
		TraceOverlayLines: traceLines,
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
// layout toggles, overlay toggles) — those are properties
// of the interactive driver, not the underlying state.
//
// PaneListLines / ScopeReviewLines are the precomputed
// line buffers the overlay renderers splice into the
// chrome. The InteractiveModel recomputes them at View
// time so any state change since the last render is
// reflected (e.g. a new pane added via reconcile shows
// up the next time the operator opens ctrl+j). The
// renderers themselves are pure — no I/O, no model
// access — so the chrome layer stays data-free.
type chromeViewState struct {
	HelpOpen        bool
	Toast           string
	PaneListOpen    bool
	ScopeReviewOpen bool
	// ScopeDriftOpen is the 6d-g flag for the
	// scope_drift overlay (ctrl+d). When true the
	// chrome splices the scope_drift panel on top of
	// the existing content.
	ScopeDriftOpen bool
	PaneListLines  []string
	// PaneListCursor is the row index for the 6d-f
	// row-highlight feature. The chrome layer applies a
	// `▸ ` prefix to the row at this index (in addition
	// to the existing focus marker on the actually-
	// focused pane row). -1 means "no row highlighted"
	// (used when the overlay is closed so the chrome
	// skips the highlight loop).
	PaneListCursor   int
	ScopeReviewLines []string
	// ScopeDriftLines is the precomputed line buffer for
	// the 6d-g scope_drift overlay. Computed by
	// activeScopeDriftLines in View-time from
	// BuildScopeDriftInputFromHealth so the chrome
	// doesn't need to know about api types.
	ScopeDriftLines []string
	// TraceOverlayOpen is the PR-B2 flag for the
	// behavior_trace overlay (v key). When true the
	// chrome splices the trace panel on top of the
	// existing content. Mirrors ScopeDriftOpen.
	TraceOverlayOpen bool
	// TraceOverlayLines are the pre-computed display
	// lines returned by B2TraceViewState. Populated by
	// View() so the chrome renderer stays I/O-free.
	TraceOverlayLines []string
	Reconcile         reconcileFooterInfo
	Layout            layoutChromeState
}

// activePaneListLines returns the line buffer for the
// pane_list overlay. Computed from the current LoopModel
// via the existing BuildPaneListLines pure function. Nil
// when the overlay is closed so the chrome's
// PaneListOpen guard can short-circuit.
func (m InteractiveModel) activePaneListLines() []string {
	if !m.paneListOpen {
		return nil
	}
	return BuildPaneListLines(m.loop)
}

// paneListRowsForChrome returns the structured row slice
// for the chrome to render with cursor highlight. Mirrors
// activePaneListLines but exposes the typed `paneRow`
// values so renderPaneListPanel can apply the `▸ `
// highlight to the row at index `paneListCursor`. 6d-f
// addition: the chrome layer needs structured access to
// apply the highlight without re-parsing the plain-text
// lines.
func (m InteractiveModel) paneListRowsForChrome() []paneRow {
	if !m.paneListOpen {
		return nil
	}
	return BuildPaneListRows(m.loop)
}

// cursorForChrome is the small adapter that maps
// `paneListCursor` to a sentinel the chrome layer can
// branch on. Returns -1 when the overlay is closed so the
// chrome skips the highlight loop entirely.
func (m InteractiveModel) cursorForChrome() int {
	if !m.paneListOpen {
		return -1
	}
	return m.paneListCursor
}

// movePaneListCursor advances the row cursor by `delta`.
// Wraps around when the cursor goes past either end. When
// the row slice is empty the cursor stays at 0 so the
// next navigation has a stable starting point. 6d-f: the
// up/down dispatch in Update path delegates here so the
// math is unit-testable in isolation.
func (m InteractiveModel) movePaneListCursor(delta int) int {
	rows := BuildPaneListRows(m.loop)
	if len(rows) == 0 {
		return 0
	}
	cur := m.paneListCursor + delta
	if cur < 0 {
		cur = len(rows) - 1
	} else if cur >= len(rows) {
		cur = 0
	}
	return cur
}

// jumpPaneListCursorToFocus looks up the row at the
// current cursor; if it's a pane row, applies
// ApplyFocusPath to the underlying model and returns true.
// Returns false (no jump) for workspace / tab rows so the
// operator's "Enter on a non-pane row" is a soft noop
// rather than a confusing "nothing happened, the overlay
// closed anyway" UX. The mutation is written through the
// LoopModel field on `m` so the next View() reflects the
// new focus path.
func (m *InteractiveModel) jumpPaneListCursorToFocus() bool {
	rows := BuildPaneListRows(m.loop)
	if m.paneListCursor < 0 || m.paneListCursor >= len(rows) {
		return false
	}
	row := rows[m.paneListCursor]
	if row.Kind != paneRowPane {
		return false
	}
	// Find the (workspaceIdx, tabIdx, paneIdx) for the
	// selected pane. ApplyFocusPath bounds-checks again
	// so a stale model (pane closed between cursor set
	// and Enter) doesn't panic.
	for wi, ws := range m.loop.Workspaces {
		if ws.ID != row.WorkspaceID {
			continue
		}
		for ti, tab := range ws.Tabs {
			if tab.ID != row.TabID {
				continue
			}
			for pi, pane := range tab.Panes {
				if pane.PaneID == row.PaneID {
					m.loop = ApplyFocusPath(m.loop, wi, ti, pi)
					return true
				}
			}
		}
	}
	return false
}

// activeScopeReviewLines returns the line buffer for the
// scope_review overlay. The data is sourced from the
// focused pane's last health response (the
// /v1/runtime/loop/health endpoint already returns
// per-pane taskScope with primaryRoot / pendingBoundaries
// / outOfScopeEvidence). For 6d-overlay step 1 the
// InteractiveModel only has the LoopModel + a
// pre-bundled ScopeReviewInput; the caller (a later
// slice that wires the data) supplies it via
// SetScopeReviewInputForTest. With no input the overlay
// shows a "no scope data yet" placeholder so the chrome
// always renders something.
func (m InteractiveModel) activeScopeReviewLines() []string {
	if !m.scopeReviewOpen {
		return nil
	}
	if m.scopeReviewInput == nil {
		return []string{
			"Scope review",
			"  no scope data yet",
			"  wait for the next health poll",
			"  (or wire ScopeReviewInput)",
		}
	}
	return BuildScopeReviewLines(*m.scopeReviewInput)
}

// activeScopeDriftLines returns the line buffer for the
// 6d-g scope_drift overlay (ctrl+d). Sourced from
// BuildScopeDriftInputFromHealth which walks the model
// for drift-status panes and lifts counts from the
// latest health response. With no drift panes the
// overlay shows a "no drift reported" placeholder so
// the chrome always renders something meaningful.
func (m InteractiveModel) activeScopeDriftLines() []string {
	if !m.scopeDriftOpen {
		return nil
	}
	// Use the most recent health response if we've
	// captured one (via SetLastHealthForTest); fall
	// back to a model-only input so the overlay can
	// still render the "no drift reported" placeholder
	// in early startup.
	if m.lastHealthForDrift == nil {
		return BuildScopeDriftLines(ScopeDriftInput{Model: m.loop})
	}
	return BuildScopeDriftLines(*BuildScopeDriftInputFromHealth(m.loop, *m.lastHealthForDrift))
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

// SetScopeReviewInputForTest attaches a precomputed
// ScopeReviewInput to the InteractiveModel so the
// scope_review overlay can render with real data in
// tests / chrome smoke commands. A later 6d slice will
// populate this from the focused pane's last health
// response automatically; for now the wiring is test-only.
func (m *InteractiveModel) SetScopeReviewInputForTest(in *ScopeReviewInput) {
	m.scopeReviewInput = in
}

// SetHealthForDriftForTest stamps a precomputed health
// response so the 6d-g scope_drift overlay can render
// live data without driving a real /v1/runtime/loop/health
// poll. The production path (handleHealthDone) sets
// `lastHealthForDrift` from the actual health fetch.
// Tests use this to seed the cache and assert that the
// overlay surfaces per-pane counts. Mirrors
// SetScopeReviewInputForTest in spirit.
func (m *InteractiveModel) SetHealthForDriftForTest(h *api.LoopHealthResponse) {
	m.lastHealthForDrift = h
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
