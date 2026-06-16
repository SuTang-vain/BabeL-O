// internal/loop/notifications/notifications_test.go
//
// Phase 4b sound + toast dedup tests.

package notifications

import (
	"testing"
	"time"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop"
)

func TestSoundForStatusMatchesPlan(t *testing.T) {
	cases := []struct {
		status loop.PaneStatus
		want   SoundName
	}{
		{loop.StatusDone, SoundChime},
		{loop.StatusDrift, SoundWarn},
		{loop.StatusBlocked, SoundAlert},
		{loop.StatusWaiting, SoundNotify},
		{loop.StatusWorking, SoundNotify},
		{loop.StatusIdle, SoundNotify},
	}
	for _, c := range cases {
		if got := SoundForStatus(c.status); got != c.want {
			t.Errorf("SoundForStatus(%v) = %q, want %q", c.status, got, c.want)
		}
	}
}

func TestDriftBlockedDoneHaveDistinctSounds(t *testing.T) {
	// Plan section 4 closure criterion: drift / blocked / done
	// must use distinct sounds.
	drift := SoundForStatus(loop.StatusDrift)
	blocked := SoundForStatus(loop.StatusBlocked)
	done := SoundForStatus(loop.StatusDone)
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
	_, ok := q.Enqueue("pane-1", "tab-1", loop.StatusBlocked, "needs approval")
	if !ok {
		t.Fatal("first event should be accepted")
	}
}

func TestToastQueueDedupesWithinWindow(t *testing.T) {
	t0 := time.Unix(0, 0)
	q := newTestQueue(t0)
	if _, ok := q.Enqueue("pane-1", "tab-1", loop.StatusBlocked, "first"); !ok {
		t.Fatal("first event should be accepted")
	}
	// 3s later, still inside the 5s window: suppressed.
	q.Now = func() time.Time { return t0.Add(3 * time.Second) }
	if _, ok := q.Enqueue("pane-1", "tab-1", loop.StatusBlocked, "second"); ok {
		t.Fatal("event within window should be suppressed")
	}
	// 6s later, outside the window: accepted again.
	q.Now = func() time.Time { return t0.Add(6 * time.Second) }
	if _, ok := q.Enqueue("pane-1", "tab-1", loop.StatusBlocked, "third"); !ok {
		t.Fatal("event outside window should be accepted")
	}
}

func TestToastQueueDedupKeySeparatesStatus(t *testing.T) {
	t0 := time.Unix(0, 0)
	q := newTestQueue(t0)
	if _, ok := q.Enqueue("pane-1", "tab-1", loop.StatusBlocked, "x"); !ok {
		t.Fatal("first blocked should be accepted")
	}
	// Same pane, different status, immediately after: should
	// be accepted (dedup key is (pane, status), not just pane).
	if _, ok := q.Enqueue("pane-1", "tab-1", loop.StatusDrift, "y"); !ok {
		t.Fatal("different status should be accepted")
	}
}

func TestToastQueueDedupKeySeparatesPane(t *testing.T) {
	t0 := time.Unix(0, 0)
	q := newTestQueue(t0)
	if _, ok := q.Enqueue("pane-1", "tab-1", loop.StatusBlocked, "x"); !ok {
		t.Fatal("first blocked should be accepted")
	}
	if _, ok := q.Enqueue("pane-2", "tab-1", loop.StatusBlocked, "y"); !ok {
		t.Fatal("different pane should be accepted")
	}
}

func TestToastQueueSuppressesFocusedTab(t *testing.T) {
	q := newTestQueue(time.Unix(0, 0))
	q.SetFocusedTab("tab-1")
	if _, ok := q.Enqueue("pane-1", "tab-1", loop.StatusBlocked, "in focus"); ok {
		t.Fatal("event on focused tab should be suppressed (user already sees it)")
	}
	// Tab change → event on a non-focused tab is accepted.
	q.SetFocusedTab("tab-2")
	if _, ok := q.Enqueue("pane-1", "tab-1", loop.StatusBlocked, "off focus"); !ok {
		t.Fatal("event on non-focused tab should be accepted")
	}
}

func TestToastQueuePlayDelegatesToPlayer(t *testing.T) {
	player := &FakeSoundPlayer{}
	t0 := time.Unix(0, 0)
	q := newTestQueue(t0)
	_, ok := q.Play(player, "pane-1", "tab-1", loop.StatusDrift, "scope drift")
	if !ok {
		t.Fatal("drift event should be accepted")
	}
	if len(player.Plays) != 1 || player.Plays[0] != SoundWarn {
		t.Fatalf("expected one warn sound, got %+v", player.Plays)
	}
	// Replay within window: no second sound.
	_, ok = q.Play(player, "pane-1", "tab-1", loop.StatusDrift, "scope drift again")
	if ok {
		t.Fatal("replay within window should be suppressed")
	}
	if len(player.Plays) != 1 {
		t.Fatalf("suppressed replay should not have played sound, got %+v", player.Plays)
	}
}
