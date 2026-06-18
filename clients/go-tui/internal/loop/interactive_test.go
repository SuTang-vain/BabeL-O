// internal/loop/interactive_test.go
//
// Phase 3f Bubble Tea adapter tests: Update handles
// WindowSize + KeyMsg (quit), View renders status bar + pane
// placeholder. Uses tea.NewProgram with WithInput(nil) so
// the test doesn't hang on stdin.

package loop

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

func TestInteractiveUpdateAppliesWindowSize(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	updated, _ := model.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	im, ok := updated.(InteractiveModel)
	if !ok {
		t.Fatalf("expected InteractiveModel, got %T", updated)
	}
	if im.loop.Width != 120 || im.loop.Height != 40 {
		t.Fatalf("expected 120x40, got %dx%d", im.loop.Width, im.loop.Height)
	}
}

func TestInteractiveUpdateQuitsOnCtrlC(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	_, cmd := model.Update(tea.KeyPressMsg(tea.Key{Code: 'c', Mod: tea.ModCtrl}))
	if cmd == nil {
		t.Fatal("Ctrl+C should produce a quit command")
	}
	// Execute the command in a goroutine with a timeout so a
	// stuck cmd doesn't hang the test.
	done := make(chan struct{})
	go func() {
		_ = cmd()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("tea.Quit command did not return in 2s")
	}
}

func TestInteractiveUpdateQuitsOnEsc(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	_, cmd := model.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEsc}))
	if cmd == nil {
		t.Fatal("Esc should produce a quit command")
	}
}

func TestInteractiveUpdateQuitsOnQ(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	_, cmd := model.Update(tea.KeyPressMsg(tea.Key{Code: 'q'}))
	if cmd == nil {
		t.Fatal("q should produce a quit command")
	}
}

func TestInteractiveUpdateIgnoresOtherKeys(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	_, cmd := model.Update(tea.KeyPressMsg(tea.Key{Code: 'a'}))
	if cmd != nil {
		t.Fatal("non-quit keys should not produce a command")
	}
}

func TestInteractiveViewRendersStatusBarAndPlaceholder(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	model.loop.Width = 80
	model.loop.Height = 24
	view := model.View()
	content := view.Content
	for _, want := range []string{"bbl loop", "no pane focused"} {
		if !strings.Contains(content, want) {
			t.Errorf("View missing %q\nfull:\n%s", want, content)
		}
	}
}

func TestInteractiveViewAppliesRuntimeOptions(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	model.loop.Width = 80
	model.loop.Height = 24

	defaultView := model.View()
	if !defaultView.AltScreen {
		t.Fatal("default bbl loop view should use alt screen")
	}
	if defaultView.MouseMode != tea.MouseModeCellMotion {
		t.Fatalf("default MouseMode = %v, want cell-motion capture", defaultView.MouseMode)
	}

	model.SetRuntimeOptionsForTest(false, false)
	plainView := model.View()
	if plainView.AltScreen {
		t.Fatal("--alt=false should disable alt screen")
	}
	if plainView.MouseMode != tea.MouseModeNone {
		t.Fatalf("--mouse=false MouseMode = %v, want none", plainView.MouseMode)
	}
}

func TestInteractiveViewRendersFocusedPaneMetadata(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	model.loop.Width = 80
	model.loop.Height = 24
	// Add a focused pane.
	tab := model.loop.Workspaces[0].Tabs[0]
	updated, err := tab.AddPane(PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: model.loop.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   "session-1",
		Agent:       "bbl",
		Cwd:         "/tmp",
		Status:      StatusDrift,
	})
	if err != nil {
		t.Fatalf("AddPane: %v", err)
	}
	model.loop.Workspaces[0].Tabs[0] = updated
	view := model.View()
	content := view.Content
	for _, want := range []string{"pane-1", "session-1", "drift"} {
		if !strings.Contains(content, want) {
			t.Errorf("View missing %q\nfull:\n%s", want, content)
		}
	}
}

func TestInteractiveViewEmptyAfterQuit(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	model.quitting = true
	if got := model.View().Content; got != "" {
		t.Fatalf("quitting model should render empty, got %q", got)
	}
}

func TestClampWidthFallback(t *testing.T) {
	if got := clampWidth(0, 40); got != 40 {
		t.Fatalf("clampWidth(0, 40) = %d, want 40", got)
	}
	if got := clampWidth(120, 40); got != 120 {
		t.Fatalf("clampWidth(120, 40) = %d, want 120", got)
	}
}

