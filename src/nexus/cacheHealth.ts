// Cache health observability — Phase A of
// `docs/nexus/reference/cache-observability-and-nexus-realtime-detection-plan.md`.
//
// Pure functions only. No I/O. No runtime coupling. This module reads
// either a NexusMetrics.tokenUsage snapshot or a list of execution_metrics
// events and produces a CacheHealthSnapshot describing 4 cache dimensions
// (prompt / code_index / tool / reasoning).
//
// Design notes:
//   - 3 of 4 dimensions are always `unavailable` because we have no real
//     hit/miss source for code index, tool result, or reasoning cache. We
//     do NOT synthesize 0% rates — missing data is not 0% (plan §2.2).
//   - Prompt Cache uses the token-weighted hit rate formula already
//     implemented in `src/nexus/metrics.ts:344-351`:
//       cacheRead / (input + cacheCreation + cacheRead)
//   - `buildCacheHealthFromEvents` is the per-session rollup path (Phase B
//     candidate; here we only return per-event observedRatio + counts).
//   - All thresholds (target, warning band) are explicit constants. v1
//     does NOT read from config; env/config override deferred to v2.

import type { NexusEvent } from '../shared/events.js'

// ---- public types ----

export type CacheDimension = 'prompt' | 'code_index' | 'tool' | 'reasoning'

export type CacheHealthStatus = 'ok' | 'warning' | 'critical' | 'unavailable'

export type CacheHealthDimension = {
  dimension: CacheDimension
  targetRatio: number
  observedRatio?: number
  sampleCount: number
  status: CacheHealthStatus
  reason?: string
  source: 'provider_usage' | 'execution_metrics' | 'not_implemented'
}

export type CacheHealthSnapshot = {
  type: 'cache_health'
  schemaVersion: '2026-06-17.cache-health.v1'
  window: {
    kind: 'process' | 'session' | 'pane'
    sessionId?: string
    lastN?: number
  }
  dimensions: CacheHealthDimension[]
  summary: {
    status: CacheHealthStatus
    belowTarget: string[]
    unavailable: string[]
  }
}

// ---- inputs ----

/**
 * Subset of NexusMetrics.tokenUsage that this module needs. Defined as
 * an interface so tests don't have to spin up the full NexusMetrics class.
 */
export type TokenUsageLike = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

/**
 * Subset of execution_metrics events carrying cache data. Each event
 * must have `type: 'execution_metrics'` and the optional
 * `cacheReadInputTokens` / `cacheCreationInputTokens` fields.
 */
