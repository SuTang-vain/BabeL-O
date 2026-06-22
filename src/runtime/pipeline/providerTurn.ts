import { performance } from 'node:perf_hooks'
import { eventBase, type NexusEvent } from '../../shared/events.js'
import type {
  FinishReason,
  ModelMessage,
  StreamDelta,
} from '../../providers/adapters/ModelAdapter.js'
import type { CacheAwareCompactUsage } from '../cacheAwareCompactPolicy.js'
import type { UserIntentGuidance } from '../intentGuidance.js'
import { buildProviderFallbackPolicy } from '../providerRecovery.js'
import {
  buildRuntimeErrorEvent,
  buildRuntimeResultEvent,
  buildToolCallTextLeakSuppressedEvent,
} from './events.js'
import {
  buildProviderAssistantMessage,
  type MemoryCapabilityAnswerLeakSuppression,
  type RuntimeProviderToolCall,
  type RuntimeProviderTurn,
  type ToolCallTextLeakPhase,
  type ToolCallTextLeakSuppression,
} from './turn.js'

type RuntimeProviderTurnOutcomeBase = {
  messages: ModelMessage[]
  eventsBeforeMessages: NexusEvent[]
  eventsAfterMessages: NexusEvent[]
  maxTokenRecoveryCount: number
  outputRetryCount: number
  suppressedToolRetryCount: number
}

export type RuntimeProviderTurnOutcome =
  | (RuntimeProviderTurnOutcomeBase & { kind: 'continue' })
  | (RuntimeProviderTurnOutcomeBase & { kind: 'terminal'; queueSessionMemoryLiteUpdate?: boolean })
  | (RuntimeProviderTurnOutcomeBase & { kind: 'tool_calls'; toolCalls: RuntimeProviderToolCall[] })

const OPTION_SELECTION_PATTERN = /^[A-Z]$/i
const CLARIFY_OPTION_SELECTION_MARKER = '[BabeL-O clarification: option-selection]'

