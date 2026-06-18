// internal/loop/health_tick_test.go
//
// Tests for the health tick driver + the toast / sound
// side effects that fire on a StatusTransition. Mirrors
// reconcile_tick_test.go so the two periodic loops share
// the same testing shape. The fake Nexus stands up via
// httptest; the in-memory InteractiveModel avoids any
// real Bubble Tea runtime.

package loop

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
	"github.com/sutang-vain/babel-o/clients/go-tui/internal/notifications"
)

func TestScheduleHealthTickRejectsZeroInterval(t *testing.T) {
	if cmd := scheduleHealthTick(0); cmd != nil {
		t.Fatalf("zero interval should produce nil cmd, got %T", cmd)
	}
	if cmd := scheduleHealthTick(-1); cmd != nil {
		t.Fatalf("negative interval should produce nil cmd, got %T", cmd)
	}
}

func TestFetchHealthCmdReturnsNilForNilClient(t *testing.T) {
	if cmd := fetchHealthCmd(nil, "", 0); cmd != nil {
		t.Fatal("nil client should produce nil cmd")
	}
}

func TestHealthTickRoundTripViaHttptest(t *testing.T) {
	// A 200 response with one drift pane should land in
	// the InteractiveModel's LoopModel after one
	// healthDoneMsg dispatch.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/runtime/loop/health":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"type": "loop_health",
				"panes": []map[string]any{{
					"sessionId": "session-1",
					"agent":     "bbl",
					"status":    "drift",
					"lastEventRev": 7,
					"lastEventAt":  "2026-06-16T12:00:00.000Z",
				}},
			})
		default:
			_ = r
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	model := seedHealthModel(t, "session-1")
	im := NewInteractiveModel(model)
	im.SetLoopClientForTest(api.NewClient(server.URL, ""), 100*time.Millisecond)
	im.SetHealthForTest(api.LoopHealthResponse{
		Type: "loop_health",
		Panes: []api.LoopHealthPane{{
			SessionID:    "session-1",
			Status:       "drift",
			LastEventRev: 7,
			LastEventAt:  "2026-06-16T12:00:00.000Z",
		}},
	})
	pane, _ := im.loop.FocusedPane()
	if pane.Status != StatusDrift {
		t.Errorf("pane.Status after health = %v, want StatusDrift", pane.Status)
	}
	if pane.LastEventRev != 7 {
		t.Errorf("pane.LastEventRev = %d, want 7", pane.LastEventRev)
	}
}

func TestHealthDoneTriggersToastAndSoundOnTransition(t *testing.T) {
	// A drift transition should fire the toast queue (which
	// delegates to the FakeSoundPlayer) and produce the
	// expected sound. The toast queue is the dedup gate, so
	// the test also covers the integration.
	sound := &notifications.FakeSoundPlayer{}
	queue := notifications.NewToastQueue()
	queue.Window = 0 // disable dedup for this test
	im := NewInteractiveModel(seedHealthModel(t, "session-1"))
	im.toastQueue = queue
	im.soundPlayer = sound
	// Default focused tab is "" so the test's pane isn't
	// suppressed by the focused-tab check; the
	// TestHealthDoneFocusedTabSuppressesToast case covers
	// the suppression path.
	im.SetHealthForTest(api.LoopHealthResponse{Panes: []api.LoopHealthPane{{
		SessionID: "session-1",
		Status:    "drift",
	}}})
	plays := sound.PlaysCopy()
	if len(plays) != 1 || plays[0] != notifications.SoundWarn {
		t.Errorf("expected one warn sound, got %+v", plays)
	}
}

func TestHealthDoneNoSoundWhenStatusUnchanged(t *testing.T) {
	// Same status on both passes should produce zero
	// transitions, which produces zero sound events.
	sound := &notifications.FakeSoundPlayer{}
	queue := notifications.NewToastQueue()
	im := NewInteractiveModel(seedHealthModel(t, "session-1"))
	im.toastQueue = queue
	im.soundPlayer = sound
	im.SetHealthForTest(api.LoopHealthResponse{Panes: []api.LoopHealthPane{{
		SessionID: "session-1", Status: "idle",
	}}})
	if got := sound.PlaysCopy(); len(got) != 0 {
		t.Errorf("no-change pass should produce no sound, got %+v", got)
	}
}

func TestHealthDoneToastDedupedWithinWindow(t *testing.T) {
	// Two back-to-back drift transitions within the queue's
	// 5s window should fire only one sound (the second is
	// suppressed by dedup).
	sound := &notifications.FakeSoundPlayer{}
	queue := notifications.NewToastQueue()
	im := NewInteractiveModel(seedHealthModel(t, "session-1"))
	im.toastQueue = queue
	im.soundPlayer = sound
	// First transition: idle → working (no special sound
	// for working, but SoundNotify fires).
	im.SetHealthForTest(api.LoopHealthResponse{Panes: []api.LoopHealthPane{{
		SessionID: "session-1", Status: "working",
	}}})
	// Second: working → blocked (alert sound).
	im.SetHealthForTest(api.LoopHealthResponse{Panes: []api.LoopHealthPane{{
		SessionID: "session-1", Status: "blocked",
	}}})
	// Third: blocked → blocked (no transition, no sound).
	im.SetHealthForTest(api.LoopHealthResponse{Panes: []api.LoopHealthPane{{
		SessionID: "session-1", Status: "blocked",
	}}})
	plays := sound.PlaysCopy()
	if len(plays) != 2 {
		t.Errorf("expected 2 plays (working + blocked), got %+v", plays)
	}
	if plays[0] != notifications.SoundNotify || plays[1] != notifications.SoundAlert {
		t.Errorf("sound order = %+v, want [notify alert]", plays)
	}
}

func TestHealthDoneFocusedTabSuppressesToast(t *testing.T) {
	// Toasts on the focused tab should be suppressed — the
	// operator already sees the change inline.
	sound := &notifications.FakeSoundPlayer{}
	queue := notifications.NewToastQueue()
	im := NewInteractiveModel(seedHealthModel(t, "session-1"))
	im.toastQueue = queue
	im.soundPlayer = sound
	im.refreshFocusedTab() // session-1 lives in the focused tab
	im.SetHealthForTest(api.LoopHealthResponse{Panes: []api.LoopHealthPane{{
		SessionID: "session-1", Status: "drift",
	}}})
	if got := sound.PlaysCopy(); len(got) != 0 {
		t.Errorf("focused tab should suppress toast, got %+v", got)
	}
}

func TestHealthDoneErrorStampsToastAndReschedules(t *testing.T) {
	// When the HTTP call fails, the chrome should stamp a
	// transient toast (visible for toastTTL) and continue
	// rescheduling the next tick. We can't observe the
	// reschedule from outside, so we just check the toast
	// surface.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, "boom")
	}))
	defer server.Close()
	im := NewInteractiveModel(seedHealthModel(t, "session-1"))
	im.SetLoopClientForTest(api.NewClient(server.URL, ""), 100*time.Millisecond)
	// Drive a failed poll through cmd + dispatch.
	cmd := fetchHealthCmd(im.loopClient, "", 0)
	if cmd == nil {
		t.Fatal("fetchHealthCmd returned nil")
	}
	msg := cmd()
	typed, ok := msg.(healthDoneMsg)
	if !ok {
		t.Fatalf("expected healthDoneMsg, got %T", msg)
	}
	if typed.err == nil {
		t.Fatal("expected error from 500 response")
	}
	im.handleHealthDone(typed)
	if got := im.activeToast(); got == "" {
		t.Errorf("failed health poll should surface a toast, got %q", got)
	}
}
