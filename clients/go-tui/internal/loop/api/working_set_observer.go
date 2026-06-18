// internal/loop/api/working_set_observer.go
//
// PR-17c (B1): WebSocket subscription to the server's
// `/v1/working-set/observe` endpoint (PR-27 in
// src/nexus/app.ts:3913-3986). Mirrors the structure of
// `api/ws_stream.go` line-for-line so the loop-level
// observer in `loop/ws_observer.go` can treat the two
// the same way.
//
// Wire contract (PR-27, server):
//
//	GET ws://host/v1/working-set/observe?cwd=<cwd>&sessionId=<optional>
//	< 101 Switching Protocols
//	< server sends one JSON object per frame:
//	    { type: "working_set_snapshot", cwd, filter, sessions: [...] }
//	    { type: "working_set_updated", sessionId, workspaceId, ws, timestamp }
//	    { type: "working_set_reset",   sessionId, workspaceId, timestamp }
//	    { type: "error", code, message } + close 1008 / 1011
//
// Why this file lives in `api/` (not `loop/`):
//
//   - The loop package owns tea.Cmd plumbing + reconnect
//     policy (PR-17c §3-5). That code needs to know about
//     backoff, the reconciler, and the Bubble Tea Update
//     path.
//   - The `api/` package owns transport: URL build, dial,
//     single-reader goroutine, close fn. Keeping reconnect
//     policy out of `api/` (per spec constraint #8) is
//     intentional — the surface is "dial → events + errs +
//     close fn", no re-dial, no backoff.
//
// Constraints honored here (from PR-17c spec):
//
//   - Single reader goroutine per WS connection
//     (mirrors `api/ws_stream.go:186-224`).
//   - Idempotent close fn (`sync.Once`) — caller can drop
//     the conn from multiple paths without double-close.
//   - No auto-reconnect inside `api/` — read errors flow
//     to the caller via the errs channel; the loop layer
//     decides whether to retry.

package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WorkingSetEntry is one key/value row in a per-session
// working set. Mirrors the server-side `WorkingSetEntry`
// shape; the runtime may extend with additional metadata
// fields that the client ignores.
type WorkingSetEntry struct {
	Key        string  `json:"key"`
	Value      string  `json:"value"`
	UpdatedAt  string  `json:"updatedAt"`
	Confidence float64 `json:"confidence"`
}

// WorkingSet is the per-session payload the server tracks.
// It is the wire shape embedded under the `ws` key of a
// `working_set_updated` event and inside the
// `sessions[].ws` array of a `working_set_snapshot` event.
type WorkingSet struct {
	SessionID   string            `json:"sessionId"`
	WorkspaceID string            `json:"workspaceId"`
	Entries     []WorkingSetEntry `json:"entries"`
	Version     int               `json:"version"`
	UpdatedAt   string            `json:"updatedAt"`
}

// WorkingSetSnapshotMsg mirrors the server's
// `working_set_snapshot` frame sent immediately on
// connect. `Cwd` + `Filter` echo the request; `Sessions`
// is the per-session list the client should treat as the
// initial state.
type WorkingSetSnapshotMsg struct {
	Cwd      string       `json:"cwd"`
	Filter   any          `json:"filter"`
	Sessions []WorkingSet `json:"sessions"`
}

// WorkingSetUpdatedMsg mirrors the server's
// `working_set_updated` frame emitted when a session's
// working set is mutated. `WorkingSet` carries the new
// full state for that session (server-side replace, not
// delta).
type WorkingSetUpdatedMsg struct {
	SessionID   string     `json:"sessionId"`
	WorkspaceID string     `json:"workspaceId"`
	WorkingSet  WorkingSet `json:"ws"`
	Timestamp   string     `json:"timestamp"`
}

// WorkingSetResetMsg mirrors the server's
// `working_set_reset` frame emitted when a session's
// working set is wiped (version rollback, manual reset,
// session teardown).
type WorkingSetResetMsg struct {
	SessionID   string `json:"sessionId"`
	WorkspaceID string `json:"workspaceId"`
	Timestamp   string `json:"timestamp"`
}

// WorkingSetObserverError mirrors the server's `error`
// frame. The server always closes the socket after sending
// one (close 1008 / 1011 per PR-27), so the caller will
// see this on the events channel followed by a read error
// on errs.
type WorkingSetObserverError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// WorkingSetObserverEvent is the single channel payload
// type the caller consumes. The `Type` field is the
// server-side `type` discriminator; exactly one of the
// pointer fields is populated based on Type.
//
// Type values:
//
//	"working_set_snapshot"  → Snapshot
//	"working_set_updated"   → Updated
//	"working_set_reset"     → Reset
//	"error"                 → Err
type WorkingSetObserverEvent struct {
	Type string

	Snapshot *WorkingSetSnapshotMsg
	Updated  *WorkingSetUpdatedMsg
	Reset    *WorkingSetResetMsg
	Err      *WorkingSetObserverError
}

// ObserveOpts configures a single /v1/working-set/observe
// connection. Zero values fall back to package defaults.
type ObserveOpts struct {
	// DialTimeout caps the initial WebSocket dial. 0
	// means use DefaultObserveDialTimeout.
	DialTimeout time.Duration
	// ReadTimeout caps each individual read. 0 means
	// block until the next frame arrives (recommended
	// for production — the server pushes on mutation).
	ReadTimeout time.Duration
}

// DefaultObserveDialTimeout matches DefaultStreamDialTimeout
// so a downed /v1/working-set/observe endpoint doesn't stall
// the startup path longer than the existing per-session
// stream dial would.
const DefaultObserveDialTimeout = 5 * time.Second

