import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import type { ExecutionMetrics } from '../src/storage/Storage.js'

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-exec-metrics-repo-'))
  return { dir, dbPath: join(dir, 'nexus.sqlite') }
}

function baseSession(sessionId: string) {
  return {
    sessionId,
    cwd: '/workspace',
    prompt: 'inspect',
    phase: 'created' as const,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    events: [],
  }
}

function makeMetrics(overrides: Partial<ExecutionMetrics> = {}): ExecutionMetrics {
  return {
    metricId: 'metric_1',
    sessionId: 'sess_1',
    timestamp: '2026-06-20T00:00:01.000Z',
    ...overrides,
  }
}

test('ExecutionMetricsRepository saveExecutionMetrics + getExecutionMetrics round-trip preserves all fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('session_metrics_roundtrip'))
    const metrics: ExecutionMetrics = {
      metricId: 'metric_roundtrip',
      sessionId: 'session_metrics_roundtrip',
      executeDurationMs: 1234.5,
      providerFirstTokenMs: 89.1,
      providerRequestDurationMs: 1100.0,
      streamDeltaCount: 42,
      toolCallCount: 7,
      toolRoundtripDurationMs: 250.5,
      contextCharsIn: 12000,
      contextCharsOut: 8000,
      inputTokens: 3000,
      outputTokens: 1500,
      cacheCreationInputTokens: 2000,
      cacheReadInputTokens: 100,
      modelContextWindow: 200000,
      reservedOutputTokens: 8192,
      providerSafetyBufferTokens: 512,
      effectiveContextCeiling: 191296,
      legacyContextCeiling: 200000,
      envMaxContextTokens: undefined,
      contextPolicySource: 'large_context',
      contextWarningThresholdPercent: 60,
      contextCompactThresholdPercent: 90,
      contextWarningThresholdTokens: 120000,
      contextCompactThresholdTokens: 180000,
      contextBlockingLimitTokens: 195000,
      cacheReadRatio: 0.73,
      cachePreservationMode: true,
      longContextUtilizationMode: false,
      prefixCacheImmutableRatio: 0.85,
      prefixCacheVolatileContentLast: true,
      prefixCacheFingerprint: 'sha256:abcdef1234567890',
      compactSummaryLatencyMs: 150.0,
      remoteToolCallCount: 3,
      remoteToolRunnerDurationMs: 4200.5,
      timestamp: '2026-06-20T00:00:01.000Z',
    }
    await storage.saveExecutionMetrics(metrics)

    const loaded = await storage.getExecutionMetrics('session_metrics_roundtrip')
    assert.ok(loaded)
    assert.equal(loaded.metricId, 'metric_roundtrip')
    assert.equal(loaded.sessionId, 'session_metrics_roundtrip')
    assert.equal(loaded.executeDurationMs, 1234.5)
    assert.equal(loaded.providerFirstTokenMs, 89.1)
    assert.equal(loaded.providerRequestDurationMs, 1100.0)
    assert.equal(loaded.streamDeltaCount, 42)
    assert.equal(loaded.toolCallCount, 7)
    assert.equal(loaded.toolRoundtripDurationMs, 250.5)
    assert.equal(loaded.contextCharsIn, 12000)
    assert.equal(loaded.contextCharsOut, 8000)
    assert.equal(loaded.inputTokens, 3000)
    assert.equal(loaded.outputTokens, 1500)
    assert.equal(loaded.cacheCreationInputTokens, 2000)
    assert.equal(loaded.cacheReadInputTokens, 100)
    assert.equal(loaded.modelContextWindow, 200000)
    assert.equal(loaded.reservedOutputTokens, 8192)
    assert.equal(loaded.providerSafetyBufferTokens, 512)
    assert.equal(loaded.effectiveContextCeiling, 191296)
    assert.equal(loaded.legacyContextCeiling, 200000)
    assert.equal(loaded.contextPolicySource, 'large_context')
    assert.equal(loaded.contextWarningThresholdPercent, 60)
    assert.equal(loaded.contextCompactThresholdPercent, 90)
    assert.equal(loaded.contextWarningThresholdTokens, 120000)
    assert.equal(loaded.contextCompactThresholdTokens, 180000)
    assert.equal(loaded.contextBlockingLimitTokens, 195000)
    assert.equal(loaded.cacheReadRatio, 0.73)
    assert.equal(loaded.cachePreservationMode, true)
    assert.equal(loaded.longContextUtilizationMode, false)
    assert.equal(loaded.prefixCacheImmutableRatio, 0.85)
    assert.equal(loaded.prefixCacheVolatileContentLast, true)
    assert.equal(loaded.prefixCacheFingerprint, 'sha256:abcdef1234567890')
    assert.equal(loaded.compactSummaryLatencyMs, 150.0)
    assert.equal(loaded.remoteToolCallCount, 3)
    assert.equal(loaded.remoteToolRunnerDurationMs, 4200.5)
    assert.equal(loaded.timestamp, '2026-06-20T00:00:01.000Z')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ExecutionMetricsRepository getExecutionMetrics returns null for unknown sessionId', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    const loaded = await storage.getExecutionMetrics('session_does_not_exist')
    assert.equal(loaded, null)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ExecutionMetricsRepository saveExecutionMetrics is upsert: re-save with same metricId updates fields', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('session_upsert'))
    await storage.saveExecutionMetrics(makeMetrics({
      metricId: 'metric_upsert',
      sessionId: 'session_upsert',
      executeDurationMs: 100,
      inputTokens: 100,
      outputTokens: 50,
      timestamp: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveExecutionMetrics(makeMetrics({
      metricId: 'metric_upsert',
      sessionId: 'session_upsert',
      executeDurationMs: 200,
      inputTokens: 200,
      outputTokens: 75,
      timestamp: '2026-06-20T00:00:02.000Z',
    }))
    const loaded = await storage.getExecutionMetrics('session_upsert')
    assert.ok(loaded)
    assert.equal(loaded.executeDurationMs, 200)
    assert.equal(loaded.inputTokens, 200)
    assert.equal(loaded.outputTokens, 75)
    assert.equal(loaded.timestamp, '2026-06-20T00:00:02.000Z')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ExecutionMetricsRepository getExecutionMetrics returns the latest record by timestamp DESC', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('session_latest'))
    // save out of order
    await storage.saveExecutionMetrics(makeMetrics({
      metricId: 'metric_2',
      sessionId: 'session_latest',
      executeDurationMs: 222,
      timestamp: '2026-06-20T00:00:02.000Z',
    }))
    await storage.saveExecutionMetrics(makeMetrics({
      metricId: 'metric_1',
      sessionId: 'session_latest',
      executeDurationMs: 111,
      timestamp: '2026-06-20T00:00:01.000Z',
    }))
    await storage.saveExecutionMetrics(makeMetrics({
      metricId: 'metric_3',
      sessionId: 'session_latest',
      executeDurationMs: 333,
      timestamp: '2026-06-20T00:00:03.000Z',
    }))

    const loaded = await storage.getExecutionMetrics('session_latest')
    assert.ok(loaded)
    assert.equal(loaded.metricId, 'metric_3')
    assert.equal(loaded.executeDurationMs, 333)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ExecutionMetricsRepository saveExecutionMetrics preserves optional fields as null when omitted', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('session_minimal'))
    await storage.saveExecutionMetrics(makeMetrics({
      metricId: 'metric_minimal',
      sessionId: 'session_minimal',
    }))
    const loaded = await storage.getExecutionMetrics('session_minimal')
    assert.ok(loaded)
    assert.equal(loaded.executeDurationMs, undefined)
    assert.equal(loaded.providerFirstTokenMs, undefined)
    assert.equal(loaded.streamDeltaCount, undefined)
    assert.equal(loaded.toolCallCount, undefined)
    assert.equal(loaded.inputTokens, undefined)
    assert.equal(loaded.outputTokens, undefined)
    assert.equal(loaded.cachePreservationMode, undefined)
    assert.equal(loaded.longContextUtilizationMode, undefined)
    assert.equal(loaded.prefixCacheVolatileContentLast, undefined)
    assert.equal(loaded.contextPolicySource, undefined)
    assert.equal(loaded.prefixCacheFingerprint, undefined)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ExecutionMetricsRepository saveExecutionMetrics encodes boolean fields as 0/1 (false → undefined on read-back)', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('session_booleans'))
    await storage.saveExecutionMetrics(makeMetrics({
      metricId: 'metric_booleans',
      sessionId: 'session_booleans',
      cachePreservationMode: false,
      longContextUtilizationMode: false,
      prefixCacheVolatileContentLast: false,
    }))
    const loaded = await storage.getExecutionMetrics('session_booleans')
    assert.ok(loaded)
    // false stored as 0, which dbToBoolean reads as false
    assert.equal(loaded.cachePreservationMode, false)
    assert.equal(loaded.longContextUtilizationMode, false)
    assert.equal(loaded.prefixCacheVolatileContentLast, false)
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ExecutionMetricsRepository saveExecutionMetrics accepts all 3 contextPolicySource enum values', async () => {
  const { dir, dbPath } = tempDbPath()
  const storage = new SqliteStorage(dbPath)
  try {
    await storage.saveSession(baseSession('session_legacy'))
    await storage.saveSession(baseSession('session_large'))
    await storage.saveSession(baseSession('session_env'))
    await storage.saveExecutionMetrics(makeMetrics({
      metricId: 'm_legacy', sessionId: 'session_legacy',
      contextPolicySource: 'legacy',
    }))
    await storage.saveExecutionMetrics(makeMetrics({
      metricId: 'm_large', sessionId: 'session_large',
      contextPolicySource: 'large_context',
    }))
    await storage.saveExecutionMetrics(makeMetrics({
      metricId: 'm_env', sessionId: 'session_env',
      contextPolicySource: 'env_cap',
    }))
    const legacy = await storage.getExecutionMetrics('session_legacy')
    const large = await storage.getExecutionMetrics('session_large')
    const env = await storage.getExecutionMetrics('session_env')
    assert.ok(legacy && large && env)
    assert.equal(legacy.contextPolicySource, 'legacy')
    assert.equal(large.contextPolicySource, 'large_context')
    assert.equal(env.contextPolicySource, 'env_cap')
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
