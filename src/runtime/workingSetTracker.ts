// src/runtime/workingSetTracker.ts
//
// Minimal WorkingSetTracker — Track A Phase 1 sub-PR-4a (see
// docs/nexus/reference/long-running-context-assembly.md §5.1).
//
// This is the in-memory-only foundation of the runtime-owned
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
// PR-26 (Track A Phase 3 §6.3 + §7.3 WebSocket):
//   - event bus: subscribe to {type: 'working_set_updated', ...} events
//   - per-workspace broadcast: linkToWorkspace + broadcastChange
//
// Out of scope (later PRs):
//   - persistence
//   - /v1/working-set/observe WebSocket (PR-27)
//   - cross-workspace aggregation API
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
  // Optional explicit version (used by load path to preserve original).
  // When provided, the resulting WorkingSet uses this version instead of
  // bumping from the previous one.
  version?: number
}

// ─── PR-26: event bus for working_set_updated push (design §6.3 + §7.3) ───

export type WorkingSetEventType = 'working_set_updated' | 'working_set_reset'

export type WorkingSetEvent =
  | { type: 'working_set_updated'; sessionId: string; workspaceId: string; ws: WorkingSet; timestamp: string }
  | { type: 'working_set_reset'; sessionId: string; workspaceId: string; timestamp: string }

export type WorkingSetEventHandler = (event: WorkingSetEvent) => void | Promise<void>

/**
 * Simple synchronous-first event bus. Handlers may return a Promise;
 * the bus does not await it (fire-and-forget) so a slow handler never
 * blocks a tracker mutation. Handler errors are caught and swallowed
 * to keep the tracker resilient — observability hooks (Phase 4) may
 * upgrade this to log to diagnostics.
 */
export class WorkingSetEventBus {
  private handlers: Set<WorkingSetEventHandler> = new Set()

  subscribe(handler: WorkingSetEventHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  size(): number {
    return this.handlers.size
  }

  emit(event: WorkingSetEvent): void {
    for (const handler of this.handlers) {
      try {
        const result = handler(event)
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          // Fire-and-forget. We deliberately don't await — see class comment.
          (result as Promise<unknown>).catch(() => { /* swallow */ })
        }
      } catch {
        // Swallow handler errors to keep tracker mutations safe.
      }
    }
  }
}

const WORKING_SET_ENTRY_VALUE_MAX_CHARS = 200

export class WorkingSetTracker {
  private bySession = new Map<string, WorkingSet>()
  // PR-26: workspaceId → set of sessionIds (per design §6.3 linkToWorkspace).
  private workspaceIndex = new Map<string, Set<string>>()
  // PR-26: event bus. Owned by tracker; subscribers attach via subscribe().
  private bus = new WorkingSetEventBus()

  // Returns null when session has no tracked working set yet.
  get(sessionId: string): WorkingSet | null {
    return this.bySession.get(sessionId) ?? null
  }

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  // PR-30: derive working-set entries from a single event and apply via
  // update(). Per doc §5.1 applyEvent API. Currently derives from
  // tool_started events (extracts file path → file:<path> entry).
  // Other event types are no-ops (returns null). Pure function on the
  // event, side effect is the update() call.
  applyEvent(sessionId: string, event: NexusEvent, cwd: string): WorkingSet | null {
    if (event.type !== 'tool_started') return null
    const toolEvent = event as Extract<NexusEvent, { type: 'tool_started' }>
    const input = toolEvent.input as Record<string, unknown> | undefined
    if (!input) return null
    const path = typeof input.path === 'string'
      ? input.path
      : typeof input.filePath === 'string'
        ? input.filePath
        : ''
    if (!path || !path.startsWith('/') || !path.startsWith(cwd)) return null

    // Find existing entry; if not present, append
    const existing = this.bySession.get(sessionId)
    const entries = existing ? [...existing.entries] : []
    const key = `file:${path}`
    if (entries.some((e) => e.key === key)) return existing ?? null
    entries.push({ key, value: path, updatedAt: new Date().toISOString(), confidence: 0.85 })
    return this.update(sessionId, {
      workspaceId: existing?.workspaceId,
      entries,
    })
  }

  // PR-30: getWorkspaceWorkingSet(workspaceId) per doc §5.1. Returns an
  // aggregated WorkingSet containing all entries from all sessions linked
  // to this workspace, with each entry's key tagged with the source
  // sessionId in the value prefix. Returns null if no sessions are linked.
  getWorkspaceWorkingSet(workspaceId: string): WorkingSet | null {
    const sessionIds = this.workspaceIndex.get(workspaceId)
    if (!sessionIds || sessionIds.size === 0) return null
    const aggregatedEntries: WorkingSetEntry[] = []
    let maxVersion = 0
    let latestUpdatedAt = ''
    for (const sid of sessionIds) {
      const ws = this.bySession.get(sid)
      if (!ws) continue
      if (ws.version > maxVersion) maxVersion = ws.version
      if (ws.updatedAt > latestUpdatedAt) latestUpdatedAt = ws.updatedAt
      for (const entry of ws.entries) {
        // Tag with source sessionId to disambiguate across sessions.
        // Use a key suffix to avoid collisions.
        aggregatedEntries.push({
          key: `${entry.key}@${sid}`,
          value: entry.value,
          updatedAt: entry.updatedAt,
          confidence: entry.confidence,
        })
      }
    }
    return {
      sessionId: `workspace:${workspaceId}`,
      workspaceId,
      entries: aggregatedEntries,
      version: maxVersion,
      updatedAt: latestUpdatedAt,
    }
  }

