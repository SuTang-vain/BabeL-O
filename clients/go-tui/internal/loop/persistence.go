// internal/loop/persistence.go
//
// Phase 5a of docs/nexus/reference/go-tui-loop-multipane-plan.md:
// local `~/.bbl/loop/state.json` ↔ Nexus `loop_state`
// reconcile. The snapshot mirrors the Nexus LoopPaneState
// schema (Phase 1b) so the diff is straightforward. Atomic
// file write avoids corrupting the snapshot on crash;
// reconcile identifies the three actions the runtime
// worker takes: push (recreate / overwrite), pull (adopt),
// unchanged.

package loop

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/sutang-vain/babel-o/clients/go-tui/internal/loop/api"
)

// Snapshot is the on-disk representation of one user's loop
// driver state. Version lets future migrations refuse old
// files; UpdatedAt is the last Replace timestamp.
type Snapshot struct {
	Version   int             `json:"version"`
	UpdatedAt string          `json:"updatedAt"`
	Panes     []PaneStateEntry `json:"panes"`
}

// PaneStateEntry mirrors api.LoopPaneState with a flatter
// layout suitable for JSON. Field tags align with the server
// contract so future cross-tooling can round-trip without
// conversion.
type PaneStateEntry struct {
	PaneID      string `json:"paneId"`
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	SessionID   string `json:"sessionId"`
	Agent       string `json:"agent"`
	Cwd         string `json:"cwd"`
	Label       string `json:"label"`
	LastRev     int64  `json:"lastRev"`
	UpdatedAt   string `json:"updatedAt"`
}

const snapshotVersion = 1

// Store handles debounced atomic writes to the snapshot
// file. All methods are safe for concurrent use.
type Store struct {
	path string

	mu      sync.Mutex
	current Snapshot
	dirty   bool

	writeDelay time.Duration
	stopCh     chan struct{}
	doneCh     chan struct{}
	once      sync.Once
}

// NewStore returns a Store backed by path. The path is
// created lazily on first persist; the directory is created
// eagerly on construction when possible. NewStore hydrates
// the in-memory snapshot from the file on disk (missing file
// is treated as empty) so a fresh `bbl loop` launch sees the
// panes the previous session left behind.
func NewStore(path string) (*Store, error) {
	if path == "" {
		path = defaultStatePath()
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("loop store: mkdir %q: %w", dir, err)
		}
	}
	snap, err := LoadSnapshot(path)
	if err != nil {
		return nil, err
	}
	store := &Store{
		path:       path,
		current:    snap,
		writeDelay: 500 * time.Millisecond,
		stopCh:     make(chan struct{}),
		doneCh:     make(chan struct{}),
	}
	go store.flushLoop()
	return store, nil
}

// Path returns the file path backing this store.
func (s *Store) Path() string { return s.path }

// LoadSnapshot reads the snapshot file at path and returns
// the parsed value. Missing file is treated as empty
// (version 1, no panes) rather than an error so first-run
// is graceful.
func LoadSnapshot(path string) (Snapshot, error) {
	if path == "" {
		path = defaultStatePath()
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Snapshot{Version: snapshotVersion, UpdatedAt: time.Now().UTC().Format(time.RFC3339)}, nil
	}
	if err != nil {
		return Snapshot{}, fmt.Errorf("loop store: read %q: %w", path, err)
	}
	var snap Snapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return Snapshot{}, fmt.Errorf("loop store: parse %q: %w", path, err)
	}
	if snap.Version == 0 {
		snap.Version = snapshotVersion
	}
	return snap, nil
}

// Snapshot returns a defensive copy of the current in-memory
// snapshot. Callers must not mutate the returned slice.
func (s *Store) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.current
	out.Panes = append([]PaneStateEntry(nil), s.current.Panes...)
	return out
}

// Replace swaps the in-memory snapshot. The change is queued
// for a debounced atomic write so frequent calls don't
// thrash the disk.
func (s *Store) Replace(snap Snapshot) error {
	if snap.Version == 0 {
		snap.Version = snapshotVersion
	}
	snap.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	snap.Panes = normalizePaneEntries(snap.Panes)
	s.mu.Lock()
	s.current = snap
	s.dirty = true
	s.mu.Unlock()
	return nil
}

// Close flushes any pending change synchronously and stops
// the background flusher.
func (s *Store) Close() error {
	s.once.Do(func() { close(s.stopCh) })
	<-s.doneCh
	return s.flushNow()
}

func (s *Store) flushLoop() {
	defer close(s.doneCh)
	ticker := time.NewTicker(s.writeDelay)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			_ = s.flushNow()
		}
	}
}

