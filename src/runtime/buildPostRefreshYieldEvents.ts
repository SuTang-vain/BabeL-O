/**
 * Phase 3B-11 slice — `buildPostRefreshYieldEvents.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains
 * the standalone function `buildPostRefreshYieldEvents()`
 * that produces the ordered list of `NexusEvent`s the
 * main loop must yield after a `ContextRefreshStrategy.refresh`
 * call returns. The list is composed of:
 *
 *   1. An optional `context_microcompact` event (skipped
 *      when the holder's `assembledContext.microcompactMetrics`
 *      says no microcompact happened on this turn).
 *   2. An optional `context_warning` event (only yielded
 *      when `contextWindowState.isWarning` is true or the
 *      `autoCompactDecision.fuseOpen` is true — the runtime
 *      surfaces the pause / threshold / fuse message).
 *
 * Why extracted:
 *
 * - The two yield sites (initial `microcompact` + warning)
 *   are the only consumers of `assembledContext.microcompactMetrics`
 *   + `contextWindowState` + `autoCompactDecision.fuseOpen`
 *   for the very first refresh on a turn. As inline
 *   `if (...) yield` blocks they make the main loop's
 *   "post-refresh yield sequence" hard to reason about;
 *   as a single `for (const e of ...) yield e` they read
 *   as one ordered step.
 * - The factory is a pure function: same input → same
 *   `NexusEvent[]` (no side effects, no I/O, no metrics
 *   mutation). It is the only post-refresh yield list
 *   with that property — every other yield in the main
 *   loop is either side-effecting (e.g. `enforceMessageBudget`
 *   mutates `messages`) or event-stream-driven (the
 *   provider turn stream). Pulling this single pure
 *   function out makes the main loop's yield sequence
 *   trivially testable.
 * - Future work that needs to "list the post-refresh
 *   yields for one refresh state" (e.g. an offline
 *   analysis tool) can call this factory directly.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: the same `NexusEvent`
 *   types, the same `if`-gated skips, the same
 *   `compactPercent` derivation between the auto-compact
 *   threshold and the manual `contextCompactPercent`
 *   fallback, the same fuse-open / isCompact / isWarning
 *   message text.
 * - Eliminate ~20 lines of inline yield block from
 *   `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not change the event shapes of
 *   `context_microcompact` or `context_warning`. Both
 *   are owned by `runtimePipeline.ts` and consumed by
 *   the §3.5 dashboard.
 * - Do not yield from the factory. The factory returns
 *   an array; the caller yields. This is a deliberate
 *   split: the factory has no `AsyncIterable` shape, so
 *   it can be unit-tested with plain array equality.
 * - Do not introduce a `NexusEventSink` abstraction. The
 *   factory's return value is a `NexusEvent[]` and that
 *   is the entire surface.
 */

import { buildContextMicrocompactEvent, buildContextWarningEvent } from './runtimePipeline.js'
import type { NexusEvent } from '../shared/events.js'
import type { AssembledContext } from './contextAssembler.js'
import type { ContextWindowState } from './tokenEstimator.js'
import type { AutoCompactDecision } from './compact.js'
import type { CacheAwareCompactPolicy } from './cacheAwareCompactPolicy.js'

export type BuildPostRefreshYieldEventsInput = {
  /** Snapshot the factory reads. The factory does not
   *  mutate this; the holder remains the source of truth. */
  assembledContext: AssembledContext
  contextWindowState: ContextWindowState
  autoCompactDecision: AutoCompactDecision
  cacheAwareCompactPolicy: CacheAwareCompactPolicy
  sessionId: string
  requestId: string | undefined
  modelId: string
  contextWarningPercent: number
  contextCompactPercent: number
}

/**
 * Build the ordered list of post-refresh NexusEvents
 * the main loop must yield. Returns an array of 0-2
 * events:
 *
 *   [0] `context_microcompact` — present iff the
 *       `assembledContext.microcompactMetrics` says one
 *       happened.
 *   [1] `context_warning` — present iff
 *       `contextWindowState.isWarning` is true or the
 *       `autoCompactDecision.fuseOpen` is true.
 *
 * The factory never throws and never returns `null`; an
 * empty list means "no events to yield".
 */
export function buildPostRefreshYieldEvents(
  input: BuildPostRefreshYieldEventsInput,
): NexusEvent[] {
  const events: NexusEvent[] = []

  const microcompactEvent = buildContextMicrocompactEvent({
    sessionId: input.sessionId,
    requestId: input.requestId,
    trigger: 'initial_refresh',
    metrics: input.assembledContext.microcompactMetrics,
  })
  if (microcompactEvent) events.push(microcompactEvent)

  if (input.contextWindowState.isWarning || input.autoCompactDecision.fuseOpen) {
    const compactPercent = input.autoCompactDecision.enabled
      ? input.autoCompactDecision.thresholdPercent
      : input.contextCompactPercent
    events.push(
      buildContextWarningEvent({
        sessionId: input.sessionId,
        modelId: input.modelId,
        windowState: input.contextWindowState,
        thresholdPercent: compactPercent,
        message: input.autoCompactDecision.fuseOpen
          ? `Auto compact is paused after ${input.autoCompactDecision.failureCount} consecutive failures. Run /compact manually or inspect compact_failure events.`
          : input.contextWindowState.isCompact
            ? `Context has passed the compact threshold (${compactPercent}%). Auto-compact will trigger on this turn.`
            : `Context is approaching the compact threshold (${input.contextWarningPercent}%→${compactPercent}%). Consider /compact soon.`,
        cacheAwareCompactPolicy: input.cacheAwareCompactPolicy,
      }),
    )
  }

  return events
}
