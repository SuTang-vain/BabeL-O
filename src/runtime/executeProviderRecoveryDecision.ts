/**
 * Phase 3B-19 slice — `executeProviderRecoveryDecision.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains
 * the standalone async function
 * `executeProviderRecoveryDecision()` that runs the
 * provider-loop catch block: it fires the
 * PostInvocation hooks, classifies the error, and either
 * (a) drives the context_window recovery compact +
 * refresh + budget sequence, (b) yields the blocking
 * events on cap-reached, or (c) reports a rethrow.
 *
 * The helper is the catch-block analog of the pre-loop
 * compact helpers (3B-13 / 3B-14) and the provider-loop
 * compact helper (3B-14). It owns one bounded step in
 * the recovery decision tree.
 *
 * What the helper owns:
 *
 *   1. Classify the error with
 *      `classifyProviderRecovery(error)`.
 *   2. Fire the `PostInvocation` runtime hooks (always,
 *      regardless of classification).
 *   3. If the error is a `context_window` candidate and
 *      the recovery cap is not yet reached:
 *      - Increment `providerContextRecoveryCount`.
 *      - Set `providerLoopCompactAttempted = true`.
 *      - Yield a `context_recovery_attempted` event.
 *      - Run the recovery `compactSession` + refresh +
 *        `enforceMessageBudget` + after-compact
 *        `context_usage` + `context_microcompact`
 *        events.
 *      - Return `{ kind: 'recovered' }` so the main
 *        loop can `continue`.
 *   4. If the cap is reached (or the recovery compact
 *      throws): yield the `context_blocking` events +
 *      `runtime_execution_metrics` and return
 *      `{ kind: 'blocked' }` so the main loop can
 *      `return`.
 *   5. If the error is not a `context_window`
 *      candidate: return `{ kind: 'rethrow', error }`
 *      so the main loop can `throw result.error`.
 *
 * Why extracted:
 *
 * - The catch block was a 100-line inline sequence
 *   that interleaved hook firing, recovery decision,
 *   compact + refresh + budget, blocking emit, and a
 *   rethrow. Pulling it out behind a single helper
 *   call makes the main loop's per-iteration shape
 *   visible at a glance — the catch block is one
 *   callable.
 * - The recovery decision is testable in isolation:
 *   a unit test can pass a fake error + state and
 *   assert that the helper fires the right hooks,
 *   increments the right counter, and reports the
 *   right outcome (`recovered` / `blocked` / rethrow).
 * - Future slices that introduce a post-recovery
 *   hook (e.g. recovery metrics) can extend this
 *   helper without touching the main loop.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: same hook firing,
 *   same counter updates, same event yields, same
 *   blocking emit, same rethrow semantics.
 * - Eliminate ~80 lines of inline code from
 *   `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not change the recovery cap policy.
 * - Do not change the order of `events` in any
 *   yield loop.
 * - Do not change the `await refreshAfterProviderContextRecovery()`
 *   call site — the helper uses the closure bundle
 *   the main loop already provides (3B-12).
 */

import {
  buildCompactFailureEvent,
  compactSession,
} from './compact.js'
import {
  absorbCompactSummaryLatencyMetrics,
  buildContextRecoveryAttemptedEvent,
  buildContextUsageEvent,
  buildContextMicrocompactEvent,
  buildRuntimeContextBlockingEventsForLoop,
  buildRuntimeExecutionMetricsEvent,
} from './runtimePipeline.js'
import { classifyProviderRecovery } from './providerRecovery.js'
import { enforceMessageBudget } from './toolResultBudget.js'
import type { RuntimeExecutionMetrics } from './pipeline/cache.js'
import type { NexusEvent } from '../shared/events.js'
import type { ModelMessage } from '../providers/adapters/ModelAdapter.js'

