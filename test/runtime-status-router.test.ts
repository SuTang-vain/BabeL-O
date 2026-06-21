import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { NEXUS_EVENT_SCHEMA_VERSION } from '../src/shared/events.js'

const originalConfigFile = process.env.BABEL_O_CONFIG_FILE
const originalNodeEnv = process.env.NODE_ENV
process.env.BABEL_O_CONFIG_FILE = join(tmpdir(), `babel-o-runtime-status-router-${process.pid}.json`)
process.env.NODE_ENV = 'test'

after(() => {
  if (originalConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
  else process.env.BABEL_O_CONFIG_FILE = originalConfigFile
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

test('runtime status router preserves health, status, and version route contracts', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const health = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(health.statusCode, 200)
    assert.equal(health.json().status, 'ok')
    assert.equal(health.json().runtime, 'babel-o')

    const status = await app.inject({ method: 'GET', url: '/v1/runtime/status' })
    assert.equal(status.statusCode, 200)
    const statusBody = status.json()
    assert.equal(statusBody.type, 'runtime_status')
    assert.equal(statusBody.health.status, 'ok')
    assert.ok(statusBody.provider)
    assert.ok(statusBody.providerSmoke)
    assert.ok(statusBody.everCore)
    assert.ok(statusBody.bootstrap)
    assert.ok(statusBody.metrics)
    assert.ok(Array.isArray(statusBody.sessions))

    const version = await app.inject({ method: 'GET', url: '/v1/runtime/version' })
    assert.equal(version.statusCode, 200)
    const versionBody = version.json()
    assert.equal(versionBody.type, 'runtime_version')
    assert.equal(versionBody.schemaVersion, NEXUS_EVENT_SCHEMA_VERSION)
    assert.deepEqual(versionBody.goTuiCompatibility.supportedMajors, [0])
    assert.deepEqual(versionBody.nodeCliCompatibility.supportedMajors, [0])
  } finally {
    await app.close()
  }
})
