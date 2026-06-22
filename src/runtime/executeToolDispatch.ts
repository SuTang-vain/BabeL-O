/**
 * Phase 3B-17 slice — `executeToolDispatch.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts`. Contains
 * the standalone async generator `executeToolDispatch()`
 * that runs `ToolDispatchPipeline.run(...)` against the
 * outcome's tool calls, streams the resulting async
 * generator events, and returns the per-loop state updates
 * the main loop must apply (previousEvents, taskScopeEvent,
 * toolResults message, terminal flag).
 *
 * Why extracted:
 *
 * - The tool-dispatch block was a 17-line inline sequence
 *   in the main loop that interleaved generator driving,
 *   state updates, and a kind-based branch. Pulling it
 *   out behind a single helper call makes the main
 *   loop's per-iteration shape visible at a glance.
 * - The pattern is the same async-generator drive as
 *   `executeProviderTurn` (3B-15) and the
 *   `compactSession` block inside the pre-loop helper
 *   (3B-13 / 3B-14). All three follow the
 *   'drive-the-async-generator' pattern; pulling this
 *   third instance out keeps the main loop consistent
 *   with the rest of the per-loop slice.
 * - Future slices that introduce a per-tool-call
 *   post-dispatch hook (e.g. budget re-check) can
 *   extend this helper without touching the main
 *   loop.
 *
 * Goals:
 *
 * - Preserve the pre-extraction streaming contract:
 *   permission_request / tool_started / scope events must
 *   reach Nexus before a tool call finishes.
 * - Eliminate ~15 lines of inline code from
 *   `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not change the call site of
 *   `ToolDispatchPipeline.run(...)`: the helper passes
 *   the same options through.
 * - Keep state ownership in the main loop: this helper
 *   yields events progressively, then returns the final
 *   state bundle for the main loop to write back.
 * - Do not fire the terminal `return`: the helper
 *   surfaces a `terminal` flag instead.
 */

import type { NexusEvent } from '../shared/events.js'
import type { ModelMessage } from '../providers/adapters/ModelAdapter.js'
import type { TaskScopeDeclaredEvent } from './taskScope.js'
import type { ToolDispatchPipeline, ToolDispatchPipelineResult } from './ToolDispatchPipeline.js'
import type { RuntimeProviderToolCall } from './runtimePipeline.js'

export type ExecuteToolDispatchInput = {
  toolCalls: RuntimeProviderToolCall[]
  runtimeOptions: any
  previousEvents: NexusEvent[]
  /** The `TaskScopeDeclaredEvent` from the most recent
   *  refresh. The helper passes it through to
   *  `ToolDispatchPipeline.run(...)` and returns the
   *  updated value the main loop must persist. */
  taskScopeEvent: TaskScopeDeclaredEvent
}

export type ExecuteToolDispatchResult = {
  /** Every `NexusEvent` the dispatch produced, in
   *  order. The main loop drives the user-facing yield
   *  loop; the helper does not yield. */
  events: NexusEvent[]
  /** Updated `previousEvents` accumulator. The main
   *  loop must write this back to its `let`. */
  previousEvents: NexusEvent[]
  /** Updated `taskScopeEvent`. The main loop must
   *  write this back to its `let`. */
  taskScopeEvent: TaskScopeDeclaredEvent
  /** When true, the main loop must `return` after
   *  this iteration. The dispatch is the last step on
   *  the terminal path. */
  terminal: boolean
  /** When `terminal` is false, the per-iteration
   *  `messages` to push onto the loop's `messages`
   *  accumulator (built from `toolDispatchResult.
   *  toolResults`). On the terminal path this is an
   *  empty array. */
  messages: ModelMessage[]
}

/**
 * Run one tool-dispatch pass: drive the
 * `ToolDispatchPipeline.run(...)` async generator,
 * yield dispatch events progressively, and return the new
 * state values the main loop must write back.
 */
export async function* executeToolDispatch(
  toolDispatchPipeline: ToolDispatchPipeline,
  input: ExecuteToolDispatchInput,
): AsyncGenerator<NexusEvent, ExecuteToolDispatchResult> {
  const events: NexusEvent[] = []
  const stream = toolDispatchPipeline.run(input)
  let result = await stream.next()
  while (!result.done) {
    events.push(result.value)
    yield result.value
    result = await stream.next()
  }
  const final: ToolDispatchPipelineResult = result.value
  const terminal = final.kind === 'terminal'
  return {
    events,
    previousEvents: final.previousEvents,
    taskScopeEvent: final.taskScopeEvent,
    terminal,
    messages: terminal ? [] : [buildProviderToolResultsMessageSafe(final.toolResults)],
  }
}

// Re-export `buildProviderToolResultsMessage` from the
// runtime pipeline so the helper can build the per-
// iteration messages without re-implementing the shape.
// We import the function lazily to keep this module's
// dependency surface small.
import { buildProviderToolResultsMessage } from './runtimePipeline.js'
function buildProviderToolResultsMessageSafe(toolResults: any): ModelMessage {
  return buildProviderToolResultsMessage(toolResults) as ModelMessage
}