export type ExecuteProviderRecoveryDecisionInput = {
  /** The error thrown by the provider turn. */
  error: unknown
  /** The runtime hooks configuration passed to
   *  `executeRuntimeHooks`. */
  hooksConfig: { config: any; hooks: any }
  /** Invocation metadata captured at the start of the
   *  provider turn. The helper adds
   *  `durationMs` / `success: false` /
   *  `errorCode` / `failureKind` before firing the
   *  PostInvocation hooks. */
  invocationMetadata: any
  /** Session / cwd / role / signal passed to
   *  `executeRuntimeHooks`. */
  hookInput: { sessionId: string; cwd: string; role: string | undefined; signal: AbortSignal | undefined }
  /** The runtime options passed to the error-code
   *  helpers + `buildRuntimeExecutionMetricsEvent`. */
  options: any
  /** Error-code helpers (defined in LLMCodingRuntime.ts
   *  as private module-level functions). The main
   *  loop passes them in so the helper does not
   *  depend on LLMCodingRuntime internals. */
  errorCodeHelpers: {
    providerInvocationErrorCode: (error: unknown, options: any) => string
    providerContextRecoveryErrorCode: (error: unknown, options: any) => string
  }
  /** Provider / model identifiers for the metrics
   *  envelope + the recovery event. */
  providerId: string
  modelId: string
  cleanedModelId: string
  requestId: string | undefined
  sessionId: string
  /** Per-loop state. The main loop owns the underlying
   *  `let` declarations; the helper reads / writes
   *  through this bundle. */
  state: {
    getPreviousEvents: () => NexusEvent[]
    setPreviousEvents: (next: NexusEvent[]) => void
    getAutoCompactDecision: () => any
    setAutoCompactDecision: (next: any) => void
    getContextWindowState: () => any
    getRequestState: () => any
    getCacheAwareCompactPolicy: () => any
    getMessages: () => ModelMessage[]
    setMessages: (next: ModelMessage[]) => void
  }
  closures: {
    applyContextRefreshState: (next: any) => void
    postCompactGroundingEvents: (
      source: 'post_compact' | 'context_recovery',
      boundaryId?: string,
    ) => NexusEvent[]
    contextMicrocompactEvent: (
      trigger: 'initial_refresh' | 'pre_provider_call' | 'after_compact' | 'after_message_budget',
    ) => NexusEvent | undefined
    refreshAfterProviderContextRecovery: () => Promise<void>
  }
  /** Counters. The helper reads + writes
   *  `providerContextRecoveryCount`. */
  counters: {
    providerContextRecoveryCount: number
    maxProviderContextRecoveries: number
  }
  /** Toggle the main loop flips when the recovery
   *  block runs. */
  flags: {
    setProviderLoopCompactAttempted: (next: boolean) => void
  }
  metrics: RuntimeExecutionMetrics
  /** Replacement state for `enforceMessageBudget`. */
  replacementState: any
  /** The original prompt (used for compactSession.initialPrompt). */
  initialPrompt: string
  /** Storage handle for compactSession. The helper
   *  passes it through. */
  storage: any
  /** Per-iteration map events builder for
   *  compactSession. */
  mapEventsForProvider: (events: NexusEvent[], initialPrompt: string) => ModelMessage[]
  /** Hook runner — kept as a function reference so the
   *  helper does not own the `executeRuntimeHooks`
   *  import directly. */
  runHooks: (
    phase: 'PreInvocation' | 'PostInvocation',
    invocation: any,
    ctx: { sessionId: string; cwd: string; role: string | undefined; signal: AbortSignal | undefined },
    config: { config: any; hooks: any },
  ) => Promise<{ events: NexusEvent[] }>
  /** `contextCompactPercent` for the blocking
   *  threshold message. */
  contextCompactPercent: number
}

export type ExecuteProviderRecoveryDecisionResult = {
  /**
   * - 'recovered' = the recovery compact ran; the main
   *   loop should `continue` to the next iteration.
   * - 'blocked' = the recovery cap is reached; the main
   *   loop should yield the blocking events (already
   *   in the result.events array) and `return`.
   * - 'rethrow' = the error is not a `context_window`
   *   candidate; the main loop should re-throw.
   */
  kind: 'recovered' | 'blocked' | 'rethrow'
  /** Every event the recovery block produced, in
   *  order. The main loop yields these (or, on the
   *  `blocked` path, just `return`s). */
  events: NexusEvent[]
  /** The updated `providerContextRecoveryCount`
   *  (incremented on the recovered path, unchanged
   *  on the blocked / rethrow paths). The main loop
   *  writes this back to its `let`. */
  providerContextRecoveryCount: number
  /** The updated `previousEvents` accumulator. */
  previousEvents: NexusEvent[]
  /** The updated `autoCompactDecision` (refreshed
   *  on the recovered path). */
  autoCompactDecision: any
  /** The updated `messages` accumulator. */
  messages: ModelMessage[]
  /** The updated `cacheAwareCompactPolicy` (refreshed
   *  on the recovered path). The main loop writes
   *  this back to its `let`. */
  cacheAwareCompactPolicy: any
  /** When 'rethrow', the error to re-throw. */
  error?: unknown
}

