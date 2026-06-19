import { performance } from 'node:perf_hooks'
import { eventBase, type NexusEvent } from '../../shared/events.js'
import type { RemoteToolRunnerDiagnostics } from '../../shared/toolTrace.js'
import type { RuntimeExecuteOptions } from '../Runtime.js'
import type { CacheAwareCompactPolicy } from '../cacheAwareCompactPolicy.js'
import type { PrefixCacheDiagnostics } from '../prefixCache.js'
import type { RuntimeProviderTurn } from './turn.js'

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
