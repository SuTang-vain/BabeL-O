import { eventBase, type NexusEvent } from '../../shared/events.js'
import type { ModelMessage, ModelToolDefinition } from '../../providers/adapters/ModelAdapter.js'
import type { AssembledContext, ContextAssemblerOptions } from '../contextAssembler.js'
import { assembleContext } from '../contextAssembler.js'
import type { RuntimeContextBroadcaster } from '../contextBroadcaster.js'
import { getAutoCompactDecision, type AutoCompactDecision } from '../compact.js'
import {
  buildCacheAwareCompactPolicy,
  computeSystemPromptCacheableRatio,
  summarizeCacheAwareUsage,
  type CacheAwareCompactPolicy,
} from '../cacheAwareCompactPolicy.js'
import type { UserIntentGuidance } from '../intentGuidance.js'
import { buildProviderFallbackPolicy } from '../providerRecovery.js'
import { estimateContextTokens, getContextWindowState, type ContextWindowState } from '../tokenEstimator.js'
import type { MicrocompactMetrics } from '../compactors/microCompact.js'
import { buildRuntimeErrorEvent, buildRuntimeResultEvent } from './events.js'

// Fire-and-forget publish of assembled-context events to an injected
// ContextBroadcaster. MUST NOT throw into the hot path, MUST NOT await
// subscriber callbacks. When no broadcaster is injected, publishing is
// disabled and the runtime remains independent from Nexus.
function safeContextPublish(options: {
  broadcaster?: RuntimeContextBroadcaster
  cwd: string | undefined
  sessionId: string | undefined
  context: AssembledContext
}): void {
  const { broadcaster, cwd, sessionId, context } = options
  if (!broadcaster) return
  if (!sessionId) return
  const safeCwd = cwd ?? ''
  try {
    broadcaster.publish(safeCwd, {
      type: 'assembled',
      sessionId,
      context,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[runtimePipeline] context publish failed:', err)
  }
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

export function buildContextUsageEvent(options: {
  sessionId: string
  requestId?: string
  modelId: string
  providerId: string
  windowState: ContextWindowState
  cacheAwareCompactPolicy?: CacheAwareCompactPolicy
  source: Extract<NexusEvent, { type: 'context_usage' }>['source']
}): Extract<NexusEvent, { type: 'context_usage' }> {
  return {
    type: 'context_usage',
    ...eventBase(options.sessionId),
    ...(options.requestId && { requestId: options.requestId }),
    modelId: options.modelId,
    providerId: options.providerId,
    tokenEstimate: options.windowState.tokenEstimate,
    maxTokens: options.windowState.maxTokens,
    percentUsed: options.windowState.percentUsed,
    warningThresholdTokens: options.windowState.warningThresholdTokens,
    compactThresholdTokens: options.windowState.compactThresholdTokens,
    blockingLimitTokens: options.windowState.blockingLimitTokens,
    ...contextPolicyEventFields(options.cacheAwareCompactPolicy),
    cachePreservationMode: options.cacheAwareCompactPolicy?.cachePreservationMode,
    longContextUtilizationMode: options.cacheAwareCompactPolicy?.longContextUtilizationMode,
    source: options.source,
    message: `Context usage ${options.windowState.percentUsed}% (${options.windowState.tokenEstimate}/${options.windowState.maxTokens} tokens).`,
  }
}

export function buildContextMicrocompactEvent(options: {
  sessionId: string
  requestId?: string
  trigger: Extract<NexusEvent, { type: 'context_microcompact' }>['trigger']
  metrics: MicrocompactMetrics
}): Extract<NexusEvent, { type: 'context_microcompact' }> | undefined {
  if (options.metrics.compactedEventCount <= 0 || options.metrics.bytesSaved <= 0) return undefined
  return {
    type: 'context_microcompact',
    ...eventBase(options.sessionId),
    ...(options.requestId && { requestId: options.requestId }),
    trigger: options.trigger,
    compactedEventCount: options.metrics.compactedEventCount,
    deduplicatedToolResultCount: options.metrics.deduplicatedToolResultCount,
    bytesBefore: options.metrics.bytesBefore,
    bytesAfter: options.metrics.bytesAfter,
    bytesSaved: options.metrics.bytesSaved,
    estimatedTokensSaved: options.metrics.estimatedTokensSaved,
    message: `Context microcompact saved about ${options.metrics.estimatedTokensSaved} tokens across ${options.metrics.compactedEventCount} tool result event(s).`,
  }
}

export function buildContextRecoveryAttemptedEvent(options: {
  sessionId: string
  requestId?: string
  providerId?: string
  modelId?: string
  providerErrorCode: string
  strategy: Extract<NexusEvent, { type: 'context_recovery_attempted' }>['strategy']
  attempt: number
  maxAttempts: number
  preTokens: number
  postTokens?: number
  retryable: boolean
  message?: string
}): Extract<NexusEvent, { type: 'context_recovery_attempted' }> {
  const message = options.message ?? `Provider context-limit recovery ${options.attempt}/${options.maxAttempts}: ${options.strategy}.`
  return {
    type: 'context_recovery_attempted',
    ...eventBase(options.sessionId),
    ...(options.requestId && { requestId: options.requestId }),
    ...(options.providerId && { providerId: options.providerId }),
    ...(options.modelId && { modelId: options.modelId }),
    providerErrorCode: options.providerErrorCode,
    strategy: options.strategy,
    attempt: options.attempt,
    maxAttempts: options.maxAttempts,
    preTokens: options.preTokens,
    ...(options.postTokens !== undefined && { postTokens: options.postTokens }),
    retryable: options.retryable,
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
  contextBroadcaster?: RuntimeContextBroadcaster
}): Promise<RuntimeContextRefreshState> {
  const assembledContext = await assembleContext({
    runtimeOptions: options.runtimeOptions,
    events: options.events,
    modelId: options.modelId,
    buildSystemPrompt: options.buildSystemPrompt,
    mapEventsToMessages: options.mapEventsToMessages,
    memoryProvider: options.memoryProvider,
    sessionInbox: options.sessionInbox,
    // PR-4a: forward workingSetOverride from the caller (R2 of
    // long-running-context-assembly.md §20) so the runtime hot path can
    // pass the persisted Nexus-owned working set. Previously this was
    // dropped — every refresh re-derived a transient working set from the
    // event slice. The override is optional; when omitted, the legacy
    // derive path is used (back-compat with callers that do not have
    // resumeDeps).
    workingSetOverride: options.workingSetOverride,
    // §3.5 v1.1 follow-up: forward the hot-path memory_retrieval
    // hook from `refreshRuntimeContextState` callers. Spread
    // conditionally so a missing hook is a no-op (the `assembleContext`
    // option is optional, but a literal `undefined` would also be
    // accepted — the conditional is just to keep the object
    // minimal when no caller wired a hook).
    ...(options.onMemoryRetrieval && { onMemoryRetrieval: options.onMemoryRetrieval }),
  })
  // PR-A2: publish to contextBroadcaster (fire-and-forget, no-op when
  // no subscribers; never throws into the hot path).
  safeContextPublish({
    broadcaster: options.contextBroadcaster,
    cwd: options.runtimeOptions.cwd,
    sessionId: options.runtimeOptions.sessionId,
    context: assembledContext,
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

export function buildRuntimeContextBlockingEventsForLoop(options: {
  sessionId: string
  modelId: string
  windowState: ContextWindowState
  autoCompactDecision: AutoCompactDecision
  fallbackThresholdPercent: number
  message?: string
  cacheAwareCompactPolicy?: CacheAwareCompactPolicy
}): NexusEvent[] {
  return buildContextBlockingEvents({
    sessionId: options.sessionId,
    modelId: options.modelId,
    windowState: options.windowState,
    thresholdPercent: options.autoCompactDecision.enabled
      ? options.autoCompactDecision.thresholdPercent
      : options.fallbackThresholdPercent,
    message: options.message,
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
