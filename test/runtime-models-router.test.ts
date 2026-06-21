import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { ConfigManager } from '../src/shared/config.js'

const originalConfigFile = process.env.BABEL_O_CONFIG_FILE
const originalNodeEnv = process.env.NODE_ENV
const originalMoonshotApiKey = process.env.MOONSHOT_API_KEY
process.env.BABEL_O_CONFIG_FILE = join(tmpdir(), `babel-o-runtime-models-router-${process.pid}.json`)
process.env.NODE_ENV = 'test'

const manager = ConfigManager.getInstance()

after(() => {
  if (originalConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
  else process.env.BABEL_O_CONFIG_FILE = originalConfigFile
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalMoonshotApiKey === undefined) delete process.env.MOONSHOT_API_KEY
  else process.env.MOONSHOT_API_KEY = originalMoonshotApiKey
})

test('runtime models router preserves provider auth diagnostics without leaking secrets', async () => {
  manager.save({})
  delete process.env.MOONSHOT_API_KEY
  manager.setProviderConfig('minimax', {
    apiKey: 'provider-minimax-secret',
    baseUrl: 'https://api.minimaxi.com/anthropic',
  })
  manager.setProfile('moonshot-work', {
    provider: 'moonshot',
    model: 'moonshot/moonshot-v1-128k',
    apiKey: 'profile-moonshot-secret',
  })

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/models' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'runtime_models')
    assert.ok(Array.isArray(body.providers))
    assert.ok(body.providers.length > 0)

    const minimax = body.providers.find((provider: { id: string }) => provider.id === 'minimax')
    assert.equal(minimax.configured, true)
    assert.equal(minimax.authConfigured, true)
    assert.equal(minimax.authSource, 'provider_config')
    assert.ok(Array.isArray(minimax.models))

    const moonshot = body.providers.find((provider: { id: string }) => provider.id === 'moonshot')
    assert.equal(moonshot.configured, false)
    assert.equal(moonshot.authConfigured, true)
    assert.equal(moonshot.authSource, 'profile')

    const local = body.providers.find((provider: { id: string }) => provider.id === 'local')
    assert.equal(local.configured, true)
    assert.equal(local.authConfigured, true)
    assert.equal(local.authSource, 'none')

    const encoded = JSON.stringify(body)
    assert.doesNotMatch(encoded, /provider-minimax-secret/)
    assert.doesNotMatch(encoded, /profile-moonshot-secret/)
  } finally {
    await app.close()
  }
})

test('runtime models router reports env credentials without treating them as provider config', async () => {
  manager.save({})
  process.env.MOONSHOT_API_KEY = 'env-moonshot-secret'

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/models' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const moonshot = body.providers.find((provider: { id: string }) => provider.id === 'moonshot')
    assert.equal(moonshot.configured, false)
    assert.equal(moonshot.authConfigured, true)
    assert.equal(moonshot.authSource, 'env')
    assert.doesNotMatch(JSON.stringify(body), /env-moonshot-secret/)
  } finally {
    await app.close()
  }
})
