import type { NexusEvent } from '../shared/events.js'
import type { ExecutionMetrics } from './Storage.js'

export function executionMetricsFromEvent(
  sessionId: string,
  event: NexusEvent,
): ExecutionMetrics | null {
  if (event.type !== 'execution_metrics') return null
  return {
    metricId: `metric:${sessionId}:${event.timestamp}`,
    sessionId,
    executeDurationMs: event.executeDurationMs,
    providerFirstTokenMs: event.providerFirstTokenMs,
    providerRequestDurationMs: event.providerRequestDurationMs,
    streamDeltaCount: event.streamDeltaCount,
    toolCallCount: event.toolCallCount,
    toolRoundtripDurationMs: event.toolRoundtripDurationMs,
    contextCharsIn: event.contextCharsIn,
    contextCharsOut: event.contextCharsOut,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheCreationInputTokens: event.cacheCreationInputTokens,
    cacheReadInputTokens: event.cacheReadInputTokens,
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
    cacheReadRatio: event.cacheReadRatio,
    cachePreservationMode: event.cachePreservationMode,
    longContextUtilizationMode: event.longContextUtilizationMode,
    prefixCacheImmutableRatio: event.prefixCacheImmutableRatio,
    prefixCacheVolatileContentLast: event.prefixCacheVolatileContentLast,
    prefixCacheFingerprint: event.prefixCacheFingerprint,
    compactSummaryLatencyMs: event.compactSummaryLatencyMs,
    remoteToolCallCount: event.remoteToolCallCount,
    remoteToolRunnerDurationMs: event.remoteToolRunnerDurationMs,
    timestamp: event.timestamp,
  }
}