func TestPadFooter(t *testing.T) {
	if got := padFooter("q quit", 10); got != "q quit    " {
		t.Fatalf("padFooter short = %q, want padded", got)
	}
	if got := padFooter("very long footer", 5); got != "very long footer" {
		t.Fatalf("padFooter overflow should not truncate, got %q", got)
	}
}

func TestApplySnapshotToLoopHydratesPanes(t *testing.T) {
	model := NewLoopModel()
	snap := Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{
			{PaneID: "pane-1", WorkspaceID: "ws-default", TabID: "ws-default:1", SessionID: "session-1", Agent: "bbl", Cwd: "/tmp", Label: "main", LastRev: 7},
			{PaneID: "pane-2", WorkspaceID: "ws-default", TabID: "ws-default:1", SessionID: "session-2", Agent: "bbl", Cwd: "/tmp", Label: "logs", LastRev: 0},
		},
	}
	hydrated := applySnapshotToLoop(model, snap)
	if len(hydrated.Workspaces[0].Tabs[0].Panes) != 2 {
		t.Fatalf("expected 2 panes, got %d", len(hydrated.Workspaces[0].Tabs[0].Panes))
	}
	if hydrated.Workspaces[0].Tabs[0].Panes[0].PaneID != "pane-1" {
		t.Fatalf("pane[0] id = %q, want pane-1", hydrated.Workspaces[0].Tabs[0].Panes[0].PaneID)
	}
	if hydrated.Workspaces[0].Tabs[0].Panes[1].LastEventRev != 0 {
		t.Fatalf("pane[1] lastEventRev = %d, want 0", hydrated.Workspaces[0].Tabs[0].Panes[1].LastEventRev)
	}
}

func TestApplySnapshotToLoopEmptySnapshotIsNoop(t *testing.T) {
	model := NewLoopModel()
	if got := applySnapshotToLoop(model, Snapshot{Version: snapshotVersion}); got.Workspaces[0].Tabs[0].Panes != nil {
		t.Fatalf("empty snapshot should not produce panes, got %+v", got)
	}
}

func TestApplySnapshotToLoopSkipsLocalFakeSessionPane(t *testing.T) {
	model := NewLoopModel()
	snap := Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{
			{PaneID: "pane-fake", WorkspaceID: "ws-default", TabID: "ws-default:1", SessionID: "session-local-deadbeef", Agent: "bbl", Cwd: "/tmp", Label: "main", LastRev: 0},
			{PaneID: "pane-empty-cwd", WorkspaceID: "ws-default", TabID: "ws-default:1", SessionID: "session-real", Agent: "bbl", Cwd: "", Label: "main", LastRev: 0},
		},
	}
	hydrated := applySnapshotToLoop(model, snap)
	if len(hydrated.Workspaces[0].Tabs[0].Panes) != 0 {
		t.Fatalf("invalid snapshot panes should be skipped, got %+v", hydrated.Workspaces[0].Tabs[0].Panes)
	}
}

func TestNewInteractiveModelWithStoreHydrates(t *testing.T) {
	storePath := filepath.Join(t.TempDir(), "state.json")
	store, err := NewStore(storePath)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer store.Close()
	if err := store.Replace(Snapshot{
		Version: snapshotVersion,
		Panes: []PaneStateEntry{
			{PaneID: "pane-persist", WorkspaceID: "ws-default", TabID: "ws-default:1", SessionID: "session-persist", Agent: "bbl", Cwd: "/tmp", LastRev: 3},
		},
	}); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	store2, err := NewStore(storePath)
	if err != nil {
		t.Fatalf("NewStore reload: %v", err)
	}
	defer store2.Close()
	im := NewInteractiveModelWithStore(NewLoopModel(), store2)
	if im.store == nil {
		t.Fatal("store should be attached")
	}
	if len(im.loop.Workspaces[0].Tabs[0].Panes) != 1 {
		t.Fatalf("expected 1 hydrated pane, got %d", len(im.loop.Workspaces[0].Tabs[0].Panes))
	}
	if im.loop.Workspaces[0].Tabs[0].Panes[0].PaneID != "pane-persist" {
		t.Fatalf("hydrated pane id = %q, want pane-persist", im.loop.Workspaces[0].Tabs[0].Panes[0].PaneID)
	}
}

