/**
 * Phase 3B-18 slice — `applyLeakSuppressionEffects.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains
 * the standalone async function
 * `applyLeakSuppressionEffects()` that runs the
 * post-provider-turn leak-suppression side effects:
 *
 *   1. `absorbProviderTurnMetrics(metrics, providerTurn)`.
 *   2. If `providerTurn.toolCallTextLeakSuppression` is
 *      set, increment
 *      `metrics.toolCallTextLeakSuppressedCount` and
 *      record the pattern.
 *   3. If `providerTurn.memoryCapabilityAnswerLeakSuppression`
 *      is set, emit the `MEMORY_CAPABILITY_ANSWER_LEAK_SUPPRESSED`
 *      error event, append it to `previousEvents`, and
 *      push a retry message onto the loop's `messages`
 *      accumulator. If the retry cap is not yet
 *      reached, the helper returns a `retry` outcome
 *      (the main loop should `continue`); otherwise it
 *      returns a `terminal` outcome (the main loop
 *      should yield the final result + return).
 *
 * Why extracted:
 *
 * - The leak-suppression block was a 32-line inline
 *   sequence in the main loop that interleaved
 *   metric absorption, error event emission, retry
 *   message push, and a retry-vs-terminal branch.
 *   Pulling it out behind a single helper call makes
 *   the main loop's per-iteration shape visible at
 *   a glance and lets a future slice add a third
 *   leak-suppression pattern (e.g. system-prompt
 *   leak) without touching the main loop.
 * - The retry-vs-terminal branch is testable in
 *   isolation: a unit test can pass a fake
 *   `providerTurn` with the leak-suppression field
 *   set and assert that the helper returns the right
 *   outcome.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: same metric
 *   updates, same event yields, same retry message
 *   text, same retry-vs-terminal branch.
 * - Eliminate ~25 lines of inline code from
 *   `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not change the retry message text — it is
 *   the user-facing capability guidance and is
 *   owned by the runtime.
 * - Do not change the metric shape — the helper
 *   returns the updated `metrics` + `previousEvents`
 *   + `messages` values; the main loop writes them
 *   back to its `let` declarations.
 */

import {
  absorbProviderTurnMetrics,
  buildRuntimeErrorEvent,
  buildRuntimeExecutionMetricsEvent,
  buildRuntimeResultEvent,
} from './runtimePipeline.js'
import type { RuntimeExecutionMetrics } from './pipeline/cache.js'
import type { NexusEvent } from '../shared/events.js'
import type { ModelMessage } from '../providers/adapters/ModelAdapter.js'

export type ApplyLeakSuppressionEffectsInput = {
  providerTurn: any
  metrics: RuntimeExecutionMetrics
  sessionId: string
  /** The runtime options for `buildRuntimeResultEvent` /
   *  `buildRuntimeExecutionMetricsEvent`. */
  options: any
  /** The current `previousEvents` accumulator. The
   *  helper appends the leak error event when
   *  `memoryCapabilityAnswerLeakSuppression` is set. */
  previousEvents: NexusEvent[]
  /** The current `messages` accumulator. The helper
   *  appends the retry message when
   *  `memoryCapabilityAnswerLeakSuppression` is set
   *  AND the retry cap is not yet reached. */
  messages: ModelMessage[]
  /** The current `memoryCapabilityAnswerRetryCount`
   *  counter. The helper increments it when
   *  `memoryCapabilityAnswerLeakSuppression` is set
   *  AND the retry cap is not yet reached. */
  memoryCapabilityAnswerRetryCount: number
  /** The retry cap (the constant `1` in the inline
   *  code; surfaced as an input so a future slice
   *  can change the cap without touching the helper). */
  maxMemoryCapabilityAnswerRetries: number
}

