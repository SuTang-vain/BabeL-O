// internal/notifications/notifications_test.go
//
// Phase 4b sound + toast dedup tests. The package is
// decoupled from internal/loop; status is a string token
// (one of "idle" / "working" / "blocked" / "waiting" /
// "drift" / "done").

package notifications

import (
	"testing"
	"time"
)

func TestSoundForStatusMatchesPlan(t *testing.T) {
	cases := []struct {
		status string
		want   SoundName
	}{
		{"done", SoundChime},
		{"drift", SoundWarn},
		{"blocked", SoundAlert},
		{"waiting", SoundNotify},
		{"working", SoundNotify},
		{"idle", SoundNotify},
		{"unknown", SoundNone},
	}
	for _, c := range cases {
		if got := SoundForStatus(c.status); got != c.want {
			t.Errorf("SoundForStatus(%q) = %q, want %q", c.status, got, c.want)
		}
	}
}

func TestDriftBlockedDoneHaveDistinctSounds(t *testing.T) {
	// Plan section 4 closure criterion: drift / blocked / done
	// must use distinct sounds.
	drift := SoundForStatus("drift")
	blocked := SoundForStatus("blocked")
	done := SoundForStatus("done")
	if drift == blocked || drift == done || blocked == done {
		t.Fatalf("sounds must be distinct, got drift=%q blocked=%q done=%q", drift, blocked, done)
	}
}

func newTestQueue(now time.Time) *ToastQueue {
	q := NewToastQueue()
	q.Now = func() time.Time { return now }
	return q
}

func TestToastQueueAcceptsFirstEvent(t *testing.T) {
	q := newTestQueue(time.Unix(0, 0))
	_, ok := q.Enqueue("pane-1", "tab-1", "blocked", "needs approval")
	if !ok {
		t.Fatal("first event should be accepted")
	}
}

func TestToastQueueDedupesWithinWindow(t *testing.T) {
	t0 := time.Unix(0, 0)
	q := newTestQueue(t0)
	if _, ok := q.Enqueue("pane-1", "tab-1", "blocked", "first"); !ok {
		t.Fatal("first event should be accepted")
	}
	// 3s later, still inside the 5s window: suppressed.
	q.Now = func() time.Time { return t0.Add(3 * time.Second) }
	if _, ok := q.Enqueue("pane-1", "tab-1", "blocked", "second"); ok {
		t.Fatal("event within window should be suppressed")
	}
	// 6s later, outside the window: accepted again.
	q.Now = func() time.Time { return t0.Add(6 * time.Second) }
	if _, ok := q.Enqueue("pane-1", "tab-1", "blocked", "third"); !ok {
		t.Fatal("event outside window should be accepted")
	}
}

func TestToastQueueDedupKeySeparatesStatus(t *testing.T) {
	t0 := time.Unix(0, 0)
	q := newTestQueue(t0)
	if _, ok := q.Enqueue("pane-1", "tab-1", "blocked", "x"); !ok {
		t.Fatal("first blocked should be accepted")
	}
	// Same pane, different status, immediately after: should
	// be accepted (dedup key is (pane, status), not just pane).
	if _, ok := q.Enqueue("pane-1", "tab-1", "drift", "y"); !ok {
		t.Fatal("different status should be accepted")
	}
}

func TestToastQueueDedupKeySeparatesPane(t *testing.T) {
	t0 := time.Unix(0, 0)
	q := newTestQueue(t0)
	if _, ok := q.Enqueue("pane-1", "tab-1", "blocked", "x"); !ok {
		t.Fatal("first blocked should be accepted")
	}
	if _, ok := q.Enqueue("pane-2", "tab-1", "blocked", "y"); !ok {
		t.Fatal("different pane should be accepted")
	}
}

func TestToastQueueSuppressesFocusedTab(t *testing.T) {
	q := newTestQueue(time.Unix(0, 0))
	q.SetFocusedTab("tab-1")
	if _, ok := q.Enqueue("pane-1", "tab-1", "blocked", "in focus"); ok {
		t.Fatal("event on focused tab should be suppressed (user already sees it)")
	}
	// Tab change → event on a non-focused tab is accepted.
	q.SetFocusedTab("tab-2")
	if _, ok := q.Enqueue("pane-1", "tab-1", "blocked", "off focus"); !ok {
		t.Fatal("event on non-focused tab should be accepted")
	}
}

func TestToastQueuePlayDelegatesToPlayer(t *testing.T) {
	player := &FakeSoundPlayer{}
	t0 := time.Unix(0, 0)
	q := newTestQueue(t0)
	_, ok := q.Play(player, "pane-1", "tab-1", "drift", "scope drift")
	if !ok {
		t.Fatal("drift event should be accepted")
	}
	if got := player.PlaysCopy(); len(got) != 1 || got[0] != SoundWarn {
		t.Fatalf("expected one warn sound, got %+v", got)
	}
	// Replay within window: no second sound.
	_, ok = q.Play(player, "pane-1", "tab-1", "drift", "scope drift again")
	if ok {
		t.Fatal("replay within window should be suppressed")
	}
	if got := player.PlaysCopy(); len(got) != 1 {
		t.Fatalf("suppressed replay should not have played sound, got %+v", got)
	}
}

func TestNewSoundPlayerForPlatformReturnsNonNil(t *testing.T) {
	// On every supported platform the factory must return a
	// non-nil player. This is the contract bbl-loop's main()
	// relies on — the TUI never has to nil-check the
	// SoundPlayer before using it.
	p := NewSoundPlayerForPlatform()
	if p == nil {
		t.Fatal("NewSoundPlayerForPlatform returned nil")
	}
	// Calling Play on a stub platform with SoundNone must be
	// a no-op and return nil.
	if err := p.Play(SoundNone); err != nil {
		t.Errorf("Play(SoundNone) error: %v", err)
	}
}
