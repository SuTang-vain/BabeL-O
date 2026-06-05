import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type BenchmarkMetricSummary = {
  name: string
  value: number
  unit: 'ms' | 'ratio' | 'count' | 'tokens' | 'bytes'
  direction: 'lower_is_better' | 'higher_is_better' | 'informational'
  previousValue?: number
  delta?: number
  deltaPct?: number
}

export type BenchmarkHistoryEntry = {
  timestamp: string
  schemaVersion: number
  metrics: BenchmarkMetricSummary[]
}

export type BenchmarkHistoryWriteResult = {
  enabled: boolean
  directory?: string
  latestPath?: string
  historyPath?: string
  summaryPath?: string
  retainedEntries?: number
  metrics?: BenchmarkMetricSummary[]
  previousTimestamp?: string
}

type WriteBenchmarkHistoryOptions = {
  result: Record<string, unknown>
  projectRoot: string
  outputDir?: string
  maxEntries?: number
  disabled?: boolean
}

const DEFAULT_MAX_HISTORY_ENTRIES = 20

export async function writeBenchmarkHistory(options: WriteBenchmarkHistoryOptions): Promise<BenchmarkHistoryWriteResult> {
  if (options.disabled) return { enabled: false }

  const directory = options.outputDir ?? join(options.projectRoot, '.babel-o', 'benchmarks')
  const latestPath = join(directory, 'latest.json')
  const historyPath = join(directory, 'history.json')
  const summaryPath = join(directory, 'summary.json')
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_HISTORY_ENTRIES

  await mkdir(directory, { recursive: true })

  const existing = await readHistory(historyPath)
  const previous = existing.at(-1)
  const entry = buildBenchmarkHistoryEntry(options.result, previous)
  const history = [...existing, entry].slice(-maxEntries)

  await writeFile(latestPath, `${JSON.stringify(options.result, null, 2)}\n`, 'utf8')
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8')
  await writeFile(summaryPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')

  return {
    enabled: true,
    directory,
    latestPath,
    historyPath,
    summaryPath,
    retainedEntries: history.length,
    metrics: entry.metrics,
    previousTimestamp: previous?.timestamp,
  }
}

export function buildBenchmarkHistoryEntry(
  result: Record<string, unknown>,
  previous?: BenchmarkHistoryEntry,
): BenchmarkHistoryEntry {
  const metrics = extractBenchmarkMetrics(result)
  const previousMetrics = new Map(previous?.metrics.map(metric => [metric.name, metric.value]) ?? [])
  return {
    timestamp: readString(result.timestamp) ?? new Date().toISOString(),
    schemaVersion: 1,
    metrics: metrics.map(metric => withDelta(metric, previousMetrics.get(metric.name))),
  }
}

export function extractBenchmarkMetrics(result: Record<string, unknown>): BenchmarkMetricSummary[] {
  const metrics: BenchmarkMetricSummary[] = []
  const topLevelResults = readArray(result.results)
  for (const item of topLevelResults) {
    if (!isRecord(item)) continue
    pushNumberMetric(metrics, item.name, item.avgMs, 'ms', 'lower_is_better', 'avgMs')
    pushNumberMetric(metrics, item.name, item.p95Ms, 'ms', 'lower_is_better', 'p95Ms')
  }

  const context = readRecord(result.context)
  pushNumberMetric(metrics, context?.name, context?.reductionPct, 'ratio', 'higher_is_better', 'reductionPct')

  const autoCompact = readRecord(result.autoCompact)
  pushNumberMetric(metrics, autoCompact?.name, autoCompact?.reductionPct, 'ratio', 'higher_is_better', 'reductionPct')
  pushNumberMetric(metrics, autoCompact?.name, autoCompact?.summaryLatencyMs, 'ms', 'lower_is_better', 'summaryLatencyMs')

  const cacheAwareCompact = readRecord(result.cacheAwareCompact)
  pushNumberMetric(metrics, cacheAwareCompact?.name, cacheAwareCompact?.cacheReadRatio, 'ratio', 'higher_is_better', 'cacheReadRatio')

  const apiScale = readArray(result.apiScale)
  for (const storageResult of apiScale) {
    if (!isRecord(storageResult)) continue
    const storage = readString(storageResult.storage)
    const routes = readArray(storageResult.routes)
    for (const route of routes) {
      if (!isRecord(route)) continue
      const name = compactMetricName(['apiScale', storage, readString(route.name)])
      pushNumberMetric(metrics, name, route.p95Ms, 'ms', 'lower_is_better')
      pushNumberMetric(metrics, `${name} payloadBytes`, route.payloadBytes, 'bytes', 'lower_is_better')
    }
  }

  const chatFirstResponse = readRecord(result.chatFirstResponse)
  for (const scenario of readArray(chatFirstResponse?.scenarios)) {
    if (!isRecord(scenario)) continue
    const name = compactMetricName(['chatFirstResponse', readString(scenario.scenario)])
    pushNumberMetric(metrics, name, scenario.p95Ms, 'ms', 'lower_is_better')
  }

  const storageBridgeFaultInjection = readRecord(result.storageBridgeFaultInjection)
  for (const scenario of readArray(storageBridgeFaultInjection?.scenarios)) {
    if (!isRecord(scenario)) continue
    const name = compactMetricName(['storageBridgeFaultInjection', readString(scenario.scenario)])
    pushNumberMetric(metrics, name, scenario.p95Ms, 'ms', 'lower_is_better')
    pushNumberMetric(metrics, `${name} permanentFailures`, scenario.permanentFailures, 'count', 'lower_is_better')
  }

  const tokenEstimator = readRecord(result.tokenEstimator)
  pushNumberMetric(metrics, tokenEstimator?.name, tokenEstimator?.multiplier, 'ratio', 'higher_is_better', 'multiplier')

  const agentLoop = readRecord(result.agentLoop)
  const agentLoopTotals = readRecord(agentLoop?.totals)
  pushNumberMetric(metrics, 'agentLoop successRate', agentLoopTotals?.successRate, 'ratio', 'higher_is_better')
  pushNumberMetric(metrics, 'agentLoop retryCount', agentLoopTotals?.retryCount, 'count', 'lower_is_better')
  const agentLoopCost = readRecord(agentLoopTotals?.cost)
  const agentLoopTotalCost = readRecord(agentLoopCost?.total)
  pushNumberMetric(metrics, 'agentLoop totalTokens', agentLoopTotalCost?.totalTokens, 'tokens', 'lower_is_better')

  const retryPolicy = readRecord(result.retryPolicy)
  const retryPolicyTotals = readRecord(retryPolicy?.totals)
  pushNumberMetric(metrics, 'retryPolicy successRate', retryPolicyTotals?.successRate, 'ratio', 'higher_is_better')
  pushNumberMetric(metrics, 'retryPolicy retryCount', retryPolicyTotals?.retryCount, 'count', 'lower_is_better')
  pushNumberMetric(metrics, 'retryPolicy retryOverheadTokens', retryPolicyTotals?.retryOverheadTokens, 'tokens', 'lower_is_better')

  const runnerComparison = readRecord(result.runnerComparison)
  for (const backend of readArray(runnerComparison?.backends)) {
    if (!isRecord(backend) || readString(backend.status) !== 'completed') continue
    const backendName = readString(backend.backend)
    const totals = readRecord(backend.totals)
    const name = compactMetricName(['runnerComparison', backendName])
    pushNumberMetric(metrics, name, totals?.durationP95Ms, 'ms', 'lower_is_better', 'durationP95Ms')
    pushNumberMetric(metrics, name, totals?.truncatedCount, 'count', 'informational', 'truncatedCount')
    pushNumberMetric(metrics, name, totals?.timeoutCount, 'count', 'lower_is_better', 'timeoutCount')
    pushNumberMetric(metrics, name, totals?.cancelledCount, 'count', 'lower_is_better', 'cancelledCount')
    pushNumberMetric(metrics, name, totals?.workspaceDeniedCount, 'count', 'higher_is_better', 'workspaceDeniedCount')
    pushNumberMetric(metrics, name, totals?.originalBytes, 'bytes', 'informational', 'originalBytes')
    pushNumberMetric(metrics, name, totals?.heapUsedDeltaBytes, 'bytes', 'lower_is_better', 'heapUsedDeltaBytes')
  }

  const runtimeMetrics = readRecord(result.metrics)
  pushNumberMetric(metrics, 'runtimeMetrics executionCount', runtimeMetrics?.executionCount, 'count', 'informational')
  pushNumberMetric(metrics, 'runtimeMetrics providerRequestCount', runtimeMetrics?.providerRequestCount, 'count', 'informational')

  return metrics
}

async function readHistory(path: string): Promise<BenchmarkHistoryEntry[]> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isBenchmarkHistoryEntry)
  } catch {
    return []
  }
}

