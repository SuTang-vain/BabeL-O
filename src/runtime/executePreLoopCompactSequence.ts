/**
 * Phase 3B-13 slice — `executePreLoopCompactSequence.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains
 * the standalone async generator
 * `executePreLoopCompactSequence()` that runs the runtime's
 * three pre-loop steps:
 *
 *   1. **Auto compact** (when `autoCompactDecision.shouldCompact`):
 *      run `compactSession({ trigger: 'auto' })`, yield the
 *      compact + context events, build post-compact
 *      grounding events, refresh the context, absorb the
 *      new `cacheAwareCompactPolicy` into the runtime
 *      metrics, yield `context_usage` (source:
 *      'after_compact') and the optional
 *      `context_microcompact` event.
 *   2. **Reactive compact** (when
 *      `contextWindowState.isBlocking` AND the auto
 *      compact did NOT run): same shape as auto compact
 *      with `trigger: 'reactive'`.
 *   3. **Blocking emit** (when
 *      `contextWindowState.isBlocking`): yield the
 *      `context_blocking` events and the
 *      `runtime_execution_metrics` event. The main loop
 *      must `return` after this so the per-turn request
 *      terminates without entering the provider loop.
 *
 * The helper returns a `{ compactAttempted, blocking }`
 * result alongside the event stream so the main loop
 * can update its `compactAttempted` flag and decide
 * whether to short-circuit.
 *
 * Why extracted:
 *
 * - The three pre-loop blocks were 120+ lines of inline
 *   code that ran in two patterns: "compact + refresh"
 *   (auto and reactive) and "blocking emit + return"
 *   (the bail-out path). The auto and reactive patterns
 *   are byte-identical except for `trigger` and the
 *   guard condition; pulling them out behind a helper
 *   makes the symmetry obvious and lets the main loop
 *   read as one ordered step.
 * - The compact + refresh + yield pattern is the
 *   runtime's first async-generator helper. It is also
 *   the most repeated pattern in the main loop (the
 *   reactive compact in the provider-recovery block at
 *   line 800-900 has the same shape). Future slices can
 *   reuse this helper.
 * - Errors are absorbed as `compact_failure` events
 *   rather than thrown, so the main loop never has to
 *   handle a `compactSession` throw — the hot path is
 *   un-interrupted even when storage is degraded.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: the auto block and
 *   the reactive block are byte-identical to the prior
 *   inline versions except for the moved-out function
 *   call. The blocking emit block is byte-identical.
 * - Eliminate ~120 lines of inline code from
 *   `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not change the `trigger` semantics: 'auto' for
 *   the first block, 'reactive' for the second.
 * - Do not throw on `compactSession` failure — the
 *   helper yields a `compact_failure` event and
 *   continues.
 * - Do not change the order in which the main loop
 *   updates `previousEvents` after a compact: the
 *   helper calls a `setPreviousEvents` callback to
 *   write the new list back to the main loop's scope.
 * - Do not introduce a new "CompactOrchestrator"
 *   class. The helper is a plain async generator
 *   function.
 */

