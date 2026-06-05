import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractBenchmarkMetrics } from '../src/nexus/benchmarkHistory.js'
import { runRunnerComparisonBenchmark } from '../src/nexus/runnerComparisonBenchmark.js'

test('runner comparison benchmark records TS local metrics and skips Go by default', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'babel-o-runner-comparison-'))
  try {
    const result = await runRunnerComparisonBenchmark({
      workspaceRoot: tempDir,
      projectRoot: new URL('..', import.meta.url).pathname,
      runGoRunner: false,
    })

    assert.equal(result.name, 'TS local runner vs optional Go RemoteToolRunner')
    assert.equal(result.goRunnerEnabled, false)
    assert.match(result.goRunnerSkippedReason ?? '', /BABEL_O_RUN_GO_RUNNER_SMOKE=1/)
    assert.ok(result.workspaceFileCount >= 200)

    const tsLocal = result.backends.find(backend => backend.backend === 'ts_local')
    assert.ok(tsLocal)
    assert.equal(tsLocal.status, 'completed')
    assert.equal(tsLocal.scenarios.length, 8)
    assert.equal(tsLocal.totals.scenarioCount, 8)
    assert.ok(tsLocal.totals.iterations > 8)
    assert.ok(tsLocal.totals.successCount > 0)
    assert.equal(tsLocal.totals.truncatedCount, 2)
    assert.equal(tsLocal.totals.timeoutCount, 1)
    assert.equal(tsLocal.totals.cancelledCount, 1)
    assert.equal(tsLocal.totals.workspaceDeniedCount, 1)
    assert.ok(tsLocal.totals.originalBytes > tsLocal.totals.outputBytes)
    assert.equal(tsLocal.totals.errorCodes.REQUEST_TIMEOUT, 1)
    assert.equal(tsLocal.totals.errorCodes.REQUEST_CANCELLED, 1)
    assert.equal(tsLocal.totals.errorCodes.WORKSPACE_PATH_ESCAPE, 1)

    const truncation = tsLocal.scenarios.find(scenario => scenario.scenario === 'output_truncation')
    assert.equal(truncation?.truncatedCount, 2)
    assert.ok((truncation?.originalBytes ?? 0) > (truncation?.outputBytes ?? 0))

    const goRemote = result.backends.find(backend => backend.backend === 'go_remote')
    assert.ok(goRemote)
    assert.equal(goRemote.status, 'skipped')
    assert.match(goRemote.skippedReason ?? '', /BABEL_O_RUN_GO_RUNNER_SMOKE=1/)
    assert.equal(goRemote.scenarios.length, 0)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('benchmark history extracts runner comparison summary metrics', () => {
  const metrics = extractBenchmarkMetrics({
    timestamp: '2026-06-05T00:00:00.000Z',
    runnerComparison: {
      backends: [
        {
          backend: 'ts_local',
          status: 'completed',
          totals: {
            durationP95Ms: 12,
            truncatedCount: 2,
            timeoutCount: 1,
            cancelledCount: 1,
            workspaceDeniedCount: 1,
            originalBytes: 4096,
            heapUsedDeltaBytes: 2048,
          },
        },
        {
          backend: 'go_remote',
          status: 'skipped',
          totals: {
            durationP95Ms: 99,
          },
        },
      ],
    },
  })
  const metricMap = Object.fromEntries(metrics.map(metric => [metric.name, metric]))

  assert.equal(metricMap['runnerComparison ts_local durationP95Ms']?.value, 12)
  assert.equal(metricMap['runnerComparison ts_local durationP95Ms']?.unit, 'ms')
  assert.equal(metricMap['runnerComparison ts_local truncatedCount']?.value, 2)
  assert.equal(metricMap['runnerComparison ts_local timeoutCount']?.value, 1)
  assert.equal(metricMap['runnerComparison ts_local cancelledCount']?.value, 1)
  assert.equal(metricMap['runnerComparison ts_local workspaceDeniedCount']?.direction, 'higher_is_better')
  assert.equal(metricMap['runnerComparison ts_local originalBytes']?.unit, 'bytes')
  assert.equal(metricMap['runnerComparison ts_local heapUsedDeltaBytes']?.unit, 'bytes')
  assert.equal(metricMap['runnerComparison go_remote durationP95Ms'], undefined)
})
