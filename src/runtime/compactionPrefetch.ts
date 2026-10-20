/**
 * Bounded async compaction-summary prefetch (SPIKE — not wired into the
 * runtime; see docs/nexus/reference/compaction-async-prefetch-spike-20261019.md).
 *
 * Hypothesis: the LLM compaction summary for the predicted next omission set
 * can be started early (e.g. after each turn), so a later auto-compaction
 * awaits an already-started summary instead of paying the full latency
 * synchronously.
 *
 * Design contract:
 *
 * 1. **Dependencies inverted.** The summarize function is injected; this
 *    module imports nothing from compact.ts / compactSummary.ts, so there is
 *    no import cycle and no runtime wiring.
 * 2. **Content-addressed.** Entries are keyed by a sha256 over a canonical
 *    JSON projection of every event field except the constant schemaVersion
 *    (type, timestamp, sessionId, and all text-ish/tool fields). Stored
 *    events are immutable once appended, so any change to the omission set —
 *    appended events, different window, different text — yields a different
 *    key. This is stronger than summaryCache.buildSummaryCacheKey, which only
 *    hashes text lengths.
 * 3. **Stale guard.** awaitSummary only ever returns the summary stored under
 *    the awaited events' own key. A key mismatch with a non-empty cache means
 *    the prefetched predictions no longer match reality: status 'stale' and
 *    every non-matching entry is invalidated. The stored summary is NEVER
 *    served for different events, even after its promise resolves.
 * 4. **Bounded.** LRU eviction at maxEntries (default 4). Late settlements of
 *    evicted/invalidated entries mutate only the orphaned entry object; they
 *    never re-enter the map. A settlement observer attached at prefetch time
 *    ensures rejections are always handled, even if nobody ever awaits.
 * 5. **Deadline-aware.** awaitSummary waits at most the REMAINING time between
 *    prefetch start and the caller's deadline. An already-resolved entry still
 *    wins the race at an exhausted deadline (microtasks beat a 0ms timer), so
 *    a free summary is never thrown away.
 * 6. **In-memory only; no globals; no env flags.** Each cache instance carries
 *    its own state. Timeout ≠ eviction: a timed-out await leaves the entry
 *    under its original key, so a later await of the SAME events may still
 *    hit; the result is never re-keyed.
 */
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { NexusEvent } from '../shared/events.js'

export type PrefetchSummarizeFn = (events: readonly NexusEvent[]) => Promise<string>

export type PrefetchCacheOptions = {
  /** Injected summarizer, e.g. events => llmSummarizeEvents(events, modelId, …). */
  summarize: PrefetchSummarizeFn
  /** LRU capacity. Default 4; clamped to >= 1. */
  maxEntries?: number
  /** Monotonic clock in ms. Default performance.now. */
  now?: () => number
}

export type AwaitSummaryResult =
  | { status: 'hit'; summary: string; latencySavedMs: number }
  | { status: 'miss' }
  | { status: 'stale' }
  | { status: 'fallback'; reason: 'timeout' | 'error' }

export type CompactionPrefetchCache = {
  /**
   * Start summarizing immediately unless an entry for the same content key
   * already exists (duplicate prefetch is a no-op). Returns the content key.
   */
  prefetch(events: readonly NexusEvent[]): string
  /**
   * Await the prefetched summary for exactly these events, bounded by the
   * time remaining until deadlineMs after the prefetch started.
   */
  awaitSummary(
    events: readonly NexusEvent[],
    options: { deadlineMs: number },
  ): Promise<AwaitSummaryResult>
  /** Live entry count (introspection for tests / wiring diagnostics). */
  size(): number
  /** Drop all entries; late settlements of dropped entries are ignored. */
  clear(): void
}

type PrefetchEntry = {
  key: string
  promise: Promise<string>
  startedAt: number
  /** Set by the settlement observer when the promise resolves successfully. */
  settledAt?: number
}

const DEFAULT_MAX_ENTRIES = 4
const KEY_DOMAIN = 'compaction-prefetch:v1'

/**
 * Stable content key: sha256 over a canonical JSON projection of each event
 * (all fields except the constant schemaVersion, object keys sorted).
 */
export function buildPrefetchKey(events: readonly NexusEvent[]): string {
  const hash = createHash('sha256').update(KEY_DOMAIN)
  for (const event of events) {
    const { schemaVersion: _schemaVersion, ...fields } = event as unknown as Record<string, unknown>
    hash.update('\n|')
    hash.update(stableStringify(fields))
  }
  return hash.digest('hex')
}