export async function executeProviderRecoveryDecision(
  input: ExecuteProviderRecoveryDecisionInput,
): Promise<ExecuteProviderRecoveryDecisionResult> {
  const events: NexusEvent[] = []
  const { error } = input
  const providerRecovery = classifyProviderRecovery(error)
  // Step 1: always fire PostInvocation hooks.
  const postInvocationHooks = await input.runHooks(
    'PostInvocation',
    {
      invocation: {
        ...input.invocationMetadata,
        success: false,
        errorCode: input.errorCodeHelpers.providerInvocationErrorCode(error, input.options),
        failureKind: providerRecovery?.kind,
      },
    },
    input.hookInput,
    input.hooksConfig,
  )
  for (const hookEvent of postInvocationHooks.events) events.push(hookEvent)

  // Step 2: branch on provider recovery.
  if (providerRecovery?.kind !== 'context_window') {
    return {
      kind: 'rethrow',
      events,
      providerContextRecoveryCount: input.counters.providerContextRecoveryCount,
      previousEvents: input.state.getPreviousEvents(),
      autoCompactDecision: input.state.getAutoCompactDecision(),
      messages: input.state.getMessages(),
      cacheAwareCompactPolicy: input.state.getCacheAwareCompactPolicy(),
      error,
    }
  }

  // Step 3: context_window recovery.
  let providerContextRecoveryCount = input.counters.providerContextRecoveryCount
  let previousEvents = input.state.getPreviousEvents()
  let messages = input.state.getMessages()
  let autoCompactDecision = input.state.getAutoCompactDecision()
  let cacheAwareCompactPolicy = input.state.getCacheAwareCompactPolicy()
  const providerErrorCode = input.errorCodeHelpers.providerContextRecoveryErrorCode(error, input.options)
  if (providerContextRecoveryCount < input.counters.maxProviderContextRecoveries) {
    providerContextRecoveryCount += 1
    input.flags.setProviderLoopCompactAttempted(true)
    const attempt = providerContextRecoveryCount
    const preTokens = input.state.getRequestState().contextWindowState.tokenEstimate
    const recoveryEvent = buildContextRecoveryAttemptedEvent({
      sessionId: input.sessionId,
      requestId: input.requestId,
      providerId: input.providerId,
      modelId: input.cleanedModelId,
      providerErrorCode,
      strategy: 'semantic_compact_retry',
      attempt,
      maxAttempts: input.counters.maxProviderContextRecoveries,
      preTokens,
      retryable: true,
      message: `Provider rejected the prompt as too large; compacting session context and retrying (${attempt}/${input.counters.maxProviderContextRecoveries}).`,
    })
    events.push(recoveryEvent)
    previousEvents = [...previousEvents, recoveryEvent]
    try {
      const compactResult = await compactSession({
        storage: input.storage,
        sessionId: input.sessionId,
        modelId: input.cleanedModelId,
        trigger: 'reactive',
        mapEventsToMessages: input.mapEventsForProvider as any,
        initialPrompt: input.initialPrompt,
      })
      absorbCompactSummaryLatencyMetrics(input.metrics, compactResult.summaryLatencyMs)
      events.push(compactResult.event)
      events.push(compactResult.contextEvent)
      const groundingEvents = input.closures.postCompactGroundingEvents('context_recovery', compactResult.contextEvent.boundaryId)
      for (const groundingEvent of groundingEvents) events.push(groundingEvent)
      previousEvents = [
        ...previousEvents,
        compactResult.event,
        compactResult.contextEvent,
        ...groundingEvents,
      ]
      await input.closures.refreshAfterProviderContextRecovery()
      // The refresh closure updated the holder state
      // (setContextRefreshState). Read back the updated
      // values for the result.
      autoCompactDecision = (input.state as any).getAutoCompactDecision?.()
        ?? input.state.getAutoCompactDecision()
      cacheAwareCompactPolicy = (input.state as any).getCacheAwareCompactPolicy?.()
        ?? input.state.getCacheAwareCompactPolicy()
      messages = await enforceMessageBudget(messages, input.replacementState, input.sessionId, input.hookInput.cwd, {
        contextMaxTokens: cacheAwareCompactPolicy.effectiveContextCeiling ?? (input.state.getRequestState() as any).budget?.maxTokens,
      })
      events.push(buildContextUsageEvent({
        sessionId: input.sessionId,
        requestId: input.requestId,
        modelId: input.cleanedModelId,
        providerId: input.providerId,
        windowState: input.state.getContextWindowState(),
        cacheAwareCompactPolicy,
        source: 'after_compact',
      }))
      const afterCompactMicrocompactEvent = input.closures.contextMicrocompactEvent('after_compact')
      if (afterCompactMicrocompactEvent) events.push(afterCompactMicrocompactEvent)
      return {
        kind: 'recovered',
        events,
        providerContextRecoveryCount,
        previousEvents,
        autoCompactDecision,
        messages,
        cacheAwareCompactPolicy,
      }
    } catch (compactError) {
      events.push(buildCompactFailureEvent({
        sessionId: input.sessionId,
        trigger: 'reactive',
        modelId: input.cleanedModelId,
        failureCount: attempt,
        maxFailures: input.counters.maxProviderContextRecoveries,
        message: compactError instanceof Error ? compactError.message : String(compactError),
      }))
      return {
        kind: 'recovered',
        events,
        providerContextRecoveryCount,
        previousEvents,
        autoCompactDecision,
        messages,
        cacheAwareCompactPolicy,
      }
    }
  }

  // Cap reached or recovery failed: yield blocking events.
  for (const event of buildRuntimeContextBlockingEventsForLoop({
    sessionId: input.sessionId,
    modelId: input.cleanedModelId,
    windowState: input.state.getRequestState().contextWindowState,
    autoCompactDecision,
    fallbackThresholdPercent: input.contextCompactPercent,
    message: `Provider rejected the prompt as too large after ${providerContextRecoveryCount} context recovery attempt(s). Tried semantic_compact_retry; remaining actions: run /context, reduce tool output, or switch to a larger-context model.`,
    cacheAwareCompactPolicy,
  })) events.push(event)
  events.push(buildRuntimeExecutionMetricsEvent(input.options, input.metrics))
  return {
    kind: 'blocked',
    events,
    providerContextRecoveryCount,
    previousEvents,
    autoCompactDecision,
    messages,
    cacheAwareCompactPolicy,
  }
}
