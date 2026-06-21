import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { createExploreRuntime } from '../src/nexus/agents/AgentScheduler.js'
import { ConfigManager } from '../src/shared/config.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { LocalCodingRuntime } from '../src/runtime/LocalCodingRuntime.js'
import { LLMCodingRuntime } from '../src/runtime/LLMCodingRuntime.js'

test('ConfigManager instances can point at independent config files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'babel-o-config-manager-instance-'))
  const localConfig = new ConfigManager({ configFile: join(dir, 'local.json') })
  const llmConfig = new ConfigManager({ configFile: join(dir, 'llm.json') })

  localConfig.save({ defaultModel: 'local/coding-runtime' })
  llmConfig.save({ defaultModel: 'minimax/MiniMax-M3' })

  assert.equal(localConfig.resolveSettings().providerId, 'local')
  assert.equal(llmConfig.resolveSettings().providerId, 'minimax')
  assert.equal(new ConfigManager({ configFile: join(dir, 'local.json') }).getDefaultModel(), 'local/coding-runtime')
  assert.equal(new ConfigManager({ configFile: join(dir, 'llm.json') }).getDefaultModel(), 'minimax/MiniMax-M3')
})

test('createDefaultNexusRuntime uses an injected ConfigManager instance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'babel-o-config-manager-runtime-'))
  const localConfig = new ConfigManager({ configFile: join(dir, 'runtime-local.json') })
  const llmConfig = new ConfigManager({ configFile: join(dir, 'runtime-llm.json') })
  localConfig.save({ defaultModel: 'local/coding-runtime' })
  llmConfig.save({ defaultModel: 'minimax/MiniMax-M3' })

  const localBundle = await createDefaultNexusRuntime({
    storagePath: ':memory:',
    configManager: localConfig,
    disableAutoMemoryBootstrap: true,
  })
  const llmBundle = await createDefaultNexusRuntime({
    storagePath: ':memory:',
    configManager: llmConfig,
    disableAutoMemoryBootstrap: true,
  })

  try {
    assert.ok(localBundle.runtime instanceof LocalCodingRuntime)
    assert.ok(llmBundle.runtime instanceof LLMCodingRuntime)
  } finally {
    await localBundle.storage.close?.()
    await llmBundle.storage.close?.()
  }
})

test('createExploreRuntime uses an injected ConfigManager instance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'babel-o-config-manager-agent-'))
  const localConfig = new ConfigManager({ configFile: join(dir, 'agent-local.json') })
  const llmConfig = new ConfigManager({ configFile: join(dir, 'agent-llm.json') })
  localConfig.save({ defaultModel: 'local/coding-runtime' })
  llmConfig.save({ defaultModel: 'minimax/MiniMax-M3' })

  const localRuntime = createExploreRuntime({
    agentType: 'explore',
    allowedTools: ['Read'],
    storage: new MemoryStorage(),
    configManager: localConfig,
  })
  const llmRuntime = createExploreRuntime({
    agentType: 'explore',
    allowedTools: ['Read'],
    storage: new MemoryStorage(),
    configManager: llmConfig,
  })

  assert.ok(localRuntime instanceof LocalCodingRuntime)
  assert.ok(llmRuntime instanceof LLMCodingRuntime)
})
