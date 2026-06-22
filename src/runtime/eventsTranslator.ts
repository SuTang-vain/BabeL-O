/**
 * Phase 3B-1 slice — `eventsTranslator.ts`
 *
 * Extracted from `src/runtime/LLMCodingRuntime.ts` (the 1841-line god
 * class). Contains the pure-function `mapEventsToMessages()` plus its
 * three private formatting helpers and the `isToolCompatibleAssistantMessage`
 * predicate.
 *
 * Why extracted:
 *
 * - The translator is a **pure function** over `NexusEvent[]` that emits
 *   `ModelMessage[]`. It has zero side effects, no class state, no
 *   module-level singletons, and no I/O. Keeping it inside the 1841-line
 *   `LLMCodingRuntime` class made the file larger than it needed to be
 *   and made the translator harder to unit-test in isolation (every
 *   test had to instantiate a full runtime).
 * - The translator is **the single source of truth** for how the 40+
 *   `NexusEvent` types map onto provider-visible `ModelMessage` content.
 *   Moving it to its own file gives it a focused module-level docstring
 *   that can describe the mapping rules without competing with the
 *   runtime loop's docs.
 * - The translator is **a candidate for codegen** (Stream F in the
 *   module-coupling-decoupling plan): the future translator table will
 *   be a `Record<NexusEvent['type'], (event) => ModelMessage | null>`
 *   lookup. Having it in its own file makes that future refactor a
 *   single-file rewrite instead of a cross-1841-line rewrite.
 *
 * Goals:
 *
 * - Preserve exact output parity: every existing call site (`LLMCodingRuntime`,
 *   `compact`, `compactSummary`, `contextAnalysis`) must produce the
 *   same `ModelMessage[]` as before.
 * - Keep the public surface stable: `LLMCodingRuntime.ts` re-exports
 *   `mapEventsToMessages` so legacy imports keep working.
 * - Eliminate ~240 lines of pure-function code from `LLMCodingRuntime.ts`.
 *
 * Non-goals:
 *
 * - Do not rewrite the translator as a `Record<type, translator>` lookup.
 *   That is Stream F work; this slice is purely extraction.
 * - Do not move `wrapWithBehaviorTraceTap` — that function depends on
 *   behaviorTrace internals (`detectTriggers`, `queueBehaviorTraceEntry`,
 *   `flushBehaviorTraceQueue`) and stays inside `LLMCodingRuntime.ts`.
 */

import type { NexusEvent } from '../shared/events.js'
import type {
  ModelMessage,
  ContentBlock,
} from '../providers/adapters/ModelAdapter.js'

export type MapEventsToMessagesOptions = {
  /**
   * When true, `thinking_delta` events are replayed into the next
   * assistant message as `reasoningContent`. Some providers (DeepSeek
   * reasoning mode, Anthropic extended thinking) treat this as live
   * context; others treat it as a summary. Default: false (do not
   * replay — keep prior hidden reasoning out of future provider
   * calls to avoid context pollution).
   */
  replayReasoningContent?: boolean
}

/**
 * Translate a session's `NexusEvent` history into the `ModelMessage[]`
 * shape a provider adapter expects.
 *
 * The translator preserves the original conversation structure:
 *
 * - The first emitted message is always a `user` message containing
 *   either the original prompt (when no `user_message` event is
 *   present in `events`) or the first observed `user_message.text`.
 * - `assistant_delta` events concatenate into a single rolling
 *   `assistant` message. When `replayReasoningContent` is true, any
 *   preceding `thinking_delta` events get folded into the assistant
 *   message's `reasoningContent` field.
 * - `tool_started` / `tool_completed` events become `tool_use` /
 *   `tool_result` content blocks on adjacent assistant / user
 *   messages. Tools that were started but never completed
 *   (denied / interrupted) get a synthetic `tool_result` with
 *   `isError: true` so the next provider call does not break.
 * - Grounding / scope / timeout events become `user` messages that
 *   explain the runtime state to the model. When such an event
 *   arrives while a tool round is still open (an assistant
 *   `tool_use` block has no matching `tool_result` yet), the
 *   message is **deferred** until the round closes, so it never
 *   splits an `assistant(tool_use)` ↔ `user(tool_result)` pair.
 *   Anthropic, OpenAI, and minimax all reject a split pair at
 *   request time (observed in `session_6ce63133` as 4 consecutive
 *   `PROVIDER_ERROR` 400s); deferral keeps the pair contiguous
 *   while preserving the runtime information for the model.
 *
 * This function is pure: it reads from `events` and writes a new
 * `messages` array. It does not call out to providers, mutate
 * `events`, or read `process.env`.
 */
