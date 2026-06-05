import { performance } from 'node:perf_hooks'
import { eventBase, type NexusEvent } from '../shared/events.js'
import type { RemoteToolRunnerDiagnostics } from '../shared/toolTrace.js'
import type {
  ContentBlock,
  FinishReason,
  ModelMessage,
  ModelQueryParams,
  ModelToolDefinition,
  StreamDelta,
} from '../providers/adapters/ModelAdapter.js'
import type { RuntimeExecuteOptions } from './Runtime.js'
import type { AssembledContext, ContextAssemblerOptions } from './contextAssembler.js'
import { assembleContext } from './contextAssembler.js'
import { getAutoCompactDecision, type AutoCompactDecision } from './compact.js'
import {
  buildCacheAwareCompactPolicy,
  computeSystemPromptCacheableRatio,
  summarizeCacheAwareUsage,
  type CacheAwareCompactPolicy,
  type CacheAwareCompactUsage,
} from './cacheAwareCompactPolicy.js'
import { computePrefixCacheDiagnostics, type PrefixCacheDiagnostics } from './prefixCache.js'
import { normalizeMessages } from './messageNormalizer.js'
import type { UserIntentGuidance } from './intentGuidance.js'
import { buildProviderFallbackPolicy } from './providerRecovery.js'
import { estimateContextTokens, getContextWindowState, type ContextWindowState } from './tokenEstimator.js'

export type LocalRuntimeParsedIntent =
  | { kind: 'tool'; toolName: string; input: unknown }
  | { kind: 'file_question'; path: string; question: string }
  | { kind: 'task_status' }
  | { kind: 'task_update'; selector: string; status: 'pending' | 'in_progress' | 'completed' | 'failed'; result?: string }
  | { kind: 'text'; text: string }

export type RuntimeExecutionMetrics = {
  executionStartMs: number
  providerFirstTokenMs?: number
  providerRequestDurationMs: number
  streamDeltaCount: number
  toolCallCount: number
  toolRoundtripDurationMs: number
  contextCharsIn: number
  contextCharsOut: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  modelContextWindow?: number
  reservedOutputTokens?: number
  providerSafetyBufferTokens?: number
  effectiveContextCeiling?: number
  legacyContextCeiling?: number
  envMaxContextTokens?: number
  contextPolicySource?: 'legacy' | 'large_context' | 'env_cap'
  contextWarningThresholdPercent?: number
  contextCompactThresholdPercent?: number
  contextWarningThresholdTokens?: number
  contextCompactThresholdTokens?: number
  contextBlockingLimitTokens?: number
  cacheReadRatio?: number
  cachePreservationMode?: boolean
  longContextUtilizationMode?: boolean
  prefixCacheImmutableRatio?: number
  prefixCacheVolatileContentLast?: boolean
  prefixCacheFingerprint?: string
  compactSummaryLatencyMs?: number
  toolCallTextLeakSuppressedCount: number
  finalAnswerRetryCount: number
  toolShapedTextPattern?: string
  remoteToolCallCount: number
  remoteToolRunnerDurationMs: number
}

export type RuntimeProviderToolCall = {
  id: string
  name: string
  partialInput: string
  input?: unknown
}

export type ToolCallTextLeakPhase = 'respond_only' | 'tools_hidden' | 'final_response_only' | 'max_loop' | 'unknown'

export type ToolCallTextLeakSuppression = {
  phase: ToolCallTextLeakPhase
  pattern: string
  redactedPreview: string
}

export type RuntimeProviderTurn = {
  assistantText: string
  reasoningText: string
  finishReason?: FinishReason
  toolCalls: RuntimeProviderToolCall[]
  toolCallTextLeakSuppression?: ToolCallTextLeakSuppression
  durationMs: number
  turnFirstTokenMs?: number
  providerFirstTokenMs?: number
  streamDeltaCount: number
  charsOut: number
  usage: CacheAwareCompactUsage
}

export function resolveProviderToolCallInput(toolCall: RuntimeProviderToolCall): unknown {
  if (toolCall.input !== undefined) return toolCall.input
  if (!toolCall.partialInput) return undefined
  try {
    return JSON.parse(toolCall.partialInput)
  } catch {
    return {}
  }
}

export function buildProviderAssistantMessage(turn: Pick<RuntimeProviderTurn, 'assistantText' | 'reasoningText' | 'toolCalls'>): ModelMessage {
  const assistantContent: ContentBlock[] = []
  if (turn.assistantText) {
    assistantContent.push({ type: 'text', text: turn.assistantText })
  }
  for (const toolCall of turn.toolCalls) {
    assistantContent.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.name,
      input: resolveProviderToolCallInput(toolCall),
    })
  }

  return {
    role: 'assistant',
    content: assistantContent.length > 0 ? assistantContent : turn.assistantText,
    ...(turn.reasoningText.trim() && { reasoningContent: turn.reasoningText }),
  }
}

