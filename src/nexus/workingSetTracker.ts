// src/nexus/workingSetTracker.ts
//
// Minimal WorkingSetTracker — Track A Phase 1 sub-PR-4a (see
// docs/nexus/reference/long-running-context-assembly.md §5.1).
//
// This is the in-memory-only foundation of the full Nexus-side
// WorkingSetTracker. Persistence (.babel-o/working-set.json),
// event-bus broadcast (working_set_updated), and cross-workspace
// sharing (workspaceId aggregation) are intentionally out of scope
// and will be layered on in later phases.
//
// Scope (this PR):
//   - per-session WorkingSet container
//   - get / update / rebuild / reset / has
//   - integration seam: assembleContext() in contextAssembler.ts
//     accepts an optional `workingSetOverride` string; when provided,
//     the per-call derive is skipped and the supplied value is used
//     verbatim (still capped at MAX_ASSEMBLED_WORKING_SET_CHARS).
//
// Out of scope (later PRs):
//   - persistence
//   - event bus / cross-session broadcast
//   - cross-workspace aggregation
//   - everCoreRuntimeManager lease reuse
//
// Invariants respected:
//   - INV-L1: Working set is never compressed (we don't touch compact path)
//   - INV-L2: Session died, state didn't — state lives here independently
//   - INV-L9: working set ≤ 2k tokens (caller-side, we only expose raw entries)

import type { NexusEvent } from '../shared/events.js'

export type WorkingSetKey = string

export type WorkingSetEntry = {
  key: WorkingSetKey
  value: string
  updatedAt: string
  confidence: number
}

export type WorkingSet = {
  sessionId: string
  workspaceId: string
  entries: WorkingSetEntry[]
  version: number
  updatedAt: string
}

export type WorkingSetPatch = {
  workspaceId?: string
  entries?: WorkingSetEntry[]
}

const WORKING_SET_ENTRY_VALUE_MAX_CHARS = 200

export class WorkingSetTracker {
  private bySession = new Map<string, WorkingSet>()

  // Returns null when session has no tracked working set yet.
  get(sessionId: string): WorkingSet | null {
    return this.bySession.get(sessionId) ?? null
  }

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  // Apply a patch to an existing working set, or create a new one if absent.
  // Returns the post-patch state.
  update(sessionId: string, patch: WorkingSetPatch): WorkingSet {
    const existing = this.bySession.get(sessionId)
    const now = new Date().toISOString()
    if (!existing) {
      const ws: WorkingSet = {
        sessionId,
        workspaceId: patch.workspaceId ?? '',
        entries: clampEntries(patch.entries ?? []),
        version: 1,
        updatedAt: now,
      }
      this.bySession.set(sessionId, ws)
      return ws
    }
    const next: WorkingSet = {
      sessionId,
      workspaceId: patch.workspaceId ?? existing.workspaceId,
      entries: clampEntries(patch.entries ?? existing.entries),
      version: existing.version + 1,
      updatedAt: now,
    }
    this.bySession.set(sessionId, next)
    return next
  }

  // Replace the working set wholesale (e.g. after a session rebuild).
  rebuild(sessionId: string, workspaceId: string, entries: WorkingSetEntry[]): WorkingSet {
    return this.update(sessionId, { workspaceId, entries })
  }

  // Remove a session's working set. Used when session ends / is GC'd.
  reset(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  // Test-only: number of tracked sessions.
  size(): number {
    return this.bySession.size
  }

  // Enumerate tracked sessions as [sessionId, WorkingSet] pairs. Used by
  // PersistedWorkingSetTracker for snapshotting. Returns a fresh array
  // each call (safe to mutate).
  entries(): Array<[string, WorkingSet]> {
    return Array.from(this.bySession.entries())
  }
}

function clampEntries(entries: WorkingSetEntry[]): WorkingSetEntry[] {
  return entries.map(entry => ({
    key: entry.key,
    value: entry.value.length > WORKING_SET_ENTRY_VALUE_MAX_CHARS
      ? entry.value.slice(0, WORKING_SET_ENTRY_VALUE_MAX_CHARS)
      : entry.value,
    updatedAt: entry.updatedAt,
    confidence: entry.confidence < 0 ? 0 : entry.confidence > 1 ? 1 : entry.confidence,
  }))
}

// Helper: derive an initial working set from an event tail. This is a
// thin wrapper for callers that want to seed a tracker from historical
// events. It is deliberately separate from contextAssembler's
// deriveWorkingSet (which returns a different shape).
export function deriveEntriesFromEvents(events: NexusEvent[], cwd: string): WorkingSetEntry[] {
  const entries: WorkingSetEntry[] = []
  const seen = new Set<string>()
  const now = new Date().toISOString()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || event.type !== 'tool_started') continue
    const input = (event as Extract<NexusEvent, { type: 'tool_started' }>).input as
      | Record<string, unknown>
      | undefined
    if (!input) continue
    const path = typeof input.path === 'string'
      ? input.path
      : typeof input.filePath === 'string'
        ? input.filePath
        : ''
    if (!path || !path.startsWith('/') || seen.has(path)) continue
    if (!path.startsWith(cwd)) continue
    seen.add(path)
    entries.push({
      key: `file:${path}`,
      value: path,
      updatedAt: now,
      confidence: 0.8,
    })
    if (entries.length >= 16) break
  }
  return entries
}
