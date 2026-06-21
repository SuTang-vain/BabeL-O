// internal/loop/api/context_observer.go
//
// R6 (long-running-context-assembly §20 Phase R6): Go API
// client for `/v1/context/observe`. Mirrors
// `working_set_observer.go` line-for-line so the loop-level
// observer in `loop/context_observer.go` can treat the two
// the same way and the only thing the operator has to learn
// is "one observer per cwd, one per cwd+sessionId".
//
// Wire contract (R4 of the proposal, server side
// `src/nexus/routers/contextObserveRouter.ts`):
//
//	GET ws://host/v1/context/observe?cwd=<cwd>&sessionId=<optional>&full=<0|1>
//	< 101 Switching Protocols
//	< server sends one JSON object per frame:
//	    { type: "assembled_snapshot", cwd, filter, redaction:"summary"|"full", context: RedactedContext|null }
//	    { type: "assembled",          cwd, sessionId, redaction:"summary"|"full", context: RedactedContext, timestamp }
//	    { type: "error", code, message } + close 1008 / 1011
//
// Why the client only consumes redacted (`?full=` defaulted
// off): per R4 acceptance, the default observer payload
// MUST NOT carry the verbatim `systemPrompt` or `messages`
// because those fields can include secrets and are large.
// The loop layer renders runtime-owned facts (chars / counts
// / blocks) only — it never invents them. R6 relies on the
// Layer-1 redaction guard: even if a future server change
// regressed and started emitting `full` mode, the loop
// renderer simply ignores `systemPrompt` / `messages`
// fields and falls back to the redaction summary block.
//
// Why this file lives in `api/` (not `loop/`):
//
//   - The loop package owns tea.Cmd plumbing + reconnect
//     policy. That code needs to know about backoff, the
//     Bubble Tea Update path, and the per-program lifetime.
//   - The `api/` package owns transport: URL build, dial,
//     single-reader goroutine, close fn. Keeping reconnect
//     policy out of `api/` is intentional — the surface is
//     "dial → events + errs + close fn", no re-dial, no
//     backoff.
//
// Constraints honored here (mirrored from
// working_set_observer.go):
//
//   - Single reader goroutine per WS connection.
//   - Idempotent close fn (`sync.Once`).
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

// ContextRedactionSummary is the redaction metadata block
// the server emits when `redaction === "summary"` (the
// default). All fields are non-sensitive counts; the
// actual `systemPrompt` and `messages` text is stripped at
// the route boundary. See `src/nexus/contextBroadcaster.ts`
// `RedactedContextSummary` for the source of truth.
type ContextRedactionSummary struct {
	SystemPromptChars   int `json:"systemPromptChars"`
	MessageCount        int `json:"messageCount"`
	MessageChars        int `json:"messageChars"`
	BlockCount          int `json:"blockCount"`
	CacheableBlockCount int `json:"cacheableBlockCount"`
}

// ContextSection is the structured side of an
// AssembledContext block. The server emits this under
// `systemPromptBlocks` (an array of section descriptors).
// We carry the cacheable bit so the loop renderer can show
// "X cacheable / Y total" without re-deriving it. The
// full block list is bounded (≈ 15 sections) and contains
// no user-controlled text by R4 redaction policy, so it is
// safe to display.
type ContextSection struct {
	ID        string `json:"id,omitempty"`
	Cacheable bool   `json:"cacheable,omitempty"`
}

// AssembledContextEnvelope is the redacted context payload
// shape the loop renderer consumes. Fields that R4
// redaction strips (systemPrompt, messages) are absent;
// what remains is structured metadata + the redaction
// summary. Fields are intentionally optional with `omitempty`
// — the server may add more in the future and the client
// must tolerate that.
//
// We intentionally do NOT mirror the `systemPrompt` /
// `messages` fields here — even if the server regressed
// and emitted `full` mode payloads, the Go renderer cannot
// derive context truth from them.
type AssembledContextEnvelope struct {
	// Redaction is populated only when the server is in
	// the default "summary" mode. Full-mode payloads do
	// not include this field; the renderer should detect
	// its absence and fall back to "not observed" rather
	// than display the verbatim prompt.
	Redaction *ContextRedactionSummary `json:"redaction,omitempty"`
	// SystemPromptBlocks is the list of section descriptors
	// (id + cacheable). Bounded length, redaction-safe.
	SystemPromptBlocks []ContextSection `json:"systemPromptBlocks,omitempty"`
	// MessagesTokenEstimate is the runtime-side token
	// estimate the assembler computed. Optional — older
	// servers may omit it.
	MessagesTokenEstimate int `json:"messagesTokenEstimate,omitempty"`
	// SystemPromptTokenEstimate is the runtime-side token
	// estimate for the system prompt. Optional.
	SystemPromptTokenEstimate int `json:"systemPromptTokenEstimate,omitempty"`
}

// AssembledSnapshotMsg mirrors the server's first frame on
// connect. `Context` is null when no event has been
// published for this (cwd, sessionId) pair yet.
type AssembledSnapshotMsg struct {
	Cwd       string                    `json:"cwd"`
	Filter    any                       `json:"filter"`
	Redaction string                    `json:"redaction"`
	Context   *AssembledContextEnvelope `json:"context"`
}

// AssembledMsg mirrors the server's `assembled` frame
// emitted whenever the runtime hot-path finishes a
// successful assembleContext. The redaction mode echoes
// the request (summary by default).
type AssembledMsg struct {
	Cwd       string                    `json:"cwd"`
	SessionID string                    `json:"sessionId"`
	Redaction string                    `json:"redaction"`
	Context   *AssembledContextEnvelope `json:"context"`
	Timestamp string                    `json:"timestamp"`
}