export function buildProviderToolResultsMessage(content: ContentBlock[]): ModelMessage {
  return {
    role: 'user',
    content,
  }
}

export function buildRuntimeResultEvent(
  sessionId: string,
  success: boolean,
  message: string,
): Extract<NexusEvent, { type: 'result' }> {
  return {
    type: 'result',
    ...eventBase(sessionId),
    success,
    message,
  }
}

export function buildRuntimeErrorEvent(options: {
  sessionId: string
  code: string
  message: string
  details?: unknown
}): Extract<NexusEvent, { type: 'error' }> {
  return {
    type: 'error',
    ...eventBase(options.sessionId),
    code: options.code,
    message: options.message,
    ...(options.details !== undefined && { details: options.details }),
  }
}

export function buildToolCallTextLeakSuppressedEvent(options: {
  sessionId: string
  providerId?: string
  modelId?: string
  suppression: ToolCallTextLeakSuppression
  retryAttempted: boolean
  retrySucceeded?: boolean
}): Extract<NexusEvent, { type: 'error' }> {
  return buildRuntimeErrorEvent({
    sessionId: options.sessionId,
    code: 'TOOL_CALL_TEXT_LEAK_SUPPRESSED',
    message: 'Suppressed tool-call-shaped assistant text while tools are unavailable for this turn.',
    details: {
      providerId: options.providerId,
      modelId: options.modelId,
      phase: options.suppression.phase,
      pattern: options.suppression.pattern,
      redactedPreview: options.suppression.redactedPreview,
      retryAttempted: options.retryAttempted,
      ...(options.retrySucceeded !== undefined && { retrySucceeded: options.retrySucceeded }),
    },
  })
}

export function buildContextWarningEvent(options: {
  sessionId: string
  modelId: string
  windowState: ContextWindowState
  thresholdPercent: number
  message: string
  cacheAwareCompactPolicy?: CacheAwareCompactPolicy
}): Extract<NexusEvent, { type: 'context_warning' }> {
  return {
    type: 'context_warning',
    ...eventBase(options.sessionId),
    modelId: options.modelId,
    tokenEstimate: options.windowState.tokenEstimate,
    maxTokens: options.windowState.maxTokens,
    percentUsed: options.windowState.percentUsed,
    thresholdPercent: options.thresholdPercent,
    ...contextPolicyEventFields(options.cacheAwareCompactPolicy),
    message: options.message,
  }
}

export function buildContextBlockingEvent(options: {
  sessionId: string
  modelId: string
  windowState: ContextWindowState
  message?: string
  cacheAwareCompactPolicy?: CacheAwareCompactPolicy
}): Extract<NexusEvent, { type: 'context_blocking' }> {
  const message = options.message ?? buildContextBlockingMessage(options.windowState)
  return {
    type: 'context_blocking',
    ...eventBase(options.sessionId),
    modelId: options.modelId,
    tokenEstimate: options.windowState.tokenEstimate,
    maxTokens: options.windowState.maxTokens,
    percentUsed: options.windowState.percentUsed,
    warningThresholdTokens: options.windowState.warningThresholdTokens,
    compactThresholdTokens: options.windowState.compactThresholdTokens,
    blockingLimitTokens: options.windowState.blockingLimitTokens,
    ...contextPolicyEventFields(options.cacheAwareCompactPolicy),
    httpStatus: 413,
    recoveryActions: ['compact', 'context', 'switch_model', 'reduce_tool_output'],
    message,
  }
}

export function buildContextBlockingErrorDetails(
  event: Extract<NexusEvent, { type: 'context_blocking' }>,
): Record<string, unknown> {
  return {
    kind: 'context_window',
    recoveryReason: 'CONTEXT_BLOCKING_LIMIT',
    retryable: true,
    httpStatus: event.httpStatus,
    tokenEstimate: event.tokenEstimate,
    maxTokens: event.maxTokens,
    blockingLimitTokens: event.blockingLimitTokens,
    contextPolicy: contextPolicyErrorDetails(event),
    recoveryActions: event.recoveryActions,
    suggestion: 'Run /compact or /context, switch to a larger context model, or reduce tool output before retrying.',
    fallbackPolicy: buildProviderFallbackPolicy('context_window'),
  }
}