function isBenchmarkHistoryEntry(value: unknown): value is BenchmarkHistoryEntry {
  if (!isRecord(value)) return false
  return typeof value.timestamp === 'string' && Array.isArray(value.metrics)
}

function withDelta(metric: BenchmarkMetricSummary, previousValue: number | undefined): BenchmarkMetricSummary {
  if (previousValue === undefined) return metric
  const delta = round(metric.value - previousValue)
  return {
    ...metric,
    previousValue,
    delta,
    deltaPct: previousValue === 0 ? undefined : round((delta / previousValue) * 100),
  }
}

function pushNumberMetric(
  metrics: BenchmarkMetricSummary[],
  rawName: unknown,
  rawValue: unknown,
  unit: BenchmarkMetricSummary['unit'],
  direction: BenchmarkMetricSummary['direction'],
  suffix?: string,
): void {
  const name = readString(rawName)
  const value = readNumber(rawValue)
  if (!name || value === undefined) return
  metrics.push({
    name: suffix ? `${name} ${suffix}` : name,
    value,
    unit,
    direction,
  })
}

function compactMetricName(parts: Array<string | undefined>): string | undefined {
  const filtered = parts.filter((part): part is string => Boolean(part))
  return filtered.length > 0 ? filtered.join(' ') : undefined
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