export function mapEventsToMessages(
  events: NexusEvent[],
  initialPrompt: string,
  options: MapEventsToMessagesOptions = {},
): ModelMessage[] {
  const messages: ModelMessage[] = []

  const firstUserMsg = events.find(e => e.type === 'user_message') as Extract<NexusEvent, { type: 'user_message' }> | undefined
  const initial = firstUserMsg ? firstUserMsg.text : initialPrompt
  messages.push({ role: 'user', content: initial })

  const completedToolIds = new Set<string>()
  const startedToolIds = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool_started') {
      startedToolIds.add(event.toolUseId)
    }
    if (event.type === 'tool_completed') {
      completedToolIds.add(event.toolUseId)
    }
  }

  let pendingToolResultMsg: ModelMessage | null = null
  let pendingToolAssistantMsg: ModelMessage | null = null
  let pendingReasoningContent = ''
  const seenStartedToolIds = new Set<string>()
  const earlyCompletedByToolId = new Map<string, Extract<NexusEvent, { type: 'tool_completed' }>>()
  const emittedToolResultIds = new Set<string>()

  // Runtime-injected user messages (scope boundary, grounding, timeout, ...)
  // that arrived while a tool round was still open. They are deferred until
  // the round closes so they never split an assistant(tool_use) ↔
  // user(tool_result) pair. See `session_6ce63133` for the regression this
  // queue prevents.
  const deferredRuntimeUserMessages: string[] = []

  const hasUnclosedToolUse = (msg: ModelMessage | null): boolean => {
    if (!msg || msg.role !== 'assistant' || typeof msg.content === 'string') {
      return false
    }
    return msg.content.some(
      (block) => block.type === 'tool_use' && !emittedToolResultIds.has(block.id),
    )
  }

  // Push every deferred runtime user message onto `messages` and clear the
  // queue. Also resets the pending tool state, since flushing implies the
  // surrounding round has closed (or we are starting a new turn / assistant
  // message). No-op when the queue is empty (so non-runtime streams see no
  // behavior change).
  const flushDeferred = () => {
    if (deferredRuntimeUserMessages.length === 0) return
    for (const text of deferredRuntimeUserMessages) {
      messages.push({ role: 'user', content: text })
    }
    deferredRuntimeUserMessages.length = 0
    pendingToolResultMsg = null
    pendingToolAssistantMsg = null
    pendingReasoningContent = ''
  }

  // Called after every tool_result emission. If the open round just closed
  // (every tool_use in the pending assistant message now has a matching
  // tool_result) and there are deferred runtime messages, flush them now so
  // they land immediately after the completed pair.
  const flushDeferredIfRoundClosed = () => {
    if (deferredRuntimeUserMessages.length === 0) return
    if (hasUnclosedToolUse(pendingToolAssistantMsg)) return
    flushDeferred()
  }

  const appendToolResult = (event: Extract<NexusEvent, { type: 'tool_completed' }>) => {
    let lastMsg: ModelMessage | null = pendingToolResultMsg
    if (!lastMsg || typeof lastMsg.content === 'string') {
      lastMsg = { role: 'user', content: [] }
      messages.push(lastMsg)
      pendingToolResultMsg = lastMsg
    }
    const outputText =
      typeof event.output === 'string'
        ? event.output
        : JSON.stringify(event.output, null, 2)
    ;(lastMsg.content as ContentBlock[]).push({
      type: 'tool_result',
      toolUseId: event.toolUseId,
      content: outputText,
      isError: !event.success,
      toolName: event.name,
    })
    emittedToolResultIds.add(event.toolUseId)
    flushDeferredIfRoundClosed()
  }

  // Push a runtime-injected user message. If a tool round is open, defer the
  // message until the round closes (via flushDeferredIfRoundClosed). Otherwise
  // flush any prior deferred messages (defensive) and push inline, resetting
  // pending tool state so the next tool round starts fresh.
  const handleRuntimeUserMessage = (content: string) => {
    if (hasUnclosedToolUse(pendingToolAssistantMsg)) {
      deferredRuntimeUserMessages.push(content)
      return
    }
    flushDeferred()
    pendingToolResultMsg = null
    pendingToolAssistantMsg = null
    pendingReasoningContent = ''
    messages.push({ role: 'user', content })
  }

  for (const event of events) {
    if (event.type === 'user_message') {
      flushDeferred()
      pendingToolResultMsg = null
      pendingToolAssistantMsg = null
      pendingReasoningContent = ''
      const lastMsg = messages[messages.length - 1]
      if (
        lastMsg?.role === 'user' &&
        typeof lastMsg.content === 'string' &&
        lastMsg.content === event.text
      ) {
        continue
      }
      messages.push({ role: 'user', content: event.text })
    } else if (event.type === 'assistant_delta') {
      flushDeferred()
      pendingToolResultMsg = null
      pendingToolAssistantMsg = null
      let lastMsg = messages[messages.length - 1]
      if (!lastMsg || lastMsg.role !== 'assistant') {
        lastMsg = {
          role: 'assistant',
          content: '',
          ...(options.replayReasoningContent && pendingReasoningContent.trim() && {
            reasoningContent: pendingReasoningContent,
          }),
        }
        pendingReasoningContent = ''
        messages.push(lastMsg)
      }
      if (typeof lastMsg.content === 'string') {
        lastMsg.content += event.text
      } else {
        const lastBlock = lastMsg.content[lastMsg.content.length - 1]
        if (lastBlock && lastBlock.type === 'text') {
          lastBlock.text += event.text
        } else {
          lastMsg.content.push({ type: 'text', text: event.text })
        }
      }
    } else if (event.type === 'thinking_delta') {
      if (!options.replayReasoningContent) {
        // Keep thinking_delta in the event log for UI/history, but do not replay
        // prior hidden reasoning into future provider calls. Some providers treat
        // reasoningContent as live context, which can pollute follow-up turns.
        continue
      }
      const lastMsg = messages[messages.length - 1]
      if (!lastMsg || lastMsg.role !== 'assistant') {
        pendingReasoningContent += event.text
        continue
      }
      lastMsg.reasoningContent = `${lastMsg.reasoningContent ?? ''}${event.text}`
      continue
    } else if (event.type === 'context_grounding_required') {
      handleRuntimeUserMessage(`Runtime grounding required: ${event.message} Required for: ${event.requiredFor.join(', ')}. Suggested actions: ${event.suggestedActions.join(', ')}.`)
    } else if (event.type === 'context_grounding_confirmed') {
      handleRuntimeUserMessage(`Runtime grounding confirmed: ${event.message} Confirmation kind: ${event.confirmationKind}. Confirmed for: ${event.confirmedFor.join(', ')}. Source: ${event.source}.`)
    } else if (event.type === 'workspace_dirty_detected') {
      handleRuntimeUserMessage(`Runtime workspace dirty guard: ${event.message} Changed files (${event.changedFileCount}): ${event.changedFiles.join(', ')}${event.truncated ? ' (truncated)' : ''}. Suggested actions: ${event.suggestedActions.join(', ')}.`)
    } else if (event.type === 'task_scope_declared') {
      handleRuntimeUserMessage(`Runtime task scope declared: ${event.message} Primary root: ${event.primaryRoot}. Explicit roots: ${event.explicitRoots.join(', ') || 'none'}. Confirmed external roots: ${event.confirmedExternalRoots.join(', ') || 'none'}. Mode: ${event.mode}.`)
    } else if (event.type === 'scope_boundary_detected') {
      handleRuntimeUserMessage(`Runtime scope boundary detected before ${event.toolName}: ${event.reason} Action: ${event.action}. Target root: ${event.targetRoot}. Current task root: ${event.taskPrimaryRoot}. Do not use this external evidence unless the user confirms the scope boundary.`)
    } else if (event.type === 'scope_boundary_confirmed') {
      handleRuntimeUserMessage(`Runtime scope boundary confirmed: ${event.message} Target root: ${event.targetRoot}. Confirmation scope: ${event.confirmationScope}.`)
    } else if (event.type === 'near_timeout_warning') {
      handleRuntimeUserMessage(formatNearTimeoutConvergenceMessage(event))
    } else if (event.type === 'timeout_budget_exceeded') {
      handleRuntimeUserMessage(formatTimeoutBudgetConvergenceMessage(event))
    } else if (event.type === 'timeout_extension_granted') {
      handleRuntimeUserMessage(formatTimeoutExtensionConvergenceMessage(event))
    } else if (event.type === 'tool_started') {
      seenStartedToolIds.add(event.toolUseId)
      let lastMsg: ModelMessage | null | undefined = pendingToolAssistantMsg
      if (!lastMsg) {
        lastMsg = messages[messages.length - 1]
        if (!lastMsg || lastMsg.role !== 'assistant' || !isToolCompatibleAssistantMessage(lastMsg)) {
          lastMsg = {
            role: 'assistant',
            content: [],
            ...(options.replayReasoningContent && pendingReasoningContent.trim() && {
              reasoningContent: pendingReasoningContent,
            }),
          }
          pendingReasoningContent = ''
          messages.push(lastMsg)
        } else if (typeof lastMsg.content === 'string') {
          lastMsg.content = lastMsg.content ? [{ type: 'text', text: lastMsg.content }] : []
        }
        pendingToolAssistantMsg = lastMsg
      }
      ;(lastMsg.content as ContentBlock[]).push({
        type: 'tool_use',
        id: event.toolUseId,
        name: event.name,
        input: event.input,
      })

      const completed = earlyCompletedByToolId.get(event.toolUseId)
      if (completed && !emittedToolResultIds.has(event.toolUseId)) {
        appendToolResult(completed)
      } else if (!completedToolIds.has(event.toolUseId)) {
        // If this tool was started but never completed (e.g. denied or interrupted),
        // we must synthetically complete it with an error result block so future queries don't break.
        let lastUserMsg: ModelMessage | null = pendingToolResultMsg
        if (!lastUserMsg || typeof lastUserMsg.content === 'string') {
          lastUserMsg = { role: 'user', content: [] }
          messages.push(lastUserMsg)
          pendingToolResultMsg = lastUserMsg
        }
        ;(lastUserMsg.content as ContentBlock[]).push({
          type: 'tool_result',
          toolUseId: event.toolUseId,
          content: 'Error: Tool execution was denied or interrupted.',
          isError: true,
        })
        emittedToolResultIds.add(event.toolUseId)
        flushDeferredIfRoundClosed()
      }
    } else if (
      event.type === 'tool_completed' &&
      startedToolIds.has(event.toolUseId) &&
      !emittedToolResultIds.has(event.toolUseId)
    ) {
      if (seenStartedToolIds.has(event.toolUseId)) {
        appendToolResult(event)
      } else {
        earlyCompletedByToolId.set(event.toolUseId, event)
      }
    }
  }

  // Flush any deferred runtime messages that were never flushed by a round
  // close (defensive — should be empty for a well-formed stream).
  flushDeferred()

  return messages
}