export function buildContextBlockingEvents(options: {
  sessionId: string
  modelId: string
  windowState: ContextWindowState
  thresholdPercent: number
  message?: string
  cacheAwareCompactPolicy?: CacheAwareCompactPolicy
}): NexusEvent[] {
  const message = options.message ?? buildContextBlockingMessage(options.windowState)
  const blockingEvent = buildContextBlockingEvent({
    sessionId: options.sessionId,
    modelId: options.modelId,
    windowState: options.windowState,
    message,
    cacheAwareCompactPolicy: options.cacheAwareCompactPolicy,
  })
  return [
    buildContextWarningEvent({
      sessionId: options.sessionId,
      modelId: options.modelId,
      windowState: options.windowState,
      thresholdPercent: options.thresholdPercent,
      message,
      cacheAwareCompactPolicy: options.cacheAwareCompactPolicy,
    }),
    blockingEvent,
    buildRuntimeErrorEvent({
      sessionId: options.sessionId,
      code: 'CONTEXT_LIMIT_EXCEEDED',
      message,
      details: buildContextBlockingErrorDetails(blockingEvent),
    }),
    buildRuntimeResultEvent(options.sessionId, false, message),
  ]
}

export function buildContextBlockingMessage(windowState: ContextWindowState): string {
  return `Context estimate ${windowState.tokenEstimate}/${windowState.maxTokens} tokens exceeds the blocking limit (${windowState.blockingLimitTokens}). Run /compact or /context before continuing.`
}

function contextPolicyEventFields(policy: CacheAwareCompactPolicy | undefined) {
  if (!policy) return {}
  return {
    modelContextWindow: policy.modelContextWindow,
    reservedOutputTokens: policy.reservedOutputTokens,
    providerSafetyBufferTokens: policy.providerSafetyBufferTokens,
    effectiveContextCeiling: policy.effectiveContextCeiling,
    legacyContextCeiling: policy.legacyContextCeiling,
    envMaxContextTokens: policy.envMaxContextTokens,
    contextPolicySource: policy.policySource,
  }
}

function contextPolicyErrorDetails(event: Extract<NexusEvent, { type: 'context_blocking' }>) {
  return {
    modelContextWindow: event.modelContextWindow,
    reservedOutputTokens: event.reservedOutputTokens,
    providerSafetyBufferTokens: event.providerSafetyBufferTokens,
    effectiveContextCeiling: event.effectiveContextCeiling,
    legacyContextCeiling: event.legacyContextCeiling,
    envMaxContextTokens: event.envMaxContextTokens,
    source: event.contextPolicySource,
  }
}

export type RuntimeContextRefreshState = {
  assembledContext: AssembledContext
  messages: ModelMessage[]
  currentToolsList: ModelToolDefinition[]
  modelVisibleTools: ModelToolDefinition[]
  contextEstimateTokens: number
  contextWindowState: ContextWindowState
  autoCompactDecision: AutoCompactDecision
  cacheAwareCompactPolicy: CacheAwareCompactPolicy
}

export function buildRuntimeContextRefreshState(options: {
  assembledContext: AssembledContext
  events: NexusEvent[]
  tools: ModelToolDefinition[]
  modelId: string
  warningPercent: number
  compactPercent: number
  maxOutputTokens?: number
  suppressToolsForUserIntent: boolean
}): RuntimeContextRefreshState {
  const messages = options.assembledContext.messages
  const currentToolsList = options.tools
  const modelVisibleTools = options.suppressToolsForUserIntent ? [] : currentToolsList
  const contextEstimateTokens = estimateContextTokens({
    systemPrompt: options.assembledContext.systemPrompt,
    messages,
    tools: modelVisibleTools,
    conservative: true,
  }).totalTokens
  const cacheAwareCompactPolicy = buildCacheAwareCompactPolicy({
    modelId: options.modelId,
    tokenEstimate: contextEstimateTokens,
    usage: summarizeCacheAwareUsage(options.events),
    cacheableSystemPromptRatio: computeSystemPromptCacheableRatio(options.assembledContext.systemPromptBlocks),
    warningPercent: options.warningPercent,
    compactPercent: options.compactPercent,
    maxOutputTokens: options.maxOutputTokens,
    providerContextError: hasRecentProviderContextError(options.events),
  })
  const contextWindowState = getContextWindowState({
    tokenEstimate: contextEstimateTokens,
    maxTokens: cacheAwareCompactPolicy.effectiveContextCeiling,
    warningPercent: cacheAwareCompactPolicy.warningThresholdPercent,
    compactPercent: cacheAwareCompactPolicy.compactThresholdPercent,
  })
  const autoCompactDecision = getAutoCompactDecision({
    events: options.events,
    tokenEstimate: contextEstimateTokens,
    maxTokens: cacheAwareCompactPolicy.effectiveContextCeiling,
    thresholdPercent: cacheAwareCompactPolicy.compactThresholdPercent,
  })

  return {
    assembledContext: options.assembledContext,
    messages,
    currentToolsList,
    modelVisibleTools,
    contextEstimateTokens,
    contextWindowState,
    autoCompactDecision,
    cacheAwareCompactPolicy,
  }
}