export function reduceProviderTurnOutcome(options: {
  sessionId: string
  turn: Pick<RuntimeProviderTurn, 'assistantText' | 'reasoningText' | 'finishReason' | 'toolCalls' | 'toolCallTextLeakSuppression'>
  finalResponseOnlyMode: boolean
  suppressToolsForUserIntent: boolean
  userIntentGuidance: UserIntentGuidance
  providerId?: string
  modelId?: string
  maxTokenRecoveryCount: number
  maxTokenRecoveries: number
  outputRetryCount: number
  maxOutputRetries: number
  suppressedToolRetryCount: number
  maxSuppressedToolRetries: number
}): RuntimeProviderTurnOutcome {
  const { turn } = options
  const baseCounts = {
    maxTokenRecoveryCount: options.maxTokenRecoveryCount,
    outputRetryCount: options.outputRetryCount,
    suppressedToolRetryCount: options.suppressedToolRetryCount,
  }

  if (turn.toolCallTextLeakSuppression) {
    const event = buildToolCallTextLeakSuppressedEvent({
      sessionId: options.sessionId,
      providerId: options.providerId,
      modelId: options.modelId,
      suppression: turn.toolCallTextLeakSuppression,
      retryAttempted: options.outputRetryCount < options.maxOutputRetries,
    })
    if (options.outputRetryCount < options.maxOutputRetries) {
      return {
        kind: 'continue',
        eventsBeforeMessages: [event],
        eventsAfterMessages: [],
        messages: [{
          role: 'user',
          content: 'The previous model response attempted to emit tool-call-shaped text while tools are disabled. Answer the latest user message directly in natural language. Do not include tool-call markup.',
        }],
        maxTokenRecoveryCount: options.maxTokenRecoveryCount,
        outputRetryCount: options.outputRetryCount + 1,
        suppressedToolRetryCount: options.suppressedToolRetryCount,
      }
    }
    const message = 'Suppressed a malformed tool-call-shaped response while tools were disabled.'
    return {
      kind: 'terminal',
      eventsBeforeMessages: [],
      eventsAfterMessages: [event, buildRuntimeResultEvent(options.sessionId, false, message)],
      messages: [],
      ...baseCounts,
    }
  }

  if (turn.finishReason === 'max_tokens' && turn.toolCalls.length === 0) {
    if (options.maxTokenRecoveryCount < options.maxTokenRecoveries) {
      return {
        kind: 'continue',
        eventsBeforeMessages: [],
        eventsAfterMessages: [],
        messages: [
          {
            role: 'assistant',
            content: turn.assistantText,
            ...(turn.reasoningText.trim() && { reasoningContent: turn.reasoningText }),
          },
          {
            role: 'user',
            content: 'Your previous response was cut off because it hit the maximum output token limit. Please continue exactly from where you left off — do not repeat what you already said.',
          },
        ],
        maxTokenRecoveryCount: options.maxTokenRecoveryCount + 1,
        outputRetryCount: options.outputRetryCount,
        suppressedToolRetryCount: options.suppressedToolRetryCount,
      }
    }
    const message = `Provider repeatedly stopped because it hit the maximum output token limit after ${options.maxTokenRecoveries} recovery attempts.`
    return {
      kind: 'terminal',
      eventsBeforeMessages: [
        buildRuntimeErrorEvent({
          sessionId: options.sessionId,
          code: 'MAX_OUTPUT_TOKENS_EXCEEDED',
          message,
          details: {
            kind: 'max_output_tokens',
            recoveryReason: 'ESCALATED_MAX_TOKENS',
            retryable: true,
            suggestion: 'Retry with a smaller requested output, ask for a shorter summary, or route this task to a model with a larger output budget.',
            fallbackPolicy: buildProviderFallbackPolicy('max_output_tokens'),
          },
        }),
        buildRuntimeResultEvent(options.sessionId, false, message),
      ],
      eventsAfterMessages: [],
      messages: [],
      ...baseCounts,
    }
  }

  if (options.finalResponseOnlyMode && turn.toolCalls.length > 0) {
    const attemptedTools = turn.toolCalls.map(toolCall => toolCall.name).join(', ')
    const message = `Runtime entered final-response-only mode after repeated tool calls and ignored additional requested tools: ${attemptedTools}.`
    return {
      kind: 'continue',
      eventsBeforeMessages: [
        buildRuntimeErrorEvent({
          sessionId: options.sessionId,
          code: 'TOOL_LOOP_FINAL_RESPONSE_ONLY',
          message,
        }),
      ],
      eventsAfterMessages: [],
      messages: [{
        role: 'user',
        content: `${message}\nProvide the best final answer now using the information already available. Do not call tools.`,
      }],
      ...baseCounts,
    }
  }

  if (options.suppressToolsForUserIntent && turn.toolCalls.length > 0 && options.suppressedToolRetryCount < options.maxSuppressedToolRetries) {
    const attemptedTools = turn.toolCalls.map(toolCall => toolCall.name).join(', ')
    const message = `Runtime suppressed provider tool calls for respond-only user intent: ${attemptedTools}.`
    const optionSelection = normalizeOptionSelection(options.userIntentGuidance.latestUserText)
    if (optionSelection) {
      const clarification = buildOptionSelectionClarificationMessage({
        optionSelection,
        attemptedTools,
      })
      return {
        kind: 'terminal',
        eventsBeforeMessages: [
          buildRuntimeErrorEvent({
            sessionId: options.sessionId,
            code: 'TOOL_CALL_NEEDS_USER_CONFIRMATION',
            message: `Tool call conflict for ambiguous option-like input "${optionSelection}". Asking the user to confirm before running tools.`,
            details: {
              intent: options.userIntentGuidance.intent,
              actionHint: options.userIntentGuidance.actionHint,
              requiresTools: options.userIntentGuidance.requiresTools,
              latestUserText: options.userIntentGuidance.latestUserText,
              optionSelection,
              attemptedTools: turn.toolCalls.map(toolCall => toolCall.name),
              retryAttempted: false,
              retryExhausted: false,
            },
          }),
        ],
        eventsAfterMessages: [
          buildRuntimeResultEvent(options.sessionId, true, clarification),
        ],
        messages: [{
          role: 'assistant',
          content: clarification,
        }],
        ...baseCounts,
      }
    }
    return {
      kind: 'continue',
      eventsBeforeMessages: [
        buildRuntimeErrorEvent({
          sessionId: options.sessionId,
          code: 'TOOL_CALL_SUPPRESSED_BY_USER_INTENT',
          message,
          details: {
            intent: options.userIntentGuidance.intent,
            actionHint: options.userIntentGuidance.actionHint,
            requiresTools: options.userIntentGuidance.requiresTools,
            latestUserText: options.userIntentGuidance.latestUserText,
            attemptedTools: turn.toolCalls.map(toolCall => toolCall.name),
            retryAttempted: true,
            retryExhausted: false,
          },
        }),
      ],
      eventsAfterMessages: [],
      messages: [{
        role: 'user',
        content: `${message}\nIf you genuinely need to execute a command or inspect files to answer the user, call the appropriate tool now. Otherwise, answer directly from existing context.`,
      }],
      maxTokenRecoveryCount: options.maxTokenRecoveryCount,
      outputRetryCount: options.outputRetryCount,
      suppressedToolRetryCount: options.suppressedToolRetryCount + 1,
    }
  }

  const assistantMessage = buildProviderAssistantMessage(turn)
  if (turn.toolCalls.length === 0) {
    if (turn.assistantText.trim().length === 0) {
      const reasoningOnly = turn.reasoningText.trim().length > 0
      if (reasoningOnly) {
        const message = 'Provider returned an empty assistant response with no tool calls.'
        return {
          kind: 'terminal',
          eventsBeforeMessages: [],
          eventsAfterMessages: [
            buildRuntimeErrorEvent({
              sessionId: options.sessionId,
              code: 'EMPTY_PROVIDER_RESPONSE',
              message,
              details: {
                kind: 'reasoning_only',
                retryable: true,
                suggestion: 'Retry the turn or switch to a model/provider that emits assistant text or tool calls after reasoning.',
              },
            }),
            buildRuntimeResultEvent(options.sessionId, false, message),
          ],
          messages: [assistantMessage],
          ...baseCounts,
        }
      }
      if (options.outputRetryCount < options.maxOutputRetries) {
        return {
          kind: 'continue',
          eventsBeforeMessages: [],
          eventsAfterMessages: [],
          messages: [
            assistantMessage,
            {
              role: 'user',
              content: 'Your previous response was cut off or empty. Please continue from where you left off.',
            },
          ],
          maxTokenRecoveryCount: options.maxTokenRecoveryCount,
          outputRetryCount: options.outputRetryCount + 1,
          suppressedToolRetryCount: options.suppressedToolRetryCount,
        }
      }
      const message = 'Provider returned an empty assistant response with no tool calls.'
      return {
        kind: 'terminal',
        eventsBeforeMessages: [],
        eventsAfterMessages: [
          buildRuntimeErrorEvent({
            sessionId: options.sessionId,
            code: 'EMPTY_PROVIDER_RESPONSE',
            message,
          }),
          buildRuntimeResultEvent(options.sessionId, false, message),
        ],
        messages: [assistantMessage],
        ...baseCounts,
      }
    }
    return {
      kind: 'terminal',
      eventsBeforeMessages: [],
      eventsAfterMessages: [buildRuntimeResultEvent(options.sessionId, true, turn.assistantText)],
      messages: [assistantMessage],
      queueSessionMemoryLiteUpdate: true,
      ...baseCounts,
    }
  }

  return {
    kind: 'tool_calls',
    eventsBeforeMessages: [],
    eventsAfterMessages: [],
    messages: [assistantMessage],
    toolCalls: turn.toolCalls,
    ...baseCounts,
  }
}

