import { performance } from 'node:perf_hooks'

type RouteMetric = {
  route: string
  count: number
  errorCount: number
  totalMs: number
  maxMs: number
}

type ExecuteMetric = {
  count: number
  activeCount: number
  successCount: number
  failureCount: number
  timeoutCount: number
  rejectedCount: number
  totalMs: number
  maxMs: number
}

type StreamMetric = {
  count: number
  activeCount: number
  successCount: number
  failureCount: number
  timeoutCount: number
  rejectedCount: number
  clientClosedCount: number
  sentEventCount: number
  totalMs: number
  maxMs: number
  maxBufferedAmount: number
}

export class NexusMetrics {
  private readonly startedAt = new Date().toISOString()
  private readonly startedAtMs = performance.now()
  private readonly routes = new Map<string, RouteMetric>()
  private readonly execute: ExecuteMetric = {
    count: 0,
    activeCount: 0,
    successCount: 0,
    failureCount: 0,
    timeoutCount: 0,
    rejectedCount: 0,
    totalMs: 0,
    maxMs: 0,
  }
  private readonly stream: StreamMetric = {
    count: 0,
    activeCount: 0,
    successCount: 0,
    failureCount: 0,
    timeoutCount: 0,
    rejectedCount: 0,
    clientClosedCount: 0,
    sentEventCount: 0,
    totalMs: 0,
    maxMs: 0,
    maxBufferedAmount: 0,
  }

  private providerFirstTokenTotalMs = 0
  private providerFirstTokenCount = 0
  private providerRequestTotalMs = 0
  private providerRequestCount = 0
  private streamDeltaTotalCount = 0
  private toolCallTotalCount = 0
  private toolRoundtripTotalMs = 0
  private contextCharsInTotal = 0
  private contextCharsOutTotal = 0
  private inputTokenTotalCount = 0
  private outputTokenTotalCount = 0
  private cacheCreationInputTokenTotalCount = 0
  private cacheReadInputTokenTotalCount = 0
  private latestEffectiveContextCeiling?: number
  private latestLegacyContextCeiling?: number
  private cachePreservationModeCount = 0
  private longContextUtilizationModeCount = 0
  private compactSummaryLatencyTotalMs = 0
  private compactSummaryLatencyCount = 0

  recordProviderFirstToken(ms: number): void {
    this.providerFirstTokenTotalMs += ms
    this.providerFirstTokenCount += 1
  }

  recordProviderRequestDuration(ms: number): void {
    this.providerRequestTotalMs += ms
    this.providerRequestCount += 1
  }

  recordStreamDeltas(count: number): void {
    this.streamDeltaTotalCount += count
  }

  recordToolCalls(count: number, durationMs: number): void {
    this.toolCallTotalCount += count
    this.toolRoundtripTotalMs += durationMs
  }

  recordContextChars(charsIn: number, charsOut: number): void {
    this.contextCharsInTotal += charsIn
    this.contextCharsOutTotal += charsOut
  }

  recordTokenUsage(options: {
    inputTokens?: number
    outputTokens?: number
    cacheCreationInputTokens?: number
    cacheReadInputTokens?: number
  }): void {
    this.inputTokenTotalCount += options.inputTokens ?? 0
    this.outputTokenTotalCount += options.outputTokens ?? 0
    this.cacheCreationInputTokenTotalCount += options.cacheCreationInputTokens ?? 0
    this.cacheReadInputTokenTotalCount += options.cacheReadInputTokens ?? 0
  }

  recordContextPolicy(options: {
    effectiveContextCeiling?: number
    legacyContextCeiling?: number
    cachePreservationMode?: boolean
    longContextUtilizationMode?: boolean
  }): void {
    if (options.effectiveContextCeiling !== undefined) this.latestEffectiveContextCeiling = options.effectiveContextCeiling
    if (options.legacyContextCeiling !== undefined) this.latestLegacyContextCeiling = options.legacyContextCeiling
    if (options.cachePreservationMode) this.cachePreservationModeCount += 1
    if (options.longContextUtilizationMode) this.longContextUtilizationModeCount += 1
  }

  recordCompactSummaryLatency(ms: number): void {
    this.compactSummaryLatencyTotalMs += ms
    this.compactSummaryLatencyCount += 1
  }

  now(): number {
    return performance.now()
  }

  recordRoute(route: string, statusCode: number, durationMs: number): void {
    const metric =
      this.routes.get(route) ??
      {
        route,
        count: 0,
        errorCount: 0,
        totalMs: 0,
        maxMs: 0,
      }
    metric.count += 1
    if (statusCode >= 500) metric.errorCount += 1
    metric.totalMs += durationMs
    metric.maxMs = Math.max(metric.maxMs, durationMs)
    this.routes.set(route, metric)
  }

  recordExecuteStart(): void {
    this.execute.activeCount += 1
  }

  recordExecuteRejected(): void {
    this.execute.rejectedCount += 1
  }