export async function refreshRuntimeContextState(options: ContextAssemblerOptions & {
  tools: () => ModelToolDefinition[]
  warningPercent: number
  compactPercent: number
  suppressToolsForIntent: (guidance: UserIntentGuidance) => boolean
}): Promise<RuntimeContextRefreshState> {
  const assembledContext = await assembleContext({
    runtimeOptions: options.runtimeOptions,
    events: options.events,
    modelId: options.modelId,
    buildSystemPrompt: options.buildSystemPrompt,
    mapEventsToMessages: options.mapEventsToMessages,
  })

  return buildRuntimeContextRefreshState({
    assembledContext,
    events: options.events,
    tools: options.tools(),
    modelId: options.modelId,
    warningPercent: options.warningPercent,
    compactPercent: options.compactPercent,
    maxOutputTokens: options.runtimeOptions.maxOutputTokens,
    suppressToolsForUserIntent: options.suppressToolsForIntent(assembledContext.userIntentGuidance),
  })
}

type RuntimeProviderTurnOutcomeBase = {
  messages: ModelMessage[]
  eventsBeforeMessages: NexusEvent[]
  eventsAfterMessages: NexusEvent[]
  maxTokenRecoveryCount: number
  outputRetryCount: number
}

export type RuntimeProviderTurnOutcome =
  | (RuntimeProviderTurnOutcomeBase & { kind: 'continue' })
  | (RuntimeProviderTurnOutcomeBase & { kind: 'terminal'; queueSessionMemoryLiteUpdate?: boolean })
  | (RuntimeProviderTurnOutcomeBase & { kind: 'tool_calls'; toolCalls: RuntimeProviderToolCall[] })

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
}): RuntimeProviderTurnOutcome {
  const { turn } = options
  const baseCounts = {
    maxTokenRecoveryCount: options.maxTokenRecoveryCount,
    outputRetryCount: options.outputRetryCount,
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

  if (options.suppressToolsForUserIntent && turn.toolCalls.length > 0) {
    const attemptedTools = turn.toolCalls.map(toolCall => toolCall.name).join(', ')
    const message = `Runtime suppressed provider tool calls for respond-only user intent: ${attemptedTools}.`
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
          },
        }),
      ],
      eventsAfterMessages: [],
      messages: [{
        role: 'user',
        content: `${message}\nAnswer the latest user message directly using existing context. Do not call tools.`,
      }],
      ...baseCounts,
    }
  }

  const assistantMessage = buildProviderAssistantMessage(turn)
  if (turn.toolCalls.length === 0) {
    if (turn.assistantText.trim().length === 0) {
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

export function createRuntimeExecutionMetrics(): RuntimeExecutionMetrics {
  return {
    executionStartMs: performance.now(),
    providerRequestDurationMs: 0,
    streamDeltaCount: 0,
    toolCallCount: 0,
    toolRoundtripDurationMs: 0,
    contextCharsIn: 0,
    contextCharsOut: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    toolCallTextLeakSuppressedCount: 0,
    finalAnswerRetryCount: 0,
    remoteToolCallCount: 0,
    remoteToolRunnerDurationMs: 0,
  }
}

export function buildRuntimeExecutionMetricsEvent(
  options: Pick<RuntimeExecuteOptions, 'sessionId' | 'requestId'>,
  metrics: RuntimeExecutionMetrics,
  format: { provider?: boolean; context?: boolean } = {},
): Extract<NexusEvent, { type: 'execution_metrics' }> {
  const includeProvider = format.provider ?? true
  const includeContext = format.context ?? true
  return {
    type: 'execution_metrics',
    ...eventBase(options.sessionId),
    requestId: options.requestId,
    executeDurationMs: performance.now() - metrics.executionStartMs,
    providerFirstTokenMs: includeProvider ? metrics.providerFirstTokenMs : undefined,
    providerRequestDurationMs: includeProvider ? metrics.providerRequestDurationMs : undefined,
    streamDeltaCount: includeProvider ? metrics.streamDeltaCount : undefined,
    toolCallCount: metrics.toolCallCount,
    toolRoundtripDurationMs: metrics.toolRoundtripDurationMs,
    contextCharsIn: includeContext ? metrics.contextCharsIn : undefined,
    contextCharsOut: includeContext ? metrics.contextCharsOut : undefined,
    inputTokens: includeProvider ? metrics.inputTokens : undefined,
    outputTokens: includeProvider ? metrics.outputTokens : undefined,
    cacheCreationInputTokens: includeProvider ? metrics.cacheCreationInputTokens : undefined,
    cacheReadInputTokens: includeProvider ? metrics.cacheReadInputTokens : undefined,
    modelContextWindow: includeContext ? metrics.modelContextWindow : undefined,
    reservedOutputTokens: includeContext ? metrics.reservedOutputTokens : undefined,
    providerSafetyBufferTokens: includeContext ? metrics.providerSafetyBufferTokens : undefined,
    effectiveContextCeiling: includeContext ? metrics.effectiveContextCeiling : undefined,
    legacyContextCeiling: includeContext ? metrics.legacyContextCeiling : undefined,
    envMaxContextTokens: includeContext ? metrics.envMaxContextTokens : undefined,
    contextPolicySource: includeContext ? metrics.contextPolicySource : undefined,
    contextWarningThresholdPercent: includeContext ? metrics.contextWarningThresholdPercent : undefined,
    contextCompactThresholdPercent: includeContext ? metrics.contextCompactThresholdPercent : undefined,
    contextWarningThresholdTokens: includeContext ? metrics.contextWarningThresholdTokens : undefined,
    contextCompactThresholdTokens: includeContext ? metrics.contextCompactThresholdTokens : undefined,
    contextBlockingLimitTokens: includeContext ? metrics.contextBlockingLimitTokens : undefined,
    cacheReadRatio: includeProvider ? metrics.cacheReadRatio : undefined,
    cachePreservationMode: includeContext ? metrics.cachePreservationMode : undefined,
    longContextUtilizationMode: includeContext ? metrics.longContextUtilizationMode : undefined,
    prefixCacheImmutableRatio: includeContext ? metrics.prefixCacheImmutableRatio : undefined,
    prefixCacheVolatileContentLast: includeContext ? metrics.prefixCacheVolatileContentLast : undefined,
    prefixCacheFingerprint: includeContext ? metrics.prefixCacheFingerprint : undefined,
    compactSummaryLatencyMs: metrics.compactSummaryLatencyMs,
    toolCallTextLeakSuppressedCount: metrics.toolCallTextLeakSuppressedCount > 0 ? metrics.toolCallTextLeakSuppressedCount : undefined,
    finalAnswerRetryCount: metrics.finalAnswerRetryCount > 0 ? metrics.finalAnswerRetryCount : undefined,
    toolShapedTextPattern: metrics.toolShapedTextPattern,
    remoteToolCallCount: metrics.remoteToolCallCount > 0 ? metrics.remoteToolCallCount : undefined,
    remoteToolRunnerDurationMs: metrics.remoteToolCallCount > 0 ? metrics.remoteToolRunnerDurationMs : undefined,
  }
}

export function absorbProviderTurnMetrics(
  metrics: RuntimeExecutionMetrics,
  turn: RuntimeProviderTurn,
): void {
  if (metrics.providerFirstTokenMs === undefined && turn.providerFirstTokenMs !== undefined) {
    metrics.providerFirstTokenMs = turn.providerFirstTokenMs
  }
  metrics.providerRequestDurationMs += turn.durationMs
  metrics.streamDeltaCount += turn.streamDeltaCount
  metrics.contextCharsOut += turn.charsOut
  metrics.inputTokens += turn.usage.inputTokens
  metrics.outputTokens += turn.usage.outputTokens
  metrics.cacheCreationInputTokens += turn.usage.cacheCreationInputTokens
  metrics.cacheReadInputTokens += turn.usage.cacheReadInputTokens
  metrics.cacheReadRatio = computeMetricsCacheReadRatio(metrics)
}

export function absorbCacheAwareCompactPolicyMetrics(
  metrics: RuntimeExecutionMetrics,
  policy: CacheAwareCompactPolicy,
): void {
  metrics.modelContextWindow = policy.modelContextWindow
  metrics.reservedOutputTokens = policy.reservedOutputTokens
  metrics.providerSafetyBufferTokens = policy.providerSafetyBufferTokens
  metrics.effectiveContextCeiling = policy.effectiveContextCeiling
  metrics.legacyContextCeiling = policy.legacyContextCeiling
  metrics.envMaxContextTokens = policy.envMaxContextTokens
  metrics.contextPolicySource = policy.policySource
  metrics.contextWarningThresholdPercent = policy.warningThresholdPercent
  metrics.contextCompactThresholdPercent = policy.compactThresholdPercent
  metrics.contextWarningThresholdTokens = policy.warningThresholdTokens
  metrics.contextCompactThresholdTokens = policy.compactThresholdTokens
  metrics.contextBlockingLimitTokens = policy.blockingLimitTokens
  metrics.cacheReadRatio = policy.cacheReadRatio
  metrics.cachePreservationMode = policy.cachePreservationMode
  metrics.longContextUtilizationMode = policy.longContextUtilizationMode
}

export function absorbPrefixCacheDiagnosticsMetrics(
  metrics: RuntimeExecutionMetrics,
  diagnostics: PrefixCacheDiagnostics,
): void {
  metrics.prefixCacheImmutableRatio = diagnostics.immutablePrefixRatio
  metrics.prefixCacheVolatileContentLast = diagnostics.volatileContentLast
  metrics.prefixCacheFingerprint = diagnostics.fingerprint
}

export function absorbCompactSummaryLatencyMetrics(
  metrics: RuntimeExecutionMetrics,
  latencyMs: number,
): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return
  metrics.compactSummaryLatencyMs = (metrics.compactSummaryLatencyMs ?? 0) + latencyMs
}

export function absorbRemoteToolRunnerMetrics(
  metrics: RuntimeExecutionMetrics,
  diagnostics: RemoteToolRunnerDiagnostics | undefined,
): void {
  if (!diagnostics) return
  metrics.remoteToolCallCount += 1
  if (diagnostics.durationMs !== undefined && Number.isFinite(diagnostics.durationMs) && diagnostics.durationMs >= 0) {
    metrics.remoteToolRunnerDurationMs += diagnostics.durationMs
  }
}

function computeMetricsCacheReadRatio(metrics: RuntimeExecutionMetrics): number {
  const denominator = metrics.inputTokens + metrics.cacheCreationInputTokens + metrics.cacheReadInputTokens
  if (denominator <= 0) return 0
  return Math.max(0, Math.min(1, metrics.cacheReadInputTokens / denominator))
}

export type RuntimeProviderLoopState = {
  finalResponseOnlyMode: boolean
  turnContextCharsIn: number
  executionStateBlock: string
}

export type RuntimeProviderLoopRequestState = RuntimeProviderLoopState & {
  currentToolsList: ModelToolDefinition[]
  modelVisibleTools: ModelToolDefinition[]
  contextWindowState: ContextWindowState
}

export function buildProviderLoopRequestState(options: {
  loopCount: number
  maxLoops: number
  readFileCache: Map<string, { mtime: number; size: number }>
  toolCallCount: number
  systemPrompt: string
  messages: ModelMessage[]
  currentToolsList: ModelToolDefinition[]
  contextMaxTokens: number
  warningPercent: number
  compactPercent: number
  suppressToolsForUserIntent: boolean
  cacheAwareCompactPolicy?: CacheAwareCompactPolicy
  finalResponseOnlyMode?: boolean
  finalResponseOnlyRemainingLoops?: number
}): RuntimeProviderLoopRequestState {
  const finalResponseOnlyMode = options.finalResponseOnlyMode ?? shouldEnterFinalResponseOnlyMode({
    loopCount: options.loopCount,
    maxLoops: options.maxLoops,
    remainingLoops: options.finalResponseOnlyRemainingLoops,
  })
  const modelVisibleTools = finalResponseOnlyMode || options.suppressToolsForUserIntent
    ? []
    : options.currentToolsList
  const contextTokenEstimate = estimateContextTokens({
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    tools: modelVisibleTools,
    conservative: true,
  }).totalTokens
  const contextWindowState = getContextWindowState({
    tokenEstimate: contextTokenEstimate,
    maxTokens: options.cacheAwareCompactPolicy?.effectiveContextCeiling ?? options.contextMaxTokens,
    warningPercent: options.cacheAwareCompactPolicy?.warningThresholdPercent ?? options.warningPercent,
    compactPercent: options.cacheAwareCompactPolicy?.compactThresholdPercent ?? options.compactPercent,
  })
  const loopState = buildProviderLoopState({
    loopCount: options.loopCount,
    maxLoops: options.maxLoops,
    readFileCache: options.readFileCache,
    toolCallCount: options.toolCallCount,
    contextTokenEstimate: contextWindowState.tokenEstimate,
    contextMaxTokens: contextWindowState.maxTokens,
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    finalResponseOnlyMode,
    finalResponseOnlyRemainingLoops: options.finalResponseOnlyRemainingLoops,
  })

  return {
    ...loopState,
    currentToolsList: options.currentToolsList,
    modelVisibleTools,
    contextWindowState,
  }
}

export function buildProviderQueryParams(options: {
  modelId: string
  systemPrompt: string
  systemPromptBlocks?: { text: string; cacheable: boolean }[]
  executionStateBlock: string
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
  maxTokens?: number
  providerId: string
  thinkingBudget?: number
}): ModelQueryParams {
  const systemPromptBlocks = buildProviderSystemPromptBlocks(options.systemPromptBlocks, options.executionStateBlock)
  return {
    model: options.modelId,
    systemPrompt: options.systemPrompt,
    systemPromptBlocks,
    messages: normalizeMessages(options.messages),
    tools: options.tools,
    maxTokens: options.maxTokens,
    enablePromptCaching: options.providerId === 'anthropic',
    ...(options.thinkingBudget !== undefined &&
      options.thinkingBudget > 0 && {
        thinking: { budgetTokens: options.thinkingBudget },
      }),
  }
}

export function buildProviderSystemPromptBlocks(
  systemPromptBlocks: { text: string; cacheable: boolean }[] | undefined,
  executionStateBlock: string,
): { text: string; cacheable: boolean }[] {
  return [
    ...(systemPromptBlocks ?? []),
    { text: executionStateBlock, cacheable: false },
  ]
}

export function computeProviderPrefixCacheDiagnostics(options: {
  systemPromptBlocks?: { text: string; cacheable: boolean }[]
  executionStateBlock: string
  tools: ModelToolDefinition[]
}): PrefixCacheDiagnostics {
  return computePrefixCacheDiagnostics({
    systemPromptBlocks: buildProviderSystemPromptBlocks(options.systemPromptBlocks, options.executionStateBlock),
    tools: options.tools,
  })
}

export function buildRuntimeContextBlockingEventsForLoop(options: {
  sessionId: string
  modelId: string
  windowState: ContextWindowState
  autoCompactDecision: AutoCompactDecision
  fallbackThresholdPercent: number
  cacheAwareCompactPolicy?: CacheAwareCompactPolicy
}): NexusEvent[] {
  return buildContextBlockingEvents({
    sessionId: options.sessionId,
    modelId: options.modelId,
    windowState: options.windowState,
    thresholdPercent: options.autoCompactDecision.enabled
      ? options.autoCompactDecision.thresholdPercent
      : options.fallbackThresholdPercent,
    cacheAwareCompactPolicy: options.cacheAwareCompactPolicy,
  })
}

function hasRecentProviderContextError(events: NexusEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue
    if (event.type === 'compact_boundary') return false
    if (event.type !== 'error') continue
    if (event.code === 'CONTEXT_LIMIT_EXCEEDED') return true
    const text = `${event.code} ${event.message}`.toLowerCase()
    if (text.includes('context') && (text.includes('too long') || text.includes('limit') || text.includes('window'))) return true
  }
  return false
}