func TestInteractiveUpdatePersistsSnapshotOnDispatch(t *testing.T) {
	storePath := filepath.Join(t.TempDir(), "state.json")
	store, err := NewStore(storePath)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer store.Close()
	im := NewInteractiveModelWithStore(NewLoopModel(), store)
	_, _ = im.Update(tea.KeyPressMsg(tea.Key{Code: 'n', Mod: tea.ModCtrl}))
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	store2, err := NewStore(storePath)
	if err != nil {
		t.Fatalf("NewStore reload: %v", err)
	}
	defer store2.Close()
	snap := store2.Snapshot()
	if len(snap.Panes) != 1 || snap.Panes[0].SessionID == "" {
		t.Fatalf("snapshot should have the dispatched pane, got %+v", snap.Panes)
	}
}

func TestInteractiveCtrlNAllocatesServerSessionBeforePane(t *testing.T) {
	var createCalled bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/sessions":
			createCalled = true
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["clientSessionId"] == "" {
				t.Fatalf("CreateSession missing clientSessionId: %+v", body)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"type":"session_created","sessionId":"session-real","clientSessionId":"pane-1","createdAt":"2026-06-17T00:00:00Z"}`))
		case "/v1/sessions/session-real/wait":
			_, _ = w.Write([]byte(`{"type":"session_wait","sessionId":"session-real","events":[],"nextRevision":"0","matched":false}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := api.NewClient(server.URL, "test")
	im := NewInteractiveModelWithLoopClient(
		NewLoopModel(),
		nil,
		nil,
		0,
		client,
		0,
		nil,
		nil,
	)
	updated, cmd := im.Update(tea.KeyPressMsg(tea.Key{Code: 'n', Mod: tea.ModCtrl}))
	im = updated.(InteractiveModel)
	if cmd == nil {
		t.Fatal("Ctrl+N should allocate a server session")
	}
	msg := cmd()
	updated, readCmd := im.Update(msg)
	im = updated.(InteractiveModel)
	if !createCalled {
		t.Fatal("CreateSession was not called")
	}
	pane, ok := im.loop.FocusedPane()
	if !ok {
		t.Fatal("expected focused pane after session allocation")
	}
	if pane.SessionID != "session-real" {
		t.Fatalf("pane SessionID = %q, want session-real", pane.SessionID)
	}
	if strings.HasPrefix(pane.SessionID, "session-local-") {
		t.Fatalf("pane should not use fake local session id: %s", pane.SessionID)
	}
	if readCmd == nil {
		t.Fatal("successful pane creation should start a read command")
	}
}

func TestInteractiveModelWithNilStoreIsSafe(t *testing.T) {
	im := NewInteractiveModelWithStore(NewLoopModel(), nil)
	if im.store != nil {
		t.Fatal("nil store should stay nil")
	}
	updated, cmd := im.Update(tea.KeyPressMsg(tea.Key{Code: 'n', Mod: tea.ModCtrl}))
	if cmd != nil {
		t.Fatal("nil store should still dispatch fine")
	}
	if _, ok := updated.(InteractiveModel); !ok {
		t.Fatalf("unexpected model type %T", updated)
	}
}

func TestRawEventFromKeyMapsControlChords(t *testing.T) {
	cases := []struct {
		name    string
		code    rune
		mod     tea.KeyMod
		wantKey string
		wantOK  bool
	}{
		{"ctrl+n", 'n', tea.ModCtrl, "ctrl+n", true},
		{"ctrl+w", 'w', tea.ModCtrl, "ctrl+w", true},
		{"ctrl+h (lowercase a)", 'h', tea.ModCtrl, "ctrl+h", true},
		{"ctrl+shift+n (uppercase N)", 'N', tea.ModCtrl, "ctrl+n", true},
		{"plain a", 'a', 0, "a", true},
		{"esc plain", tea.KeyEsc, 0, "esc", true},
		{"tab plain", tea.KeyTab, 0, "tab", true},
		{"enter plain", tea.KeyEnter, 0, "enter", true},
		{"backspace plain", tea.KeyBackspace, 0, "backspace", true},
		{"pgup plain", tea.KeyPgUp, 0, "ctrl+pgup", true},
		{"pgdn plain", tea.KeyPgDown, 0, "ctrl+pgdn", true},
		{"left arrow", tea.KeyLeft, 0, "ctrl+left", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ev, ok := rawEventFromKey(tea.KeyPressMsg(tea.Key{Code: c.code, Mod: c.mod, Text: string(c.code)}))
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v", ok, c.wantOK)
			}
			if ok && ev.Key != c.wantKey {
				t.Fatalf("Key = %q, want %q", ev.Key, c.wantKey)
			}
		})
	}
}