  recordExecuteFinish(result: {
    success: boolean
    timedOut: boolean
    durationMs: number
  }): void {
    this.execute.activeCount = Math.max(0, this.execute.activeCount - 1)
    this.execute.count += 1
    if (result.success) {
      this.execute.successCount += 1
    } else {
      this.execute.failureCount += 1
    }
    if (result.timedOut) this.execute.timeoutCount += 1
    this.execute.totalMs += result.durationMs
    this.execute.maxMs = Math.max(this.execute.maxMs, result.durationMs)
  }

  recordStreamStart(): void {
    this.stream.activeCount += 1
  }

  recordStreamRejected(): void {
    this.stream.rejectedCount += 1
  }

  recordStreamEvent(bufferedAmount: number): void {
    this.stream.sentEventCount += 1
    this.stream.maxBufferedAmount = Math.max(
      this.stream.maxBufferedAmount,
      bufferedAmount,
    )
  }

  recordStreamFinish(result: {
    success: boolean
    timedOut: boolean
    clientClosed: boolean
    durationMs: number
  }): void {
    this.stream.activeCount = Math.max(0, this.stream.activeCount - 1)
    this.stream.count += 1
    if (result.success) {
      this.stream.successCount += 1
    } else {
      this.stream.failureCount += 1
    }
    if (result.timedOut) this.stream.timeoutCount += 1
    if (result.clientClosed) this.stream.clientClosedCount += 1
    this.stream.totalMs += result.durationMs
    this.stream.maxMs = Math.max(this.stream.maxMs, result.durationMs)
  }

  snapshot() {
    return {
      type: 'runtime_metrics',
      startedAt: this.startedAt,
      uptimeMs: Math.round(this.now() - this.startedAtMs),
      execute: withAverage(this.execute),
      stream: withAverage(this.stream),
      providerFirstTokenMs: {
        totalMs: round(this.providerFirstTokenTotalMs),
        count: this.providerFirstTokenCount,
        avgMs: this.providerFirstTokenCount > 0 ? round(this.providerFirstTokenTotalMs / this.providerFirstTokenCount) : 0,
      },
      providerRequestDurationMs: {
        totalMs: round(this.providerRequestTotalMs),
        count: this.providerRequestCount,
        avgMs: this.providerRequestCount > 0 ? round(this.providerRequestTotalMs / this.providerRequestCount) : 0,
      },
      streamDeltaCount: this.streamDeltaTotalCount,
      toolCallCount: this.toolCallTotalCount,
      toolRoundtripDurationMs: {
        totalMs: round(this.toolRoundtripTotalMs),
        count: this.toolCallTotalCount,
        avgMs: this.toolCallTotalCount > 0 ? round(this.toolRoundtripTotalMs / this.toolCallTotalCount) : 0,
      },
      contextCharsIn: this.contextCharsInTotal,
      contextCharsOut: this.contextCharsOutTotal,
      tokenUsage: {
        inputTokens: this.inputTokenTotalCount,
        outputTokens: this.outputTokenTotalCount,
        cacheCreationInputTokens: this.cacheCreationInputTokenTotalCount,
        cacheReadInputTokens: this.cacheReadInputTokenTotalCount,
        cacheReadRatio: cacheReadRatio({
          inputTokens: this.inputTokenTotalCount,
          cacheCreationInputTokens: this.cacheCreationInputTokenTotalCount,
          cacheReadInputTokens: this.cacheReadInputTokenTotalCount,
        }),
      },
      contextPolicy: {
        effectiveContextCeiling: this.latestEffectiveContextCeiling,
        legacyContextCeiling: this.latestLegacyContextCeiling,
        cachePreservationModeCount: this.cachePreservationModeCount,
        longContextUtilizationModeCount: this.longContextUtilizationModeCount,
      },
      compactSummaryLatencyMs: {
        totalMs: round(this.compactSummaryLatencyTotalMs),
        count: this.compactSummaryLatencyCount,
        avgMs: this.compactSummaryLatencyCount > 0 ? round(this.compactSummaryLatencyTotalMs / this.compactSummaryLatencyCount) : 0,
      },
      routes: [...this.routes.values()]
        .map(withAverage)
        .sort((left, right) => left.route.localeCompare(right.route)),
    }
  }
}

function cacheReadRatio(options: {
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}): number {
  const denominator = options.inputTokens + options.cacheCreationInputTokens + options.cacheReadInputTokens
  if (denominator <= 0) return 0
  return round(options.cacheReadInputTokens / denominator)
}

function withAverage<T extends { count: number; totalMs: number }>(metric: T) {
  return {
    ...metric,
    totalMs: round(metric.totalMs),
    maxMs: 'maxMs' in metric && typeof metric.maxMs === 'number'
      ? round(metric.maxMs)
      : undefined,
    avgMs: metric.count > 0 ? round(metric.totalMs / metric.count) : 0,
  }
}

export function round(value: number): number {
  return Math.round(value * 100) / 100
}
