/**
 * Phase 3B-14 slice — `executeProviderLoopCompactBlock.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains
 * the standalone async generator
 * `executeProviderLoopCompactBlock()` that runs the
 * provider-loop reactive compact + refresh step. The
 * helper is the provider-loop analog of
 * `executePreLoopCompactSequence()` (Phase 3B-13):
 *
 *   - **Skip** when the runtime context is NOT
 *     blocking OR the runtime has already attempted a
 *     reactive compact in the provider loop.
 *   - **Run** the compact with `trigger: 'reactive'`,
 *     yield the compact + context events, build the
 *     post-compact grounding events, refresh the
 *     context, and absorb the new
 *     `cacheAwareCompactPolicy` into the runtime
 *     metrics.
 *   - **Return** `{ compactAttempted: true }` so the
 *     main loop can update its
 *     `providerLoopCompactAttempted` flag and decide
 *     whether to short-circuit the rest of the loop.
 *
 * Why extracted:
 *
 * - The provider-loop reactive block is byte-identical
 *   to the pre-loop reactive block (3B-13) except for
 *   the runtime's `previousEvents` + `autoCompactDecision`
 *   + `cacheAwareCompactPolicy` are slightly different
 *   locals. Pulling it out behind a helper makes the
 *   provider loop body smaller and lets a future slice
 *   (3B-15) refactor the main loop's while-loop
 *   termination logic without re-touching the compact
 *   sequence.
 * - The pattern is the same fire-and-forget + yield
 *   shape as 3B-13: errors are absorbed as
 *   `compact_failure` events rather than thrown, so
 *   the hot path is un-interrupted even when storage
 *   is degraded.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: the provider-loop
 *   reactive block is byte-identical to the prior
 *   inline version except for the moved-out function
 *   call. The compact session is constructed with the
 *   same options, and the post-compact refresh uses
 *   `sessionInbox: 'load'`.
 * - Eliminate ~33 lines of inline code from
 *   `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not change the `trigger` semantics: 'reactive'
 *   for the provider-loop block.
 * - Do not throw on `compactSession` failure — the
 *   helper yields a `compact_failure` event and
 *   returns `{ compactAttempted: true }` so the main
 *   loop's `providerLoopCompactAttempted` flag is
 *   correctly updated.
 * - Do not touch the post-compact `enforceMessageBudget`
 *   + `requestState` rebuild — those are downstream
 *   steps the main loop still owns; they are addressed
 *   in 3B-15.
 */

import {
  buildContextMicrocompactEvent,
  buildContextUsageEvent,
  buildPostCompactGroundingEvents,
  absorbCompactSummaryLatencyMetrics,
} from './runtimePipeline.js'
import { buildCompactFailureEvent, compactSession } from './compact.js'
import { ContextRefreshStrategy, type ContextRefreshStrategyOptions } from './ContextRefreshStrategy.js'
import type { NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { ModelMessage } from '../providers/adapters/ModelAdapter.js'

export type ExecuteProviderLoopCompactBlockInput = {
  storage: NexusStorage
  sessionId: string
  requestId: string | undefined
  modelId: string
  providerId: string
  cleanedModelId: string
  /** Whether the runtime context is blocking. The
   *  helper skips if this is false. */
  isContextWindowBlocking: boolean
  /** Whether the provider loop has already attempted a
   *  reactive compact on a prior iteration. The
   *  helper skips if this is true. */
  alreadyAttempted: boolean
  refreshStrategy: ContextRefreshStrategy
  refreshOptions: Omit<ContextRefreshStrategyOptions, 'sessionInbox'>
  state: {
    getPreviousEvents: () => NexusEvent[]
    setPreviousEvents: (next: NexusEvent[]) => void
    getAutoCompactDecision: () => any
    setAutoCompactDecision: (next: any) => void
    getCacheAwareCompactPolicy: () => any
    setCacheAwareCompactPolicy: (next: any) => void
    getContextWindowState: () => any
  }
  closures: {
    applyContextRefreshState: (next: any) => void
    postCompactGroundingEvents: (source: 'post_compact' | 'context_recovery', boundaryId?: string) => NexusEvent[]
    contextMicrocompactEvent: (
      trigger: 'initial_refresh' | 'pre_provider_call' | 'after_compact' | 'after_message_budget',
    ) => NexusEvent | undefined
  }
  metrics: any
  toolsList: () => unknown[]
  mapEventsForProvider: (events: NexusEvent[], initialPrompt: string) => ModelMessage[]
  shouldSuppressToolsForIntent: (guidance: any) => boolean
  onMemoryRetrieval: (input: any) => Promise<void> | void
  workingSetOverride: string | undefined
  initialPrompt: string
}

export type ExecuteProviderLoopCompactBlockResult = {
  events: NexusEvent[]
  /** Whether the compact was attempted (or skipped
   *  because the helper short-circuited). The main
   *  loop uses this to update its
   *  `providerLoopCompactAttempted` flag. */
  compactAttempted: boolean
}

export async function executeProviderLoopCompactBlock(
  input: ExecuteProviderLoopCompactBlockInput,
): Promise<ExecuteProviderLoopCompactBlockResult> {
  if (!input.isContextWindowBlocking || input.alreadyAttempted) {
    return { events: [], compactAttempted: input.alreadyAttempted }
  }
  const events: NexusEvent[] = []
  try {
    const compactResult = await compactSession({
      storage: input.storage,
      sessionId: input.sessionId,
      modelId: input.cleanedModelId,
      trigger: 'reactive',
      mapEventsToMessages: input.mapEventsForProvider,
      initialPrompt: input.initialPrompt,
    })
    absorbCompactSummaryLatencyMetrics(input.metrics, compactResult.summaryLatencyMs)
    events.push(compactResult.event)
    events.push(compactResult.contextEvent)
    const groundingEvents = input.closures.postCompactGroundingEvents('post_compact', compactResult.contextEvent.boundaryId)
    for (const groundingEvent of groundingEvents) events.push(groundingEvent)
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
    input.state.setAutoCompactDecision(next.autoCompactDecision)
    events.push(buildContextUsageEvent({
      sessionId: input.sessionId,
      requestId: input.requestId,
      modelId: input.cleanedModelId,
      providerId: input.providerId,
      windowState: input.state.getContextWindowState(),
      cacheAwareCompactPolicy: next.cacheAwareCompactPolicy,
      source: 'after_compact',
    }))
    const afterCompactMicrocompactEvent = input.closures.contextMicrocompactEvent('after_compact')
    if (afterCompactMicrocompactEvent) events.push(afterCompactMicrocompactEvent)
    return { events, compactAttempted: true }
  } catch (error) {
    const decision = input.state.getAutoCompactDecision()
    events.push(buildCompactFailureEvent({
      sessionId: input.sessionId,
      trigger: 'reactive',
      modelId: input.cleanedModelId,
      failureCount: decision.failureCount + 1,
      maxFailures: decision.failureLimit,
      message: error instanceof Error ? error.message : String(error),
    }))
    return { events, compactAttempted: true }
  }
}