func TestInteractiveUpdateCtrlNCreatesPane(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	before := len(model.loop.Workspaces[0].Tabs[0].Panes)
	updated, _ := model.Update(tea.KeyPressMsg(tea.Key{Code: 'n', Mod: tea.ModCtrl}))
	im := updated.(InteractiveModel)
	after := len(im.loop.Workspaces[0].Tabs[0].Panes)
	if after != before+1 {
		t.Fatalf("Ctrl+N should add a pane, panes %d -> %d", before, after)
	}
	if im.loop.Focus.PaneIdx != 0 {
		t.Fatalf("new pane should be focused, got PaneIdx=%d", im.loop.Focus.PaneIdx)
	}
}

func TestInteractiveUpdateCtrlWClosesPane(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	tab := model.loop.Workspaces[0].Tabs[0]
	updated, err := tab.AddPane(PaneModel{
		PaneID:      "pane-1",
		WorkspaceID: model.loop.Workspaces[0].ID,
		TabID:       tab.ID,
		SessionID:   "session-1",
	})
	if err != nil {
		t.Fatalf("AddPane: %v", err)
	}
	model.loop.Workspaces[0].Tabs[0] = updated
	before := len(model.loop.Workspaces[0].Tabs[0].Panes)
	updatedModel, _ := model.Update(tea.KeyPressMsg(tea.Key{Code: 'w', Mod: tea.ModCtrl}))
	im := updatedModel.(InteractiveModel)
	after := len(im.loop.Workspaces[0].Tabs[0].Panes)
	if after != before-1 {
		t.Fatalf("Ctrl+W should remove a pane, panes %d -> %d", before, after)
	}
}

func TestInteractiveUpdateCtrlHMovesFocusLeft(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	for i := 0; i < 3; i++ {
		updated, _ := model.loop.Workspaces[0].Tabs[0].AddPane(PaneModel{
			PaneID:      "pane-" + string(rune('a'+i)),
			WorkspaceID: model.loop.Workspaces[0].ID,
			TabID:       model.loop.Workspaces[0].Tabs[0].ID,
			SessionID:   "session-" + string(rune('a'+i)),
		})
		model.loop.Workspaces[0].Tabs[0] = updated
	}
	model.loop.Focus.PaneIdx = 2
	updated, _ := model.Update(tea.KeyPressMsg(tea.Key{Code: 'h', Mod: tea.ModCtrl}))
	im := updated.(InteractiveModel)
	if im.loop.Focus.PaneIdx != 1 {
		t.Fatalf("Ctrl+H from index 2 should land at 1, got %d", im.loop.Focus.PaneIdx)
	}
}

func TestInteractiveUpdateCtrlPgDnCyclesTab(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	ws := model.loop.Workspaces[0]
	ws = ws.AddTab("logs")
	model.loop.Workspaces[0] = ws
	if model.loop.Focus.TabIdx != 0 {
		t.Fatalf("starting TabIdx should be 0, got %d", model.loop.Focus.TabIdx)
	}
	updated, _ := model.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyPgDown, Mod: tea.ModCtrl}))
	im := updated.(InteractiveModel)
	if im.loop.Focus.TabIdx != 1 {
		t.Fatalf("Ctrl+PgDn from 0 should land at 1, got %d", im.loop.Focus.TabIdx)
	}
}

func TestInteractiveUpdateReleaseMsgIsNoop(t *testing.T) {
	model := NewInteractiveModel(NewLoopModel())
	updated, cmd := model.Update(tea.KeyReleaseMsg(tea.Key{Code: 'a'}))
	if cmd != nil {
		t.Fatal("KeyReleaseMsg should not produce a command")
	}
	im := updated.(InteractiveModel)
	// Check that no pane was created (the most common side effect
	// of accidental dispatch from KeyRelease).
	panes := im.loop.Workspaces[0].Tabs[0].Panes
	if len(panes) != 0 {
		t.Fatalf("KeyReleaseMsg should not mutate model, got %d panes", len(panes))
	}
}
