// src/nexus/workingSetBroadcaster.ts
//
// PR-27: per-app singleton that owns a per-cwd cache of PersistedWorkingSetTracker
// instances. The /v1/working-set/observe WebSocket subscribes to a tracker's
// event bus so it can fan out working_set_updated / working_set_reset events
// to live clients.
//
// Design rationale (per long-running-context-assembly.md §6.3 + §7.3):
//   - Each WorkingSetTracker has its own event bus. If a REST handler creates
//     a new tracker per request, that handler's mutations never reach a
//     WebSocket that subscribes to a different tracker instance.
//   - The broadcaster gives the WebSocket a stable per-cwd tracker handle,
//     AND lets future REST handlers (PR-28+) share the same instance so
//     mutations flow into the bus that WebSocket clients are listening on.
//
// This module is purely additive. Existing REST handlers (PR-11/12/18/20)
// still create per-request trackers and remain unaffected.

import { PersistedWorkingSetTracker } from '../runtime/persistedWorkingSetTracker.js'
import type {
  WorkingSetEvent,
  WorkingSetEventHandler,
  WorkingSetTracker as WorkingSetTrackerType,
} from '../runtime/workingSetTracker.js'

export type BroadcasterTracker = {
  tracker: PersistedWorkingSetTracker
  loadPromise: Promise<void>
}

export class WorkingSetBroadcaster {
  private byCwd = new Map<string, BroadcasterTracker>()

  /**
   * Get or create a per-cwd tracker. The tracker's `load()` is invoked
   * eagerly and exposed as a Promise so callers can `await` the initial
   * state. The same load() promise is returned on subsequent calls
   * (so multiple callers don't double-load).
   */
  getOrCreateTracker(cwd: string): BroadcasterTracker {
    const existing = this.byCwd.get(cwd)
    if (existing) return existing
    const tracker = new PersistedWorkingSetTracker(cwd)
    const loadPromise = tracker.load()
    const entry: BroadcasterTracker = { tracker, loadPromise }
    this.byCwd.set(cwd, entry)
    return entry
  }

  /**
   * Subscribe to events for a specific cwd. The handler is called for
   * every working_set_updated / working_set_reset the tracker emits.
   * Returns an unsubscribe fn.
   *
   * Note: load() is not awaited here. If a caller subscribes before
   * load completes, the initial state is not delivered via this hook.
   * Use `getOrCreateTracker(cwd).loadPromise` if you need that.
   */
  subscribe(cwd: string, handler: WorkingSetEventHandler): () => void {
    const { tracker } = this.getOrCreateTracker(cwd)
    return tracker.subscribe(handler)
  }

  /**
   * Convenience: subscribe with a sessionId filter. The handler is only
   * invoked for events whose sessionId matches.
   */
  subscribeSession(cwd: string, sessionId: string, handler: WorkingSetEventHandler): () => void {
    return this.subscribe(cwd, (event) => {
      if (event.sessionId === sessionId) handler(event)
    })
  }

  /**
   * Get the in-memory tracker (for read access). Returns undefined if no
   * tracker has been created for this cwd yet.
   */
  getTracker(cwd: string): WorkingSetTrackerType | undefined {
    return this.byCwd.get(cwd)?.tracker
  }

  /**
   * Test/observability: number of cached trackers.
   */
  size(): number {
    return this.byCwd.size
  }

  /**
   * Test/observability: clear the cache. Does NOT close trackers or
   * dispose file handles — callers must ensure no subscribers remain.
   */
  clear(): void {
    this.byCwd.clear()
  }

  /**
   * R3 of docs/nexus/proposals/long-running-context-assembly.md §20:
   * Shared mutation helper. Routes a mutation through the same per-cwd
   * tracker that the /v1/working-set/observe WebSocket subscribes to,
   * so REST write mutations (PUT /v1/context/working-set/:sessionId)
   * are observed by every connected subscriber. Awaits the initial
   * load, runs the user's mutation against the in-memory tracker
   * (which emits working_set_updated on the bus), then flushes the
   * tracker to disk so the persistence layer is consistent.
   *
   * The mutation callback may return a value that is forwarded to the
   * caller (useful for the PUT route which returns the post-update
   * state). On any error during the mutation, the in-memory state
   * is whatever the callback left it as; the flush is skipped so we
   * do not persist a partial state. Errors propagate to the caller.
   */
  async mutate<T>(
    cwd: string,
    fn: (tracker: PersistedWorkingSetTracker) => T | Promise<T>,
  ): Promise<T> {
    const { tracker, loadPromise } = this.getOrCreateTracker(cwd)
    await loadPromise
    const result = await fn(tracker)
    await tracker.flush()
    return result
  }
}
