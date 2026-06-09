import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

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
 * - POST /v1/runtime/config/select  切换 profile (持久化)
 *
 * 收口标准：
 * - profile 列表与 active 状态可被远程客户端读取。
 * - apiKey 不出现在响应中。
 * - select 拒绝未知 profile，拒绝 model/role/roleModel 切换。
 *
 * 注意：ConfigManager.getInstance() 是进程级单例；本文件与
 * runtime.test.ts 等共享同一份单例。所有写入 / 读取都通过单例
 * 进行，测试间通过 save() + setProfile() 显式隔离 state。
 */

const sharedConfigPath = join(tmpdir(), `babel-o-config-endpoint-config-${process.pid}.json`)
process.env.BABEL_O_CONFIG_FILE = sharedConfigPath
const manager = ConfigManager.getInstance()
manager.save({})

function resetProfiles() {
  manager.save({})
}

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
      assert.ok(Array.isArray(provider.models))
    }
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

test('POST /v1/runtime/config/select rejects model / role switching (CLI-only)', async () => {
  resetProfiles()

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: '/tmp' })
  try {
    for (const payload of [{ model: 'x' }, { role: 'planner' }, { roleModel: 'x' }]) {
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

test('ConfigManager.hasProfile reports presence correctly', () => {
  resetProfiles()
  assert.equal(manager.hasProfile('missing'), false)
  manager.setProfile('present', { provider: 'local', model: 'local/coding-runtime' })
  assert.equal(manager.hasProfile('present'), true)
})
