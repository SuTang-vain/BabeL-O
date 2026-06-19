import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { ConfigManager } from '../src/shared/config.js'

const originalConfigFile = process.env.BABEL_O_CONFIG_FILE
const originalNodeEnv = process.env.NODE_ENV
process.env.BABEL_O_CONFIG_FILE = join(tmpdir(), `babel-o-runtime-config-mutation-router-${process.pid}.json`)
process.env.NODE_ENV = 'test'

const manager = ConfigManager.getInstance()

after(() => {
  if (originalConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
  else process.env.BABEL_O_CONFIG_FILE = originalConfigFile
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

test('runtime config mutation router preserves provider save and model select contracts', async () => {
  manager.save({})
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const providerResponse = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/provider',
      payload: {
        provider: 'minimax',
        apiKey: 'sk-router-secret',
        baseUrl: 'https://api.minimaxi.com/anthropic',
      },
    })
    assert.equal(providerResponse.statusCode, 200)
    const providerBody = providerResponse.json()
    assert.equal(providerBody.type, 'runtime_config')
    assert.ok(!('apiKey' in providerBody))
    assert.doesNotMatch(JSON.stringify(providerBody), /sk-router-secret/)
    assert.equal(manager.getProviderConfig('minimax').apiKey, 'sk-router-secret')

    const selectResponse = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/select',
      payload: { model: 'local/coding-runtime' },
    })
    assert.equal(selectResponse.statusCode, 200)
    const selectBody = selectResponse.json()
    assert.equal(selectBody.type, 'runtime_config')
    assert.equal(selectBody.modelId, 'local/coding-runtime')
    assert.equal(selectBody.providerId, 'local')
    assert.equal(manager.getDefaultModel(), 'local/coding-runtime')
  } finally {
    await app.close()
  }
})
