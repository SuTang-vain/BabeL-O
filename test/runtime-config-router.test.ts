import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { ConfigManager } from '../src/shared/config.js'

const originalConfigFile = process.env.BABEL_O_CONFIG_FILE
const originalNodeEnv = process.env.NODE_ENV
const configFile = join(tmpdir(), `babel-o-runtime-config-router-${process.pid}.json`)
process.env.BABEL_O_CONFIG_FILE = configFile
process.env.NODE_ENV = 'test'

const manager = ConfigManager.getInstance()

after(() => {
  if (originalConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
  else process.env.BABEL_O_CONFIG_FILE = originalConfigFile
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

test('runtime config router preserves sanitized config, profiles, detail, and since contracts', async () => {
  manager.save({})
  manager.setProfile('work', {
    provider: 'local',
    model: 'local/coding-runtime',
    apiKey: 'profile-secret',
    baseUrl: 'https://example.invalid',
  })
  manager.setProfile('personal', { provider: 'openai', model: 'openai/gpt-test' })
  manager.setActiveProfile('work')
  manager.deleteProfile('personal')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const config = await app.inject({ method: 'GET', url: '/v1/runtime/config' })
    assert.equal(config.statusCode, 200)
    const configBody = config.json()
    assert.equal(configBody.type, 'runtime_config')
    assert.equal(configBody.activeProfile, 'work')
    assert.equal(configBody.modelId, 'local/coding-runtime')
    assert.ok(!('apiKey' in configBody), 'config response must not leak apiKey')

    const unchanged = await app.inject({
      method: 'GET',
      url: `/v1/runtime/config?since=${configBody.version}`,
    })
    assert.equal(unchanged.statusCode, 304)

    const profiles = await app.inject({ method: 'GET', url: '/v1/runtime/config/profiles' })
    assert.equal(profiles.statusCode, 200)
    const profilesBody = profiles.json()
    assert.equal(profilesBody.type, 'runtime_config_profiles')
    assert.equal(profilesBody.activeProfile, 'work')
    assert.equal(profilesBody.profiles.length, 1)
    assert.equal(profilesBody.profiles[0].name, 'work')
    assert.equal(profilesBody.profiles[0].active, true)
    assert.equal(profilesBody.profiles[0].hasApiKey, true)
    assert.ok(!('apiKey' in profilesBody.profiles[0]), 'profile list must not leak apiKey')
    assert.ok(Object.keys(profilesBody.tombstones).includes('personal'))

    const detail = await app.inject({ method: 'GET', url: '/v1/runtime/config/profiles/work' })
    assert.equal(detail.statusCode, 200)
    const detailBody = detail.json()
    assert.equal(detailBody.type, 'runtime_config_profile')
    assert.equal(detailBody.found, true)
    assert.equal(detailBody.profile.name, 'work')
    assert.ok(!('apiKey' in detailBody.profile), 'profile detail must not leak apiKey')

    const missing = await app.inject({ method: 'GET', url: '/v1/runtime/config/profiles/missing' })
    assert.equal(missing.statusCode, 200)
    assert.equal(missing.json().found, false)
  } finally {
    await app.close()
  }
})