func (s *Store) flushNow() error {
	s.mu.Lock()
	if !s.dirty {
		s.mu.Unlock()
		return nil
	}
	snap := s.current
	snap.Panes = append([]PaneStateEntry(nil), s.current.Panes...)
	s.dirty = false
	s.mu.Unlock()
	return writeSnapshotAtomic(s.path, snap)
}

func writeSnapshotAtomic(path string, snap Snapshot) error {
	encoded, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return fmt.Errorf("loop store: encode: %w", err)
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".state.json.tmp.*")
	if err != nil {
		return fmt.Errorf("loop store: create tmp: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpPath) }
	if _, err := io.Copy(tmp, bytesReader(encoded)); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("loop store: write tmp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("loop store: sync tmp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("loop store: close tmp: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		cleanup()
		return fmt.Errorf("loop store: rename %q -> %q: %w", tmpPath, path, err)
	}
	return nil
}

func bytesReader(b []byte) io.Reader { return &sliceReader{b: b} }

type sliceReader struct {
	b   []byte
	off int
}

func (r *sliceReader) Read(p []byte) (int, error) {
	if r.off >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.off:])
	r.off += n
	return n, nil
}

// ReconcileOutcome captures the delta between the local
// snapshot and the server's loop_state. The semantics match
// the bbl loop philosophy: local is the user's open tabs.
//
//	PushToServer: entries in local that are not (or differ) on
//	              the server. Caller should UpsertPane.
//	PullFromServer: entries on the server that are not in
//	                local. Caller should add to local snapshot.
//	Unchanged: exact match between local and server. No-op.
type ReconcileOutcome struct {
	PushToServer   []PaneStateEntry
	PullFromServer []PaneStateEntry
	Unchanged      []PaneStateEntry
}

// Reconcile computes the delta between the local snapshot
// and the server's authoritative panes. Pure function: no
// I/O, no clock, no allocation beyond the result slice.
func Reconcile(local Snapshot, serverPanes []api.LoopPaneState) ReconcileOutcome {
	localByID := make(map[string]PaneStateEntry, len(local.Panes))
	for _, entry := range local.Panes {
		localByID[entry.PaneID] = entry
	}
	serverByID := make(map[string]api.LoopPaneState, len(serverPanes))
	for _, pane := range serverPanes {
		serverByID[pane.PaneID] = pane
	}

	out := ReconcileOutcome{}
	for id, entry := range localByID {
		server, ok := serverByID[id]
		if !ok {
			// Local has it, server does not → push to server
			// (recreate on next server start).
			out.PushToServer = append(out.PushToServer, entry)
			continue
		}
		if !entry.matchesServer(server) {
			// Both have it but content differs → push local
			// to server (local is the user's open tabs).
			out.PushToServer = append(out.PushToServer, entry)
		} else {
			out.Unchanged = append(out.Unchanged, entry)
		}
	}
	for id, server := range serverByID {
		if _, ok := localByID[id]; !ok {
			// Server has it, local does not → pull to local
			// (adopt server's authoritative state).
			out.PullFromServer = append(out.PullFromServer, paneStateFromServer(server))
		}
	}
	sort.Slice(out.PushToServer, func(i, j int) bool {
		return out.PushToServer[i].PaneID < out.PushToServer[j].PaneID
	})
	sort.Slice(out.PullFromServer, func(i, j int) bool {
		return out.PullFromServer[i].PaneID < out.PullFromServer[j].PaneID
	})
	sort.Slice(out.Unchanged, func(i, j int) bool {
		return out.Unchanged[i].PaneID < out.Unchanged[j].PaneID
	})
	return out
}

func (e PaneStateEntry) matchesServer(server api.LoopPaneState) bool {
	return e.PaneID == server.PaneID &&
		e.WorkspaceID == server.WorkspaceID &&
		e.TabID == server.TabID &&
		e.SessionID == server.SessionID &&
		e.Agent == server.Agent &&
		e.Cwd == server.Cwd &&
		e.Label == server.Label &&
		e.LastRev == server.LastRev
}

func paneStateFromServer(server api.LoopPaneState) PaneStateEntry {
	return PaneStateEntry{
		PaneID:      server.PaneID,
		WorkspaceID: server.WorkspaceID,
		TabID:       server.TabID,
		SessionID:   server.SessionID,
		Agent:       server.Agent,
		Cwd:         server.Cwd,
		Label:       server.Label,
		LastRev:     server.LastRev,
		UpdatedAt:   server.UpdatedAt,
	}
}

func normalizePaneEntries(entries []PaneStateEntry) []PaneStateEntry {
	if len(entries) == 0 {
		return []PaneStateEntry{}
	}
	out := append([]PaneStateEntry(nil), entries...)
	sort.Slice(out, func(i, j int) bool { return out[i].PaneID < out[j].PaneID })
	return out
}