export function buildProviderLoopState(options: {
  loopCount: number
  maxLoops: number
  readFileCache: Map<string, { mtime: number; size: number }>
  toolCallCount: number
  contextTokenEstimate: number
  contextMaxTokens: number
  systemPrompt: string
  messages: ModelMessage[]
  finalResponseOnlyMode?: boolean
  finalResponseOnlyRemainingLoops?: number
}): RuntimeProviderLoopState {
  const finalResponseOnlyMode = options.finalResponseOnlyMode ?? shouldEnterFinalResponseOnlyMode({
    loopCount: options.loopCount,
    maxLoops: options.maxLoops,
    remainingLoops: options.finalResponseOnlyRemainingLoops,
  })
  return {
    finalResponseOnlyMode,
    turnContextCharsIn: countRuntimeTurnContextChars({
      systemPrompt: options.systemPrompt,
      messages: options.messages,
    }),
    executionStateBlock: buildRuntimeExecutionStateBlock({
      loopCount: options.loopCount,
      maxLoops: options.maxLoops,
      readFileCache: options.readFileCache,
      toolCallCount: options.toolCallCount,
      contextTokenEstimate: options.contextTokenEstimate,
      contextMaxTokens: options.contextMaxTokens,
      finalResponseOnlyMode,
      finalResponseOnlyRemainingLoops: options.finalResponseOnlyRemainingLoops,
    }),
  }
}

