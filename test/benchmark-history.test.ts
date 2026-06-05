import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildBenchmarkHistoryEntry,
  extractBenchmarkMetrics,
  writeBenchmarkHistory,
  type BenchmarkHistoryEntry,
} from '../src/nexus/benchmarkHistory.js'

test('benchmark history extracts stable key metrics', () => {
  const result = sampleBenchmarkResult('2026-06-05T00:00:00.000Z', 10)
  const metrics = extractBenchmarkMetrics(result)
  const metricMap = Object.fromEntries(metrics.map(metric => [metric.name, metric]))

  assert.equal(metricMap['GET /health avgMs']?.value, 10)
  assert.equal(metricMap['GET /health avgMs']?.unit, 'ms')
  assert.equal(metricMap['GET /health avgMs']?.direction, 'lower_is_better')
  assert.equal(metricMap['Context assembly long session reductionPct']?.direction, 'higher_is_better')
  assert.equal(metricMap['apiScale memory GET /v1/sessions?limit=200']?.value, 18)
  assert.equal(metricMap['retryPolicy retryOverheadTokens']?.unit, 'tokens')
})

test('benchmark history records deltas against previous summary', () => {
  const previous: BenchmarkHistoryEntry = buildBenchmarkHistoryEntry(sampleBenchmarkResult('2026-06-05T00:00:00.000Z', 10))
  const current = buildBenchmarkHistoryEntry(sampleBenchmarkResult('2026-06-05T00:01:00.000Z', 12), previous)
  const health = current.metrics.find(metric => metric.name === 'GET /health avgMs')

  assert.equal(current.timestamp, '2026-06-05T00:01:00.000Z')
  assert.equal(health?.previousValue, 10)
  assert.equal(health?.delta, 2)
  assert.equal(health?.deltaPct, 20)
})

test('benchmark history writes latest history and summary locally', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'babel-o-benchmark-history-'))
  try {
    const first = await writeBenchmarkHistory({
      result: sampleBenchmarkResult('2026-06-05T00:00:00.000Z', 10),
      projectRoot: tempDir,
      maxEntries: 2,
    })
    const second = await writeBenchmarkHistory({
      result: sampleBenchmarkResult('2026-06-05T00:01:00.000Z', 12),
      projectRoot: tempDir,
      maxEntries: 2,
    })

    assert.equal(first.enabled, true)
    assert.equal(second.retainedEntries, 2)
    assert.equal(second.previousTimestamp, '2026-06-05T00:00:00.000Z')

    const latest = JSON.parse(await readFile(second.latestPath!, 'utf8'))
    const history = JSON.parse(await readFile(second.historyPath!, 'utf8'))
    const summary = JSON.parse(await readFile(second.summaryPath!, 'utf8'))

    assert.equal(latest.timestamp, '2026-06-05T00:01:00.000Z')
    assert.equal(history.length, 2)
    assert.equal(summary.timestamp, '2026-06-05T00:01:00.000Z')
    assert.ok(summary.metrics.some((metric: any) => metric.name === 'GET /health avgMs' && metric.delta === 2))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('benchmark history can be disabled', async () => {
  const result = await writeBenchmarkHistory({
    result: sampleBenchmarkResult('2026-06-05T00:00:00.000Z', 10),
    projectRoot: '/unused',
    disabled: true,
  })

  assert.deepEqual(result, { enabled: false })
})

function sampleBenchmarkResult(timestamp: string, healthAvgMs: number): Record<string, unknown> {
  return {
    type: 'performance_benchmark',
    timestamp,
    schemaVersion: 1,
    results: [
      {
        name: 'GET /health',
        iterations: 100,
        avgMs: healthAvgMs,
        p95Ms: healthAvgMs + 5,
      },
    ],
    context: {
      name: 'Context assembly long session',
      reductionPct: 75,
    },
    autoCompact: {
      name: 'Auto-compact long session',
      reductionPct: 80,
      summaryLatencyMs: 4,
    },
    cacheAwareCompact: {
      name: 'Cache-aware compact policy',
      cacheReadRatio: 0.86,
    },
    apiScale: [
      {
        storage: 'memory',
        routes: [
          {
            name: 'GET /v1/sessions?limit=200',
            p95Ms: 18,
            payloadBytes: 2048,
          },
        ],
      },
    ],
    chatFirstResponse: {
      scenarios: [
        {
          scenario: 'warm_start_embedded',
          p95Ms: 6,
        },
      ],
    },
    storageBridgeFaultInjection: {
      scenarios: [
        {
          scenario: 'sqlite_write_failure_retry',
          p95Ms: 3,
          permanentFailures: 0,
        },
      ],
    },
    tokenEstimator: {
      name: 'Chinese context token estimator',
      multiplier: 2.4,
    },
    agentLoop: {
      totals: {
        successRate: 0.66,
        retryCount: 2,
        cost: {
          total: {
            totalTokens: 1234,
          },
        },
      },
    },
    retryPolicy: {
      totals: {
        successRate: 0.4,
        retryCount: 6,
        retryOverheadTokens: 120,
      },
    },
    metrics: {
      executionCount: 4,
      providerRequestCount: 0,
    },
  }
}
