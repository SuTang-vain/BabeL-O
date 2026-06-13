import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { ConfigManager } from '../src/shared/config.js'

/**
 * Phase / §5 路径 C 阶段 1: Go TUI 与其他远程客户端必须能从 Nexus
 * 拉取 config profile / active 视图，不必依赖 private 字段。
 *
 * 端点：
 * - GET  /v1/runtime/config         当前 ResolvedSettings (脱敏: 不返回 apiKey)
 * - GET  /v1/runtime/models         provider + model 清单 (含配置状态)
 * - POST /v1/runtime/config/select  切换 active profile 或 default model (持久化)
 *
 * 收口标准：
 * - profile 列表与 active 状态可被远程客户端读取。
 * - apiKey 不出现在响应中。
 * - select 接受 `profile` (切换 active profile) 或 `model` (切换 default
 *   model，供 Go TUI /model Step 4 一类 Picker 写入)；二者互斥。
 * - select 拒绝 role/roleModel 切换 (CLI-only)。
 * - select 拒绝未知 profile / 未知 model。
 *
 * 注意：ConfigManager.getInstance() 是进程级单例；本文件与
 * runtime.test.ts 等共享同一份单例。所有写入 / 读取都通过单例
 * 进行，测试间通过 save() + setProfile() 显式隔离 state。
 */

const sharedConfigPath = join(tmpdir(), `babel-o-config-endpoint-config-${process.pid}.json`)
process.env.BABEL_O_CONFIG_FILE = sharedConfigPath
const manager = ConfigManager.getInstance()
manager.save({})

const providerCredentialEnvKeys = [
  'BABEL_O_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ZHIPU_API_KEY',
  'ZHIPUAI_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_AUTH_TOKEN',
  'MOONSHOT_API_KEY',
  'OLLAMA_API_KEY',
] as const

const originalProviderCredentialEnv = new Map<string, string | undefined>(
  providerCredentialEnvKeys.map(key => [key, process.env[key]]),
)

function resetProfiles() {
  manager.save({})
  for (const key of providerCredentialEnvKeys) {
    delete process.env[key]
  }
}

after(() => {
  for (const [key, value] of originalProviderCredentialEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('GET /v1/runtime/config returns sanitized active settings without apiKey', async () => {
  resetProfiles()
  manager.setProfile('work', { provider: 'anthropic', model: 'anthropic/claude-test' })
  manager.setActiveProfile('work')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/config' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.providerId, 'anthropic')
    assert.equal(body.modelId, 'anthropic/claude-test')
    assert.equal(body.hasApiKey, false)
    assert.equal(body.apiKeySource, 'none')
    assert.ok(!('apiKey' in body), 'config response must not leak apiKey')
    assert.ok('capabilities' in body)
    assert.equal(typeof body.contextWindow, 'number')
  } finally {
    await app.close()
  }
})

test('GET /v1/runtime/models lists providers and models with configured flag', async () => {
  resetProfiles()

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/models' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.ok(Array.isArray(body.providers))
    assert.ok(body.providers.length > 0)
    for (const provider of body.providers) {
      assert.ok(typeof provider.id === 'string')
      assert.ok(typeof provider.displayName === 'string')
      assert.equal(typeof provider.configured, 'boolean')
      assert.equal(typeof provider.authConfigured, 'boolean')
      assert.equal(typeof provider.authSource, 'string')
      assert.ok(Array.isArray(provider.models))
    }
  } finally {
    await app.close()
  }
})

test('GET /v1/runtime/models reports profile apiKey as auth-only, not persisted provider configuration', async () => {
  resetProfiles()
  manager.setProfile('work', {
    provider: 'moonshot',
    model: 'moonshot/moonshot-v1-128k',
    apiKey: 'profile-moonshot-key',
  })

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/models' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const moonshot = body.providers.find((provider: { id: string }) => provider.id === 'moonshot')
    assert.equal(moonshot.configured, false)
    assert.equal(moonshot.authConfigured, true)
    assert.equal(moonshot.authSource, 'profile')
    assert.doesNotMatch(JSON.stringify(body), /profile-moonshot-key/)
  } finally {
    await app.close()
  }
})

test('GET /v1/runtime/models marks provider configured only for saved provider credentials', async () => {
  resetProfiles()
  manager.setProviderConfig('minimax', {
    apiKey: 'provider-minimax-key',
    baseUrl: 'https://api.minimaxi.com/anthropic',
  })

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/models' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const minimax = body.providers.find((provider: { id: string }) => provider.id === 'minimax')
    assert.equal(minimax.configured, true)
    assert.equal(minimax.authConfigured, true)
    assert.equal(minimax.authSource, 'provider_config')
    assert.doesNotMatch(JSON.stringify(body), /provider-minimax-key/)
  } finally {
    await app.close()
  }
})