  // Apply a patch to an existing working set, or create a new one if absent.
  // Returns the post-patch state. Emits `working_set_updated` on success
  // (PR-26) so the WebSocket layer can fan out to subscribers.
  update(sessionId: string, patch: WorkingSetPatch): WorkingSet {
    const existing = this.bySession.get(sessionId)
    const now = new Date().toISOString()
    let next: WorkingSet
    if (!existing) {
      next = {
        sessionId,
        workspaceId: patch.workspaceId ?? '',
        entries: clampEntries(patch.entries ?? []),
        version: patch.version ?? 1,
        updatedAt: now,
      }
    } else {
      next = {
        sessionId,
        workspaceId: patch.workspaceId ?? existing.workspaceId,
        entries: clampEntries(patch.entries ?? existing.entries),
        // If caller provided an explicit version, use it (load path);
        // otherwise bump from existing.
        version: patch.version ?? existing.version + 1,
        updatedAt: now,
      }
    }
    this.bySession.set(sessionId, next)
    // Keep workspaceIndex in sync with the post-update workspaceId.
    this.indexWorkspace(sessionId, next.workspaceId)
    this.bus.emit({
      type: 'working_set_updated',
      sessionId,
      workspaceId: next.workspaceId,
      ws: next,
      timestamp: now,
    })
    return next
  }

  // Replace the working set wholesale (e.g. after a session rebuild).
  rebuild(sessionId: string, workspaceId: string, entries: WorkingSetEntry[]): WorkingSet {
    return this.update(sessionId, { workspaceId, entries })
  }

  // Remove a session's working set. Used when session ends / is GC'd.
  // Emits `working_set_reset` so subscribers can drop the session.
  reset(sessionId: string): void {
    const existing = this.bySession.get(sessionId)
    this.bySession.delete(sessionId)
    const workspaceId = existing?.workspaceId ?? ''
    if (workspaceId) {
      this.workspaceIndex.get(workspaceId)?.delete(sessionId)
      if (this.workspaceIndex.get(workspaceId)?.size === 0) {
        this.workspaceIndex.delete(workspaceId)
      }
    }
    this.bus.emit({
      type: 'working_set_reset',
      sessionId,
      workspaceId,
      timestamp: new Date().toISOString(),
    })
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

  // ─── PR-26: event bus API (per design §7.3 working_set_updated push) ───

  // Subscribe to all working-set mutations. Returns an unsubscribe fn.
  subscribe(handler: WorkingSetEventHandler): () => void {
    return this.bus.subscribe(handler)
  }

  // Number of active subscribers. Test/observability surface.
  subscriberCount(): number {
    return this.bus.size()
  }

  // ─── PR-26: cross-session workspace broadcast (per design §6.3) ───

  // Register a session as belonging to a workspace. Idempotent.
  linkToWorkspace(sessionId: string, workspaceId: string): void {
    if (!workspaceId) return
    if (!this.workspaceIndex.has(workspaceId)) {
      this.workspaceIndex.set(workspaceId, new Set())
    }
    this.workspaceIndex.get(workspaceId)!.add(sessionId)
  }

  // Unregister a session from a workspace. No-op if not linked.
  unlinkFromWorkspace(sessionId: string, workspaceId: string): void {
    this.workspaceIndex.get(workspaceId)?.delete(sessionId)
    if (this.workspaceIndex.get(workspaceId)?.size === 0) {
      this.workspaceIndex.delete(workspaceId)
    }
  }

  // All sessionIds currently linked to a workspace. Used by future
  // WebSocket fan-out (PR-27 /v1/working-set/observe).
  sessionsInWorkspace(workspaceId: string): string[] {
    return Array.from(this.workspaceIndex.get(workspaceId) ?? [])
  }

  // Number of registered workspaces. Test/observability surface.
  workspaceCount(): number {
    return this.workspaceIndex.size
  }

  // Internal: keep workspaceIndex consistent with the latest workspaceId
  // recorded for a session. Called from update(). Removes the sessionId
  // from any other workspace's set first, so a workspace-change
  // (ws-a → ws-b) leaves the old workspace correctly empty.
  private indexWorkspace(sessionId: string, workspaceId: string): void {
    for (const [wsId, members] of this.workspaceIndex) {
      if (members.delete(sessionId) && members.size === 0) {
        this.workspaceIndex.delete(wsId)
      }
    }
    if (!workspaceId) return
    if (!this.workspaceIndex.has(workspaceId)) {
      this.workspaceIndex.set(workspaceId, new Set())
    }
    this.workspaceIndex.get(workspaceId)!.add(sessionId)
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