// ObserveWorkingSet opens a WebSocket to
// `/v1/working-set/observe?cwd=<cwd>&sessionId=<optional>`
// and returns three channels:
//
//   - events: each WorkingSetObserverEvent the server pushes
//   - errs:   any dial / read / close error (after which
//     the loop layer should reconnect with backoff)
//   - close:  func() the caller MUST invoke to cancel the
//     read loop and close the socket. Idempotent.
//
// The function returns an error on dial failure so the
// caller can decide between abort and reconnect. Once the
// connection is established, all subsequent failures flow
// through the errs channel (the caller's loop selects on it).
//
// ObserveWorkingSet never panics. The caller is responsible
// for invoking `close` exactly once; multiple invocations
// are safe (no-op after the first) thanks to `sync.Once`.
func (c *Client) ObserveWorkingSet(
	ctx context.Context,
	cwd string,
	sessionID string,
	opts ObserveOpts,
) (<-chan WorkingSetObserverEvent, <-chan error, func(), error) {
	if c == nil {
		return nil, nil, nil, errors.New("ObserveWorkingSet: nil client")
	}
	if cwd == "" {
		return nil, nil, nil, errors.New("ObserveWorkingSet: empty cwd")
	}
	dialTimeout := opts.DialTimeout
	if dialTimeout <= 0 {
		dialTimeout = DefaultObserveDialTimeout
	}

	// Build the ws:// URL from the client's HTTP base.
	// Same scheme swap as StreamSession so the caller
	// doesn't have to plumb a second config.
	u, err := url.Parse(c.BaseURL)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("ObserveWorkingSet: parse base url: %w", err)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
		// already a WS URL — keep as-is
	default:
		return nil, nil, nil, fmt.Errorf("ObserveWorkingSet: unsupported base url scheme %q", u.Scheme)
	}
	u.Path = "/v1/working-set/observe"
	q := u.Query()
	q.Set("cwd", cwd)
	if sessionID != "" {
		q.Set("sessionId", sessionID)
	}
	u.RawQuery = q.Encode()

	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()

	headers := http.Header{
		"User-Agent": []string{"bbl-loop/PR-17c-B1"},
	}
	if c.APIKey != "" {
		headers.Set("Authorization", "Bearer "+c.APIKey)
	}

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = dialTimeout
	conn, resp, err := dialer.DialContext(dialCtx, u.String(), headers)
	if err != nil {
		if resp != nil {
			return nil, nil, nil, fmt.Errorf("ObserveWorkingSet: dial %s: %w (status %d)", u.String(), err, resp.StatusCode)
		}
		return nil, nil, nil, fmt.Errorf("ObserveWorkingSet: dial %s: %w", u.String(), err)
	}

	events := make(chan WorkingSetObserverEvent, 16)
	errs := make(chan error, 1)

	// closeOnce ensures the close func is idempotent so
	// the caller can call it from multiple paths without
	// panicking on a double-close. The deferred close in
	// the reader goroutine uses the same guard so the
	// two close paths can't race.
	var once sync.Once
	closeChannels := func() {
		once.Do(func() {
			_ = conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
				time.Now().Add(time.Second))
			_ = conn.Close()
			close(events)
		})
	}
	closeFn := closeChannels

	// Reader goroutine: the only goroutine spawned by
	// this file. Mirrors the StreamSession pattern
	// (api/ws_stream.go:186-224) — read frames in a
	// loop, dispatch based on the server's `type`
	// discriminator, surface read/decode errors via
	// errs, exit on first permanent error.
	go func() {
		defer closeChannels()
		for {
			if opts.ReadTimeout > 0 {
				_ = conn.SetReadDeadline(time.Now().Add(opts.ReadTimeout))
			}
			_, raw, err := conn.ReadMessage()
			if err != nil {
				select {
				case errs <- err:
				default:
				}
				return
			}
			// Peek the `type` discriminator so we can
			// decode into the right concrete shape.
			var probe struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(raw, &probe); err != nil {
				select {
				case errs <- fmt.Errorf("ws observe: malformed frame (no type): %w", err):
				default:
				}
				continue
			}
			ev := WorkingSetObserverEvent{Type: probe.Type}
			switch probe.Type {
			case "working_set_snapshot":
				var msg WorkingSetSnapshotMsg
				if err := json.Unmarshal(raw, &msg); err != nil {
					select {
					case errs <- fmt.Errorf("ws observe: malformed snapshot: %w", err):
					default:
					}
					continue
				}
				ev.Snapshot = &msg
			case "working_set_updated":
				var msg WorkingSetUpdatedMsg
				if err := json.Unmarshal(raw, &msg); err != nil {
					select {
					case errs <- fmt.Errorf("ws observe: malformed updated: %w", err):
					default:
					}
					continue
				}
				ev.Updated = &msg
			case "working_set_reset":
				var msg WorkingSetResetMsg
				if err := json.Unmarshal(raw, &msg); err != nil {
					select {
					case errs <- fmt.Errorf("ws observe: malformed reset: %w", err):
					default:
					}
					continue
				}
				ev.Reset = &msg
			case "error":
				var msg WorkingSetObserverError
				if err := json.Unmarshal(raw, &msg); err != nil {
					select {
					case errs <- fmt.Errorf("ws observe: malformed error: %w", err):
					default:
					}
					continue
				}
				ev.Err = &msg
			default:
				// Unknown type — log to errs but keep
				// reading. The server may emit new
				// types in the future; the client
				// should be tolerant.
				select {
				case errs <- fmt.Errorf("ws observe: unknown frame type %q", probe.Type):
				default:
				}
				continue
			}
			select {
			case events <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()

	return events, errs, closeFn, nil
}
