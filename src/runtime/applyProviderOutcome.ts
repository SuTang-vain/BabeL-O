/**
 * Phase 3B-16 slice — `applyProviderOutcome.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains
 * the standalone async function `applyProviderOutcome()`
 * that runs `reduceProviderTurnOutcome(...)` and applies
 * the resulting outcome to the runtime's per-loop
 * counters / messages. The helper is the provider-loop
 * analog of the per-loop compact helpers (3B-13 / 3B-14):
 * it owns one bounded step and returns a result the
 * main loop dispatches on.
 *
 * What the helper owns:
 *
 *   1. Calls `reduceProviderTurnOutcome(...)` with the
 *      loop's counters + intent guidance.
 *   2. Updates the four `let` counters the main loop
 *      owns (`maxTokenRecoveryCount`, `outputRetryCount`,
 *      `suppressedToolRetryCount`, `finalAnswerRetryCount`).
 *   3. Returns the `messages` to push onto the per-loop
 *      `messages` accumulator.
 *   4. Returns the list of `NexusEvent`s the main loop
 *      must yield (eventsBeforeMessages + the terminal
 *      metrics event when the outcome is terminal).
 *   5. Returns the outcome `kind` ('continue' or
 *      'terminal') so the main loop can decide whether
 *      to `continue` or `return`.
 *   6. Returns a `queueSessionMemoryLiteUpdate` flag so
 *      the main loop can fire the queue helper on the
 *      terminal path.
 *
 * Why extracted:
 *
 * - The provider-outcome block was a 35-line inline
 *   sequence in the main loop that interleaved counter
 *   updates, event yields, message pushes, and a
 *   kind-based branch. Pulling it out behind a single
 *   helper call makes the main loop's per-iteration
 *   shape visible at a glance.
 * - The four counter updates + outcome branching is
 *   testable in isolation: a unit test can pass a
 *   fake `reduceProviderTurnOutcome` return value and
 *   assert that the helper updates the right counters
 *   and returns the right kind.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: same counter
 *   updates, same event yields, same kind-based
 *   branch, same terminal-path `queueSessionMemoryLiteUpdate`
 *   decision.
 * - Eliminate ~25 lines of inline code from
 *   `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not change the call site of
 *   `reduceProviderTurnOutcome(...)`: the helper
 *   passes the same options through.
 * - Do not fire `queueSessionMemoryLiteUpdate(...)`
 *   here — the main loop fires it on the terminal
 *   path because the helper returns a flag. (The helper
 *   does not own the runtime's storage handle, so it
 *   cannot fire the side effect itself without
 *   growing the input bundle.)
 * - Do not yield any events: the main loop drives the
 *   user-facing yield loop.
 */

import { reduceProviderTurnOutcome } from './runtimePipeline.js'
import type { NexusEvent } from '../shared/events.js'
import type { ModelMessage } from '../providers/adapters/ModelAdapter.js'

export type ApplyProviderOutcomeInput = {
  turn: any
  finalResponseOnlyMode: boolean
  suppressToolsForUserIntent: boolean
  confirmedOptionSelection?: boolean
  userIntentGuidance: any
  providerId: string
  modelId: string
  maxTokenRecoveryCount: number
  maxTokenRecoveries: number
  outputRetryCount: number
  maxOutputRetries: number
  suppressedToolRetryCount: number
  maxSuppressedToolRetries: number
}

export type ApplyProviderOutcomeResult = {
  /** 'continue' = the main loop should `continue` to
   *  the next iteration; 'terminal' = the main loop
   *  should yield the terminal metrics event and
   *  `return`; 'tool_calls' = the main loop should
   *  dispatch the tools and re-enter the loop. */
  kind: 'continue' | 'terminal' | 'tool_calls'
  /** The new counter values to write back to the main
   *  loop's `let` declarations. */
  nextCounters: {
    maxTokenRecoveryCount: number
    outputRetryCount: number
    suppressedToolRetryCount: number
  }
  /** When 1, the main loop should `metrics.
   *  finalAnswerRetryCount += 1`. The helper returns
   *  this as a 0/1 increment rather than mutating
   *  the metrics object directly so the metrics
   *  shape stays owned by the main loop. */
  finalAnswerRetryIncrement: 0 | 1
  /** Messages to push onto the per-loop `messages`
   *  accumulator. */
  messages: ModelMessage[]
  /** Events the main loop must yield in order. The
   *  helper has already sorted them
   *  (eventsBeforeMessages, then eventsAfterMessages).
   *  The terminal metrics event is built by the main
   *  loop because the storage handle lives there. */
  events: NexusEvent[]
  /** When true (kind === 'terminal'), the main loop
   *  should fire `queueSessionMemoryLiteUpdate(...)`. */
  queueSessionMemoryLiteUpdate: boolean
  /** Tool calls to dispatch (kind === 'tool_calls'). */
  toolCalls: any[] | null
}

/**
 * Run one provider-outcome pass: build the outcome,
 * compute counter updates, and return the events /
 * messages / kind for the main loop to dispatch.
 */
export async function applyProviderOutcome(
  input: ApplyProviderOutcomeInput,
): Promise<ApplyProviderOutcomeResult> {
  const providerOutcome = reduceProviderTurnOutcome({
    sessionId: input.turn.sessionId ?? '',
    turn: input.turn,
    finalResponseOnlyMode: input.finalResponseOnlyMode,
    suppressToolsForUserIntent: input.suppressToolsForUserIntent,
    confirmedOptionSelection: input.confirmedOptionSelection,
    userIntentGuidance: input.userIntentGuidance,
    providerId: input.providerId,
    modelId: input.modelId,
    maxTokenRecoveryCount: input.maxTokenRecoveryCount,
    maxTokenRecoveries: input.maxTokenRecoveries,
    outputRetryCount: input.outputRetryCount,
    maxOutputRetries: input.maxOutputRetries,
    suppressedToolRetryCount: input.suppressedToolRetryCount,
    maxSuppressedToolRetries: input.maxSuppressedToolRetries,
  })
  // The leak suppression "final answer retry" is a
  // metrics update that lives at the main loop's
  // counter level (it is counted once per turn with
  // leak suppression + outcome.kind === 'continue').
  const finalAnswerRetryIncrement: 0 | 1 =
    input.turn.toolCallTextLeakSuppression && providerOutcome.kind === 'continue' ? 1 : 0
  const events: NexusEvent[] = [
    ...providerOutcome.eventsBeforeMessages,
    ...providerOutcome.eventsAfterMessages,
  ]
  return {
    kind: providerOutcome.kind,
    nextCounters: {
      maxTokenRecoveryCount: providerOutcome.maxTokenRecoveryCount,
      outputRetryCount: providerOutcome.outputRetryCount,
      suppressedToolRetryCount: providerOutcome.suppressedToolRetryCount,
    },
    finalAnswerRetryIncrement,
    messages: providerOutcome.messages,
    events,
    queueSessionMemoryLiteUpdate:
      providerOutcome.kind === 'terminal' && providerOutcome.queueSessionMemoryLiteUpdate
        ? true
        : false,
    toolCalls: providerOutcome.kind === 'tool_calls' ? providerOutcome.toolCalls : null,
  }
}
