import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { ConfigManager } from '../src/shared/config.js'

const originalConfigFile = process.env.BABEL_O_CONFIG_FILE
const originalNodeEnv = process.env.NODE_ENV
process.env.BABEL_O_CONFIG_FILE = join(tmpdir(), `babel-o-runtime-provider-diagnostics-router-${process.pid}.json`)
process.env.NODE_ENV = 'test'

after(() => {
  if (originalConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
  else process.env.BABEL_O_CONFIG_FILE = originalConfigFile
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

test('runtime provider diagnostics router preserves dry-run smoke and fallback plan contracts', async () => {
  ConfigManager.getInstance().save({})
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const smoke = await app.inject({
      method: 'GET',
      url: '/v1/runtime/provider-smoke?requireTools=false&requireStreaming=false&requireStructuredOutput=true',
    })
    assert.equal(smoke.statusCode, 200)
    const smokeBody = smoke.json()
    assert.equal(smokeBody.type, 'provider_smoke')
    assert.equal(smokeBody.mode, 'dry_run')
    assert.equal(smokeBody.requirements.tools, false)
    assert.equal(smokeBody.requirements.streaming, false)
    assert.equal(smokeBody.requirements.structuredOutput, true)
    assert.ok(smokeBody.provider)
    assert.ok(smokeBody.checks)
    assert.equal(smokeBody.fallbackPolicy.allowSilentModelSwitch, false)

    const fallback = await app.inject({
      method: 'POST',
      url: '/v1/runtime/provider-fallback/plan',
      payload: { kind: 'rate_limit' },
    })
    assert.equal(fallback.statusCode, 200)
    const fallbackBody = fallback.json()
    assert.equal(fallbackBody.type, 'provider_fallback_plan')
    assert.equal(fallbackBody.fallbackPolicy.allowSilentModelSwitch, false)
    assert.equal(fallbackBody.action.requiresUserConfirmation, true)
    assert.equal(fallbackBody.action.willSwitchModel, false)
    assert.equal(fallbackBody.action.willSwitchProvider, false)
    assert.equal(fallbackBody.action.willMutateConfig, false)
    assert.equal(fallbackBody.action.willCallProvider, false)
    assert.equal(fallbackBody.action.willCreateSession, false)
  } finally {
    await app.close()
  }
})
