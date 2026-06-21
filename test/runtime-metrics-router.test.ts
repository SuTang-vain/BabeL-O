import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'

const originalConfigFile = process.env.BABEL_O_CONFIG_FILE
const originalNodeEnv = process.env.NODE_ENV
process.env.BABEL_O_CONFIG_FILE = join(tmpdir(), `babel-o-runtime-metrics-router-${process.pid}.json`)
process.env.NODE_ENV = 'test'

after(() => {
  if (originalConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
  else process.env.BABEL_O_CONFIG_FILE = originalConfigFile
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

test('runtime metrics router preserves runtime metrics snapshot contract', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/metrics' })
    assert.equal(response.statusCode, 200)

    const body = response.json()
    assert.equal(body.type, 'runtime_metrics')
    assert.ok(typeof body.startedAt === 'string')
    assert.ok(typeof body.uptimeMs === 'number')
    assert.equal(body.execute.count, 0)
    assert.equal(body.stream.count, 0)
    assert.equal(body.providerFirstTokenMs.count, 0)
    assert.equal(body.tokenUsage.inputTokens, 0)
    assert.equal(body.contextPolicy.prefixCache.sampleCount, 0)
    assert.deepEqual(body.routes, [])

    assert.equal(body.providerInvocations.count, 0)
    assert.equal(body.agentLoop.sessionsObserved, 0)
    assert.equal(body.agentLoop.taskCount, 0)
    assert.equal(body.agentJobs.count, 0)
    assert.ok(body.cacheHealth)
    assert.ok(body.cacheHealth.summary)
  } finally {
    await app.close()
  }
})
