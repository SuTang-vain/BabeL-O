// Package notifications implements Phase 4b sound + toast
// suppression for the bbl loop driver. The package is pure:
// SoundPlayer is an interface so tests can capture the play
// log without touching the host audio stack; ToastQueue
// enforces a dedup window and tab-aware suppression so the
// same (pane, status) does not spam the user.
//
// macOS / Linux / Windows hooks live behind SoundPlayer;
// Phase 4b' will add platform implementations; tests use
// FakeSoundPlayer.
package notifications

import (
	"sync"
	"time"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop"
)

// SoundName is a string token the SoundPlayer maps to a
// platform audio file / system beep. Keeping this as a typed
// string avoids hard-coding audio paths inside the loop
// package and lets tests assert on intent.
type SoundName string

const (
	SoundNone   SoundName = ""
	SoundChime  SoundName = "chime"
	SoundWarn   SoundName = "warn"
	SoundAlert  SoundName = "alert"
	SoundNotify SoundName = "notify"
)

// SoundForStatus maps a PaneStatus to its canonical sound.
// The mapping matches the plan's section 4 closure criteria:
// drift / blocked / done have distinct sounds; idle / working
// / waiting share a quiet notify (or none).
func SoundForStatus(status loop.PaneStatus) SoundName {
	switch status {
	case StatusDone():
		return SoundChime
	case StatusDrift():
		return SoundWarn
	case StatusBlocked():
		return SoundAlert
	case StatusWaiting(), StatusWorking(), StatusIdle():
		return SoundNotify
	default:
		return SoundNone
	}
}

// StatusDone / StatusDrift / StatusBlocked thin wrappers so
// the package can use the loop.PaneStatus type without
// importing its constants in every call site.
func StatusDone() loop.PaneStatus    { return loop.StatusDone }
func StatusDrift() loop.PaneStatus   { return loop.StatusDrift }
func StatusBlocked() loop.PaneStatus { return loop.StatusBlocked }
func StatusWaiting() loop.PaneStatus { return loop.StatusWaiting }
func StatusWorking() loop.PaneStatus { return loop.StatusWorking }
func StatusIdle() loop.PaneStatus    { return loop.StatusIdle }

// SoundPlayer is the platform audio abstraction.
type SoundPlayer interface {
	Play(name SoundName) error
}

// FakeSoundPlayer captures Play calls for tests.
type FakeSoundPlayer struct {
	mu    sync.Mutex
	Plays []SoundName
}

func (f *FakeSoundPlayer) Play(name SoundName) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Plays = append(f.Plays, name)
	return nil
}

// ToastEvent is one recordable toast before suppression.
type ToastEvent struct {
	PaneID  string
	TabID   string
	Status  loop.PaneStatus
	Sound   SoundName
	Message string
	Now     time.Time
}

// ToastQueue deduplicates toasts within a configurable
// window and suppresses notifications for tabs the user is
// already viewing.
type ToastQueue struct {
	mu sync.Mutex

	// Window is the dedup horizon: a repeat (paneID, status)
	// within Window is suppressed.
	Window time.Duration

	// Now is the clock; tests can override for determinism.
	Now func() time.Time

	// lastSeen tracks the last accepted time per (pane, status).
	lastSeen map[string]time.Time

	// focusedTabID is the tab the user is currently looking
	// at; toasts for that tab are suppressed (the user
	// already sees the change inline).
	focusedTabID string
}

// NewToastQueue returns a queue with default 5s dedup window.
func NewToastQueue() *ToastQueue {
	return &ToastQueue{
		Window:   5 * time.Second,
		Now:      time.Now,
		lastSeen: make(map[string]time.Time),
	}
}

// SetFocusedTab records which tab the user is currently
// viewing so toasts on that tab can be suppressed.
func (q *ToastQueue) SetFocusedTab(tabID string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.focusedTabID = tabID
}

// Enqueue decides whether to accept an event. Returns the
// accepted event with the resolved sound, or zero + false if
// the event should be suppressed (duplicate within window or
// focused tab).
func (q *ToastQueue) Enqueue(paneID, tabID string, status loop.PaneStatus, message string) (ToastEvent, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if tabID != "" && tabID == q.focusedTabID {
		return ToastEvent{}, false
	}
	key := paneID + "|" + status.String()
	now := q.Now()
	if last, ok := q.lastSeen[key]; ok && now.Sub(last) < q.Window {
		return ToastEvent{}, false
	}
	q.lastSeen[key] = now
	return ToastEvent{
		PaneID:  paneID,
		TabID:   tabID,
		Status:  status,
		Sound:   SoundForStatus(status),
		Message: message,
		Now:     now,
	}, true
}

// Play accepts the event, plays its sound via the player, and
// returns the recorded ToastEvent for the caller to render
// in the toast overlay. The caller is expected to call
// Enqueue first; this helper is the convenience wrapper that
// combines the two for runtime wiring.
func (q *ToastQueue) Play(player SoundPlayer, paneID, tabID string, status loop.PaneStatus, message string) (ToastEvent, bool) {
	event, ok := q.Enqueue(paneID, tabID, status, message)
	if !ok {
		return ToastEvent{}, false
	}
	if event.Sound != SoundNone && player != nil {
		_ = player.Play(event.Sound)
	}
	return event, true
}
