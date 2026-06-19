// src/nexus/contextBroadcaster.ts
//
// PR-A2: per-app singleton that owns a per-cwd cache of the most recent
// AssembledContext per sessionId. The /v1/context/observe WebSocket
// subscribes to this broadcaster to receive:
//   1. An initial `assembled_snapshot` frame on connect (from the cache).
//   2. Live `assembled` events whenever the runtime's hot path
//      (refreshRuntimeContextState) finishes a successful assembleContext.
//
// Design rationale (mirrors PR-27 workingSetBroadcaster.ts):
//   - Generic pub/sub keyed by cwd. Each subscriber is invoked fire-and-
//     forget; if a subscriber throws, the error is swallowed so a
//     misbehaving observer never blocks the runtime hot path.
//   - The cache supports snapshot-on-connect (per design §7.3).
//   - publish() is a no-op when no subscribers exist for the cwd, so the
//     hot path stays free in the common case (no observer).
//
// Hot-path contract:
//   - publish() never throws into the caller (try/catch wrap).
//   - publish() does not await subscriber callbacks (fire-and-forget).
//   - publish() short-circuits when there are no subscribers for the cwd.
//
// Module-level `defaultContextBroadcaster` is the legacy no-op instance
// used by /v1/context/observe when a caller does not inject a broadcaster.
// Runtime hot paths receive a broadcaster explicitly.

import type { AssembledContext } from '../runtime/contextAssembler.js'

export type ContextEvent = {
  type: 'assembled'
  sessionId: string
  context: AssembledContext
  timestamp: string
}

export type ContextEventHandler = (event: ContextEvent) => void

type CwdEntry = {
  subscribers: Set<ContextEventHandler>
  lastBySessionId: Map<string, AssembledContext>
}

export class ContextBroadcaster {
  private entries: Map<string, CwdEntry> = new Map()

  /**
   * Fire-and-forget publish. Always returns synchronously. The cwd
   * entry is always ensured (so the last-by-session cache is
   * available for snapshot-on-connect), but the fan-out is skipped
   * when no subscribers are registered. Subscriber exceptions are
   * caught and logged at warn level so a misbehaving observer never
   * breaks the hot path.
   */
  publish(cwd: string, event: ContextEvent): void {
    const entry = this.ensureEntry(cwd)
    // Update last-by-session cache (cheap, single Map.set).
    entry.lastBySessionId.set(event.sessionId, event.context)
    if (entry.subscribers.size === 0) return
    // Fan out. Iterate over a snapshot so unsubscribes during fan-out
    // do not skip or double-deliver.
    const subscribers = Array.from(entry.subscribers)
    for (const handler of subscribers) {
      try {
        handler(event)
      } catch (err) {
        // Swallow observer errors. Use console.warn to avoid pulling
        // a logger into the hot path.
        // eslint-disable-next-line no-console
        console.warn('[contextBroadcaster] subscriber threw:', err)
      }
    }
  }

  /**
   * Subscribe to context events for a specific cwd. Returns an
   * unsubscribe function. The handler is invoked for every `assembled`
   * event whose cwd matches.
   */
  subscribe(cwd: string, handler: ContextEventHandler): () => void {
    const entry = this.ensureEntry(cwd)
    entry.subscribers.add(handler)
    return () => {
      const current = this.entries.get(cwd)
      if (!current) return
      current.subscribers.delete(handler)
    }
  }

  /**
   * Convenience: subscribe with a sessionId filter. The handler is only
   * invoked for events whose sessionId matches.
   */
  subscribeSession(cwd: string, sessionId: string, handler: ContextEventHandler): () => void {
    return this.subscribe(cwd, (event) => {
      if (event.sessionId === sessionId) handler(event)
    })
  }

  /**
   * Get the most recent AssembledContext for a given cwd+sessionId.
   * Returns undefined if no event has been published for that pair.
   * Used by the /v1/context/observe route to send the initial snapshot.
   */
  getLast(cwd: string, sessionId: string): AssembledContext | undefined {
    return this.entries.get(cwd)?.lastBySessionId.get(sessionId)
  }

  /**
   * Test/observability: number of cached cwds.
   */
  size(): number {
    return this.entries.size
  }

  /**
   * Test/observability: number of subscribers for a cwd.
   */
  subscriberCount(cwd: string): number {
    return this.entries.get(cwd)?.subscribers.size ?? 0
  }

  /**
   * Test/observability: clear all entries. Does NOT invoke any cleanup
   * on subscribers — callers must ensure no subscribers remain.
   */
  clear(): void {
    this.entries.clear()
  }

  private ensureEntry(cwd: string): CwdEntry {
    let entry = this.entries.get(cwd)
    if (!entry) {
      entry = { subscribers: new Set(), lastBySessionId: new Map() }
      this.entries.set(cwd, entry)
    }
    return entry
  }
}

/**
 * Legacy default instance used by /v1/context/observe when no explicit
 * broadcaster is passed. Production composition roots that need runtime
 * fan-out should construct one ContextBroadcaster and pass it both to
 * createDefaultNexusRuntime({ contextBroadcaster }) and createNexusApp({
 * contextBroadcaster }).
 */
export let defaultContextBroadcaster: ContextBroadcaster = new ContextBroadcaster()

/**
 * Swap the module-level singleton. Kept for legacy tests / manual
 * compatibility only; new runtime code should use explicit injection.
 */
export function setDefaultContextBroadcaster(instance: ContextBroadcaster): void {
  defaultContextBroadcaster = instance
}