test('GET /v1/runtime/models reports env credentials without treating them as persisted config', async () => {
  resetProfiles()
  process.env.MOONSHOT_API_KEY = 'env-moonshot-key'

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
    assert.doesNotMatch(JSON.stringify(body), /env-moonshot-key/)
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/provider saves provider credentials without leaking the key', async () => {
  resetProfiles()

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/provider',
      payload: {
        provider: 'minimax',
        apiKey: ' sk-minimax\r\n-test\t',
        baseUrl: 'https://api.minimaxi.com/anthropic',
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'runtime_config')
    assert.ok(!('apiKey' in body), 'provider config response must not leak apiKey')

    const reloaded = new ConfigManager(sharedConfigPath)
    assert.equal(reloaded.getProviderConfig('minimax').apiKey, 'sk-minimax-test')
    assert.equal(reloaded.getProviderConfig('minimax').baseUrl, 'https://api.minimaxi.com/anthropic')
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/provider rejects unknown providers', async () => {
  resetProfiles()

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/provider',
      payload: { provider: 'not-real', apiKey: 'secret' },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'unknown_provider')
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/select switches active profile and persists', async () => {
  resetProfiles()
  manager.setProfile('alpha', { provider: 'openai', model: 'openai/gpt-test' })
  manager.setProfile('beta', { provider: 'moonshot', model: 'moonshot/kimi-test' })
  manager.setActiveProfile('alpha')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/select',
      payload: { profile: 'beta' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.activeProfile, 'beta')
    assert.equal(body.providerId, 'moonshot')
    assert.equal(body.modelId, 'moonshot/kimi-test')

    // Confirm persistence: a fresh manager reading the same file must
    // see the new active profile.
    const reloaded = new ConfigManager(sharedConfigPath)
    assert.equal(reloaded.getActiveProfile(), 'beta')
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/select rejects unknown profile with 400', async () => {
  resetProfiles()

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/select',
      payload: { profile: 'nope' },
    })
    assert.equal(response.statusCode, 400)
    const body = response.json()
    assert.equal(body.error, 'unknown_profile')
    assert.equal(body.profile, 'nope')
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/select rejects role / roleModel switching (CLI-only)', async () => {
  resetProfiles()

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    for (const payload of [{ role: 'planner' }, { roleModel: 'x' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/runtime/config/select',
        payload,
      })
      assert.equal(response.statusCode, 400, JSON.stringify(payload))
      assert.equal(response.json().error, 'not_supported')
    }
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/select rejects empty / missing field with 400', async () => {
  resetProfiles()

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    for (const payload of [{}, { model: '' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/runtime/config/select',
        payload,
      })
      assert.equal(response.statusCode, 400, JSON.stringify(payload))
      assert.equal(response.json().error, 'missing_field')
    }
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/select rejects profile + model at the same time', async () => {
  resetProfiles()
  manager.setProfile('alpha', { provider: 'openai', model: 'openai/gpt-4o' })
  manager.setActiveProfile('alpha')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/select',
      payload: { profile: 'alpha', model: 'openai/gpt-4o' },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'mutually_exclusive')
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/select switches default model and persists', async () => {
  // No active profile so the resolved view reflects the new
  // defaultModel directly (resolveSettings falls through to
  // defaultModel when no profile is active).
  resetProfiles()

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/select',
      payload: { model: 'local/coding-runtime' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.modelId, 'local/coding-runtime')
    assert.equal(body.providerId, 'local')
    assert.equal(body.modelSource, 'default')

    // Confirm persistence: a fresh manager reading the same file
    // must observe the new default model.
    const reloaded = new ConfigManager(sharedConfigPath)
    assert.equal(reloaded.getDefaultModel(), 'local/coding-runtime')
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/select rejects API-key providers without credentials', async () => {
  resetProfiles()

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/select',
      payload: { model: 'minimax/MiniMax-M3' },
    })
    assert.equal(response.statusCode, 400)
    const body = response.json()
    assert.equal(body.error, 'missing_provider_api_key')
    assert.equal(body.provider, 'minimax')
    assert.equal(body.model, 'minimax/MiniMax-M3')
    assert.equal(body.command, 'bbl config add minimax <KEY>')
    assert.match(body.message, /Provider 'minimax' has no API key configured/)

    const reloaded = new ConfigManager(sharedConfigPath)
    assert.notEqual(reloaded.getDefaultModel(), 'minimax/MiniMax-M3')
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/select allows no-auth local and ollama models', async () => {
  resetProfiles()

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    for (const model of ['local/coding-runtime', 'ollama/qwen2.5-coder:7b']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/runtime/config/select',
        payload: { model },
      })
      assert.equal(response.statusCode, 200, `${model}: ${response.body}`)
      assert.equal(new ConfigManager(sharedConfigPath).getDefaultModel(), model)
    }
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/select model switch clears active profile so the TUI selection takes effect', async () => {
  // /model is an interactive "use this model now" flow. If an active
  // profile remains selected, resolveSettings() would keep returning the
  // profile model and the user would see a successful save that does not
  // actually affect the current runtime model.
  resetProfiles()
  manager.setProfile('alpha', { provider: 'openai', model: 'openai/gpt-4o' })
  manager.setActiveProfile('alpha')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/select',
      payload: { model: 'local/coding-runtime' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.modelId, 'local/coding-runtime')
    assert.equal(body.activeProfile, undefined)

    const reloaded = new ConfigManager(sharedConfigPath)
    assert.equal(reloaded.getDefaultModel(), 'local/coding-runtime')
    assert.equal(reloaded.getActiveProfile(), undefined)
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/select rejects unknown model with 400', async () => {
  resetProfiles()

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/select',
      payload: { model: 'definitely/not-a-model' },
    })
    assert.equal(response.statusCode, 400)
    const body = response.json()
    assert.equal(body.error, 'unknown_model')
    assert.equal(body.model, 'definitely/not-a-model')
  } finally {
    await app.close()
  }
})