export function shouldEnterFinalResponseOnlyMode(options: {
  loopCount: number
  maxLoops: number
  remainingLoops?: number
}): boolean {
  return options.maxLoops - options.loopCount <= (options.remainingLoops ?? 3)
}

export function countRuntimeTurnContextChars(options: {
  systemPrompt: string
  messages: ModelMessage[]
}): number {
  let chars = options.systemPrompt.length
  for (const msg of options.messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          chars += block.text.length
        } else if (block.type === 'tool_result') {
          chars += block.content.length
        }
      }
    }
  }
  return chars
}

export function buildRuntimeExecutionStateBlock(state: {
  loopCount: number
  maxLoops: number
  readFileCache: Map<string, { mtime: number; size: number }>
  toolCallCount: number
  contextTokenEstimate: number
  contextMaxTokens: number
  finalResponseOnlyMode?: boolean
  finalResponseOnlyRemainingLoops?: number
}): string {
  const filesRead = [...state.readFileCache.keys()]
  const remaining = state.maxLoops - state.loopCount
  const pctUsed = state.contextMaxTokens > 0 ? Math.round(state.contextTokenEstimate / state.contextMaxTokens * 100) : 0
  let phase = 'gathering'
  if (state.finalResponseOnlyMode || remaining <= (state.finalResponseOnlyRemainingLoops ?? 3)) phase = 'must_respond'
  else if (state.toolCallCount >= 10) phase = 'synthesize'

  const lines = [
    `## Execution State (iteration ${state.loopCount}/${state.maxLoops})`,
    `- Files read: ${filesRead.length > 0 ? filesRead.join(', ') : 'none'}`,
    `- Tool calls: ${state.toolCallCount} | Remaining iterations: ${remaining}`,
    `- Context: ${Math.round(state.contextTokenEstimate / 1000)}K/${Math.round(state.contextMaxTokens / 1000)}K tokens (${pctUsed}%)`,
    `- Phase: ${phase}`,
  ]
  if (phase === 'synthesize') {
    lines.push('  → Present your findings now. Only read more if critical information is missing.')
  } else if (phase === 'must_respond') {
    lines.push('  → Runtime has hidden all tools for this request. You MUST produce your final answer immediately.')
  }
  return lines.join('\n')
}