export function normalizeOptionSelection(text: string): string | undefined {
  const trimmed = text.trim()
  if (!OPTION_SELECTION_PATTERN.test(trimmed)) return undefined
  return trimmed.toUpperCase()
}

export function isOptionSelectionClarificationText(text: string): boolean {
  return text.includes(CLARIFY_OPTION_SELECTION_MARKER)
}

export function buildOptionSelectionClarificationMessage(options: {
  optionSelection: string
  attemptedTools: string
}): string {
  return [
    `${CLARIFY_OPTION_SELECTION_MARKER}`,
    `I saw your "${options.optionSelection}" input, but there is a conflict: the intake step treated it as a text-only reply, while the next action would need tools (${options.attemptedTools}).`,
    `Did you mean to choose the previous "${options.optionSelection}" option and continue, or was it a typo?`,
    `Reply "${options.optionSelection}" again to confirm that option, or describe the correction you intended.`,
  ].join('\n')
}

export async function* streamProviderTurn(options: {
  stream: AsyncIterable<StreamDelta>
  sessionId: string
  signal?: AbortSignal
  executionStartMs?: number
  queryStartMs?: number
  toolCallTextLeakGuard?: { phase: ToolCallTextLeakPhase }
  memoryCapabilityAnswerLeakGuard?: boolean
}): AsyncGenerator<NexusEvent, RuntimeProviderTurn> {
  const queryStartMs = options.queryStartMs ?? performance.now()
  let assistantText = ''
  let reasoningText = ''
  let finishReason: FinishReason | undefined
  let turnFirstTokenMs: number | undefined
  let providerFirstTokenMs: number | undefined
  let streamDeltaCount = 0
  let charsOut = 0
  const usage: CacheAwareCompactUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
  const toolCalls: RuntimeProviderToolCall[] = []
  let textLeakSuppression: ToolCallTextLeakSuppression | undefined
  let memoryCapabilityAnswerLeakSuppression: MemoryCapabilityAnswerLeakSuppression | undefined
  let guardedTextBuffer = ''
  let memoryCapabilityAnswerBuffer = ''

  const markFirstToken = () => {
    if (turnFirstTokenMs !== undefined) return
    const now = performance.now()
    turnFirstTokenMs = now - queryStartMs
    if (options.executionStartMs !== undefined) {
      providerFirstTokenMs = now - options.executionStartMs
    }
  }

  for await (const delta of options.stream) {
    if (options.signal?.aborted) {
      throw new Error('Aborted')
    }

    if (delta.type === 'text') {
      markFirstToken()
      streamDeltaCount += 1
      charsOut += delta.text.length
      if (options.memoryCapabilityAnswerLeakGuard) {
        memoryCapabilityAnswerBuffer += delta.text
        continue
      }
      if (options.toolCallTextLeakGuard) {
        guardedTextBuffer += delta.text
        const leak = detectToolCallTextLeak(guardedTextBuffer, options.toolCallTextLeakGuard.phase)
        if (leak) {
          textLeakSuppression = leak
          guardedTextBuffer = ''
        }
        continue
      }
      assistantText += delta.text
      yield {
        type: 'assistant_delta',
        ...eventBase(options.sessionId),
        text: delta.text,
      }
    } else if (delta.type === 'thinking') {
      markFirstToken()
      streamDeltaCount += 1
      charsOut += delta.text.length
      reasoningText += delta.text
      yield {
        type: 'thinking_delta',
        ...eventBase(options.sessionId),
        text: delta.text,
      }
    } else if (delta.type === 'tool_use_start') {
      markFirstToken()
      toolCalls.push({
        id: delta.id,
        name: delta.name,
        partialInput: '',
      })
    } else if (delta.type === 'tool_use_delta') {
      const toolCall = toolCalls.find(tc => tc.id === delta.id)
      if (toolCall) {
        toolCall.partialInput += delta.inputDelta
      }
    } else if (delta.type === 'tool_use_end') {
      const toolCall = toolCalls.find(tc => tc.id === delta.id)
      if (toolCall) {
        toolCall.input = delta.input
      }
    } else if (delta.type === 'usage') {
      usage.inputTokens += delta.inputTokens
      usage.outputTokens += delta.outputTokens
      usage.cacheCreationInputTokens += delta.cacheCreationInputTokens ?? 0
      usage.cacheReadInputTokens += delta.cacheReadInputTokens ?? 0
      yield {
        type: 'usage',
        ...eventBase(options.sessionId),
        inputTokens: delta.inputTokens,
        outputTokens: delta.outputTokens,
        cacheCreationInputTokens: delta.cacheCreationInputTokens,
        cacheReadInputTokens: delta.cacheReadInputTokens,
      }
    } else if (delta.type === 'finish') {
      finishReason = delta.reason
    }
  }

  if (options.memoryCapabilityAnswerLeakGuard && memoryCapabilityAnswerBuffer) {
    memoryCapabilityAnswerLeakSuppression = detectMemoryCapabilityAnswerLeak(memoryCapabilityAnswerBuffer)
    if (!memoryCapabilityAnswerLeakSuppression) {
      assistantText += memoryCapabilityAnswerBuffer
      yield {
        type: 'assistant_delta',
        ...eventBase(options.sessionId),
        text: memoryCapabilityAnswerBuffer,
      }
    }
  } else if (options.toolCallTextLeakGuard && guardedTextBuffer && !textLeakSuppression) {
    assistantText += guardedTextBuffer
    yield {
      type: 'assistant_delta',
      ...eventBase(options.sessionId),
      text: guardedTextBuffer,
    }
  }

  return {
    assistantText,
    reasoningText,
    finishReason,
    toolCalls,
    toolCallTextLeakSuppression: textLeakSuppression,
    memoryCapabilityAnswerLeakSuppression,
    durationMs: performance.now() - queryStartMs,
    turnFirstTokenMs,
    providerFirstTokenMs,
    streamDeltaCount,
    charsOut,
    usage,
  }
}