// ContextObserverError mirrors the server's `error` frame.
// The server always closes the socket after sending one
// (close 1008 / 1011), so the caller will see this on the
// events channel followed by a read error on errs.
type ContextObserverError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ContextObserverEvent is the single channel payload type
// the caller consumes. `Type` is the server-side `type`
// discriminator; exactly one of the pointer fields is
// populated based on Type.
//
// Type values:
//
//	"assembled_snapshot" → Snapshot
//	"assembled"          → Assembled
//	"error"              → Err
type ContextObserverEvent struct {
	Type string

	Snapshot  *AssembledSnapshotMsg
	Assembled *AssembledMsg
	Err       *ContextObserverError
}

// ContextObserveOpts configures a single
// `/v1/context/observe` connection. Zero values fall back
// to package defaults. RedactionMode controls the `?full=`
// query param — empty string means use the server default
// ("summary"), "full" sets `?full=1` (debug only; loop
// renderer must still ignore verbatim fields).
type ContextObserveOpts struct {
	DialTimeout   time.Duration
	ReadTimeout   time.Duration
	RedactionMode string // "" | "summary" | "full"
}

// DefaultContextObserveDialTimeout matches
// DefaultObserveDialTimeout for symmetry.
const DefaultContextObserveDialTimeout = 5 * time.Second

// ObserveContext opens a WebSocket to
// `/v1/context/observe?cwd=<cwd>&sessionId=<optional>&full=<0|1>`
// and returns three channels:
//
//   - events: each ContextObserverEvent the server pushes
//   - errs:   any dial / read / close error (after which
//     the loop layer should reconnect with backoff)
//   - close:  func() the caller MUST invoke to cancel the
//     read loop and close the socket. Idempotent.
//
// The function returns an error on dial failure so the
// caller can decide between abort and reconnect. Once the
// connection is established, all subsequent failures flow
// through the errs channel.
//
// ObserveContext never panics. The caller is responsible
// for invoking `close` exactly once; multiple invocations
// are safe (no-op after the first).
func (c *Client) ObserveContext(
	ctx context.Context,
	cwd string,
	sessionID string,
	opts ContextObserveOpts,
) (<-chan ContextObserverEvent, <-chan error, func(), error) {
	if c == nil {
		return nil, nil, nil, errors.New("ObserveContext: nil client")
	}
	if cwd == "" {
		return nil, nil, nil, errors.New("ObserveContext: empty cwd")
	}
	dialTimeout := opts.DialTimeout
	if dialTimeout <= 0 {
		dialTimeout = DefaultContextObserveDialTimeout
	}

	// Build the ws:// URL from the client's HTTP base.
	u, err := url.Parse(c.BaseURL)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("ObserveContext: parse base url: %w", err)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
		// already a WS URL — keep as-is
	default:
		return nil, nil, nil, fmt.Errorf("ObserveContext: unsupported base url scheme %q", u.Scheme)
	}
	u.Path = "/v1/context/observe"
	q := u.Query()
	q.Set("cwd", cwd)
	if sessionID != "" {
		q.Set("sessionId", sessionID)
	}
	// Per R4 default-on policy: only set `full=1` when the
	// caller explicitly requests it. The loop layer never
	// passes "full" — debug callers may.
	if opts.RedactionMode == "full" {
		q.Set("full", "1")
	}
	u.RawQuery = q.Encode()

	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()

	headers := http.Header{
		"User-Agent": []string{"bbl-loop/R6"},
	}
	if c.APIKey != "" {
		headers.Set("Authorization", "Bearer "+c.APIKey)
	}

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = dialTimeout
	conn, resp, err := dialer.DialContext(dialCtx, u.String(), headers)
	if err != nil {
		if resp != nil {
			return nil, nil, nil, fmt.Errorf("ObserveContext: dial %s: %w (status %d)", u.String(), err, resp.StatusCode)
		}
		return nil, nil, nil, fmt.Errorf("ObserveContext: dial %s: %w", u.String(), err)
	}

	events := make(chan ContextObserverEvent, 16)
	errs := make(chan error, 1)

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

	// Reader goroutine: single reader, mirrors
	// working_set_observer.go.
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
			var probe struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(raw, &probe); err != nil {
				select {
				case errs <- fmt.Errorf("ws context observe: malformed frame (no type): %w", err):
				default:
				}
				continue
			}
			ev := ContextObserverEvent{Type: probe.Type}
			switch probe.Type {
			case "assembled_snapshot":
				var msg AssembledSnapshotMsg
				if err := json.Unmarshal(raw, &msg); err != nil {
					select {
					case errs <- fmt.Errorf("ws context observe: malformed snapshot: %w", err):
					default:
					}
					continue
				}
				ev.Snapshot = &msg
			case "assembled":
				var msg AssembledMsg
				if err := json.Unmarshal(raw, &msg); err != nil {
					select {
					case errs <- fmt.Errorf("ws context observe: malformed assembled: %w", err):
					default:
					}
					continue
				}
				ev.Assembled = &msg
			case "error":
				var msg ContextObserverError
				if err := json.Unmarshal(raw, &msg); err != nil {
					select {
					case errs <- fmt.Errorf("ws context observe: malformed error: %w", err):
					default:
					}
					continue
				}
				ev.Err = &msg
			default:
				// Unknown type — emit to errs but keep
				// reading. Forward-compat with future
				// frame types.
				select {
				case errs <- fmt.Errorf("ws context observe: unknown frame type %q", probe.Type):
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