export type ExecutionMetricsLike = {
  type: 'execution_metrics'
  sessionId?: string
  timestamp?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

/**
 * Anything that has the `type` discriminator + optional cache fields.
 * Used to accept either a typed `ExecutionMetricsLike` or a wide
 * `NexusEvent[]` slice (the function filters by `type` internally).
 */
export type MaybeExecutionMetrics = {
  type: string
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

// ---- constants ----

/** Default target ratios from plan §4.2. v1 does not read from config. */
export const DEFAULT_CACHE_HEALTH_TARGETS: Readonly<Record<CacheDimension, number>> = Object.freeze({
  prompt: 0.85,
  code_index: 0.90,
  tool: 0.50,
  reasoning: 0.10,
})

/** Lower edge of the warning band: ok if >= target, warning if >= target * warningFloor. */
const WARNING_FLOOR = 0.75

// ---- core helpers ----

/** Token-weighted hit rate. Mirrors `src/nexus/metrics.ts:344-351`. */
function computeCacheReadRatio(usage: TokenUsageLike): number | undefined {
  const denominator =
    usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
  if (denominator <= 0) return undefined
  return clamp01(usage.cacheReadInputTokens / denominator)
}

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  if (n > 1) return 1
  return n
}

function evaluateStatus(
  observedRatio: number,
  targetRatio: number,
): CacheHealthStatus {
  if (observedRatio >= targetRatio) return 'ok'
  if (observedRatio >= targetRatio * WARNING_FLOOR) return 'warning'
  return 'critical'
}

function unavailableDimension(
  dimension: CacheDimension,
  reason: string,
): CacheHealthDimension {
  return {
    dimension,
    targetRatio: DEFAULT_CACHE_HEALTH_TARGETS[dimension],
    sampleCount: 0,
    status: 'unavailable',
    reason,
    source: 'not_implemented',
  }
}

// ---- prompt cache dimension ----

function evaluatePromptDimension(usage: TokenUsageLike | undefined): CacheHealthDimension {
  const target = DEFAULT_CACHE_HEALTH_TARGETS.prompt
  if (!usage) {
    return unavailableDimension('prompt', 'token_usage_snapshot_unavailable')
  }
  // "No samples" = no provider cache fields at all. When input tokens
  // are present but cache fields are all zero, we don't have a real
  // signal — treat as `unavailable` instead of fabricating a 0% rate.
  // This matches plan §2.2: "0% means 'has samples and missed'";
  // missing data is not 0%.
  const hasAnyCacheToken =
    usage.cacheReadInputTokens > 0 || usage.cacheCreationInputTokens > 0
  if (!hasAnyCacheToken) {
    return {
      dimension: 'prompt',
      targetRatio: target,
      sampleCount: 0,
      status: 'unavailable',
      reason: 'no_provider_cache_token_samples',
      source: 'provider_usage',
    }
  }
  const ratio = computeCacheReadRatio(usage)
  if (ratio === undefined) {
    // Has cache fields but denominator is 0 — shouldn't happen given the
    // hasAnyCacheToken check above, but stay defensive.
    return {
      dimension: 'prompt',
      targetRatio: target,
      sampleCount: 0,
      status: 'unavailable',
      reason: 'no_provider_cache_token_samples',
      source: 'provider_usage',
    }
  }
  const sampleCount = 1
  return {
    dimension: 'prompt',
    targetRatio: target,
    observedRatio: ratio,
    sampleCount,
    status: evaluateStatus(ratio, target),
    source: 'provider_usage',
  }
}

// ---- public builders ----

/**
 * Build a process-level CacheHealthSnapshot from a NexusMetrics
 * tokenUsage snapshot. Used by `/v1/runtime/metrics`.
 */
export function buildCacheHealthFromRuntimeMetrics(snapshot: {
  tokenUsage: TokenUsageLike
}): CacheHealthSnapshot {
  const dimensions: CacheHealthDimension[] = [
    evaluatePromptDimension(snapshot.tokenUsage),
    unavailableDimension('code_index', 'code_index_cache_not_implemented'),
    unavailableDimension('tool', 'tool_result_cache_not_implemented'),
    unavailableDimension('reasoning', 'reasoning_cache_not_reported'),
  ]
  return finalize({ kind: 'process', dimensions })
}

/**
 * Build a per-session (or per-pane) CacheHealthSnapshot from a slice
 * of `execution_metrics` events. Used by `/v1/runtime/loop/health`.
 *
 * Phase A scope: this is a starting point that:
 *   - aggregates the per-event `cacheReadInputTokens` / `cacheCreationInputTokens`
 *     / `inputTokens` into one TokenUsageLike shape, then evaluates Prompt Cache.
 *   - leaves code_index / tool / reasoning as `unavailable`.
 *   - returns sampleCount = number of `execution_metrics` events contributing.
 *
 * Phase B follow-up: add session replay path + windowing.
 */
export function buildCacheHealthFromEvents(
  events: ReadonlyArray<MaybeExecutionMetrics>,
  options: { sessionId?: string; lastN?: number; kind?: 'session' | 'pane' } = {},
): CacheHealthSnapshot {
  // Aggregate token usage across the events. Events without cache fields
  // contribute input/output tokens to the denominator but not the numerator.
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadInputTokens = 0
  let cacheCreationInputTokens = 0
  let executionMetricsEventCount = 0
  for (const e of events) {
    if (e.type !== 'execution_metrics') continue
    executionMetricsEventCount += 1
    inputTokens += e.inputTokens ?? 0
    outputTokens += e.outputTokens ?? 0
    cacheReadInputTokens += e.cacheReadInputTokens ?? 0
    cacheCreationInputTokens += e.cacheCreationInputTokens ?? 0
  }
  const usage: TokenUsageLike = {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  }
  const prompt = evaluatePromptDimension(usage)
  // Override sampleCount for the per-event path: it represents the number
  // of contributing `execution_metrics` events, not the total wide slice.
  // When the input is `ExecutionMetricsLike[]` this equals `events.length`;
  // when the input is a wide `NexusEvent[]` slice it counts only the
  // execution_metrics entries that actually contributed.
  prompt.sampleCount = executionMetricsEventCount

  const dimensions: CacheHealthDimension[] = [
    prompt,
    unavailableDimension('code_index', 'code_index_cache_not_implemented'),
    unavailableDimension('tool', 'tool_result_cache_not_implemented'),
    unavailableDimension('reasoning', 'reasoning_cache_not_reported'),
  ]
  return finalize({
    kind: options.kind ?? 'session',
    sessionId: options.sessionId,
    lastN: options.lastN,
    dimensions,
  })
}

// ---- finalize ----

function finalize(input: {
  kind: 'process' | 'session' | 'pane'
  sessionId?: string
  lastN?: number
  dimensions: CacheHealthDimension[]
}): CacheHealthSnapshot {
  const belowTarget: string[] = []
  const unavailable: string[] = []
  let hasCritical = false
  let hasWarning = false
  let hasOk = false
  for (const dim of input.dimensions) {
    if (dim.status === 'unavailable') {
      unavailable.push(dim.dimension)
    } else if (dim.status === 'critical') {
      hasCritical = true
      belowTarget.push(dim.dimension)
    } else if (dim.status === 'warning') {
      hasWarning = true
      belowTarget.push(dim.dimension)
    } else if (dim.status === 'ok') {
      hasOk = true
    }
  }
  // overall status: critical > warning > ok > unavailable
  let status: CacheHealthStatus
  if (hasCritical) status = 'critical'
  else if (hasWarning) status = 'warning'
  else if (hasOk) status = 'ok'
  else status = 'unavailable'
  return {
    type: 'cache_health',
    schemaVersion: '2026-06-17.cache-health.v1',
    window: {
      kind: input.kind,
      sessionId: input.sessionId,
      lastN: input.lastN,
    },
    dimensions: input.dimensions,
    summary: {
      status,
      belowTarget,
      unavailable,
    },
  }
}

// ---- evaluator (exported for unit tests) ----

/** Public so tests can exercise the threshold logic without rebuilding a snapshot. */
export function evaluateCacheDimension(input: {
  dimension: CacheDimension
  observedRatio: number | undefined
  sampleCount: number
}): CacheHealthDimension {
  const target = DEFAULT_CACHE_HEALTH_TARGETS[input.dimension]
  if (input.sampleCount <= 0 || input.observedRatio === undefined) {
    return unavailableDimension(input.dimension, 'no_provider_cache_token_samples')
  }
  return {
    dimension: input.dimension,
    targetRatio: target,
    observedRatio: clamp01(input.observedRatio),
    sampleCount: input.sampleCount,
    status: evaluateStatus(input.observedRatio, target),
    source: 'provider_usage',
  }
}

// ---- nexus-event adapter (used in Phase B/C, exposed for testability) ----

/**
 * Filter NexusEvent[] down to `execution_metrics` events. Exposed so
 * `buildCacheHealthFromEvents` can be called directly from
 * `/v1/runtime/loop/health` route handlers without duplicating the
 * type narrowing. Uses the `NexusEvent` type for callers that already
 * have a wide event slice.
 */
export function pickExecutionMetricsEvents(
  events: ReadonlyArray<NexusEvent>,
): ExecutionMetricsLike[] {
  const out: ExecutionMetricsLike[] = []
  for (const e of events) {
    if (e.type !== 'execution_metrics') continue
    out.push(e as unknown as ExecutionMetricsLike)
  }
  return out
}

// ---- Phase C: build a `cache_health` NexusEvent from a snapshot ----

/**
 * Phase C of `cache-observability-and-nexus-realtime-detection-plan.md`:
 * shape of a `cache_health` event. The Zod schema lives in
 * `src/shared/events.ts`; this is the in-code mirror so the build
 * helper has a concrete type. `cacheHealth` is a snapshot of the
 * structured CacheHealthSnapshot from §4.1.
 */
export type CacheHealthEvent = {
  type: 'cache_health'
  schemaVersion: '2026-05-21.babel-o.v1'
  sessionId: string
  timestamp: string
  cwd: string
  requestId?: string
  cacheHealth: CacheHealthSnapshot
  trigger: 'after_execution_metrics' | 'manual'
}

/**
 * Build a `cache_health` event from a `CacheHealthSnapshot`.
 *
 * v1 rule (plan §5.3): only emit when `summary.status !== 'ok'`. The
 * schema guarantees `trigger` is one of the documented enums.
 */
export function buildCacheHealthEvent(input: {
  sessionId: string
  cwd: string
  requestId?: string
  cacheHealth: CacheHealthSnapshot
  trigger?: 'after_execution_metrics' | 'manual'
  now?: () => Date
}): CacheHealthEvent | undefined {
  // v1: only emit non-ok health. ok = "all dimensions healthy" — the
  // transcript and wait surfaces don't need an event for it.
  if (input.cacheHealth.summary.status === 'ok') return undefined
  const now = input.now ?? (() => new Date())
  return {
    type: 'cache_health',
    schemaVersion: '2026-05-21.babel-o.v1',
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: now().toISOString(),
    requestId: input.requestId,
    cacheHealth: input.cacheHealth,
    trigger: input.trigger ?? 'after_execution_metrics',
  }
}

/**
 * Per-session dedup registry for `cache_health` events. The plan
 * §5.3 dedup invariant ("不重复发同一 requestId 的相同 warning") is
 * enforced here at the emit site, not the schema.
 *
 * Behavior:
 *   - When `seen(sessionId, requestId)` returns `true`, skip emit.
 *   - Otherwise record and emit.
 *   - `requestId` undefined is treated as a unique key per emit (no
 *     dedup; this is acceptable because the emit site should always
 *     provide a requestId after an `execution_metrics`).
 *   - Set eviction: at most 256 entries per session; older entries
 *     are dropped FIFO. Keeps the registry bounded across long-lived
 *     sessions.
 */
export class CacheHealthEventDedup {
  private seen = new Map<string, Set<string>>()
  private readonly maxEntriesPerSession: number

  constructor(maxEntriesPerSession = 256) {
    this.maxEntriesPerSession = maxEntriesPerSession
  }

  shouldEmit(sessionId: string, requestId: string | undefined): boolean {
    if (requestId === undefined) return true
    const set = this.seen.get(sessionId) ?? new Set<string>()
    if (set.has(requestId)) return false
    set.add(requestId)
    // Evict FIFO when the set grows past the cap. We do not track
    // insertion order, so we evict the first iterated entry — close
    // enough for a dedup set whose only invariant is bounded size.
    while (set.size > this.maxEntriesPerSession) {
      const first = set.values().next().value
      if (first === undefined) break
      set.delete(first)
    }
    this.seen.set(sessionId, set)
    return true
  }

  /** Test-only: clear the dedup set (e.g., between tests). */
  reset(): void {
    this.seen.clear()
  }
}

// ---- module-level dedup singleton (mirrors defaultContextBroadcaster) ----
//
// Per app.ts's module-level singleton pattern (defaultContextBroadcaster),
// a process-level CacheHealthEventDedup is exported so both the HTTP
// `/v1/execute` and WebSocket `/v1/stream` paths share the same dedup
// state. This guarantees "不重复发同一 requestId 的相同 warning"
// across both transports.
//
// Tests that need isolation can pass their own dedup instance via
// `setCacheHealthDedupForTesting()`.
let globalCacheHealthDedup: CacheHealthEventDedup = new CacheHealthEventDedup()

export function getCacheHealthDedup(): CacheHealthEventDedup {
  return globalCacheHealthDedup
}

export function setCacheHealthDedup(dedup: CacheHealthEventDedup): void {
  globalCacheHealthDedup = dedup
}

/** Test-only: reset the module-level dedup singleton. */
export function _resetCacheHealthDedupForTesting(): void {
  globalCacheHealthDedup.reset()
}

/**
 * Phase C emit helper. Given an `execution_metrics` NexusEvent, build
 * the corresponding `cache_health` event (or `undefined` if the snapshot
 * is `ok` or the requestId was already seen).
 *
 * Callers (HTTP `/v1/execute` and WebSocket `/v1/stream`) call this
 * after they have appended the `execution_metrics` event to storage
 * and fed it to the BehaviorMonitor.
 */
export function maybeBuildCacheHealthEventFromExecutionMetrics(
  event: NexusEvent,
  cwd: string,
): CacheHealthEvent | undefined {
  if (event.type !== 'execution_metrics') return undefined
  const execEvent = event as unknown as ExecutionMetricsLike & {
    sessionId: string
    requestId?: string
  }
  const usage: TokenUsageLike = {
    inputTokens: execEvent.inputTokens ?? 0,
    outputTokens: execEvent.outputTokens ?? 0,
    cacheCreationInputTokens: execEvent.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: execEvent.cacheReadInputTokens ?? 0,
  }
  const snapshot = buildCacheHealthFromRuntimeMetrics({ tokenUsage: usage })
  // Apply dedup BEFORE building the event so we don't pay the cost of
  // building an event we won't emit.
  if (!globalCacheHealthDedup.shouldEmit(execEvent.sessionId, execEvent.requestId)) {
    return undefined
  }
  return buildCacheHealthEvent({
    sessionId: execEvent.sessionId,
    cwd,
    requestId: execEvent.requestId,
    cacheHealth: snapshot,
  })
}