function detectToolCallTextLeak(text: string, phase: ToolCallTextLeakPhase): ToolCallTextLeakSuppression | undefined {
  const normalized = text.toLowerCase()
  const patterns = [
    '<tool_call',
    '</tool_call>',
    '<invoke name=',
    '</invoke>',
    '<minimax:tool_call',
    '</minimax:tool_call>',
    '"tool_calls"',
    '"function_call"',
    'call_tool ',
  ]
  const pattern = patterns.find(candidate => normalized.includes(candidate))
  if (!pattern) return undefined
  return {
    phase,
    pattern,
    redactedPreview: redactToolCallTextPreview(text),
  }
}

function redactToolCallTextPreview(text: string): string {
  return text
    .replace(/<command>[\s\S]*?<\/command>/gi, '<command>[REDACTED]</command>')
    .replace(/"arguments"\s*:\s*"(?:\\.|[^"\\])*"/gi, '"arguments":"[REDACTED]"')
    .replace(/"command"\s*:\s*"(?:\\.|[^"\\])*"/gi, '"command":"[REDACTED]"')
    .slice(0, 300)
}

function detectMemoryCapabilityAnswerLeak(text: string): MemoryCapabilityAnswerLeakSuppression | undefined {
  const patterns: Array<[string, RegExp]> = [
    ['source_path', /\b(?:src|test|docs)\/[A-Za-z0-9_./-]+/u],
    ['commit_hash', /\b[0-9a-f]{7,40}\b/iu],
    ['hidden_prompt', /\b(hidden prompt|system prompt|provider-visible|provider prompt|内通|隐藏提示)\b/iu],
    ['mcp_sidecar_internal', /\b(MCP|sidecar|MemoryProvider|EverCoreMemoryProvider|configureEverCoreFromEnv|memory_save_note)\b/u],
    ['secret_like', /\b(API key|apiKey|secret|token|provider key)\b/iu],
  ]
  const hit = patterns.find(([, pattern]) => pattern.test(text))
  if (!hit) return undefined
  return {
    pattern: hit[0],
    redactedPreview: text.slice(0, 300),
  }
}