test('ConfigManager.hasProfile reports presence correctly', () => {
  resetProfiles()
  assert.equal(manager.hasProfile('missing'), false)
  manager.setProfile('present', { provider: 'local', model: 'local/coding-runtime' })
  assert.equal(manager.hasProfile('present'), true)
})

// === 路径 C 阶段 2: 增量拉取 + tombstone + profile 切换命令 ===

test('GET /v1/runtime/config exposes version and tombstones', async () => {
  resetProfiles()
  manager.setProfile('work', { provider: 'anthropic', model: 'anthropic/claude-test' })
  manager.setActiveProfile('work')
  const versionBeforeDelete = manager.getConfigVersion()

  manager.deleteProfile('work')
  const versionAfterDelete = manager.getConfigVersion()
  assert.ok(versionAfterDelete > versionBeforeDelete, 'version must bump on delete')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/config' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(typeof body.version, 'number')
    assert.ok(body.version >= versionAfterDelete)
    assert.ok(body.tombstones && Object.keys(body.tombstones).includes('work'))
    assert.equal(body.tombstones.work.deletedAt.length > 0, true)
  } finally {
    await app.close()
  }
})

test('GET /v1/runtime/config?since returns 304 when no change since given version', async () => {
  resetProfiles()
  manager.setProfile('work', { provider: 'local', model: 'local/coding-runtime' })
  manager.setActiveProfile('work')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const current = await app.inject({ method: 'GET', url: '/v1/runtime/config' })
    assert.equal(current.statusCode, 200)
    const version = current.json().version
    assert.ok(typeof version === 'number')

    const unchanged = await app.inject({
      method: 'GET',
      url: `/v1/runtime/config?since=${version}`,
    })
    assert.equal(unchanged.statusCode, 304, `expected 304, got ${unchanged.statusCode} body=${unchanged.body}`)

    // A since value beyond the current version also returns 304.
    const future = await app.inject({
      method: 'GET',
      url: `/v1/runtime/config?since=${version + 10}`,
    })
    assert.equal(future.statusCode, 304)

    // Any modification bumps the version, so the next since=version
    // request must return 200.
    manager.setActiveProfile('work')
    const afterBump = await app.inject({
      method: 'GET',
      url: `/v1/runtime/config?since=${version}`,
    })
    assert.equal(afterBump.statusCode, 200)
    assert.ok(afterBump.json().version > version)
  } finally {
    await app.close()
  }
})

test('GET /v1/runtime/config/profiles exposes version and tombstones', async () => {
  resetProfiles()
  manager.setProfile('work', { provider: 'anthropic', model: 'anthropic/claude-test' })
  manager.setProfile('personal', { provider: 'openai', model: 'openai/gpt-test' })
  manager.setActiveProfile('work')
  manager.deleteProfile('personal')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/config/profiles' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(typeof body.version, 'number')
    assert.equal(body.activeProfile, 'work')
    assert.equal(body.profiles.length, 1)
    assert.equal(body.profiles[0].name, 'work')
    assert.equal(body.profiles[0].active, true)
    assert.ok(Object.keys(body.tombstones).includes('personal'))
  } finally {
    await app.close()
  }
})