export function createPrefetchCache(options: PrefetchCacheOptions): CompactionPrefetchCache {
  const summarize = options.summarize
  const now = options.now ?? (() => performance.now())
  const limit = normalizeMaxEntries(options.maxEntries)
  const entries = new Map<string, PrefetchEntry>()

  const touch = (key: string, entry: PrefetchEntry): void => {
    entries.delete(key)
    entries.set(key, entry)
  }

  const prefetch = (events: readonly NexusEvent[]): string => {
    const key = buildPrefetchKey(events)
    const existing = entries.get(key)
    if (existing) {
      touch(key, existing)
      return key
    }
    const startedAt = now()
    let promise: Promise<string>
    try {
      promise = Promise.resolve(summarize(events))
    } catch (error) {
      // A synchronously-throwing summarize becomes a rejected promise so the
      // failure surfaces uniformly as awaitSummary 'fallback'.
      promise = Promise.reject(error)
    }
    const entry: PrefetchEntry = { key, promise, startedAt }
    // Settlement observer, attached exactly once at creation: records the
    // resolution time for latencySavedMs and guarantees every rejection is
    // handled even if the entry is evicted/invalidated before anyone awaits.
    promise.then(
      () => { entry.settledAt = now() },
      () => { /* rejection handled here; surfaced via awaitSummary 'fallback' */ },
    )
    entries.set(key, entry)
    while (entries.size > limit) {
      const oldestKey = entries.keys().next().value
      if (oldestKey === undefined) break
      entries.delete(oldestKey)
    }
    return key
  }

  const awaitSummary = async (
    events: readonly NexusEvent[],
    awaitOptions: { deadlineMs: number },
  ): Promise<AwaitSummaryResult> => {
    const key = buildPrefetchKey(events)
    const entry = entries.get(key)
    if (!entry) {
      if (entries.size === 0) return { status: 'miss' }
      // Stale: predictions exist but none matches the awaited events. They can
      // only hit if the identical omission set recurs, which a monotonically
      // growing event log plus a compaction boundary prevents — invalidate all.
      entries.clear()
      return { status: 'stale' }
    }
    touch(key, entry)
    const awaitStartMs = now()
    const waitMs = Math.max(0, awaitOptions.deadlineMs - (awaitStartMs - entry.startedAt))
    const TIMEOUT = Symbol('prefetch-timeout')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<typeof TIMEOUT>(resolve => {
      timer = setTimeout(() => resolve(TIMEOUT), waitMs)
    })
    try {
      const outcome = await Promise.race([
        entry.promise.then(
          value => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        ),
        timeoutPromise,
      ])
      if (outcome === TIMEOUT) {
        // Keep the entry under its original key: a later await of the SAME
        // events may still hit. The result is never re-keyed.
        return { status: 'fallback', reason: 'timeout' }
      }
      if (!outcome.ok) {
        // A rejected summarize can never produce a summary; drop the entry —
        // but ONLY if it is still the same entry. After an LRU eviction the
        // key may already hold a NEWER prefetch; deleting by key alone would
        // destroy that live entry (P2 identity-delete race).
        if (entries.get(key) === entry) entries.delete(key)
        return { status: 'fallback', reason: 'error' }
      }
      // Saved latency = summarization time we did not pay synchronously:
      // the full duration when it finished before we arrived, else the head
      // start elapsed before we arrived. The settlement observer is attached
      // before this race handler, so settledAt is already set when the race
      // resolves during our await.
      const resolvedAtMs = entry.settledAt ?? now()
      const latencySavedMs = Math.max(0, Math.min(awaitStartMs, resolvedAtMs) - entry.startedAt)
      return { status: 'hit', summary: outcome.value, latencySavedMs }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    prefetch,
    awaitSummary,
    size: () => entries.size,
    clear: () => entries.clear(),
  }
}

function normalizeMaxEntries(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ENTRIES
  return Math.max(1, Math.floor(value))
}

/**
 * JSON.stringify with sorted object keys and circular-reference tolerance, so
 * the content key is independent of object key insertion order.
 */
function stableStringify(value: unknown, seen: Set<object> = new Set()): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (seen.has(value)) return '"[Circular]"'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => stableStringify(item, seen)).join(',')}]`
    }
    const fields = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(field => `${JSON.stringify(field)}:${stableStringify((value as Record<string, unknown>)[field], seen)}`)
    return `{${fields.join(',')}}`
  } finally {
    seen.delete(value)
  }
}