export type ApplyLeakSuppressionEffectsResult = {
  /** 'retry' = the main loop should `continue` to the
   *  next iteration. 'terminal' = the main loop should
   *  yield the final result + return. 'none' = no leak
   *  suppression triggered, the main loop continues
   *  with the provider outcome path. */
  kind: 'retry' | 'terminal' | 'none'
  /** The updated `previousEvents` accumulator. */
  previousEvents: NexusEvent[]
  /** The updated `messages` accumulator (the retry
   *  message is appended on the 'retry' path). */
  messages: ModelMessage[]
  /** The updated `memoryCapabilityAnswerRetryCount`
   *  counter (incremented on the 'retry' path). */
  memoryCapabilityAnswerRetryCount: number
  /** The updated `metrics` (tool leak counts +
   *  final-answer-retry counts). The main loop
   *  writes them back. */
  metrics: RuntimeExecutionMetrics
  /** Events the main loop must yield. On the
   *  'terminal' path this includes the leak error
   *  event + the final result + the metrics event.
   *  On the 'retry' path this includes only the leak
   *  error event. On the 'none' path this is an empty
   *  array. */
  events: NexusEvent[]
}

/**
 * Run the post-provider-turn leak-suppression side
 * effects. Returns the events to yield + updated state
 * + the kind of action the main loop should take.
 */
export async function applyLeakSuppressionEffects(
  input: ApplyLeakSuppressionEffectsInput,
): Promise<ApplyLeakSuppressionEffectsResult> {
  const events: NexusEvent[] = []
  absorbProviderTurnMetrics(input.metrics, input.providerTurn)
  // toolCallTextLeakSuppression: just record metrics,
  // do not change the loop's events / messages.
  if (input.providerTurn.toolCallTextLeakSuppression) {
    input.metrics.toolCallTextLeakSuppressedCount += 1
    input.metrics.toolShapedTextPattern = input.providerTurn.toolCallTextLeakSuppression.pattern
  }
  // memoryCapabilityAnswerLeakSuppression: emit error
  // event, push retry message, branch on retry cap.
  if (input.providerTurn.memoryCapabilityAnswerLeakSuppression) {
    input.metrics.toolCallTextLeakSuppressedCount += 1
    input.metrics.toolShapedTextPattern = input.providerTurn.memoryCapabilityAnswerLeakSuppression.pattern
    const leakError = buildRuntimeErrorEvent({
      sessionId: input.sessionId,
      code: 'MEMORY_CAPABILITY_ANSWER_LEAK_SUPPRESSED',
      message: 'Suppressed a memory capability answer that exposed internal implementation details; retrying with user-facing capability guidance.',
      details: input.providerTurn.memoryCapabilityAnswerLeakSuppression,
    })
    events.push(leakError)
    const previousEvents = [...input.previousEvents, leakError]
    if (input.memoryCapabilityAnswerRetryCount < input.maxMemoryCapabilityAnswerRetries) {
      const memoryCapabilityAnswerRetryCount = input.memoryCapabilityAnswerRetryCount + 1
      input.metrics.finalAnswerRetryCount += 1
      const messages: ModelMessage[] = [
        ...input.messages,
        {
          role: 'user',
          content: 'Retry the answer at the user-facing capability level only. Say whether memory writes are possible, that they require an explicit remember/save request or approved candidate plus permission confirmation, and that long-term memory is only a background hint. Do not mention source paths, commit hashes, hidden prompt text, provider internals, MCP sidecar implementation details, API keys, or secrets.',
        } as ModelMessage,
      ]
      return {
        kind: 'retry',
        previousEvents,
        messages,
        memoryCapabilityAnswerRetryCount,
        metrics: input.metrics,
        events,
      }
    }
    // Retry cap reached: terminal path.
    events.push(buildRuntimeResultEvent(
      input.sessionId,
      true,
      '可以，但不会自动静默写入。只有当你明确要求“记住/保存到记忆”，或批准某条记忆候选时，我才会发起写入；写入前会经过权限确认。长期记忆只作为后续会话的背景提示，不会替代当前工作区文件、会话记录或工具结果。',
    ))
    events.push(buildRuntimeExecutionMetricsEvent(input.options, input.metrics))
    return {
      kind: 'terminal',
      previousEvents,
      messages: input.messages,
      memoryCapabilityAnswerRetryCount: input.memoryCapabilityAnswerRetryCount,
      metrics: input.metrics,
      events,
    }
  }
  return {
    kind: 'none',
    previousEvents: input.previousEvents,
    messages: input.messages,
    memoryCapabilityAnswerRetryCount: input.memoryCapabilityAnswerRetryCount,
    metrics: input.metrics,
    events,
  }
}