test('POST /v1/runtime/config/select rejects tombstoned profile with 400', async () => {
  resetProfiles()
  manager.setProfile('work', { provider: 'anthropic', model: 'anthropic/claude-test' })
  manager.setActiveProfile('work')
  manager.deleteProfile('work')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/select',
      payload: { profile: 'work' },
    })
    assert.equal(response.statusCode, 400)
    const body = response.json()
    assert.equal(body.error, 'tombstoned_profile')
    assert.equal(body.profile, 'work')
    assert.ok(body.tombstone && body.tombstone.deletedAt)
  } finally {
    await app.close()
  }
})

test('ConfigManager.deleteProfile moves profile to tombstones and bumps version', () => {
  resetProfiles()
  manager.setProfile('work', { provider: 'local', model: 'local/coding-runtime' })
  const versionBefore = manager.getConfigVersion()
  manager.deleteProfile('work')
  assert.equal(manager.hasProfile('work'), false)
  assert.equal(manager.isProfileTombstoned('work'), true)
  const tombstones = manager.getTombstones()
  assert.ok(tombstones.work)
  assert.ok(tombstones.work.deletedAt.length > 0)
  assert.ok(manager.getConfigVersion() > versionBefore)
})

test('ConfigManager.restoreProfile clears tombstone and bumps version', () => {
  resetProfiles()
  manager.setProfile('work', { provider: 'local', model: 'local/coding-runtime' })
  manager.deleteProfile('work')
  assert.equal(manager.isProfileTombstoned('work'), true)
  const versionBefore = manager.getConfigVersion()
  const ok = manager.restoreProfile('work')
  assert.equal(ok, true)
  assert.equal(manager.isProfileTombstoned('work'), false)
  // hasProfile stays false because restore only clears the tombstone,
  // it does not recreate the profile config.
  assert.equal(manager.hasProfile('work'), false)
  assert.ok(manager.getConfigVersion() > versionBefore)
})

test('ConfigManager.setProfile clears stale tombstone for the same profile name', () => {
  resetProfiles()
  manager.setProfile('work', { provider: 'local', model: 'local/coding-runtime' })
  manager.deleteProfile('work')
  assert.equal(manager.isProfileTombstoned('work'), true)

  manager.setProfile('work', { provider: 'openai', model: 'openai/gpt-test' })
  assert.equal(manager.hasProfile('work'), true)
  assert.equal(manager.isProfileTombstoned('work'), false)
})

test('ConfigManager.save bumps configVersion on every call', () => {
  resetProfiles()
  const v0 = manager.getConfigVersion()
  manager.save({})
  const v1 = manager.getConfigVersion()
  manager.save({})
  const v2 = manager.getConfigVersion()
  assert.ok(v1 > v0)
  assert.ok(v2 > v1)
})

/**
 * Phase 8 PR1: GET /v1/runtime/version 端点。
 * 客户端启动时拉这个端点做 major-version 兼容性检查。
 * 响应脱敏，不返回 secret；schemaVersion 用于客户端决定
 * 它跟 Nexus 协议层是否还在同代。
 */
test('GET /v1/runtime/version returns server version + goTui compatibility range', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/version' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'runtime_version')
    assert.equal(typeof body.serverVersion, 'string')
    assert.ok(body.serverVersion.length > 0, 'serverVersion should be a non-empty string')
    assert.equal(typeof body.schemaVersion, 'string')
    assert.ok(body.schemaVersion.length > 0, 'schemaVersion should be a non-empty string')
    // supportedMajors + latestSupported must be present
    // and well-typed so the Go TUI can iterate without
    // runtime guards.
    assert.ok(Array.isArray(body.goTuiCompatibility.supportedMajors))
    assert.equal(typeof body.goTuiCompatibility.latestSupported, 'string')
    assert.ok(Array.isArray(body.nodeCliCompatibility.supportedMajors))
    assert.equal(typeof body.nodeCliCompatibility.latestSupported, 'string')
  } finally {
    await app.close()
  }
})

test('GET /v1/runtime/version does not leak secrets', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/version' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const serialized = JSON.stringify(body)
    // The version response should never carry any secret-like
    // fields. apiKey is the canonical secret; we assert on
    // its absence explicitly.
    assert.equal(
      serialized.includes('apiKey'),
      false,
      '/v1/runtime/version response must not include apiKey',
    )
    assert.equal(
      serialized.includes('api_key'),
      false,
      '/v1/runtime/version response must not include api_key',
    )
  } finally {
    await app.close()
  }
})
