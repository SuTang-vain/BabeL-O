import type { NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'
import { maybeBuildCacheHealthEventFromExecutionMetrics } from './cacheHealth.js'
import type { ExecuteTimeoutDecision, WatchdogState } from './executionPreparation.js'
import type { NexusMetrics } from './metrics.js'

export type BehaviorMonitorLike = {
  ingest(event: NexusEvent): void
}

export type ProcessRuntimeExecutionEventResult = {
  event: NexusEvent
  cacheHealthEvent?: NexusEvent
}

export async function processRuntimeExecutionEvent(options: {
  event: NexusEvent
  events: NexusEvent[]
  sessionId: string
  cwd: string
  storage: NexusStorage
  metrics: NexusMetrics
  timeoutDecision: ExecuteTimeoutDecision
  watchdog: WatchdogState
  behaviorMonitor?: BehaviorMonitorLike
}): Promise<ProcessRuntimeExecutionEventResult> {
  const decoratedEvent =
    maybeDecorateWatchdogError({
      event: options.event,
      timeoutDecision: options.timeoutDecision,
      watchdog: options.watchdog,
      events: options.events,
    }) ?? options.event
  options.events.push(decoratedEvent)
  await options.storage.appendEvent(options.sessionId, decoratedEvent)
  recordExecutionEventMetrics(options.metrics, decoratedEvent)
  options.behaviorMonitor?.ingest(decoratedEvent)
  const cacheHealthEvent = maybeBuildExecutionCacheHealthEvent(decoratedEvent, options.cwd)
  if (cacheHealthEvent) {
    options.events.push(cacheHealthEvent)
    await options.storage.appendEvent(options.sessionId, cacheHealthEvent)
  }
  return {
    event: decoratedEvent,
    ...(cacheHealthEvent && { cacheHealthEvent }),
  }
}

export function recordExecutionEventMetrics(metrics: NexusMetrics, event: NexusEvent): void {
  if (event.type !== 'execution_metrics') return
  if (event.providerFirstTokenMs !== undefined) metrics.recordProviderFirstToken(event.providerFirstTokenMs)
  if (event.providerRequestDurationMs !== undefined) metrics.recordProviderRequestDuration(event.providerRequestDurationMs)
  if (event.streamDeltaCount !== undefined) metrics.recordStreamDeltas(event.streamDeltaCount)
  if (event.toolCallCount !== undefined && event.toolRoundtripDurationMs !== undefined) metrics.recordToolCalls(event.toolCallCount, event.toolRoundtripDurationMs)
  if (event.remoteToolCallCount !== undefined && event.remoteToolRunnerDurationMs !== undefined) metrics.recordRemoteToolCalls(event.remoteToolCallCount, event.remoteToolRunnerDurationMs)
  if (event.contextCharsIn !== undefined && event.contextCharsOut !== undefined) metrics.recordContextChars(event.contextCharsIn, event.contextCharsOut)
  metrics.recordTokenUsage({
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheCreationInputTokens: event.cacheCreationInputTokens,
    cacheReadInputTokens: event.cacheReadInputTokens,
  })
  metrics.recordContextPolicy({
    modelContextWindow: event.modelContextWindow,
    reservedOutputTokens: event.reservedOutputTokens,
    providerSafetyBufferTokens: event.providerSafetyBufferTokens,
    effectiveContextCeiling: event.effectiveContextCeiling,
    legacyContextCeiling: event.legacyContextCeiling,
    envMaxContextTokens: event.envMaxContextTokens,
    contextPolicySource: event.contextPolicySource,
    contextWarningThresholdPercent: event.contextWarningThresholdPercent,
    contextCompactThresholdPercent: event.contextCompactThresholdPercent,
    contextWarningThresholdTokens: event.contextWarningThresholdTokens,
    contextCompactThresholdTokens: event.contextCompactThresholdTokens,
    contextBlockingLimitTokens: event.contextBlockingLimitTokens,
    cachePreservationMode: event.cachePreservationMode,
    longContextUtilizationMode: event.longContextUtilizationMode,
    prefixCacheImmutableRatio: event.prefixCacheImmutableRatio,
    prefixCacheVolatileContentLast: event.prefixCacheVolatileContentLast,
    prefixCacheFingerprint: event.prefixCacheFingerprint,
  })
  if (event.compactSummaryLatencyMs !== undefined) metrics.recordCompactSummaryLatency(event.compactSummaryLatencyMs)
}

export function maybeBuildExecutionCacheHealthEvent(event: NexusEvent, cwd: string): NexusEvent | undefined {
  return maybeBuildCacheHealthEventFromExecutionMetrics(event, cwd)
}

export function maybeDecorateWatchdogError(options: {
  event: NexusEvent
  timeoutDecision: ExecuteTimeoutDecision
  watchdog: WatchdogState
  events: readonly NexusEvent[]
}): Extract<NexusEvent, { type: 'error' }> | undefined {
  if (options.event.type !== 'error') return undefined
  if (options.event.code !== 'REQUEST_TIMEOUT') return undefined
  if (options.timeoutDecision.policy !== 'soft') return undefined
  if (!options.watchdog.fired) return undefined
  const softCycleEvents = options.events.filter(event => event.type === 'timeout_budget_exceeded' || event.type === 'timeout_extension_granted')
  const existingDetails = asRecord(options.event.details) ?? {}
  const detailRecord: Record<string, unknown> = {
    ...existingDetails,
    kind: 'watchdog',
    policy: 'soft',
    softTimeoutMs: options.timeoutDecision.softTimeoutMs,
    watchdogTimeoutMs: options.timeoutDecision.watchdogTimeoutMs,
    maxSoftTimeoutExtensions: options.timeoutDecision.maxSoftTimeoutExtensions,
    softCycleEvents: softCycleEvents.length,
    retryable: false,
  }
  return {
    ...options.event,
    details: detailRecord,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}
