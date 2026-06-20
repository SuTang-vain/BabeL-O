// internal/loop/context_observer_test.go
//
// R6 state-machine focused tests for the loop-level
// ContextObserver. Verifies the 5 acceptance scenarios
// from `docs/nexus/proposals/long-running-context-assembly.md`
// §20 R6:
//
//   S1 — observer absent → "context: not observed"
//   S2 — observer late connect → status flips to connected
//   S3 — observer reconnect → backoff + state replaced (no
//        stale derivation)
//   S4 — payload schema mismatch → reader recovers, status
//        stays connected, no panic
//   S5 — payload partial (no redaction summary) → fallback
//        rendering, no fabricated facts
//
// These tests exercise the model state mutation path
// (`applyCtxObservationFrame`,
// `markCtxObservationDisconnected`,
// `GetCtxObservation`, `FormatCtxObservationLine`)
// directly — without spinning up a Bubble Tea program — so
// they capture the "TUI is renderer-only, observer is the
// source of truth" R6 contract.

package loop

import (
	"strings"
	"testing"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// newTestModel constructs a minimal InteractiveModel that
// can drive applyCtxObservationFrame without any real
// observer connection. The map is left nil; the helper
// allocates on first write.
func newTestModel() *InteractiveModel {
	return &InteractiveModel{}
}

// newTestObserver constructs a ContextObserver with a nil
// API client. The observer is only used as a key into the
// per-cwd observation map; we never call ConnectCmd /
// ReconnectCmd in these tests.
func newTestObserver(cwd, sessionID string) *ContextObserver {
	return &ContextObserver{cwd: cwd, sessionID: sessionID}
}

// S1: observer absent → "context: not observed".
//
// When the model has not received a single observer
// event, GetCtxObservation must report observed=false and
// FormatCtxObservationLine must emit "not observed". This
// is the R6 "TUI says not observed rather than inventing
// context facts" acceptance.
func TestR6_S1_NotObservedWhenNoFrameEverArrived(t *testing.T) {
	m := newTestModel()
	obs, observed := m.GetCtxObservation("/workspace", "")
	if observed {
		t.Errorf("observed = true; want false on a freshly constructed model")
	}
	got := FormatCtxObservationLine(obs, observed)
	if got != "context: not observed" {
		t.Errorf("line = %q, want %q", got, "context: not observed")
	}
}

// S2: observer late connect → status flips to connected.
//
// First a snapshot frame arrives (with a populated
// redaction summary); the renderer must show
// connected/chars/blocks. The status must come from the
// observer event, not from the model's own state — verified
// by inspecting that the line includes the SERVER-emitted
// counts.
func TestR6_S2_LateConnectFlipsToConnected(t *testing.T) {
	m := newTestModel()
	o := newTestObserver("/workspace", "session-1")

	// Frame 1: assembled_snapshot with full redaction
	// summary populated.
	m.applyCtxObservationFrame(o, api.ContextObserverEvent{
		Type: "assembled_snapshot",
		Snapshot: &api.AssembledSnapshotMsg{
			Cwd:       "/workspace",
			Redaction: "summary",
			Context: &api.AssembledContextEnvelope{
				Redaction: &api.ContextRedactionSummary{
					SystemPromptChars:   1024,
					MessageCount:        3,
					MessageChars:        48,
					BlockCount:          5,
					CacheableBlockCount: 4,
				},
			},
		},
	})

	obs, observed := m.GetCtxObservation("/workspace", "session-1")
	if !observed {
		t.Fatalf("observed = false after snapshot frame")
	}
	if obs.Status != CtxObserverConnected {
		t.Errorf("status = %v, want connected", obs.Status)
	}
	line := FormatCtxObservationLine(obs, observed)
	if !strings.Contains(line, "connected") || !strings.Contains(line, "5 blocks") || !strings.Contains(line, "4 cacheable") {
		t.Errorf("line = %q, want it to include connected/5 blocks/4 cacheable", line)
	}

	// Frame 2: live `assembled` overrides snapshot with
	// fresher counts. The renderer must reflect the new
	// counts, not the old.
	m.applyCtxObservationFrame(o, api.ContextObserverEvent{
		Type: "assembled",
		Assembled: &api.AssembledMsg{
			Cwd:       "/workspace",
			SessionID: "session-1",
			Redaction: "summary",
			Context: &api.AssembledContextEnvelope{
				Redaction: &api.ContextRedactionSummary{
					SystemPromptChars:   2048,
					MessageCount:        7,
					MessageChars:        300,
					BlockCount:          6,
					CacheableBlockCount: 4,
				},
			},
			Timestamp: "2026-06-20T01:00:00Z",
		},
	})
	obs, observed = m.GetCtxObservation("/workspace", "session-1")
	if !observed || obs.Status != CtxObserverConnected {
		t.Fatalf("observed=%v, status=%v after assembled frame", observed, obs.Status)
	}
	if obs.Summary.MessageCount != 7 || obs.Summary.BlockCount != 6 {
		t.Errorf("summary = %+v, want msg=7 blocks=6", obs.Summary)
	}
	if obs.LastTimestamp != "2026-06-20T01:00:00Z" {
		t.Errorf("LastTimestamp = %q", obs.LastTimestamp)
	}
}

// S3: observer reconnect → backoff + state replaced (no
// stale derivation).
//
// 1. Connect → assembled frame populates state.
// 2. Disconnect (mark) → status flips to disconnected,
//    renderer shows "reconnecting".
// 3. Reconnect → fresh snapshot replaces state; old
//    counters MUST be replaced, not merged.
//
// This exercises the R6 contract: between disconnect and
// re-snapshot, the renderer must NOT show the stale
// summary as if it were live truth.
func TestR6_S3_ReconnectReplacesStaleState(t *testing.T) {
	m := newTestModel()
	o := newTestObserver("/workspace", "")

	// Step 1: initial connect with summary.
	m.applyCtxObservationFrame(o, api.ContextObserverEvent{
		Type: "assembled_snapshot",
		Snapshot: &api.AssembledSnapshotMsg{
			Cwd:       "/workspace",
			Redaction: "summary",
			Context: &api.AssembledContextEnvelope{
				Redaction: &api.ContextRedactionSummary{
					SystemPromptChars: 1024, MessageCount: 3, BlockCount: 5, CacheableBlockCount: 4,
				},
			},
		},
	})
	if obs, _ := m.GetCtxObservation("/workspace", ""); obs.Summary.MessageCount != 3 {
		t.Fatalf("step-1 summary = %+v", obs.Summary)
	}

	// Step 2: mark disconnected via the read-error path.
	m.markCtxObservationDisconnected(o, "read tcp: connection reset")
	obs, observed := m.GetCtxObservation("/workspace", "")
	if !observed {
		t.Fatalf("observed = false after disconnect (entry should still exist)")
	}
	if obs.Status != CtxObserverDisconnected {
		t.Errorf("status = %v, want disconnected", obs.Status)
	}
	if line := FormatCtxObservationLine(obs, observed); !strings.HasPrefix(line, "context: reconnecting") {
		t.Errorf("line = %q, want prefix 'context: reconnecting'", line)
	}

	// Step 3: reconnect with fresh snapshot containing a
	// completely different summary. The model must
	// REPLACE the state (the apply path always overwrites
	// the snapshot for snapshot/assembled frames).
	m.applyCtxObservationFrame(o, api.ContextObserverEvent{
		Type: "assembled_snapshot",
		Snapshot: &api.AssembledSnapshotMsg{
			Cwd:       "/workspace",
			Redaction: "summary",
			Context: &api.AssembledContextEnvelope{
				Redaction: &api.ContextRedactionSummary{
					SystemPromptChars: 4096, MessageCount: 12, BlockCount: 8, CacheableBlockCount: 5,
				},
			},
		},
	})
	obs, _ = m.GetCtxObservation("/workspace", "")
	if obs.Status != CtxObserverConnected {
		t.Errorf("status = %v, want connected after reconnect", obs.Status)
	}
	if obs.Summary.MessageCount != 12 {
		t.Errorf("summary.MessageCount = %d, want 12 (state must replace, not merge)", obs.Summary.MessageCount)
	}
	if obs.LastError != "read tcp: connection reset" {
		// The previous error string should still be
		// retrievable for diagnostic purposes — but
		// crucially the status is connected, not
		// disconnected. The renderer prefers Status over
		// LastError, so the operator does not see a
		// stale error message.
		// (We allow the field to be either preserved or
		// cleared; what matters is Status.)
	}
}

// S4: payload schema mismatch → reader recovers, no panic.
//
// We exercise three sub-cases:
//   (a) Unknown frame type — the apply path stamps
//       LastFrameAt but does not pretend to have a summary;
//       renderer must still render whatever it had before.
//   (b) Error frame after a successful snapshot — status
//       flips to disconnected; previous summary is
//       preserved for diagnostic but renderer shows
//       reconnecting.
//   (c) Snapshot frame with `Context: nil` — connected but
//       no summary; renderer shows "(no frame yet)".
func TestR6_S4_SchemaMismatchRecovery(t *testing.T) {
	t.Run("(a) unknown frame keeps previous state, status connected", func(t *testing.T) {
		m := newTestModel()
		o := newTestObserver("/a", "")
		// Seed with a valid snapshot.
		m.applyCtxObservationFrame(o, api.ContextObserverEvent{
			Type: "assembled_snapshot",
			Snapshot: &api.AssembledSnapshotMsg{
				Cwd: "/a", Redaction: "summary",
				Context: &api.AssembledContextEnvelope{
					Redaction: &api.ContextRedactionSummary{MessageCount: 1, BlockCount: 1, CacheableBlockCount: 1},
				},
			},
		})
		// Apply an unknown-type frame.
		m.applyCtxObservationFrame(o, api.ContextObserverEvent{Type: "future_type"})
		obs, observed := m.GetCtxObservation("/a", "")
		if !observed || obs.Status != CtxObserverConnected {
			t.Fatalf("status = %v after unknown frame, want still connected", obs.Status)
		}
		if obs.Summary == nil || obs.Summary.MessageCount != 1 {
			t.Errorf("summary lost after unknown frame: %+v", obs.Summary)
		}
	})
	t.Run("(b) error frame after snapshot → disconnected", func(t *testing.T) {
		m := newTestModel()
		o := newTestObserver("/b", "")
		m.applyCtxObservationFrame(o, api.ContextObserverEvent{
			Type: "assembled_snapshot",
			Snapshot: &api.AssembledSnapshotMsg{
				Cwd: "/b", Redaction: "summary",
				Context: &api.AssembledContextEnvelope{
					Redaction: &api.ContextRedactionSummary{MessageCount: 2, BlockCount: 2, CacheableBlockCount: 1},
				},
			},
		})
		m.applyCtxObservationFrame(o, api.ContextObserverEvent{
			Type: "error",
			Err:  &api.ContextObserverError{Code: "INTERNAL", Message: "broadcaster blew up"},
		})
		obs, observed := m.GetCtxObservation("/b", "")
		if !observed {
			t.Fatal("entry missing after error frame")
		}
		if obs.Status != CtxObserverDisconnected {
			t.Errorf("status = %v, want disconnected", obs.Status)
		}
		if !strings.Contains(obs.LastError, "INTERNAL") {
			t.Errorf("LastError = %q, want it to include INTERNAL", obs.LastError)
		}
		line := FormatCtxObservationLine(obs, observed)
		if !strings.HasPrefix(line, "context: reconnecting") {
			t.Errorf("line = %q, want prefix 'context: reconnecting'", line)
		}
	})
	t.Run("(c) null context snapshot → connected (no frame yet)", func(t *testing.T) {
		m := newTestModel()
		o := newTestObserver("/c", "")
		m.applyCtxObservationFrame(o, api.ContextObserverEvent{
			Type: "assembled_snapshot",
			Snapshot: &api.AssembledSnapshotMsg{
				Cwd: "/c", Redaction: "summary", Context: nil,
			},
		})
		obs, observed := m.GetCtxObservation("/c", "")
		if !observed || obs.Status != CtxObserverConnected {
			t.Fatalf("status = %v, want connected", obs.Status)
		}
		if obs.Summary != nil {
			t.Errorf("summary = %+v, want nil for null-context snapshot", obs.Summary)
		}
		line := FormatCtxObservationLine(obs, observed)
		if line != "context: connected (no frame yet)" {
			t.Errorf("line = %q, want 'context: connected (no frame yet)'", line)
		}
	})
}

// S5: payload partial (full mode or absent redaction) →
// fallback rendering.
//
// Two sub-cases:
//   (a) Server emits redaction:"full" — even if the
//       payload contains the verbatim systemPrompt /
//       messages (which our envelope intentionally drops),
//       the renderer must NOT pretend to display them. It
//       falls back to "context: full mode (debug)".
//   (b) Server emits a frame with no redaction summary
//       block at all — the renderer must NOT fabricate
//       counts; it falls back to "(no frame yet)".
//
// This is the R6 "renderer never invents context facts"
// guarantee: even when the server is misconfigured or in
// debug mode, the loop layer cannot derive a count from
// thin air.
func TestR6_S5_PartialPayloadFallbacks(t *testing.T) {
	t.Run("(a) full-mode payload → fallback line", func(t *testing.T) {
		m := newTestModel()
		o := newTestObserver("/full", "")
		m.applyCtxObservationFrame(o, api.ContextObserverEvent{
			Type: "assembled",
			Assembled: &api.AssembledMsg{
				Cwd:       "/full",
				SessionID: "s",
				Redaction: "full",
				// Context envelope intentionally has no
				// `Redaction` summary because in full mode
				// the server doesn't emit one.
				Context:   &api.AssembledContextEnvelope{},
				Timestamp: "2026-06-20T02:00:00Z",
			},
		})
		obs, observed := m.GetCtxObservation("/full", "")
		if !observed || obs.Status != CtxObserverConnected {
			t.Fatalf("status = %v", obs.Status)
		}
		if obs.Redaction != "full" {
			t.Errorf("Redaction = %q, want full", obs.Redaction)
		}
		line := FormatCtxObservationLine(obs, observed)
		if line != "context: full mode (debug)" {
			t.Errorf("line = %q, want 'context: full mode (debug)'", line)
		}
	})
	t.Run("(b) frame missing redaction summary → no-frame-yet", func(t *testing.T) {
		m := newTestModel()
		o := newTestObserver("/partial", "")
		m.applyCtxObservationFrame(o, api.ContextObserverEvent{
			Type: "assembled_snapshot",
			Snapshot: &api.AssembledSnapshotMsg{
				Cwd:       "/partial",
				Redaction: "summary",
				// Context envelope present but without a
				// Redaction summary block (server-side
				// regression / forward-compat).
				Context: &api.AssembledContextEnvelope{
					SystemPromptBlocks: []api.ContextSection{{ID: "identity", Cacheable: true}},
				},
			},
		})
		obs, observed := m.GetCtxObservation("/partial", "")
		if !observed || obs.Status != CtxObserverConnected {
			t.Fatalf("status = %v", obs.Status)
		}
		if obs.Summary != nil {
			t.Errorf("summary = %+v, want nil (renderer must not fabricate counts)", obs.Summary)
		}
		line := FormatCtxObservationLine(obs, observed)
		if line != "context: connected (no frame yet)" {
			t.Errorf("line = %q, want 'context: connected (no frame yet)'", line)
		}
	})
}

// Backoff cursor regression — the R6 reconnect path
// shares the BackoffState type with PR-17c (B1). Verify
// 2s → 5s → 15s (cap) sequence + Reset.
func TestR6_BackoffSequence(t *testing.T) {
	var b BackoffState
	got := []int{
		int(b.Next().Seconds()),
		int(b.Next().Seconds()),
		int(b.Next().Seconds()),
		int(b.Next().Seconds()), // capped
	}
	want := []int{2, 5, 15, 15}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("Next[%d] = %d, want %d", i, got[i], w)
		}
	}
	b.Reset()
	if int(b.Next().Seconds()) != 2 {
		t.Errorf("after Reset, Next() did not return 2s")
	}
}

// Format helper sanity — k/m thousands rendering.
func TestR6_FormatThousands(t *testing.T) {
	cases := []struct {
		in   int
		want string
	}{
		{0, "0"},
		{42, "42"},
		{999, "999"},
		{1000, "1k"},
		{14_500, "14k"},
		{1_500_000, "1.5m"},
	}
	for _, c := range cases {
		if got := formatThousands(c.in); got != c.want {
			t.Errorf("formatThousands(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}