import {
  buildContextBlockingEvents,
  buildContextMicrocompactEvent,
  buildContextUsageEvent,
  buildPostCompactGroundingEvents,
  absorbCompactSummaryLatencyMetrics,
  absorbCacheAwareCompactPolicyMetrics,
} from './runtimePipeline.js'
import { buildCompactFailureEvent, compactSession } from './compact.js'
import { ContextRefreshStrategy, type ContextRefreshStrategyOptions } from './ContextRefreshStrategy.js'
import type { RuntimeExecutionMetrics } from './pipeline/cache.js'
import type { NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { ReadFileCacheEntry } from './runtimeToolLoop.js'
import type { ModelMessage } from '../providers/adapters/ModelAdapter.js'

export type ExecutePreLoopCompactSequenceInput = {
  storage: NexusStorage
  sessionId: string
  requestId: string | undefined
  modelId: string
  providerId: string
  cleanedModelId: string
  /** Whether `autoCompactDecision.shouldCompact` is true. The
   *  helper reads this once at the top; the rest of the
   *  helper uses the fresh `autoCompactDecision` returned
   *  by the post-refresh call. */
  autoCompactShouldCompact: boolean
  /** Whether `contextWindowState.isBlocking` is true. */
  isContextWindowBlocking: boolean
  /** Refresh strategy — the helper calls `.refresh(...)` on
   *  this. The helper does NOT own the closure bundle. */
  refreshStrategy: ContextRefreshStrategy
  /** Refresh options to pass to `.refresh(...)` for the
   *  post-compact refresh. The sessionInbox is forced
   *  to 'load' inside the helper so the reactive
   *  path always gets a fresh inbox. */
  refreshOptions: Omit<ContextRefreshStrategyOptions, 'sessionInbox'>
  /** Mutable state bundle the helper reads / writes
   *  through. The main loop owns the underlying `let`
   *  state; the helper uses the bundle's getters
   *  (read) and setters (write) to stay decoupled. */
  state: {
    getContextWindowState: () => any
    getPreviousEvents: () => NexusEvent[]
    setPreviousEvents: (next: NexusEvent[]) => void
    getAutoCompactDecision: () => any
    setAutoCompactDecision: (next: any) => void
    getCacheAwareCompactPolicy: () => any
    setCacheAwareCompactPolicy: (next: any) => void
  }
  closures: {
    applyContextRefreshState: (next: any) => void
    postCompactGroundingEvents: (source: 'post_compact' | 'context_recovery', boundaryId?: string) => NexusEvent[]
    contextMicrocompactEvent: (
      trigger: 'initial_refresh' | 'pre_provider_call' | 'after_compact' | 'after_message_budget',
    ) => NexusEvent | undefined
  }
  metrics: RuntimeExecutionMetrics
  /** Map from providerId+modelId to refresh options, plus
   *  providerId used by buildContextUsageEvent. The helper
   *  uses `providerId` only. */
  readFileCache: Map<string, ReadFileCacheEntry>
  /** Tool list builder — passed through to
   *  `compactSession.mapEventsToMessages` and to the
   *  refresh options. */
  toolsList: () => unknown[]
  /** Per-turn map events builder. */
  mapEventsForProvider: (events: NexusEvent[], initialPrompt: string) => ModelMessage[]
  /** Whether the runtime should suppress tools for the
   *  current user intent. */
  shouldSuppressToolsForIntent: (guidance: any) => boolean
  /** The runtime's emitMemoryRetrieval hook. */
  onMemoryRetrieval: (input: any) => Promise<void> | void
  /** The user intent guidance source for the runtime. */
  userIntentGuidance: unknown
  /** The runtime's readFileCache. */
  /** The runtime's persistence sink for assembleContext
   *  the working-set override. */
  workingSetOverride: string | undefined
  /** Helper for emitting the `runtime_execution_metrics`
   *  event after the blocking yield sequence. */
  buildRuntimeExecutionMetricsEvent: () => NexusEvent
  /** Whether the helper should attempt the reactive
   *  compact block. The main loop passes
   *  `!compactAttempted` from the auto-block result. */
  compactAttempted: boolean
}

export type ExecutePreLoopCompactSequenceResult = {
  /** Whether either of the two compact blocks ran.
   *  `true` if auto or reactive compact ran; `false`
   *  if neither ran (i.e. `shouldCompact=false` and
   *  `isBlocking=false`). */
  compactAttempted: boolean
  /** Whether the blocking emit block ran. The main
   *  loop must `return` after this. */
  blocking: boolean
}

export async function* executePreLoopCompactSequence(
  input: ExecutePreLoopCompactSequenceInput,
): AsyncGenerator<NexusEvent, ExecutePreLoopCompactSequenceResult> {
  let compactAttempted = input.compactAttempted

  // Block 1: auto compact.
  if (input.autoCompactShouldCompact) {
    compactAttempted = true
    try {
      const compactResult = await compactSession({
        storage: input.storage,
        sessionId: input.sessionId,
        modelId: input.cleanedModelId,
        trigger: 'auto',
        mapEventsToMessages: input.mapEventsForProvider,
        initialPrompt: '', // unused; the helper doesn't need the prompt here
      })
      absorbCompactSummaryLatencyMetrics(input.metrics, compactResult.summaryLatencyMs)
      yield compactResult.event
      yield compactResult.contextEvent
      const groundingEvents = input.closures.postCompactGroundingEvents('post_compact', compactResult.contextEvent.boundaryId)
      for (const groundingEvent of groundingEvents) yield groundingEvent
      input.state.setPreviousEvents([
        ...input.state.getPreviousEvents(),
        compactResult.event,
        compactResult.contextEvent,
        ...groundingEvents,
      ])
      const next = await input.refreshStrategy.refresh({
        ...input.refreshOptions,
        events: input.state.getPreviousEvents(),
        sessionInbox: 'load',
      })
      input.closures.applyContextRefreshState(next)
      input.state.setCacheAwareCompactPolicy(next.cacheAwareCompactPolicy)
      input.state.setAutoCompactDecision(next.autoCompactDecision as any)
      yield buildContextUsageEvent({
        sessionId: input.sessionId,
        requestId: input.requestId,
        modelId: input.cleanedModelId,
        providerId: input.providerId,
        windowState: input.state.getContextWindowState() as any,
        cacheAwareCompactPolicy: next.cacheAwareCompactPolicy,
        source: 'after_compact',
      })
      const afterCompactMicrocompactEvent = input.closures.contextMicrocompactEvent('after_compact')
      if (afterCompactMicrocompactEvent) yield afterCompactMicrocompactEvent
    } catch (error) {
      const decision = input.state.getAutoCompactDecision()
      yield buildCompactFailureEvent({
        sessionId: input.sessionId,
        trigger: 'auto',
        modelId: input.cleanedModelId,
        failureCount: decision.failureCount + 1,
        maxFailures: decision.failureLimit,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Block 2: reactive compact (only if auto did not run and
  // the context is still blocking).
  if (input.isContextWindowBlocking && !compactAttempted) {
    compactAttempted = true
    try {
      const compactResult = await compactSession({
        storage: input.storage,
        sessionId: input.sessionId,
        modelId: input.cleanedModelId,
        trigger: 'reactive',
        mapEventsToMessages: input.mapEventsForProvider,
        initialPrompt: '',
      })
      absorbCompactSummaryLatencyMetrics(input.metrics, compactResult.summaryLatencyMs)
      yield compactResult.event
      yield compactResult.contextEvent
      const groundingEvents = input.closures.postCompactGroundingEvents('post_compact', compactResult.contextEvent.boundaryId)
      for (const groundingEvent of groundingEvents) yield groundingEvent
      input.state.setPreviousEvents([
        ...input.state.getPreviousEvents(),
        compactResult.event,
        compactResult.contextEvent,
        ...groundingEvents,
      ])
      const next = await input.refreshStrategy.refresh({
        ...input.refreshOptions,
        events: input.state.getPreviousEvents(),
        sessionInbox: 'load',
      })
      input.closures.applyContextRefreshState(next)
      input.state.setCacheAwareCompactPolicy(next.cacheAwareCompactPolicy)
      yield buildContextUsageEvent({
        sessionId: input.sessionId,
        requestId: input.requestId,
        modelId: input.cleanedModelId,
        providerId: input.providerId,
        windowState: input.state.getContextWindowState() as any,
        cacheAwareCompactPolicy: next.cacheAwareCompactPolicy,
        source: 'after_compact',
      })
      const afterCompactMicrocompactEvent = input.closures.contextMicrocompactEvent('after_compact')
      if (afterCompactMicrocompactEvent) yield afterCompactMicrocompactEvent
    } catch (error) {
      const decision = input.state.getAutoCompactDecision()
      yield buildCompactFailureEvent({
        sessionId: input.sessionId,
        trigger: 'reactive',
        modelId: input.cleanedModelId,
        failureCount: decision.failureCount + 1,
        maxFailures: decision.failureLimit,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Block 3: blocking emit (only if the context is still
  // blocking). The main loop must `return` after this.
  if (input.isContextWindowBlocking) {
    const decision = input.state.getAutoCompactDecision()
    const compactPercent = decision.enabled
      ? decision.thresholdPercent
      : input.refreshOptions.compactPercent
    for (const event of buildContextBlockingEvents({
      sessionId: input.sessionId,
      modelId: input.cleanedModelId,
      windowState: input.state.getContextWindowState() as any,
      thresholdPercent: compactPercent,
      cacheAwareCompactPolicy: input.state.getCacheAwareCompactPolicy() as any,
    })) yield event
    yield input.buildRuntimeExecutionMetricsEvent()
    return { compactAttempted, blocking: true }
  }

  return { compactAttempted, blocking: false }
}