function formatNearTimeoutConvergenceMessage(event: Extract<NexusEvent, { type: 'near_timeout_warning' }>): string {
  return [
    `Runtime timeout convergence warning: elapsed ${event.elapsedMs}ms of ${event.timeoutMs}ms (${Math.round(event.thresholdRatio * 100)}% threshold). ${event.message}`,
    'Do not start new exploratory tool calls.',
    'Either answer with verified evidence already collected, or run at most one explicitly bounded final check.',
    'Mark unverified claims as unverified.',
    'If the task needs more exploration, ask the user to continue with a fresh budget.',
    event.partialSummary ? `Partial summary already available: ${event.partialSummary}` : '',
  ].filter(Boolean).join('\n')
}

function formatTimeoutBudgetConvergenceMessage(event: Extract<NexusEvent, { type: 'timeout_budget_exceeded' }>): string {
  return [
    `Runtime soft timeout budget reached: elapsed ${event.elapsedMs}ms of ${event.timeoutMs}ms (policy=${event.policy}). ${event.message}`,
    'This is a recoverable budget signal, not permission for broad discovery.',
    'Do not start new exploratory tool calls.',
    'Either answer with verified evidence already collected, or run at most one explicitly bounded final check.',
    'Mark unverified claims as unverified.',
    'If more exploration is required, ask the user to continue with a fresh budget.',
    event.suggestedActions?.length ? `Suggested actions: ${event.suggestedActions.join(', ')}.` : '',
    event.partialSummary ? `Partial summary already available: ${event.partialSummary}` : '',
  ].filter(Boolean).join('\n')
}

function formatTimeoutExtensionConvergenceMessage(event: Extract<NexusEvent, { type: 'timeout_extension_granted' }>): string {
  return [
    `Runtime soft timeout extension granted: extension ${event.extensionCount}/${event.maxExtensions}, +${event.additionalMs}ms, total soft budget ${event.totalSoftBudgetMs}ms.`,
    'Use this extension to wrap up.',
    'Do not start broad discovery. Run at most one explicitly bounded final check, then answer.',
    'Separate verified evidence from unverified claims.',
    `Reason: ${event.reason}. ${event.message}`,
  ].join('\n')
}

function isToolCompatibleAssistantMessage(message: ModelMessage): boolean {
  if (message.role !== 'assistant' || typeof message.content === 'string') {
    return message.role === 'assistant'
  }
  return message.content.every(block => block.type === 'text' || block.type === 'tool_use')
}