export function parseLocalRuntimeIntent(prompt: string): LocalRuntimeParsedIntent {
  const trimmed = prompt.trim()
  const [verb = '', ...rest] = splitCommand(trimmed)
  const arg = rest.join(' ')

  if (verb.includes(':') && arg) {
    try {
      return {
        kind: 'tool',
        toolName: verb,
        input: JSON.parse(arg),
      }
    } catch {
      return {
        kind: 'tool',
        toolName: verb,
        input: {},
      }
    }
  }

  if (verb === 'read' && arg) {
    return { kind: 'tool', toolName: 'Read', input: { path: arg } }
  }
  if (verb === 'write' && rest.length >= 2) {
    const [path, ...content] = rest
    return {
      kind: 'tool',
      toolName: 'Write',
      input: { path, content: content.join(' ') },
    }
  }
  if (verb === 'edit' && rest.length >= 3) {
    const [path, oldString, ...newString] = rest
    return {
      kind: 'tool',
      toolName: 'Edit',
      input: { path, oldString, newString: newString.join(' ') },
    }
  }
  if (verb === 'grep' && arg) {
    return { kind: 'tool', toolName: 'Grep', input: { pattern: arg } }
  }
  if (verb === 'glob' && arg) {
    return { kind: 'tool', toolName: 'Glob', input: { pattern: arg } }
  }
  if (verb === 'bash' && arg) {
    return { kind: 'tool', toolName: 'Bash', input: { command: arg } }
  }
  if (verb === 'task' && rest[0] === 'status') {
    return { kind: 'task_status' }
  }
  if (verb === 'task' && rest[0] === 'update' && rest.length >= 3) {
    const [, selector, status, ...resultParts] = rest
    if (isSupportedTaskUpdateStatus(status)) {
      return {
        kind: 'task_update',
        selector,
        status,
        result: resultParts.length > 0 ? resultParts.join(' ') : undefined,
      }
    }
  }
  if (verb === 'task' && arg) {
    return { kind: 'tool', toolName: 'TaskCreate', input: { title: arg } }
  }

  const fileQuestionPath = extractFileQuestionPath(trimmed)
  if (fileQuestionPath) {
    return { kind: 'file_question', path: fileQuestionPath, question: trimmed }
  }

  return {
    kind: 'text',
    text:
      `BabeL-O local runtime is active. I can already run explicit coding tools: ` +
      '`read <file>`, `write <file> <text>`, `edit <file> <old> <new>`, ' +
      '`grep <pattern>`, `glob <pattern>`, `bash <command>`, `task <title>`. ' +
      `You said: ${trimmed || '(empty prompt)'}`,
  }
}

export async function* streamProviderTurn(options: {
  stream: AsyncIterable<StreamDelta>
  sessionId: string
  signal?: AbortSignal
  executionStartMs?: number
  queryStartMs?: number
  toolCallTextLeakGuard?: { phase: ToolCallTextLeakPhase }
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
  let guardedTextBuffer = ''

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

  if (options.toolCallTextLeakGuard && guardedTextBuffer && !textLeakSuppression) {
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

function isSupportedTaskUpdateStatus(status: string | undefined): status is 'pending' | 'in_progress' | 'completed' | 'failed' {
  return status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'failed'
}

function extractFileQuestionPath(prompt: string): string | undefined {
  if (!/(file|文件|read|读取|内容|content|about|关于|what|does|say)/i.test(prompt)) return undefined
  const match = prompt.match(/(?:^|\s)([\w./-]+\.[A-Za-z0-9_]+)(?=$|\s|[，。！？,.!?])/)
  return match?.[1]
}

function splitCommand(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return matches.map(part => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1)
    }
    return part
  })
}
