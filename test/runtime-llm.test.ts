import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { z } from 'zod'
import { ConfigManager, createBabeLXConfigImportPlan, loadBabeLXConfigImportPlan } from '../src/shared/config.js'
import { LLMCodingRuntime, mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import { isRecoveryBoundaryError } from '../src/runtime/contextAssembler.js'
import { summarizeSessionEvents } from '../src/runtime/sessionSummary.js'
import { deriveFallbackUserIntentGuidance, formatUserIntentGuidance, shouldSuppressToolsForIntent, isPureMemoryCapabilityQuestion, normalizeGuidancePolicy, type UserIntentGuidance } from '../src/runtime/intentGuidance.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { allowAllTools, allowlistedTools } from '../src/runtime/LocalCodingRuntime.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { flushSessionMemoryLiteQueue } from '../src/runtime/sessionMemoryLite.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'
import { PendingPermissionRegistry } from '../src/shared/session.js'
import { CRITIC_ROLE, EXECUTOR_ROLE, PLANNER_ROLE } from '../src/nexus/agentRoles.js'
import { parseStructuredAgentOutput, zodRoleOutputSchemaToJsonSchema } from '../src/nexus/runtimeAgentStep.js'
import { createEverCoreMcpToolRegistry } from '../src/tools/everCoreMcpTools.js'
import type { EverCoreClient } from '../src/runtime/everCoreClient.js'
import type { EverCoreRuntimeConfig } from '../src/nexus/everCoreConfig.js'

const CONFIG_ENV_KEYS = [
  'BABEL_O_MODEL',
  'BABEL_O_PROVIDER',
  'BABEL_O_API_KEY',
  'BABEL_O_BASE_URL',
  'BABEL_O_CONFIG_FILE',
  'BABEL_O_TEST_CONFIG_WRITE_GUARD',
  'BABEL_O_SESSION_MEMORY_LITE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'ZHIPU_API_KEY',
  'ZHIPUAI_API_KEY',
  'ZHIPU_BASE_URL',
  'ZHIPUAI_BASE_URL',
  'MINIMAX_API_KEY',
  'MINIMAX_AUTH_TOKEN',
  'MINIMAX_BASE_URL',
  'MOONSHOT_API_KEY',
  'MOONSHOT_BASE_URL',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
] as const

type ConfigEnvSnapshot = Partial<Record<typeof CONFIG_ENV_KEYS[number], string>>

function snapshotConfigEnv(): ConfigEnvSnapshot {
  return Object.fromEntries(
    CONFIG_ENV_KEYS
      .map(key => [key, process.env[key]] as const)
      .filter((entry): entry is readonly [typeof CONFIG_ENV_KEYS[number], string] => entry[1] !== undefined),
  )
}

function clearConfigEnv(): void {
  for (const key of CONFIG_ENV_KEYS) {
    delete process.env[key]
  }
}

function restoreConfigEnv(snapshot: ConfigEnvSnapshot): void {
  clearConfigEnv()
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value
  }
}

function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

function createAnthropicTextStream(text: string): ReadableStream<Uint8Array> {
  return createMockStream([
    'event: content_block_start\n',
    'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\n',
    `data: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    'event: content_block_stop\n',
    'data: {"index":0}\n\n',
  ])
}

function createAnthropicToolUseStream(options: {
  id: string
  name: string
  input: unknown
}): ReadableStream<Uint8Array> {
  return createMockStream([
    'event: content_block_start\n',
    `data: ${JSON.stringify({ index: 0, content_block: { type: 'tool_use', id: options.id, name: options.name, input: {} } })}\n\n`,
    'event: content_block_delta\n',
    `data: ${JSON.stringify({ index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(options.input) } })}\n\n`,
    'event: content_block_stop\n',
    'data: {"index":0}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":16}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
  ])
}

async function collectEvents(iterable: AsyncIterable<NexusEvent>): Promise<NexusEvent[]> {
  const events: NexusEvent[] = []
  for await (const event of iterable) {
    events.push(event)
  }
  return events
}

function parseRequestBody(init?: RequestInit): any {
  if (typeof init?.body !== 'string') return undefined
  try {
    return JSON.parse(init.body)
  } catch {
    return undefined
  }
}

function isIntakeRequestBody(body: any): boolean {
  if (!body) return false
  if (typeof body.system === 'string' && body.system.includes('fast intake classifier')) return true
  if (Array.isArray(body.system) && JSON.stringify(body.system).includes('fast intake classifier')) return true
  if (Array.isArray(body.messages) && JSON.stringify(body.messages).includes('coding agent intake step')) return true
  return false
}

describe('ConfigManager', () => {
  let tempConfigPath: string
  let envSnapshot: ConfigEnvSnapshot

  beforeEach(() => {
    envSnapshot = snapshotConfigEnv()
    clearConfigEnv()
    tempConfigPath = join(tmpdir(), `babel-o-test-config-${Date.now()}-${Math.random()}.json`)
  })

  afterEach(() => {
    restoreConfigEnv(envSnapshot)
    if (fs.existsSync(tempConfigPath)) {
      try {
        fs.unlinkSync(tempConfigPath)
      } catch {}
    }
  })

  test('refuses to write default user config from tests without isolation', () => {
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
    const configManager = new ConfigManager(join(homedir(), '.babel-o', 'config.json'))

    assert.throws(
      () => configManager.save({}),
      (error: any) => error?.code === 'BABEL_O_TEST_CONFIG_NOT_ISOLATED',
    )
  })

  test('saves and loads configuration with 0o600 permissions', () => {
    const configManager = new ConfigManager(tempConfigPath)

    // Check loading non-existent config returns empty object
    const initial = configManager.load()
    assert.deepEqual(initial, {})

    // Set provider config
    configManager.setProviderConfig('anthropic', {
      apiKey: 'test-api-key',
      baseUrl: 'https://test.anthropic.com',
    })

    // Verify stats & permissions (macOS/Unix file mode check)
    assert.ok(fs.existsSync(tempConfigPath))
    const stat = fs.statSync(tempConfigPath)
    if (process.platform !== 'win32') {
      const mode = stat.mode & 0o777
      assert.equal(mode, 0o600)
    }

    // Load and check properties
    const reloaded = configManager.load()
    assert.equal(reloaded.providers?.anthropic?.apiKey, 'test-api-key')
    assert.equal(reloaded.providers?.anthropic?.baseUrl, 'https://test.anthropic.com')

    // Test default model configuration
    assert.equal(configManager.getDefaultModel(), 'local/coding-runtime')
    configManager.setDefaultModel('anthropic/claude-3-5-sonnet')
    assert.equal(configManager.getDefaultModel(), 'anthropic/claude-3-5-sonnet')
  })

  test('resolves settings with correct env var precedence', () => {
    const configManager = new ConfigManager(tempConfigPath)
    configManager.setProviderConfig('openai', {
      apiKey: 'config-openai-key',
      baseUrl: 'https://config.openai.com',
    })
    configManager.setDefaultModel('openai/gpt-4o')

    // Clean env variables that might pollute the test
    const oldBabelOModel = process.env.BABEL_O_MODEL
    const oldBabelOProvider = process.env.BABEL_O_PROVIDER
    const oldBabelOApiKey = process.env.BABEL_O_API_KEY
    const oldBabelOBaseUrl = process.env.BABEL_O_BASE_URL
    const oldOpenAiApiKey = process.env.OPENAI_API_KEY

    try {
      delete process.env.BABEL_O_MODEL
      delete process.env.BABEL_O_PROVIDER
      delete process.env.BABEL_O_API_KEY
      delete process.env.BABEL_O_BASE_URL
      delete process.env.OPENAI_API_KEY

      // 1. Resolve from config
      const resolvedFromConfig = configManager.resolveSettings()
      assert.equal(resolvedFromConfig.modelId, 'openai/gpt-4o')
      assert.equal(resolvedFromConfig.providerId, 'openai')
      assert.equal(resolvedFromConfig.apiKey, 'config-openai-key')
      assert.equal(resolvedFromConfig.apiKeySource, 'provider_config')
      assert.equal(resolvedFromConfig.baseUrl, 'https://config.openai.com')
      assert.equal(resolvedFromConfig.baseUrlSource, 'provider_config')

      const diagnosticsFromConfig = configManager.getProviderDiagnostics()
      assert.equal(diagnosticsFromConfig.providerId, 'openai')
      assert.equal(diagnosticsFromConfig.modelId, 'openai/gpt-4o')
      assert.equal(diagnosticsFromConfig.authConfigured, true)
      assert.equal(diagnosticsFromConfig.authSource, 'provider_config')
      assert.equal(diagnosticsFromConfig.capabilities.toolCalling, true)
      assert.equal(diagnosticsFromConfig.capabilities.structuredOutput, true)
      assert.equal(diagnosticsFromConfig.modelDeclared, true)
      assert.equal(diagnosticsFromConfig.capabilitySource, 'registry')
      assert.equal(diagnosticsFromConfig.suitability.agentLoopRoles.executor.suitable, true)

      // 2. Env variable fallback for API key
      process.env.OPENAI_API_KEY = 'env-openai-key'
      const resolvedFromProviderEnv = configManager.resolveSettings()
      assert.equal(resolvedFromProviderEnv.apiKey, 'env-openai-key')
      assert.equal(resolvedFromProviderEnv.apiKeySource, 'env')

      // 3. BABEL_O_API_KEY precedence over provider specific env
      process.env.BABEL_O_API_KEY = 'babel-o-env-key'
      const resolvedFromBabelOEnv = configManager.resolveSettings()
      assert.equal(resolvedFromBabelOEnv.apiKey, 'babel-o-env-key')

      // 4. Model env override
      process.env.BABEL_O_MODEL = 'anthropic/claude-3-opus'
      const resolvedModelOverride = configManager.resolveSettings()
      assert.equal(resolvedModelOverride.modelId, 'anthropic/claude-3-opus')
      assert.equal(resolvedModelOverride.providerId, 'anthropic')

      delete process.env.BABEL_O_MODEL
      delete process.env.BABEL_O_API_KEY
      process.env.MOONSHOT_API_KEY = 'env-moonshot-key'
      process.env.MOONSHOT_BASE_URL = 'https://moonshot.test/v1'
      const resolvedMoonshot = configManager.resolveSettings({ model: 'moonshot/moonshot-v1-128k' })
      assert.equal(resolvedMoonshot.providerId, 'moonshot')
      assert.equal(resolvedMoonshot.apiKey, 'env-moonshot-key')
      assert.equal(resolvedMoonshot.apiKeySource, 'env')
      assert.equal(resolvedMoonshot.baseUrl, 'https://moonshot.test/v1')
      assert.equal(resolvedMoonshot.baseUrlSource, 'env')

      delete process.env.MOONSHOT_API_KEY
      delete process.env.MOONSHOT_BASE_URL
      process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1'
      const resolvedOllama = configManager.resolveSettings({ model: 'ollama/qwen2.5-coder:7b' })
      assert.equal(resolvedOllama.providerId, 'ollama')
      assert.equal(resolvedOllama.apiKey, undefined)
      assert.equal(resolvedOllama.apiKeySource, 'none')
      assert.equal(resolvedOllama.baseUrl, 'http://127.0.0.1:11434/v1')
      assert.equal(resolvedOllama.baseUrlSource, 'env')
    } finally {
      // Restore env
      if (oldBabelOModel) process.env.BABEL_O_MODEL = oldBabelOModel; else delete process.env.BABEL_O_MODEL
      if (oldBabelOProvider) process.env.BABEL_O_PROVIDER = oldBabelOProvider; else delete process.env.BABEL_O_PROVIDER
      if (oldBabelOApiKey) process.env.BABEL_O_API_KEY = oldBabelOApiKey; else delete process.env.BABEL_O_API_KEY
      if (oldBabelOBaseUrl) process.env.BABEL_O_BASE_URL = oldBabelOBaseUrl; else delete process.env.BABEL_O_BASE_URL
      if (oldOpenAiApiKey) process.env.OPENAI_API_KEY = oldOpenAiApiKey; else delete process.env.OPENAI_API_KEY
    }
  })

  test('validates provider and profile options format', () => {
    const configManager = new ConfigManager(tempConfigPath)

    // Valid save should succeed
    configManager.save({
      defaultModel: 'openai/gpt-4o',
      providers: {
        openai: { apiKey: 'my-key', baseUrl: 'https://api.openai.com/v1' }
      }
    })

    // Invalid baseUrl should throw during save
    assert.throws(() => {
      configManager.save({
        providers: {
          openai: { baseUrl: 'not-a-valid-url' }
        }
      })
    })

    // Load method should fallback safely if configuration is invalid
    fs.writeFileSync(tempConfigPath, JSON.stringify({
      defaultModel: 'nonexistent/model',
    }), 'utf-8')
    const originalStderrWrite = process.stderr.write
    const previousLogLevel = process.env.NEXUS_LOG_LEVEL
    let gotErrorLog = false
    process.env.NEXUS_LOG_LEVEL = 'error'
    process.stderr.write = ((chunk: string | Uint8Array) => {
      gotErrorLog = String(chunk).includes('Invalid BabeL-O configuration file')
      return true
    }) as typeof process.stderr.write
    try {
      const configManager2 = new ConfigManager(tempConfigPath)
      const loaded = configManager2.load()
      assert.deepEqual(loaded, {})
      assert.ok(gotErrorLog)
    } finally {
      process.stderr.write = originalStderrWrite
      if (previousLogLevel === undefined) {
        delete process.env.NEXUS_LOG_LEVEL
      } else {
        process.env.NEXUS_LOG_LEVEL = previousLogLevel
      }
    }
  })

  test('supports profiles switching and resolution', () => {
    const configManager = new ConfigManager(tempConfigPath)

    configManager.save({
      defaultModel: 'local/coding-runtime',
      providers: {
        openai: { apiKey: 'global-key' }
      },
      profiles: {
        dev: {
          model: 'openai/gpt-4o',
          provider: 'openai',
          apiKey: 'dev-key',
          baseUrl: 'https://dev.openai.com/v1'
        },
        prod: {
          model: 'anthropic/claude-3-5-sonnet',
          provider: 'anthropic',
          apiKey: 'prod-key'
        }
      }
    })

    // No active profile: resolves to defaultModel/global provider configs
    const resDefault = configManager.resolveSettings()
    assert.equal(resDefault.modelId, 'local/coding-runtime')

    // Switch to dev profile
    configManager.setActiveProfile('dev')
    const resDev = configManager.resolveSettings()
    assert.equal(resDev.modelId, 'openai/gpt-4o')
    assert.equal(resDev.apiKey, 'dev-key')
    assert.equal(resDev.baseUrl, 'https://dev.openai.com/v1')

    // Switch to prod profile
    configManager.setActiveProfile('prod')
    const resProd = configManager.resolveSettings()
    assert.equal(resProd.modelId, 'anthropic/claude-3-5-sonnet')
    assert.equal(resProd.apiKey, 'prod-key')
    assert.equal(resProd.baseUrl, 'https://api.anthropic.com') // Default anthropic base URL fallback
  })

  test('profile roles field is parsed and loaded by ProfileConfigSchema', () => {
    const configManager = new ConfigManager(tempConfigPath)

    // Save a profile that has per-role model overrides
    configManager.save({
      defaultModel: 'local/coding-runtime',
      profiles: {
        roletest: {
          model: 'openai/gpt-4o',
          provider: 'openai',
          apiKey: 'role-key',
          roles: {
            planner: 'anthropic/claude-3-7-sonnet',
            executor: 'openai/gpt-4o',
            critic: 'anthropic/claude-3-5-sonnet',
          },
        },
      },
    })

    const loaded = configManager.load()
    const profile = loaded.profiles?.roletest
    assert.ok(profile, 'profile should exist')
    assert.equal(profile.roles?.planner, 'anthropic/claude-3-7-sonnet')
    assert.equal(profile.roles?.executor, 'openai/gpt-4o')
    assert.equal(profile.roles?.critic, 'anthropic/claude-3-5-sonnet')
    assert.equal(profile.roles?.optimizer, undefined)
  })

  test('resolveSettings respects role override over profile model', () => {
    const configManager = new ConfigManager(tempConfigPath)

    configManager.save({
      defaultModel: 'local/coding-runtime',
      activeProfile: 'roletest',
      profiles: {
        roletest: {
          model: 'openai/gpt-4o',
          provider: 'openai',
          apiKey: 'role-key',
          roles: {
            planner: 'anthropic/claude-3-7-sonnet',
          },
        },
      },
    })

    const oldBabelOModel = process.env.BABEL_O_MODEL
    try {
      delete process.env.BABEL_O_MODEL

      // With role=planner → should use roles.planner override
      const plannerSettings = configManager.resolveSettings('planner')
      assert.equal(plannerSettings.modelId, 'anthropic/claude-3-7-sonnet')

      // With role=executor (no override) → should fall back to profile.model
      const executorSettings = configManager.resolveSettings('executor')
      assert.equal(executorSettings.modelId, 'openai/gpt-4o')

      // With no role → should fall back to profile.model
      const noRoleSettings = configManager.resolveSettings()
      assert.equal(noRoleSettings.modelId, 'openai/gpt-4o')
    } finally {
      if (oldBabelOModel) process.env.BABEL_O_MODEL = oldBabelOModel
      else delete process.env.BABEL_O_MODEL
    }
  })

  test('provider diagnostics expose undeclared custom model capabilities without blocking config', () => {
    const configManager = new ConfigManager(tempConfigPath)

    configManager.save({
      defaultModel: 'openai/custom-gpt',
      providers: {
        openai: { apiKey: 'custom-openai-key' },
      },
    })

    const diagnostics = configManager.getProviderDiagnostics()

    assert.equal(diagnostics.providerId, 'openai')
    assert.equal(diagnostics.modelId, 'openai/custom-gpt')
    assert.equal(diagnostics.modelDeclared, false)
    assert.equal(diagnostics.capabilitySource, 'undeclared')
    assert.match(diagnostics.capabilityWarning ?? '', /not declared in the registry/)
    assert.equal(diagnostics.contextWindow, 8192)
    assert.equal(diagnostics.defaultMaxTokens, 4096)
    assert.equal(diagnostics.capabilities.toolCalling, false)
    assert.equal(diagnostics.capabilities.structuredOutput, false)
    assert.equal(diagnostics.suitability.agentLoopRoles.executor.suitable, false)
  })

  test('provider diagnostics use explicit provider for slashless custom model capabilities', () => {
    const configManager = new ConfigManager(tempConfigPath)

    configManager.save({
      providers: {
        openai: { apiKey: 'custom-openai-key' },
      },
    })

    const diagnostics = configManager.getProviderDiagnostics({ model: 'custom-gpt', provider: 'openai' })

    assert.equal(diagnostics.providerId, 'openai')
    assert.equal(diagnostics.modelId, 'custom-gpt')
    assert.equal(diagnostics.modelDeclared, false)
    assert.equal(diagnostics.capabilitySource, 'undeclared')
    assert.equal(diagnostics.authConfigured, true)
  })

  test('provider diagnostics expose role recommendation without switching models', () => {
    const configManager = new ConfigManager(tempConfigPath)

    configManager.save({
      defaultModel: 'local/coding-runtime',
      profiles: {
        roletest: {
          model: 'openai/gpt-4o',
          provider: 'openai',
          apiKey: 'role-key',
        },
      },
      activeProfile: 'roletest',
    })

    const oldBabelOModel = process.env.BABEL_O_MODEL
    try {
      delete process.env.BABEL_O_MODEL
      const plannerSettings = configManager.resolveSettings({ role: 'planner' })
      const plannerDiagnostics = configManager.getProviderDiagnostics({ role: 'planner' })

      assert.equal(plannerSettings.modelId, 'openai/gpt-4o')
      assert.equal(plannerSettings.modelSource, 'profile')
      assert.equal(plannerDiagnostics.modelId, 'openai/gpt-4o')
      assert.equal(plannerDiagnostics.roleRecommendation?.role, 'planner')
      assert.equal(plannerDiagnostics.roleRecommendation?.capability, 'long_context')
      assert.equal(plannerDiagnostics.roleRecommendation?.configured, false)
      assert.equal(plannerDiagnostics.roleRecommendation?.activeModelId, 'openai/gpt-4o')
      assert.equal(plannerDiagnostics.roleRecommendation?.willAutoSwitch, false)
    } finally {
      if (oldBabelOModel) process.env.BABEL_O_MODEL = oldBabelOModel
      else delete process.env.BABEL_O_MODEL
    }
  })

  test('creates explicit BabeL-X config import plan without transcript import', () => {
    const plan = createBabeLXConfigImportPlan({
      version: 1,
      activeProfile: 'minimax-work',
      profiles: [
        {
          name: 'minimax-work',
          type: 'minimax',
          apiKey: 'legacy-minimax-key',
          baseUrl: 'https://legacy.minimax.example/anthropic',
          defaultModel: 'minimax-m2.7-highspeed',
        },
        {
          name: 'moonshot-old',
          type: 'moonshot',
          apiKey: 'legacy-moonshot-key',
          defaultModel: 'moonshot-v1-auto',
        },
        {
          name: 'empty-key',
          type: 'openai',
          apiKey: '',
        },
      ],
      settings: { telemetry: false, autoUpdate: true },
    })

    assert.equal(plan.sourceSchema, 'babel-x-config-v1')
    assert.equal(plan.transcriptImportSupported, false)
    assert.deepEqual(plan.importedProfiles, [
      {
        name: 'minimax-work',
        providerId: 'minimax',
        modelId: 'minimax/MiniMax-M2.7-highspeed',
        hasApiKey: true,
        hasBaseUrl: true,
      },
      {
        name: 'moonshot-old',
        providerId: 'moonshot',
        modelId: 'moonshot/moonshot-v1-auto',
        hasApiKey: true,
        hasBaseUrl: false,
      },
    ])
    assert.deepEqual(plan.skippedProfiles, [
      {
        name: 'empty-key',
        providerId: 'openai',
        reason: 'profile has no API key',
      },
    ])
    assert.equal(plan.config.defaultModel, 'minimax/MiniMax-M2.7-highspeed')
    assert.equal(plan.config.activeProfile, 'minimax-work')
    assert.equal(plan.config.profiles?.['minimax-work']?.apiKey, 'legacy-minimax-key')
    assert.equal(plan.config.providers?.minimax?.apiKey, 'legacy-minimax-key')
    assert.equal(plan.config.profiles?.['moonshot-old']?.model, 'moonshot/moonshot-v1-auto')
    assert.equal(plan.config.providers?.moonshot?.apiKey, 'legacy-moonshot-key')
    assert.match(plan.warnings.join('\n'), /transcripts are not imported/)
  })

  test('loads BabeL-X import plan only from an explicit file path', () => {
    const legacyConfigPath = join(tmpdir(), `babel-x-test-config-${Date.now()}-${Math.random()}.json`)
    fs.writeFileSync(legacyConfigPath, JSON.stringify({
      version: 1,
      activeProfile: 'zhipu-default',
      profiles: [
        {
          name: 'zhipu-default',
          type: 'zhipu',
          apiKey: 'legacy-zhipu-key',
          baseUrl: 'https://open.bigmodel.cn/api/anthropic',
          defaultModel: 'glm-5.1',
        },
      ],
      settings: { telemetry: false, autoUpdate: true },
    }), 'utf-8')

    try {
      const plan = loadBabeLXConfigImportPlan(legacyConfigPath)
      assert.equal(plan.importedProfiles[0]?.modelId, 'zhipu/glm-5.1')
      const isolatedConfig = new ConfigManager(tempConfigPath)
      assert.deepEqual(isolatedConfig.load(), {})
    } finally {
      fs.unlinkSync(legacyConfigPath)
    }
  })

  test('resolveSettings respects request model over env, role, and profile defaults', () => {
    const configManager = new ConfigManager(tempConfigPath)

    configManager.save({
      defaultModel: 'local/coding-runtime',
      activeProfile: 'roletest',
      profiles: {
        roletest: {
          model: 'openai/gpt-4o',
          provider: 'openai',
          apiKey: 'role-key',
          roles: {
            planner: 'anthropic/claude-3-7-sonnet',
          },
        },
      },
    })

    const oldBabelOModel = process.env.BABEL_O_MODEL
    const oldBabelOProvider = process.env.BABEL_O_PROVIDER
    try {
      process.env.BABEL_O_MODEL = 'anthropic/claude-3-opus'
      process.env.BABEL_O_PROVIDER = 'openai'

      const requestSettings = configManager.resolveSettings({
        role: 'planner',
        model: 'deepseek/deepseek-v4-pro',
      })
      assert.equal(requestSettings.modelId, 'deepseek/deepseek-v4-pro')
      assert.equal(requestSettings.providerId, 'deepseek')
      assert.equal(requestSettings.modelSource, 'request')

      const roleSettings = configManager.resolveSettings({ role: 'planner' })
      assert.equal(roleSettings.modelId, 'anthropic/claude-3-opus')
      assert.equal(roleSettings.providerId, 'anthropic')
      assert.equal(roleSettings.modelSource, 'env')
    } finally {
      if (oldBabelOModel) process.env.BABEL_O_MODEL = oldBabelOModel
      else delete process.env.BABEL_O_MODEL
      if (oldBabelOProvider) process.env.BABEL_O_PROVIDER = oldBabelOProvider
      else delete process.env.BABEL_O_PROVIDER
    }
  })
})

describe('User intent fallback guidance', () => {
  test('classifies identity and memory prompts as respond-only without tools', () => {
    const identity = deriveFallbackUserIntentGuidance({
      events: [],
      latestPrompt: '你是谁？',
      cwd: tmpdir(),
    })
    assert.equal(identity.intent, 'greeting')
    assert.equal(identity.actionHint, 'respond_only')
    assert.equal(identity.requiresTools, false)
    assert.equal(shouldSuppressToolsForIntent(identity), true)

    const memory = deriveFallbackUserIntentGuidance({
      events: [],
      latestPrompt: '还记得我刚刚问什么吗？',
      cwd: tmpdir(),
    })
    assert.equal(memory.intent, 'status')
    assert.equal(memory.actionHint, 'respond_only')
    assert.equal(memory.requiresTools, false)
    assert.equal(shouldSuppressToolsForIntent(memory), false)
  })

  test('keeps explicit memory-save prompts tool-required', () => {
    const guidance = deriveFallbackUserIntentGuidance({
      events: [],
      latestPrompt: '请立即使用 mcp:evercore:memory_save_note 保存长期记忆：我偏好 regression-first 修复。',
      cwd: tmpdir(),
    })
    assert.equal(guidance.intent, 'continue')
    assert.equal(guidance.actionHint, 'normal')
    assert.equal(guidance.requiresTools, true)
    assert.equal(shouldSuppressToolsForIntent(guidance), false)
  })

  test('keeps memory capability questions respond-only without tools', () => {
    const guidance = deriveFallbackUserIntentGuidance({
      events: [],
      latestPrompt: '你当前能否写入记忆？',
      cwd: tmpdir(),
    })
    assert.equal(guidance.intent, 'status')
    assert.equal(guidance.actionHint, 'respond_only')
    assert.equal(guidance.requiresTools, false)
    assert.equal(shouldSuppressToolsForIntent(guidance), true)
    assert.match(formatUserIntentGuidance(guidance), /Intent category: pure_capability_question/)
    assert.equal('guidance' in guidance, false)
  })

  test('keeps memory availability checks tool-required', () => {
    const prompts = [
      '执行一下长期记忆是否可用',
      '查看当前长期记忆是否可用',
      '检查长期记忆是否启用',
      '测试长期记忆读写是否可用',
      '跑一下 memory status',
    ]

    for (const latestPrompt of prompts) {
      const guidance = deriveFallbackUserIntentGuidance({
        events: [],
        latestPrompt,
        cwd: tmpdir(),
      })
      assert.equal(guidance.intent, 'status')
      assert.equal(guidance.actionHint, 'normal')
      assert.equal(guidance.requiresTools, true)
      assert.equal(shouldSuppressToolsForIntent(guidance), false)
      assert.match(formatUserIntentGuidance(guidance), /Intent category: availability_check/)
      assert.match(formatUserIntentGuidance(guidance), /Tool mode: enabled/)
    }
  })

  test('keeps general current-state verification prompts tool-required', () => {
    const prompts = [
      '查看当前配置是否生效',
      '检查当前 provider 是否支持 tool call',
      '验证这个 session 是否记录了事件',
      '`workspace_dirty_detected` push 模型解释一下这部分',
      '这个不就是源码吗/Users/tangyaoyue/DEV/Baidu/Baidu/钢架雪车/index.html',
      '所以目前的核心问题在于，文档说明不足、内核耦合性问题？',
    ]

    for (const latestPrompt of prompts) {
      const guidance = deriveFallbackUserIntentGuidance({
        events: [],
        latestPrompt,
        cwd: tmpdir(),
      })
      assert.equal(guidance.intent, 'continue')
      assert.equal(guidance.actionHint, 'normal')
      assert.equal(guidance.requiresTools, true)
      assert.equal(shouldSuppressToolsForIntent(guidance), false)
      assert.match(formatUserIntentGuidance(guidance), /Intent category: availability_check/)
      assert.match(formatUserIntentGuidance(guidance), /Tool mode: enabled/)
    }
  })

  test('keeps pure memory capability and conversational status direct-answer', () => {
    const memoryCapability = deriveFallbackUserIntentGuidance({
      events: [],
      latestPrompt: '你有长期记忆吗？',
      cwd: tmpdir(),
    })
    assert.equal(memoryCapability.intent, 'status')
    assert.equal(memoryCapability.actionHint, 'respond_only')
    assert.equal(memoryCapability.requiresTools, false)
    assert.equal(shouldSuppressToolsForIntent(memoryCapability), true)
    assert.match(formatUserIntentGuidance(memoryCapability), /Intent category: pure_capability_question/)

    const conversationalStatus = deriveFallbackUserIntentGuidance({
      events: [],
      latestPrompt: '你还在吗？',
      cwd: tmpdir(),
    })
    assert.equal(conversationalStatus.intent, 'status')
    assert.equal(conversationalStatus.actionHint, 'respond_only')
    assert.equal(conversationalStatus.requiresTools, false)
    assert.equal(shouldSuppressToolsForIntent(conversationalStatus), false)
    assert.match(formatUserIntentGuidance(conversationalStatus), /Tool mode: available_for_verification/)
  })

  test('binds ambiguous problem analysis to agent failure after self-diagnosis history', () => {
    const events: NexusEvent[] = [
      {
        type: 'user_message',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: 'session-intent-target',
        timestamp: '2026-06-13T00:00:00.000Z',
        text: '为什么你会编？这是你系统prompt的问题吗？',
      },
    ]

    const guidance = deriveFallbackUserIntentGuidance({
      events,
      latestPrompt: '查看源码深度分析问题',
      cwd: tmpdir(),
    })

    assert.equal(guidance.intent, 'continue')
    assert.equal(guidance.requiresTools, true)
    assert.equal(guidance.problemTarget, 'agent_failure')
    const renderedPolicy = formatUserIntentGuidance(guidance)
    assert.match(renderedPolicy, /Problem target: agent_failure/)
    assert.match(renderedPolicy, /Evidence mode: verify_before_claim/)
    assert.match(renderedPolicy, /Stale task mode: background_only/)
    assert.doesNotMatch(renderedPolicy, /Guidance:|Instruction:|Do not switch back|Observed facts/)
  })

  test('keeps ordinary project problem analysis on project feature target', () => {
    const guidance = deriveFallbackUserIntentGuidance({
      events: [],
      latestPrompt: '查看项目源码，深度分析当前功能问题',
      cwd: tmpdir(),
    })

    assert.equal(guidance.intent, 'continue')
    assert.equal(guidance.requiresTools, true)
    assert.equal(guidance.problemTarget, 'project_feature')
    assert.match(formatUserIntentGuidance(guidance), /Evidence mode: standard/)
  })

  test('binds correction away from project to agent failure target', () => {
    const guidance = deriveFallbackUserIntentGuidance({
      events: [],
      latestPrompt: '不是项目本身，是你刚才为什么错',
      cwd: tmpdir(),
    })

    assert.equal(guidance.intent, 'correction')
    assert.equal(guidance.actionHint, 'prioritize_latest')
    assert.equal(guidance.problemTarget, 'agent_failure')
    assert.match(formatUserIntentGuidance(guidance), /Stale task mode: background_only/)
  })
})

describe('Intent tool suppression stopgap (Mode A + Mode B)', () => {
  // See docs/nexus/proposals/intent-tool-suppression-stopgap-plan.md.
  // Reproduces session_eafe6bfc Glob/Read suppression — same class as the
  // source-verified session_b7f64aa1 / session_9b1c212c in the intent-guidance
  // Active Plan.

  function modelGuidance(overrides: Partial<UserIntentGuidance>): UserIntentGuidance {
    return {
      intent: 'continue',
      confidence: 0.8,
      continuity: 0.8,
      contextScope: 'full',
      actionHint: 'normal',
      requiresTools: true,
      problemTarget: 'unknown',
      reason: 'test',
      latestUserText: 'continue with the next step',
      explicitPaths: [],
      source: 'model',
      ...overrides,
    }
  }

  test('Mode A: isPureMemoryCapabilityQuestion returns false when an action verb is present', () => {
    // Each prompt matches the capability-question regex (能否/可以/是否 ... 记忆)
    // AND carries an action verb. Before Fix A these are forced respond-only;
    // after Fix A the action verb wins.
    assert.equal(isPureMemoryCapabilityQuestion('能否分析记忆功能的设计'), false)
    assert.equal(isPureMemoryCapabilityQuestion('可以解释一下记忆模块吗'), false)
    assert.equal(isPureMemoryCapabilityQuestion('是否支持核对长期记忆的写入'), false)

    // Pure capability questions without action verbs stay respond-only (unchanged).
    assert.equal(isPureMemoryCapabilityQuestion('你当前能否写入记忆？'), true)
    assert.equal(isPureMemoryCapabilityQuestion('你有长期记忆吗？'), true)
    assert.equal(isPureMemoryCapabilityQuestion('长期记忆是否可用'), true)
  })

  test('Mode A: deriveFallbackUserIntentGuidance keeps analysis-of-memory tool-required', () => {
    const guidance = deriveFallbackUserIntentGuidance({
      events: [],
      latestPrompt: '能否分析记忆功能的设计',
      cwd: tmpdir(),
    })
    assert.equal(guidance.requiresTools, true)
    assert.equal(shouldSuppressToolsForIntent(guidance), false)
  })

  test('Mode B: continue + normal forces requiresTools=true so model tool calls are not suppressed', () => {
    const underclassified = normalizeGuidancePolicy(modelGuidance({
      actionHint: 'normal',
      requiresTools: false,
      latestUserText: '继续分析这个方案的可行性',
      reason: 'Pure analytical discussion, no tool-backed verification requested.',
    }))
    assert.equal(underclassified.requiresTools, true)
    assert.equal(underclassified.actionHint, 'normal')
    assert.equal(shouldSuppressToolsForIntent(underclassified), false)
  })

  test('Mode B negative: guard is scoped to intent=continue + actionHint=normal', () => {
    // prioritize_latest must NOT fire the guard — still suppressible when the
    // model said requiresTools=false.
    const prioritizeLatest = normalizeGuidancePolicy(modelGuidance({
      intent: 'continue',
      actionHint: 'prioritize_latest',
      requiresTools: false,
      latestUserText: 'look at this other path instead',
    }))
    assert.equal(prioritizeLatest.requiresTools, false)
    assert.equal(shouldSuppressToolsForIntent(prioritizeLatest), true)

    // pause normalizes to respond_only before the guard; still suppressed.
    const pause = normalizeGuidancePolicy(modelGuidance({
      intent: 'pause',
      actionHint: 'normal',
      requiresTools: false,
      latestUserText: '等一下',
    }))
    assert.equal(pause.actionHint, 'respond_only')
    assert.equal(pause.requiresTools, false)
    assert.equal(shouldSuppressToolsForIntent(pause), true)

    // status without tools normalizes to respond_only before the guard; not hard-suppressed.
    const status = normalizeGuidancePolicy(modelGuidance({
      intent: 'status',
      actionHint: 'normal',
      requiresTools: false,
      latestUserText: 'what is the current state',
    }))
    assert.equal(status.actionHint, 'respond_only')
    assert.equal(status.requiresTools, false)
    assert.equal(shouldSuppressToolsForIntent(status), false)
  })
})

describe('LLMCodingRuntime', () => {
  let tempConfigPath: string
  let configManager: ConfigManager
  let toolsRegistry: ReturnType<typeof createDefaultToolRegistry>
  let originalFetch: typeof globalThis.fetch
  let fetchCalls: { url: string; init?: RequestInit }[]
  let fetchStreamResponses: ReadableStream<Uint8Array>[]
  let envSnapshot: ConfigEnvSnapshot

  beforeEach(() => {
    envSnapshot = snapshotConfigEnv()
    clearConfigEnv()
    tempConfigPath = join(tmpdir(), `babel-o-test-config-${Date.now()}-${Math.random()}.json`)
    configManager = new ConfigManager(tempConfigPath)
    configManager.setProviderConfig('anthropic', {
      apiKey: 'anthropic-test-key',
      baseUrl: 'https://api.test-anthropic.com',
    })
    configManager.setDefaultModel('anthropic/claude-3-5-sonnet')

    toolsRegistry = createDefaultToolRegistry()
    fetchCalls = []
    fetchStreamResponses = []
    originalFetch = globalThis.fetch

    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"continue\\",\\"confidence\\":0.9,\\"continuity\\":0.8,\\"contextScope\\":\\"full\\",\\"actionHint\\":\\"normal\\",\\"requiresTools\\":true,\\"reason\\":\\"test intake\\",\\"guidance\\":\\"Proceed with the latest request.\\",\\"explicitPaths\\":[]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock intake response text',
        } as Response
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      const nextStream = fetchStreamResponses.shift() || createMockStream([])
      return {
        ok: true,
        status: 200,
        body: nextStream,
        text: async () => 'mock response text',
      } as Response
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreConfigEnv(envSnapshot)
    if (fs.existsSync(tempConfigPath)) {
      try {
        fs.unlinkSync(tempConfigPath)
      } catch {}
    }
  })

  test('emits assistant_delta and thinking_delta events during stream execution', async () => {
    // Mock SSE stream with thinking delta then text delta
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"thinking_delta","thinking":"Analyzing task"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
        'event: content_block_start\n',
        'data: {"index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":1,"delta":{"type":"text_delta","text":"The file contains info"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":1}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-session-123',
        prompt: 'analyze code',
        cwd: tmpdir(),
      })
    )

    // Verify events
    assert.ok(events.find(e => e.type === 'session_started'))

    const thinkingDelta = events.find(e => e.type === 'thinking_delta')
    assert.ok(thinkingDelta)
    assert.equal((thinkingDelta as any).text, 'Analyzing task')

    const assistantDelta = events.find(e => e.type === 'assistant_delta')
    assert.ok(assistantDelta)
    assert.equal((assistantDelta as any).text, 'The file contains info')

    const resultEvent = events.find(e => e.type === 'result')
    assert.ok(resultEvent)
    assert.equal((resultEvent as any).success, true)
    assert.equal((resultEvent as any).message, 'The file contains info')

    // Verify endpoint called is custom base URL
    assert.equal(fetchCalls.length, 1)
    assert.ok(fetchCalls[0].url.startsWith('https://api.test-anthropic.com'))
    const headers = fetchCalls[0].init?.headers as Record<string, string>
    assert.equal(headers?.['x-api-key'], 'anthropic-test-key')
  })

  test('skips Session Memory Lite write on no-tool final response (post-natural_pause retirement)', async () => {
    process.env.BABEL_O_SESSION_MEMORY_LITE = '1'
    // Post-R7: the per-turn non-tool summary path (`natural_pause`) was
    // retired. A single-turn no-tool response now hits `insufficient_signal`
    // and must NOT produce a memory file or a `session_memory_updated` event.
    const cwd = join(tmpdir(), `babel-o-runtime-session-memory-${Date.now()}-${Math.random()}`)
    const sessionId = 'test-session-memory-runtime'
    const storage = new MemoryStorage()
    const now = '2026-05-23T00:00:00.000Z'
    fs.mkdirSync(cwd, { recursive: true })
    await storage.saveSession({
      sessionId,
      cwd,
      prompt: 'summarize current state',
      phase: 'executing',
      createdAt: now,
      updatedAt: now,
      events: [],
    })
    await storage.appendEvent(sessionId, {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:01.000Z',
      text: 'summarize current state',
    })
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"Current state is stable."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), storage, configManager)
    try {
      for await (const event of runtime.executeStream({
        sessionId,
        prompt: 'summarize current state',
        cwd,
      })) {
        await storage.appendEvent(sessionId, event)
      }
      await flushSessionMemoryLiteQueue()

      const memoryPath = join(cwd, '.babel-o/session-memory.md')
      assert.equal(fs.existsSync(memoryPath), false)

      const persisted = await storage.listEvents(sessionId, { order: 'asc', limit: 10_000 })
      assert.equal(persisted.events.filter(event => event.type === 'session_memory_updated').length, 0)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('emits invocation hook events around provider calls', async () => {
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"Invocation hooks ran."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-invocation-hooks',
        prompt: 'answer with one sentence',
        cwd: tmpdir(),
        role: 'executor',
      })
    )

    const invocationHooks = events.filter(event =>
      event.type === 'hook_completed' &&
      event.hookName === 'InvocationDiagnosticsHook'
    ) as any[]
    assert.deepEqual(invocationHooks.map(event => event.hookEvent), ['PreInvocation', 'PostInvocation'])
    assert.equal(invocationHooks[0].output.metadata.providerId, 'anthropic')
    assert.equal(invocationHooks[0].output.metadata.modelId, 'anthropic/claude-3-5-sonnet')
    assert.equal(invocationHooks[0].output.metadata.loopCount, 1)
    assert.equal(invocationHooks[0].output.metadata.role, 'executor')
    assert.equal(invocationHooks[0].output.metadata.visibleToolCount, toolsRegistry.size)
    assert.equal(invocationHooks[1].output.metadata.success, true)
    assert.equal(typeof invocationHooks[1].output.metadata.durationMs, 'number')

    const preIndex = events.findIndex(event => event.type === 'hook_completed' && event.hookEvent === 'PreInvocation')
    const deltaIndex = events.findIndex(event => event.type === 'assistant_delta')
    const postIndex = events.findIndex(event => event.type === 'hook_completed' && event.hookEvent === 'PostInvocation')
    assert.ok(preIndex >= 0 && deltaIndex > preIndex && postIndex > deltaIndex)
  })

  test('passes maxOutputTokens to provider requests', async () => {
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"short"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    await collectEvents(
      runtime.executeStream({
        sessionId: 'test-max-output-tokens',
        prompt: 'answer briefly',
        cwd: tmpdir(),
        maxOutputTokens: 256,
      })
    )

    const body = JSON.parse(String(fetchCalls[0].init?.body))
    assert.equal(body.max_tokens, 256)
  })

  test('persists user_intake_guidance and hides tools for respond-only intake', async () => {
    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"pause\\",\\"confidence\\":0.96,\\"continuity\\":0.3,\\"contextScope\\":\\"recent\\",\\"actionHint\\":\\"respond_only\\",\\"requiresTools\\":false,\\"reason\\":\\"The user asked the agent to wait.\\",\\"guidance\\":\\"Acknowledge and wait without using tools.\\",\\"explicitPaths\\":[]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock intake response text',
        } as Response
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: true,
        status: 200,
        body: createMockStream([
          'event: content_block_start\n',
          'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\n',
          'data: {"index":0,"delta":{"type":"text_delta","text":"I will wait for your next request."}}\n\n',
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
        ]),
        text: async () => 'mock response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-intake-respond-only',
        prompt: 'just stop it and wait for me',
        cwd: tmpdir(),
      })
    )

    const intake = events.find(event => event.type === 'user_intake_guidance') as any
    assert.ok(intake)
    assert.equal(intake.intent, 'pause')
    assert.equal(intake.actionHint, 'respond_only')
    assert.equal(intake.requiresTools, false)
    assert.equal(intake.source, 'model')
    assert.equal('guidance' in intake, false)

    assert.equal(fetchCalls.length, 1)
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    assert.equal(body.tools, undefined)
    assert.match(JSON.stringify(body.system), /Turn Policy/)
  })

  test('persists self-diagnosis problemTarget even when intake model drifts to project_feature', async () => {
    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"continue\\",\\"confidence\\":0.8,\\"continuity\\":0.8,\\"contextScope\\":\\"full\\",\\"actionHint\\":\\"normal\\",\\"requiresTools\\":true,\\"problemTarget\\":\\"project_feature\\",\\"reason\\":\\"Analyze project source.\\",\\"guidance\\":\\"Analyze the project feature.\\",\\"explicitPaths\\":[]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock intake response text',
        } as Response
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: true,
        status: 200,
        body: createMockStream([
          'event: content_block_start\n',
          'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\n',
          'data: {"index":0,"delta":{"type":"text_delta","text":"I will inspect the runtime failure mode."}}\n\n',
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
        ]),
        text: async () => 'mock response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-intake-problem-target-self-diagnosis',
        prompt: '为什么你会编？这是你系统prompt的问题吗？',
        cwd: tmpdir(),
      })
    )

    const intake = events.find(event => event.type === 'user_intake_guidance') as any
    assert.ok(intake)
    assert.equal(intake.source, 'model')
    assert.equal(intake.problemTarget, 'agent_failure')
    assert.equal('guidance' in intake, false)

    assert.equal(fetchCalls.length, 1)
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    assert.match(JSON.stringify(body.system), /Problem target: agent_failure/)
    assert.match(JSON.stringify(body.system), /Evidence mode: verify_before_claim/)
    assert.match(JSON.stringify(body.system), /Stale task mode: background_only/)
    assert.doesNotMatch(JSON.stringify(body.system), /Guidance:|Instruction:|Do not switch back|Observed facts|agent\/runtime failure mode/)
  })

  test('falls back identity prompts to respond-only intake when intake model fails', async () => {
    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        throw new Error('mock intake unavailable')
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: true,
        status: 200,
        body: createMockStream([
          'event: content_block_start\n',
          'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\n',
          'data: {"index":0,"delta":{"type":"text_delta","text":"我是 BabeL-O，可以帮你处理编码任务。"}}\n\n',
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
        ]),
        text: async () => 'mock response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-intake-fallback-identity',
        prompt: '你是谁？',
        cwd: tmpdir(),
      }),
    )

    const intake = events.find(event => event.type === 'user_intake_guidance') as any
    assert.ok(intake)
    assert.equal(intake.intent, 'greeting')
    assert.equal(intake.actionHint, 'respond_only')
    assert.equal(intake.requiresTools, false)
    assert.equal(intake.source, 'fallback')

    assert.equal(fetchCalls.length, 1)
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    assert.equal(body.tools, undefined)
    assert.match(JSON.stringify(body.system), /Requires tools: no/)
  })

  test('falls back context-memory prompts to status guidance without hiding tools when intake model fails', async () => {
    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        throw new Error('mock intake unavailable')
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: true,
        status: 200,
        body: createMockStream([
          'event: content_block_start\n',
          'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\n',
          'data: {"index":0,"delta":{"type":"text_delta","text":"我会根据当前可见上下文回答。"}}\n\n',
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
        ]),
        text: async () => 'mock response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-intake-fallback-context-memory',
        prompt: '还记得我刚刚问什么吗？',
        cwd: tmpdir(),
      }),
    )

    const intake = events.find(event => event.type === 'user_intake_guidance') as any
    assert.ok(intake)
    assert.equal(intake.intent, 'status')
    assert.equal(intake.actionHint, 'respond_only')
    assert.equal(intake.requiresTools, false)
    assert.equal(intake.source, 'fallback')

    assert.equal(fetchCalls.length, 1)
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    const toolNames = body.tools.map((tool: any) => tool.name).sort()
    assert.deepEqual(toolNames, [...toolsRegistry.keys()].sort())
    assert.match(JSON.stringify(body.system), /Requires tools: no/)
    assert.match(JSON.stringify(body.system), /Tool mode: available_for_verification/)
  })

  test('loads latest session tail before building intake guidance', async () => {
    const sessionId = 'test-long-session-tail-intake'
    const storage = new MemoryStorage()
    const oldEvents: NexusEvent[] = []
    for (let index = 0; index < 1100; index += 1) {
      oldEvents.push({
        type: 'assistant_delta',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: new Date(Date.UTC(2026, 4, 29, 15, 0, index)).toISOString(),
        text: `old event ${index} `,
      })
    }
    oldEvents.push({
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-29T15:22:48.000Z',
      text: '你好？',
    })
    await storage.saveSession({
      sessionId,
      cwd: tmpdir(),
      prompt: 'old prompt',
      phase: 'created',
      createdAt: '2026-05-29T15:00:00.000Z',
      updatedAt: '2026-05-29T15:22:48.000Z',
      events: oldEvents,
    })

    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        const bodyText = JSON.stringify(body)
        assert.match(bodyText, /你好？/)
        assert.doesNotMatch(bodyText, /old event 0/)
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"greeting\\",\\"confidence\\":0.9,\\"continuity\\":0.7,\\"contextScope\\":\\"full\\",\\"actionHint\\":\\"respond_only\\",\\"requiresTools\\":false,\\"reason\\":\\"Greeting.\\",\\"guidance\\":\\"Reply briefly.\\",\\"explicitPaths\\":[\\"/Users/tangyaoyou/DEV/gemini-cli\\"]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock intake response text',
        } as Response
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: true,
        status: 200,
        body: createMockStream([
          'event: content_block_start\n',
          'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\n',
          'data: {"index":0,"delta":{"type":"text_delta","text":"你好，我在。"}}\n\n',
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
        ]),
        text: async () => 'mock response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), storage, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId,
        prompt: '你好？',
        cwd: tmpdir(),
      }),
    )

    const intake = events.find(event => event.type === 'user_intake_guidance') as any
    assert.ok(intake)
    assert.equal(intake.userText, '你好？')
    assert.equal(intake.actionHint, 'respond_only')
    assert.deepEqual(intake.explicitPaths, [])

    const body = JSON.parse(String(fetchCalls[0].init?.body))
    assert.equal(body.tools, undefined)
    assert.match(JSON.stringify(body), /你好？/)
    assert.doesNotMatch(JSON.stringify(body), /tangyaoyou/)
  })

  test('normalizes contradictory pause intake before exposing tools', async () => {
    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"pause\\",\\"confidence\\":0.94,\\"continuity\\":0.4,\\"contextScope\\":\\"full\\",\\"actionHint\\":\\"normal\\",\\"requiresTools\\":true,\\"reason\\":\\"Contradictory intake fixture.\\",\\"guidance\\":\\"Pause, but incorrectly allows tools.\\",\\"explicitPaths\\":[]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock contradictory intake response text',
        } as Response
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: true,
        status: 200,
        body: createMockStream([
          'event: content_block_start\n',
          'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\n',
          'data: {"index":0,"delta":{"type":"text_delta","text":"Paused. I will wait for your next instruction."}}\n\n',
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
        ]),
        text: async () => 'mock response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-contradictory-pause-intake',
        prompt: '等一下，先停',
        cwd: tmpdir(),
      }),
    )

    const intake = events.find(event => event.type === 'user_intake_guidance') as any
    assert.ok(intake)
    assert.equal(intake.intent, 'pause')
    assert.equal(intake.contextScope, 'recent')
    assert.equal(intake.actionHint, 'respond_only')
    assert.equal(intake.requiresTools, false)
    assert.equal(intake.source, 'model')

    assert.equal(fetchCalls.length, 1)
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    assert.equal(body.tools, undefined)
    assert.match(JSON.stringify(body.system), /Requires tools: no/)
  })

  test('keeps tools visible for status intake when the latest message asks to verify changes', async () => {
    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        const bodyText = JSON.stringify(body)
        assert.match(bodyText, /验证当前改动是否健康/)
        assert.match(bodyText, /check if tests pass/)
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"status\\",\\"confidence\\":0.9,\\"continuity\\":0.7,\\"contextScope\\":\\"full\\",\\"actionHint\\":\\"normal\\",\\"requiresTools\\":true,\\"reason\\":\\"The user asks to verify current uncommitted changes.\\",\\"guidance\\":\\"Use tools to verify the current changes.\\",\\"explicitPaths\\":[]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock status intake requiring tools',
        } as Response
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: true,
        status: 200,
        body: createMockStream([
          'event: content_block_start\n',
          'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\n',
          'data: {"index":0,"delta":{"type":"text_delta","text":"I will verify the current changes."}}\n\n',
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
        ]),
        text: async () => 'mock provider response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowlistedTools(['Bash']),
      null as any,
      configManager,
    )
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-status-intake-verify-keeps-tools-visible',
        prompt: '验证当前未提交改动是否健康',
        cwd: tmpdir(),
      })
    )

    const intake = events.find(event => event.type === 'user_intake_guidance') as any
    assert.ok(intake)
    assert.equal(intake.intent, 'continue')
    assert.equal(intake.actionHint, 'normal')
    assert.equal(intake.requiresTools, true)
    assert.ok(!events.some(event => event.type === 'error' && (event as any).code === 'TOOL_CALL_SUPPRESSED_BY_USER_INTENT'))

    const body = JSON.parse(String(fetchCalls[0].init?.body))
    const toolNames = body.tools.map((tool: any) => tool.name)
    assert.deepEqual(toolNames, ['Bash'])
    assert.match(JSON.stringify(body.system), /Requires tools: yes/)
  })

  test('normalizes model respond-only drift for current-state explanation and source verification prompts', async () => {
    const prompts = [
      '`workspace_dirty_detected` push 模型解释一下这部分',
      '这个不就是源码吗/Users/tangyaoyue/DEV/Baidu/Baidu/钢架雪车/index.html',
    ]

    for (const prompt of prompts) {
      fetchCalls = []
      globalThis.fetch = async (url, init) => {
        const body = parseRequestBody(init)
        if (isIntakeRequestBody(body)) {
          return {
            ok: true,
            status: 200,
            body: createMockStream([
              'event: content_block_start\n',
              'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
              'event: content_block_delta\n',
              'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"status\\",\\"confidence\\":0.9,\\"continuity\\":0.7,\\"contextScope\\":\\"full\\",\\"actionHint\\":\\"respond_only\\",\\"requiresTools\\":false,\\"reason\\":\\"Incorrect respond-only fixture.\\",\\"explicitPaths\\":[]}"}}\n\n',
              'event: content_block_stop\n',
              'data: {"index":0}\n\n',
            ]),
            text: async () => 'mock drifted intake response',
          } as Response
        }
        fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"我会先用当前证据核对。"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock provider response text',
        } as Response
      }

      const runtime = new LLMCodingRuntime(
        toolsRegistry,
        allowlistedTools(['Read', 'Grep']),
        null as any,
        configManager,
      )
      const events = await collectEvents(
        runtime.executeStream({
          sessionId: `test-current-state-intake-drift-${prompts.indexOf(prompt)}`,
          prompt,
          cwd: tmpdir(),
        }),
      )

      const intake = events.find(event => event.type === 'user_intake_guidance') as any
      assert.ok(intake)
      assert.equal(intake.actionHint, 'normal')
      assert.equal(intake.requiresTools, true)
      assert.ok(!events.some(event => event.type === 'error' && (event as any).code === 'TOOL_CALL_SUPPRESSED_BY_USER_INTENT'))

      assert.equal(fetchCalls.length, 1)
      const body = JSON.parse(String(fetchCalls[0].init?.body))
      assert.deepEqual(body.tools.map((tool: any) => tool.name).sort(), ['Grep', 'Read'])
      assert.match(JSON.stringify(body.system), /Intent category: availability_check/)
      assert.match(JSON.stringify(body.system), /Requires tools: yes/)
    }
  })

  test('only exposes policy-allowed tools to provider requests under strict policy', async () => {
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"Done"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowlistedTools(['Read', 'Glob']),
      null as any,
      configManager,
    )
    await collectEvents(
      runtime.executeStream({
        sessionId: 'test-tool-policy-visible-strict',
        prompt: 'inspect project',
        cwd: tmpdir(),
      })
    )

    const body = JSON.parse(String(fetchCalls[0].init?.body))
    const toolNames = body.tools.map((tool: any) => tool.name).sort()
    assert.deepEqual(toolNames, ['Glob', 'Read'])
  })

  test('exposes permission-gated write/execute tools to provider requests under soft-deny', async () => {
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"Done"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowlistedTools(['Read', 'Glob']),
      null as any,
      configManager,
    )
    await collectEvents(
      runtime.executeStream({
        sessionId: 'test-tool-policy-visible-soft-deny',
        prompt: 'inspect and update project',
        cwd: tmpdir(),
        policyMode: 'soft-deny',
      })
    )

    const body = JSON.parse(String(fetchCalls[0].init?.body))
    const toolNames = body.tools.map((tool: any) => tool.name).sort()
    assert.deepEqual(toolNames, ['Bash', 'Edit', 'Glob', 'Read', 'SkillSave', 'Write'])
  })

  test('memory capability prompt lets mock provider self-trigger memory_search', async () => {
    const searchInputs: unknown[] = []
    const client = createMockEverCoreClient({
      async search(input) {
        searchInputs.push(input)
        return {
          data: {
            episodes: [{
              id: 'episode-provider-preference',
              content: 'User prefers regression-first provider fixes.',
              score: 0.91,
            }],
          },
        }
      },
    })
    const tools = createEverCoreMcpToolRegistry(client, createEverCoreRuntimeTestConfig({ mcpToolsEnabled: true }))
    fetchStreamResponses.push(
      createAnthropicToolUseStream({
        id: 'memory-search-1',
        name: 'mcp:evercore:memory_search',
        input: { query: '用户之前偏好的 provider', topK: 1, maxChars: 256, maxHitChars: 128 },
      }),
      createAnthropicTextStream('我记得你偏好 regression-first provider 修复。'),
    )

    const runtime = new LLMCodingRuntime(
      tools,
      allowlistedTools(['mcp:evercore:memory_search']),
      new MemoryStorage(),
      configManager,
      {
        name: 'test-memory-capability',
        async retrieve() {
          return {
            content: '',
            diagnostics: {
              provider: 'test-memory-capability',
              enabled: true,
              hitCount: 0,
              injectedChars: 0,
              budgetChars: 256,
              maxHitChars: 128,
              truncated: false,
              scope: 'project',
            },
          }
        },
      },
    )
    const events = await collectEvents(runtime.executeStream({
      sessionId: 'test-memory-search-self-trigger',
      prompt: '你还记得我之前偏好的 provider 吗？',
      cwd: tmpdir(),
    }))

    const firstBody = JSON.parse(String(fetchCalls[0].init?.body))
    assert.match(JSON.stringify(firstBody.system), /Long-Term Memory Capability/)
    assert.deepEqual(firstBody.tools.map((tool: any) => tool.name), ['mcp:evercore:memory_search'])
    assert.equal(searchInputs.length, 1)
    assert.deepEqual(searchInputs[0], {
      query: '用户之前偏好的 provider',
      appId: 'babel-o',
      projectId: 'project-1',
      userId: undefined,
      agentId: 'agent-1',
      method: 'hybrid',
      topK: 1,
    })
    const completed = events.find(event => event.type === 'tool_completed' && event.name === 'mcp:evercore:memory_search') as any
    assert.ok(completed)
    assert.equal(completed.success, true)
    assert.match(completed.output.content, /regression-first provider fixes/)
    const result = events.find(event => event.type === 'result') as any
    assert.ok(result)
    assert.equal(result.success, true)
    assert.match(result.message, /regression-first provider/)
  })

  test('memory capability answer suppresses internal implementation leakage and retries', async () => {
    fetchStreamResponses.push(
      createAnthropicTextStream('可以写入，但走的是 src/runtime/memoryProvider.ts 和 mcp:evercore:memory_save_note；commit ad22ed9 接了 MCP sidecar。'),
      createAnthropicTextStream('可以，但不会自动静默写入。只有你明确要求记住，或批准记忆候选时，我才会发起写入；写入前会经过权限确认。长期记忆只作为背景提示，不替代当前工作区文件、会话记录或工具结果。'),
    )

    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowAllTools(),
      new MemoryStorage(),
      configManager,
      {
        name: 'test-memory-capability',
        async retrieve() {
          return {
            content: '',
            diagnostics: {
              provider: 'test-memory-capability',
              enabled: true,
              hitCount: 0,
              injectedChars: 0,
              budgetChars: 256,
              maxHitChars: 128,
              truncated: false,
              scope: 'project',
            },
          }
        },
      },
    )
    const events = await collectEvents(runtime.executeStream({
      sessionId: 'test-memory-capability-answer-leakage',
      prompt: '你当前能否写入记忆？',
      cwd: tmpdir(),
    }))

    assert.equal(fetchCalls.length, 2)
    const firstBody = JSON.parse(String(fetchCalls[0].init?.body))
    assert.equal(firstBody.tools, undefined)
    assert.match(JSON.stringify(firstBody.system), /Long-Term Memory Capability/)
    assert.match(JSON.stringify(firstBody.system), /user-facing capability level/)

    const leakError = events.find(event => event.type === 'error' && (event as any).code === 'MEMORY_CAPABILITY_ANSWER_LEAK_SUPPRESSED') as any
    assert.ok(leakError)
    assert.equal(leakError.details.pattern, 'source_path')
    assert.ok(!events.some(event => event.type === 'assistant_delta' && /src\/runtime|ad22ed9|MCP sidecar|memory_save_note/.test((event as any).text)))

    const result = events.find(event => event.type === 'result') as any
    assert.ok(result)
    assert.equal(result.success, true)
    assert.match(result.message, /不会自动静默写入/)
    assert.match(result.message, /权限确认/)
    assert.match(result.message, /背景提示/)
    assert.doesNotMatch(result.message, /src\/runtime|ad22ed9|MCP sidecar|memory_save_note/)
  })

  test('memory_save_note self-trigger emits permission_request before write', async () => {
    const addInputs: unknown[] = []
    const client = createMockEverCoreClient({
      async addAgentMessages(input) {
        addInputs.push(input)
        return { data: { ok: true } }
      },
    })
    const tools = createEverCoreMcpToolRegistry(client, createEverCoreRuntimeTestConfig({ mcpToolsEnabled: true }))
    const sessionId = 'test-memory-save-self-trigger-permission'
    fetchStreamResponses.push(
      createAnthropicToolUseStream({
        id: 'memory-save-1',
        name: 'mcp:evercore:memory_save_note',
        input: { note: 'User prefers regression-first fixes.' },
      }),
      createAnthropicTextStream('我不会写入这条长期记忆，因为权限请求已被拒绝。'),
    )

    const runtime = new LLMCodingRuntime(
      tools,
      allowlistedTools(['mcp:evercore:memory_save_note']),
      new MemoryStorage(),
      configManager,
      {
        name: 'test-memory-capability',
        async retrieve() {
          return {
            content: '',
            diagnostics: {
              provider: 'test-memory-capability',
              enabled: true,
              hitCount: 0,
              injectedChars: 0,
              budgetChars: 256,
              maxHitChars: 128,
              truncated: false,
              scope: 'project',
            },
          }
        },
      },
    )
    const events: NexusEvent[] = []
    for await (const event of runtime.executeStream({
      sessionId,
      prompt: '记住：我偏好 regression-first 修复。',
      cwd: tmpdir(),
      runtimeHooks: [{
        name: 'TestDenyMemorySavePermission',
        events: ['PermissionRequest'],
        run() {
          return {
            permissionDecision: {
              approved: false,
              reason: 'test denies write after observing permission gate',
            },
          }
        },
      }],
    })) {
      events.push(event)
    }

    const firstBody = JSON.parse(String(fetchCalls[0].init?.body))
    assert.match(JSON.stringify(firstBody.system), /Only save memory when the user explicitly asks you to remember something/)
    assert.deepEqual(firstBody.tools.map((tool: any) => tool.name), ['mcp:evercore:memory_save_note'])
    const permission = events.find(event => event.type === 'permission_request') as any
    assert.ok(permission)
    assert.equal(permission.name, 'mcp:evercore:memory_save_note')
    assert.equal(permission.risk, 'write')
    assert.deepEqual(permission.source, {
      type: 'mcp',
      serverName: 'evercore',
      originalName: 'memory_save_note',
    })
    assert.equal(addInputs.length, 0)
    assert.ok(events.some(event => event.type === 'permission_response' && event.approved === false))
    assert.ok(events.some(event => event.type === 'tool_denied' && event.name === 'mcp:evercore:memory_save_note' && event.recoverable === true))
    assert.ok(events.some(event => event.type === 'result' && event.success === true))
  })

  test('streams Bash permission_request before waiting for user approval', async () => {
    const sessionId = 'test-bash-permission-streaming'
    const toolUseId = 'tool-call-bash-permission'
    fetchStreamResponses.push(
      createAnthropicToolUseStream({
        id: toolUseId,
        name: 'Bash',
        input: { command: 'npm install left-pad' },
      }),
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), new MemoryStorage(), configManager)
    const iterator = runtime.executeStream({
      sessionId,
      prompt: 'run a command that needs permission',
      cwd: tmpdir(),
    })[Symbol.asyncIterator]()
    const seen: NexusEvent[] = []

    try {
      for (let i = 0; i < 120; i++) {
        const next = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for permission_request')), 500)),
        ])
        if (next.done) break
        seen.push(next.value)
        if (next.value.type === 'permission_request') {
          assert.equal(next.value.name, 'Bash')
          assert.equal(next.value.risk, 'execute')
          assert.equal(next.value.toolUseId, toolUseId)
          return
        }
      }
      assert.fail(`permission_request not observed; saw ${seen.map(event => event.type).join(', ')}`)
    } finally {
      PendingPermissionRegistry.getInstance().resolve(sessionId, toolUseId, {
        approved: false,
        reason: 'test cleanup',
      })
      await iterator.return?.()
    }
  })

  test('permission denial is fed back to provider so it can adjust', async () => {
    fetchStreamResponses.push(
      createAnthropicToolUseStream({
        id: 'write-denied-1',
        name: 'Write',
        input: { path: 'generated.txt', content: 'hello' },
      }),
      createAnthropicTextStream('写入已被拒绝，我不会继续调用 Write；可以改为给出需要手动创建的内容。'),
    )

    const sessionId = 'test-provider-permission-denial-feedback'
    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowlistedTools(['Read']),
      new MemoryStorage(),
      configManager,
    )
    const events: NexusEvent[] = []
    for await (const event of runtime.executeStream({
      sessionId,
      prompt: 'write generated.txt',
      cwd: tmpdir(),
      policyMode: 'soft-deny',
      runtimeHooks: [{
        name: 'TestDenyWritePermission',
        events: ['PermissionRequest'],
        run() {
          return {
            permissionDecision: {
              approved: false,
              reason: 'user denied write for regression',
              feedback: 'Do not retry Write; provide manual file content instead.',
            },
          }
        },
      }],
    })) {
      events.push(event)
    }

    assert.equal(fetchCalls.length, 2)
    const secondBody = JSON.parse(String(fetchCalls[1].init?.body))
    assert.match(JSON.stringify(secondBody.messages), /user denied write for regression/)
    assert.match(JSON.stringify(secondBody.messages), /Do not retry Write/)
    const denied = events.find(event => event.type === 'tool_denied' && event.name === 'Write') as any
    assert.ok(denied)
    assert.equal(denied.denialKind, 'permission')
    assert.equal(denied.recoverable, true)
    assert.equal(denied.terminal, undefined)
    const result = events.find(event => event.type === 'result') as any
    assert.ok(result)
    assert.equal(result.success, true)
    assert.match(result.message, /写入已被拒绝/)
  })

  test('emits classified provider error details and a failed result', async () => {
    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"continue\\",\\"confidence\\":0.9,\\"continuity\\":0.8,\\"contextScope\\":\\"full\\",\\"actionHint\\":\\"normal\\",\\"requiresTools\\":true,\\"reason\\":\\"test intake\\",\\"guidance\\":\\"Proceed.\\",\\"explicitPaths\\":[]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock intake response text',
        } as Response
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: false,
        status: 402,
        body: null,
        text: async () => '{"error":{"message":"Insufficient Balance"}}',
      } as Response
    }

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-provider-error-recoverable-result',
        prompt: 'analyze code',
        cwd: tmpdir(),
      }),
    )

    const errorEvent = events.find(event => event.type === 'error') as any
    assert.ok(errorEvent)
    assert.equal(errorEvent.code, 'PROVIDER_ERROR')
    assert.equal(errorEvent.details.kind, 'auth_or_billing')
    assert.equal(errorEvent.details.retryable, false)
    assert.equal(errorEvent.details.fallbackPolicy.mode, 'fix_configuration')
    assert.equal(errorEvent.details.fallbackPolicy.allowSilentModelSwitch, false)

    const resultEvent = events.find(event => event.type === 'result') as any
    assert.ok(resultEvent)
    assert.equal(resultEvent.success, false)
    assert.match(resultEvent.message, /Insufficient Balance/i)
  })

  test('fails instead of accepting repeated max token truncation as a successful answer', async () => {
    for (let i = 1; i <= 4; i++) {
      fetchStreamResponses.push(
        createMockStream([
          'event: content_block_start\n',
          'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\n',
          `data: {"index":0,"delta":{"type":"text_delta","text":"partial chunk ${i}"}}\n\n`,
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
          'event: message_delta\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":4096}}\n\n',
          'event: message_stop\n',
          'data: {"type":"message_stop"}\n\n',
        ]),
      )
    }

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-max-output-recovery-exhausted',
        prompt: 'write a very long report',
        cwd: tmpdir(),
      }),
    )

    assert.equal(fetchCalls.length, 4)

    const errorEvent = events.find(event => event.type === 'error' && (event as any).code === 'MAX_OUTPUT_TOKENS_EXCEEDED') as any
    assert.ok(errorEvent)
    assert.equal(errorEvent.details.kind, 'max_output_tokens')
    assert.equal(errorEvent.details.recoveryReason, 'ESCALATED_MAX_TOKENS')
    assert.equal(errorEvent.details.fallbackPolicy.mode, 'manual_confirm')
    assert.equal(errorEvent.details.fallbackPolicy.allowSilentModelSwitch, false)

    const resultEvent = events.find(event => event.type === 'result') as any
    assert.ok(resultEvent)
    assert.equal(resultEvent.success, false)
    assert.match(resultEvent.message, /maximum output token limit/)
  })

  test('treats empty provider response as a failed result instead of successful done', async () => {
    fetchStreamResponses.push(
      createMockStream([
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_empty","type":"message","role":"assistant","content":[],"model":"claude","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-empty-response',
        prompt: 'hello',
        cwd: tmpdir(),
      })
    )

    const errorEvent = events.find(e => e.type === 'error') as any
    assert.ok(errorEvent)
    assert.equal(errorEvent.code, 'EMPTY_PROVIDER_RESPONSE')

    const resultEvent = events.find(e => e.type === 'result') as any
    assert.ok(resultEvent)
    assert.equal(resultEvent.success, false)
    assert.match(resultEvent.message, /empty assistant response/)
  })

  test('treats thinking-only provider response as a failed result instead of hanging', async () => {
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"thinking_delta","thinking":"I should call a tool but did not emit one."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}\n\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-thinking-only-response',
        prompt: '查看当前项目的分支信息',
        cwd: tmpdir(),
      })
    )

    assert.ok(events.some(e => e.type === 'thinking_delta'), 'thinking_delta should still be surfaced')
    assert.ok(
      !events.some(e => e.type === 'hook_completed' && e.hookEvent === 'PostInvocation'),
      'reasoning-only provider turns should terminate before PostInvocation hooks can open a silent gap',
    )
    const errorEvent = events.find(e => e.type === 'error') as any
    assert.ok(errorEvent)
    assert.equal(errorEvent.code, 'EMPTY_PROVIDER_RESPONSE')
    assert.equal(errorEvent.details?.kind, 'reasoning_only')

    const resultEvent = events.find(e => e.type === 'result') as any
    assert.ok(resultEvent)
    assert.equal(resultEvent.success, false)
    assert.match(resultEvent.message, /empty assistant response/)
  })

  test('sequentially calls and executes allowed tools', async () => {
    const cwd = join(tmpdir(), `babel-o-test-exec-${Date.now()}`)
    fs.mkdirSync(cwd, { recursive: true })
    const targetFile = join(cwd, 'test.txt')

    // Stream 1: Request tool execution
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-1","name":"Write","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"' +
          targetFile.replace(/\\/g, '\\\\') +
          '\\",\\"content\\":\\"Hello tool flow\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    // Stream 2: Final response using the tool output
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"I have written the file."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-session-tool',
        prompt: 'write text to file',
        cwd,
        skipPermissionCheck: true,
      })
    )

    // Cleanup file/folder
    try {
      if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile)
      fs.rmdirSync(cwd)
    } catch {}

    // Verify events sequence
    const eventTypes = events.map(e => e.type)
    assert.deepEqual(eventTypes.filter(t => ['tool_started', 'tool_completed', 'result'].includes(t)), [
      'tool_started',
      'tool_completed',
      'result',
    ])

    const toolStarted = events.find(e => e.type === 'tool_started') as any
    assert.equal(toolStarted.name, 'Write')
    assert.equal(toolStarted.input.path, targetFile)

    const toolCompleted = events.find(e => e.type === 'tool_completed') as any
    assert.equal(toolCompleted.name, 'Write')
    assert.equal(toolCompleted.success, true)

    const resultEvent = events.find(e => e.type === 'result') as any
    assert.equal(resultEvent.success, true)
    assert.equal(resultEvent.message, 'I have written the file.')

    // Ensure two LLM prompts were made
    assert.equal(fetchCalls.length, 2)
  })

  test('replays live DeepSeek reasoning_content when returning tool results', async () => {
    configManager.setProviderConfig('deepseek', {
      apiKey: 'deepseek-test-key',
      baseUrl: 'https://api.deepseek.test/v1',
    })
    configManager.setDefaultModel('deepseek/deepseek-v4-pro')
    const cwd = join(tmpdir(), `babel-o-test-deepseek-${Date.now()}`)
    fs.mkdirSync(cwd, { recursive: true })
    const targetFile = join(cwd, 'README.md')
    fs.writeFileSync(targetFile, 'hello from deepseek replay test', 'utf8')

    fetchStreamResponses.push(
      createMockStream([
        'data: {"choices":[{"delta":{"reasoning_content":"I should inspect the file first."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"I will read the file."}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","function":{"name":"Read"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"' +
          targetFile.replace(/\\/g, '\\\\') +
          '\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    )
    fetchStreamResponses.push(
      createMockStream([
        'data: {"choices":[{"delta":{"content":"The file says hello."}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-deepseek-reasoning-replay',
        prompt: 'read README',
        cwd,
      })
    )

    try {
      fs.rmSync(cwd, { recursive: true, force: true })
    } catch {}

    assert.equal(fetchCalls.length, 2)
    const secondBody = JSON.parse(String(fetchCalls[1].init?.body))
    const assistantWithTool = secondBody.messages.find((message: any) => message.role === 'assistant' && message.tool_calls)
    assert.ok(assistantWithTool)
    assert.equal(assistantWithTool.reasoning_content, 'I should inspect the file first.')
    assert.ok(events.some(event => event.type === 'thinking_delta'))
    const result = events.find(event => event.type === 'result') as any
    assert.equal(result?.success, true)
  })

  test('returns missing Read paths to the model instead of aborting the turn', async () => {
    const cwd = join(tmpdir(), `babel-o-test-missing-read-${Date.now()}`)
    fs.mkdirSync(cwd, { recursive: true })

    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-missing","name":"Read","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"missing.txt\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"The file is missing, so I will continue without it."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-missing-read-recoverable',
        prompt: 'read missing config',
        cwd,
        skipPermissionCheck: true,
      })
    )

    const toolCompleted = events.find(e => e.type === 'tool_completed') as any
    assert.equal(toolCompleted.name, 'Read')
    assert.equal(toolCompleted.success, false)
    assert.match(String(toolCompleted.output), /could not find/)
    assert.ok(!events.some(e => e.type === 'error' && (e as any).code === 'TOOL_ERROR'))
    const resultEvent = events.find(e => e.type === 'result') as any
    assert.equal(resultEvent.success, true)
    assert.match(resultEvent.message, /file is missing/)

    const secondBody = JSON.parse(String(fetchCalls[1].init?.body))
    const toolResultTurn = secondBody.messages.find((message: any) =>
      Array.isArray(message.content) &&
      message.content.some((block: any) => block.type === 'tool_result'),
    )
    const toolResult = toolResultTurn.content.find((block: any) => block.type === 'tool_result')
    assert.equal(toolResult.is_error, true)
    assert.match(toolResult.content, /could not find/)

    try {
      fs.rmdirSync(cwd)
    } catch {}
  })

  test('returns workspace escape paths to the model instead of aborting the turn', async () => {
    const cwd = join(tmpdir(), `babel-o-test-escape-read-${Date.now()}`)
    fs.mkdirSync(cwd, { recursive: true })
    const outsidePath = join(dirname(cwd), 'outside-package.json')

    process.env.NEXUS_ALLOWED_WORKSPACES = cwd

    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-escape","name":"Read","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"' +
          outsidePath.replace(/\\/g, '\\\\') +
          '\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"The path is outside the workspace, so I will stay in the current project."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-escape-read-recoverable',
        prompt: 'read the package file',
        cwd,
        skipPermissionCheck: true,
      })
    )

    const toolCompleted = events.find(e => e.type === 'tool_completed') as any
    assert.equal(toolCompleted.name, 'Read')
    assert.equal(toolCompleted.success, false)
    assert.equal(toolCompleted.output.code, 'WORKSPACE_PATH_ESCAPE')
    assert.match(toolCompleted.output.message, /outside the current workspace/)
    assert.ok(!events.some(e => e.type === 'error' && (e as any).code === 'TOOL_ERROR'))
    const resultEvent = events.find(e => e.type === 'result') as any
    assert.equal(resultEvent.success, true)
    assert.match(resultEvent.message, /outside the workspace/)

    const secondBody = JSON.parse(String(fetchCalls[1].init?.body))
    const toolResultTurn = secondBody.messages.find((message: any) =>
      Array.isArray(message.content) &&
      message.content.some((block: any) => block.type === 'tool_result'),
    )
    const toolResult = toolResultTurn.content.find((block: any) => block.type === 'tool_result')
    assert.equal(toolResult.is_error, true)
    assert.match(toolResult.content, /WORKSPACE_PATH_ESCAPE|outside the current workspace/)

    delete process.env.NEXUS_ALLOWED_WORKSPACES
    try {
      fs.rmdirSync(cwd)
    } catch {}
  })

  test('returns invalid tool input to the model so it can retry with corrected arguments', async () => {
    const cwd = join(tmpdir(), `babel-o-test-invalid-tool-input-${Date.now()}`)
    fs.mkdirSync(cwd, { recursive: true })
    const targetFile = join(cwd, 'plan.md')

    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-invalid","name":"Write","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"content\\":\\"draft plan\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ]),
    )

    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-fixed","name":"Write","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"' +
          targetFile.replace(/\\/g, '\\\\') +
          '\\",\\"content\\":\\"draft plan\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ]),
    )

    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"I fixed the Write call and saved the plan."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ]),
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-invalid-tool-input-retry',
        prompt: 'write a plan',
        cwd,
        skipPermissionCheck: true,
      }),
    )

    try {
      if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile)
      fs.rmdirSync(cwd)
    } catch {}

    const invalidCompleted = events.find(e =>
      e.type === 'tool_completed' && e.toolUseId === 'tool-call-invalid'
    ) as any
    assert.ok(invalidCompleted)
    assert.equal(invalidCompleted.success, false)
    assert.equal(invalidCompleted.output.code, 'INVALID_TOOL_INPUT')
    assert.match(invalidCompleted.output.message, /path/)

    const fixedCompleted = events.find(e =>
      e.type === 'tool_completed' && e.toolUseId === 'tool-call-fixed'
    ) as any
    assert.ok(fixedCompleted)
    assert.equal(fixedCompleted.success, true)
    assert.ok(!events.some(e => e.type === 'error' && (e as any).code === 'INVALID_TOOL_INPUT'))
    assert.equal(fetchCalls.length, 3)
  })

  test('returns thrown tool execution errors to the model instead of aborting the turn', async () => {
    const cwd = join(tmpdir(), `babel-o-test-thrown-tool-error-${Date.now()}`)
    fs.mkdirSync(cwd, { recursive: true })
    toolsRegistry.set('Thrower', {
      name: 'Thrower',
      description: 'Test tool that throws a recoverable execution error.',
      risk: 'read',
      inputSchema: z.object({ target: z.string() }),
      async execute() {
        throw new Error('simulated helper failure')
      },
    })

    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-thrower","name":"Thrower","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"target\\":\\"notes.md\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"The helper failed, so I will continue from existing evidence."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-thrown-tool-error-recoverable',
        prompt: 'use the helper',
        cwd,
        skipPermissionCheck: true,
      })
    )

    try {
      fs.rmdirSync(cwd)
    } catch {}

    const toolCompleted = events.find(e => e.type === 'tool_completed' && e.toolUseId === 'tool-call-thrower') as any
    assert.ok(toolCompleted)
    assert.equal(toolCompleted.name, 'Thrower')
    assert.equal(toolCompleted.success, false)
    assert.equal(toolCompleted.output.code, 'TOOL_EXECUTION_FAILED')
    assert.equal(toolCompleted.output.toolName, 'Thrower')
    assert.match(toolCompleted.output.message, /simulated helper failure/)
    assert.match(toolCompleted.output.repairHint, /corrected tool call|existing verified evidence/)
    assert.ok(!events.some(e => e.type === 'error' && (e as any).code === 'TOOL_ERROR'))

    const resultEvent = events.find(e => e.type === 'result') as any
    assert.equal(resultEvent.success, true)
    assert.match(resultEvent.message, /helper failed/)

    const secondBody = JSON.parse(String(fetchCalls[1].init?.body))
    const toolResultTurn = secondBody.messages.find((message: any) =>
      Array.isArray(message.content) &&
      message.content.some((block: any) => block.type === 'tool_result'),
    )
    const toolResult = toolResultTurn.content.find((block: any) => block.type === 'tool_result')
    assert.equal(toolResult.tool_use_id ?? toolResult.toolUseId, 'tool-call-thrower')
    assert.equal(toolResult.is_error ?? toolResult.isError, true)
    assert.match(toolResult.content, /TOOL_EXECUTION_FAILED|simulated helper failure/)
  })

  test('returns Bash non-zero exits to the model instead of aborting the turn', async () => {
    const cwd = join(tmpdir(), `babel-o-test-bash-nonzero-${Date.now()}`)
    fs.mkdirSync(cwd, { recursive: true })

    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-bash-fail","name":"Bash","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"cd definitely-missing && git remote -v\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"The command failed because the directory does not exist, so I will inspect another path."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-bash-nonzero-recoverable',
        prompt: 'inspect git remotes',
        cwd,
        skipPermissionCheck: true,
      })
    )

    const toolCompleted = events.find(e => e.type === 'tool_completed') as any
    assert.equal(toolCompleted.name, 'Bash')
    assert.equal(toolCompleted.success, false)
    assert.match(String(toolCompleted.output.stderr), /no such file or directory|not a directory|can't cd/i)
    assert.ok(!events.some(e => e.type === 'error' && (e as any).code === 'TOOL_ERROR'))
    const resultEvent = events.find(e => e.type === 'result') as any
    assert.equal(resultEvent.success, true)
    assert.match(resultEvent.message, /command failed/)

    const secondBody = JSON.parse(String(fetchCalls[1].init?.body))
    const toolResultTurn = secondBody.messages.find((message: any) =>
      Array.isArray(message.content) &&
      message.content.some((block: any) => block.type === 'tool_result'),
    )
    const toolResult = toolResultTurn.content.find((block: any) => block.type === 'tool_result')
    assert.equal(toolResult.is_error, true)
    assert.match(toolResult.content, /exitCode|stderr/)

    try {
      fs.rmdirSync(cwd)
    } catch {}
  })

  test('emits failed result when max loop limit is exceeded', async () => {
    const cwd = join(tmpdir(), `babel-o-test-max-loops-${Date.now()}`)
    fs.mkdirSync(cwd, { recursive: true })

    for (let i = 1; i <= 25; i++) {
      fetchStreamResponses.push(
        createMockStream([
          'event: content_block_start\n',
          `data: {"index":0,"content_block":{"type":"tool_use","id":"missing-tool-${i}","name":"MissingTool","input":{}}}\n\n`,
          'event: content_block_delta\n',
          'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
        ]),
      )
    }

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-max-loops-failed-result',
        prompt: 'keep thinking without answering',
        cwd,
        skipPermissionCheck: true,
      }),
    )

    try {
      fs.rmSync(cwd, { recursive: true, force: true })
    } catch {}

    const errorEvent = events.find(event => event.type === 'error' && (event as any).code === 'MAX_LOOPS_EXCEEDED') as any
    assert.ok(errorEvent)

    const resultEvent = events.find(event => event.type === 'result') as any
    assert.ok(resultEvent)
    assert.equal(resultEvent.success, false)
    assert.match(resultEvent.message, /maximum tool call iterations/)
  })

  test('final_check allows one read-only check then must_respond hides tools and refuses further calls', async () => {
    // Phase D: when the loop enters the finalization reserve (remaining <= 3)
    // and the one bounded check is unused, the runtime narrows visible tools to
    // the read-only whitelist (final_check) instead of hiding them. The model
    // gets ONE read-only check; after it executes, the next turn is must_respond
    // (tools hidden, further tool calls refused with TOOL_LOOP_FINAL_RESPONSE_ONLY).
    // See docs/nexus/reference/runtime-tool-loop-governance-plan.md Phase D.
    const cwd = join(tmpdir(), `babel-o-test-tool-loop-guard-${Date.now()}`)
    fs.mkdirSync(cwd, { recursive: true })
    const targetFile = join(cwd, 'notes.txt')
    fs.writeFileSync(targetFile, 'loop guard fixture', 'utf8')

    for (let i = 1; i <= 21; i++) {
      fetchStreamResponses.push(
        createMockStream([
          'event: content_block_start\n',
          `data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-${i}","name":"Read","input":{}}}\n\n`,
          'event: content_block_delta\n',
          'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"' +
            targetFile.replace(/\\/g, '\\\\') +
            '\\"}"}}\n\n',
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
        ]),
      )
    }
    // Iteration 22 (remaining=3, final_check): the one bounded read-only check
    // is ALLOWED to pass through (Read is on the read-only whitelist).
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        `data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-final-check","name":"Read","input":{}}}\n\n`,
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"' +
          targetFile.replace(/\\/g, '\\\\') +
          '\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ]),
    )
    // Iteration 23 (remaining=2, must_respond): a further tool call is REFUSED
    // with TOOL_LOOP_FINAL_RESPONSE_ONLY (backstop semantics unchanged).
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-blocked","name":"Read","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"notes.txt\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ]),
    )
    // Iteration 24 (must_respond): final answer from existing evidence.
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"I will stop using tools and provide the final answer."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ]),
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-tool-loop-final-response-only',
        prompt: 'keep inspecting until done',
        cwd,
        skipPermissionCheck: true,
      }),
    )

    try {
      fs.rmSync(cwd, { recursive: true, force: true })
    } catch {}

    const toolStartedEvents = events.filter(event => event.type === 'tool_started')
    // 21 normal Reads + 1 final_check Read execute; the must_respond Read is refused.
    assert.equal(toolStartedEvents.length, 22)
    assert.ok(toolStartedEvents.some(event => (event as any).toolUseId === 'tool-call-final-check'))
    assert.ok(!toolStartedEvents.some(event => (event as any).toolUseId === 'tool-call-blocked'))

    // final_check (iteration 22 = fetchCalls[21]): tools narrowed to the read-only
    // whitelist, not hidden. System prompt advertises the one bounded check.
    const finalCheckBody = JSON.parse(String(fetchCalls[21].init?.body))
    const finalCheckToolNames = (finalCheckBody.tools ?? []).map((t: any) => t.name)
    assert.deepEqual(finalCheckToolNames.sort(), ['Glob', 'Grep', 'ListDir', 'Read'])
    assert.match(JSON.stringify(finalCheckBody.system), /ONE bounded read-only check/)

    // must_respond (iteration 23 = fetchCalls[22]): tools hidden, further call refused.
    const mustRespondBody = JSON.parse(String(fetchCalls[22].init?.body))
    assert.equal(mustRespondBody.tools, undefined)
    assert.match(JSON.stringify(mustRespondBody.system), /Runtime has hidden all tools/)

    const guardError = events.find(event => event.type === 'error' && (event as any).code === 'TOOL_LOOP_FINAL_RESPONSE_ONLY') as any
    assert.ok(guardError)
    assert.match(guardError.message, /ignored additional requested tools/)

    const resultEvent = events.find(event => event.type === 'result') as any
    assert.ok(resultEvent)
    assert.equal(resultEvent.success, true)
    assert.match(resultEvent.message, /final answer/)
  })

  test('suppresses tool-shaped text in final-response-only mode without starting a new loop', async () => {
    const cwd = join(tmpdir(), `babel-o-test-final-only-text-leak-${Date.now()}`)
    fs.mkdirSync(cwd, { recursive: true })
    const targetFile = join(cwd, 'notes.txt')
    fs.writeFileSync(targetFile, 'final-only leakage fixture', 'utf8')

    for (let i = 1; i <= 21; i++) {
      fetchStreamResponses.push(
        createMockStream([
          'event: content_block_start\n',
          `data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-${i}","name":"Read","input":{}}}\n\n`,
          'event: content_block_delta\n',
          'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"' +
            targetFile.replace(/\\/g, '\\\\') +
            '\\"}"}}\n\n',
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
        ]),
      )
    }
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"<tool_call><invoke name=\\"Bash\\"><command>pwd</command></invoke></tool_call>"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ]),
    )
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"I will provide the final answer without more tools."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ]),
    )

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-final-only-text-leak-suppressed',
        prompt: 'keep inspecting until done',
        cwd,
        skipPermissionCheck: true,
      }),
    )

    try {
      fs.rmSync(cwd, { recursive: true, force: true })
    } catch {}

    const toolStartedEvents = events.filter(event => event.type === 'tool_started')
    assert.equal(toolStartedEvents.length, 21)
    assert.ok(!events.some(event => event.type === 'assistant_delta' && JSON.stringify(event).includes('<tool_call>')))
    assert.ok(!events.some(event => event.type === 'assistant_delta' && JSON.stringify(event).includes('pwd')))

    const leakError = events.find(event => event.type === 'error' && (event as any).code === 'TOOL_CALL_TEXT_LEAK_SUPPRESSED') as any
    assert.ok(leakError)
    assert.equal(leakError.details.phase, 'final_response_only')
    assert.match(leakError.details.pattern, /<\/?tool_call/)

    const metricsEvent = events.find(event => event.type === 'execution_metrics') as any
    assert.ok(metricsEvent)
    assert.equal(metricsEvent.toolCallTextLeakSuppressedCount, 1)
    assert.equal(metricsEvent.finalAnswerRetryCount, 1)
    assert.match(metricsEvent.toolShapedTextPattern, /<\/?tool_call/)

    const resultEvent = events.find(event => event.type === 'result') as any
    assert.ok(resultEvent)
    assert.equal(resultEvent.success, true)
    assert.doesNotMatch(resultEvent.message, /tool_call|invoke name|pwd/)
  })

  test('hard-suppresses MiniMax text-encoded tool calls for respond-only intake', async () => {
    configManager.setProviderConfig('minimax', {
      apiKey: 'minimax-test-key',
      baseUrl: 'https://api.test-minimax.com/anthropic',
    })
    configManager.setDefaultModel('minimax/MiniMax-M2.7-highspeed')

    let providerCallCount = 0
    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"greeting\\",\\"confidence\\":0.9,\\"continuity\\":0.7,\\"contextScope\\":\\"full\\",\\"actionHint\\":\\"respond_only\\",\\"requiresTools\\":false,\\"reason\\":\\"Greeting.\\",\\"guidance\\":\\"Reply directly.\\",\\"explicitPaths\\":[]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock intake response text',
        } as Response
      }
      providerCallCount += 1
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: true,
        status: 200,
        body: providerCallCount === 1
          ? createMockStream([
              'event: content_block_start\n',
              'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
              'event: content_block_delta\n',
              'data: {"index":0,"delta":{"type":"text_delta","text":"<minimax:tool_call>\\n<invoke name=\\"Bash\\">\\n<parameter name=\\"command\\">pwd</parameter>\\n<parameter name=\\"timeoutMs\\">15000</parameter>\\n</invoke>\\n</minimax:tool_call>"}}\n\n',
            ])
          : createMockStream([
              'event: content_block_start\n',
              'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
              'event: content_block_delta\n',
              'data: {"index":0,"delta":{"type":"text_delta","text":"你好，我在。"}}\n\n',
              'event: content_block_stop\n',
              'data: {"index":0}\n\n',
            ]),
        text: async () => 'mock response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowlistedTools(['Bash']),
      null as any,
      configManager,
    )
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-minimax-tool-call-suppressed-by-intent',
        prompt: '你好？',
        cwd: tmpdir(),
      }),
    )

    assert.ok(!events.some(event =>
      event.type === 'assistant_delta' && (event as any).text.includes('<minimax:tool_call>'),
    ))
    assert.ok(!events.some(event => event.type === 'tool_started'))
    assert.equal(fetchCalls.length, 2)

    const suppressionError = events.find(event => event.type === 'error' && (event as any).code === 'TOOL_CALL_SUPPRESSED_BY_USER_INTENT') as any
    assert.ok(suppressionError)
    assert.deepEqual(suppressionError.details.attemptedTools, ['Bash'])
    assert.equal(suppressionError.details.intentCategory, 'general')
    assert.equal(suppressionError.details.suppressionReason, 'greeting')
    assert.equal(suppressionError.details.retryAttempted, true)

    const firstBody = JSON.parse(String(fetchCalls[0].init?.body))
    assert.equal(firstBody.tools, undefined)
    const secondBody = JSON.parse(String(fetchCalls[1].init?.body))
    assert.deepEqual(secondBody.tools.map((tool: any) => tool.name), ['Bash'])
    assert.match(JSON.stringify(secondBody.messages), /genuinely need to execute a command or inspect files/)
  })

  test('hard-suppresses MiniMax bracket-wrapped tool calls for respond-only intake', async () => {
    configManager.setProviderConfig('minimax', {
      apiKey: 'minimax-test-key',
      baseUrl: 'https://api.test-minimax.com/anthropic',
    })
    configManager.setDefaultModel('minimax/MiniMax-M3')

    let providerCallCount = 0
    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"greeting\\",\\"confidence\\":0.9,\\"continuity\\":0.7,\\"contextScope\\":\\"full\\",\\"actionHint\\":\\"respond_only\\",\\"requiresTools\\":false,\\"reason\\":\\"Greeting.\\",\\"guidance\\":\\"Reply directly.\\",\\"explicitPaths\\":[]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock intake response text',
        } as Response
      }
      providerCallCount += 1
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: true,
        status: 200,
        body: providerCallCount === 1
          ? createMockStream([
              'event: content_block_start\n',
              'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
              'event: content_block_delta\n',
              'data: {"index":0,"delta":{"type":"text_delta","text":"]<]minimax[>[<tool_call>\\n]<]minimax[>[<invoke name=\\"Bash\\">]<]minimax[>[<command>pwd</command>]"}}\n\n',
              'event: content_block_delta\n',
              'data: {"index":0,"delta":{"type":"text_delta","text":"]<]minimax[>[<timeoutMs>10000</timeoutMs>]\\n]<]minimax[>[</invoke>\\n]<]minimax[>[</tool_call>"}}\n\n',
            ])
          : createMockStream([
              'event: content_block_start\n',
              'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
              'event: content_block_delta\n',
              'data: {"index":0,"delta":{"type":"text_delta","text":"可以，GitHub Pages 很适合托管项目文档站。"}}\n\n',
              'event: content_block_stop\n',
              'data: {"index":0}\n\n',
            ]),
        text: async () => 'mock response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowlistedTools(['Bash']),
      null as any,
      configManager,
    )
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-minimax-bracket-tool-call-suppressed-by-intent',
        prompt: '你的意思是可以用 GitHub Pages 做文档站？',
        cwd: tmpdir(),
      }),
    )

    assert.ok(!events.some(event =>
      event.type === 'assistant_delta' && JSON.stringify(event).includes(']<]minimax[>['),
    ))
    assert.ok(!events.some(event =>
      event.type === 'assistant_delta' && JSON.stringify(event).includes('<tool_call>'),
    ))
    assert.ok(!events.some(event => event.type === 'tool_started'))
    assert.equal(fetchCalls.length, 2)

    const suppressionError = events.find(event => event.type === 'error' && (event as any).code === 'TOOL_CALL_SUPPRESSED_BY_USER_INTENT') as any
    assert.ok(suppressionError)
    assert.deepEqual(suppressionError.details.attemptedTools, ['Bash'])
    assert.equal(suppressionError.details.retryAttempted, true)

    const firstBody = JSON.parse(String(fetchCalls[0].init?.body))
    assert.equal(firstBody.tools, undefined)
    const secondBody = JSON.parse(String(fetchCalls[1].init?.body))
    assert.deepEqual(secondBody.tools.map((tool: any) => tool.name), ['Bash'])

    const resultEvent = events.find(event => event.type === 'result') as any
    assert.ok(resultEvent)
    assert.equal(resultEvent.success, true)
    assert.doesNotMatch(resultEvent.message, /tool_call|invoke name|Bash|pwd/)
  })

  test('retries suppressed respond-only tool calls once and allows tool execution on retry', async () => {
    const cwd = join(tmpdir(), `babel-o-test-suppressed-retry-${Date.now()}`)
    fs.mkdirSync(cwd, { recursive: true })

    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"greeting\\",\\"confidence\\":0.9,\\"continuity\\":0.7,\\"contextScope\\":\\"full\\",\\"actionHint\\":\\"respond_only\\",\\"requiresTools\\":false,\\"reason\\":\\"Greeting.\\",\\"guidance\\":\\"Reply directly.\\",\\"explicitPaths\\":[]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock intake response text',
        } as Response
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      const nextStream = fetchCalls.length <= 2
        ? createMockStream([
            'event: content_block_start\n',
            `data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-${fetchCalls.length}","name":"Bash","input":{}}}\n\n`,
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"pwd\\",\\"timeoutMs\\":15000}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ])
        : createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"已完成验证。"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ])
      return {
        ok: true,
        status: 200,
        body: nextStream,
        text: async () => 'mock response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowlistedTools(['Bash']),
      null as any,
      configManager,
    )
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-suppressed-tool-call-retry-allows-tool',
        prompt: '你好？',
        cwd,
        skipPermissionCheck: true,
      }),
    )

    try {
      fs.rmSync(cwd, { recursive: true, force: true })
    } catch {}

    assert.equal(fetchCalls.length, 3)
    const suppressionError = events.find(event => event.type === 'error' && (event as any).code === 'TOOL_CALL_SUPPRESSED_BY_USER_INTENT') as any
    assert.ok(suppressionError)
    assert.deepEqual(suppressionError.details.attemptedTools, ['Bash'])
    assert.equal(suppressionError.details.retryAttempted, true)
    assert.equal(suppressionError.details.retryExhausted, false)

    const firstBody = JSON.parse(String(fetchCalls[0].init?.body))
    assert.equal(firstBody.tools, undefined)
    const secondBody = JSON.parse(String(fetchCalls[1].init?.body))
    assert.deepEqual(secondBody.tools.map((tool: any) => tool.name), ['Bash'])

    const toolStartedEvents = events.filter(event => event.type === 'tool_started') as any[]
    assert.equal(toolStartedEvents.length, 1)
    assert.equal(toolStartedEvents[0]?.name, 'Bash')
    assert.equal(toolStartedEvents[0]?.input.command, 'pwd')

    const toolCompleted = events.find(event => event.type === 'tool_completed') as any
    assert.ok(toolCompleted)
    assert.equal(toolCompleted.name, 'Bash')
    assert.equal(toolCompleted.success, true)
    assert.match(JSON.stringify(toolCompleted.output), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const resultEvent = events.find(event => event.type === 'result') as any
    assert.ok(resultEvent)
    assert.equal(resultEvent.success, true)
    assert.match(resultEvent.message, /已完成验证/)
  })

  test('asks user to confirm ambiguous option input before running tools', async () => {
    const sessionId = 'test-option-input-tool-conflict-clarification'
    const cwd = join(tmpdir(), `babel-o-test-option-clarify-${Date.now()}`)
    const storage = new MemoryStorage()
    fs.mkdirSync(cwd, { recursive: true })
    fs.writeFileSync(join(cwd, 'package.json'), '{"name":"option-clarify-test"}\n')
    await storage.saveSession({
      sessionId,
      cwd,
      prompt: 'B',
      phase: 'executing',
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
      events: [],
    })

    const appendAll = async (events: NexusEvent[]) => {
      for (const event of events) await storage.appendEvent(sessionId, event)
    }

    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"new_focus\\",\\"confidence\\":0.6,\\"continuity\\":0.8,\\"contextScope\\":\\"recent\\",\\"actionHint\\":\\"respond_only\\",\\"requiresTools\\":false,\\"reason\\":\\"Single-letter option-like input.\\",\\"guidance\\":\\"Confirm whether this selects a prior option.\\",\\"explicitPaths\\":[]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock intake response text',
        } as Response
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: true,
        status: 200,
        body: fetchCalls.length === 1
          ? createMockStream([
              'event: content_block_start\n',
              'data: {"index":0,"content_block":{"type":"tool_use","id":"tool-read-b","name":"Read","input":{}}}\n\n',
              'event: content_block_delta\n',
              'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"package.json\\"}"}}\n\n',
              'event: content_block_stop\n',
              'data: {"index":0}\n\n',
            ])
          : createMockStream([
              'event: content_block_start\n',
              'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
              'event: content_block_delta\n',
              'data: {"index":0,"delta":{"type":"text_delta","text":"Confirmed option B and read package.json."}}\n\n',
              'event: content_block_stop\n',
              'data: {"index":0}\n\n',
            ]),
        text: async () => 'mock response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowlistedTools(['Read']),
      storage,
      configManager,
    )

    try {
      await storage.appendEvent(sessionId, {
        type: 'user_message',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: '2026-06-12T00:00:01.000Z',
        text: 'B',
      })
      const firstEvents = await collectEvents(runtime.executeStream({
        sessionId,
        prompt: 'B',
        cwd,
        skipPermissionCheck: true,
      }))
      await appendAll(firstEvents)

      assert.equal(fetchCalls.length, 1)
      assert.ok(!firstEvents.some(event => event.type === 'tool_started'))
      const clarificationError = firstEvents.find(event => event.type === 'error' && (event as any).code === 'TOOL_CALL_NEEDS_USER_CONFIRMATION') as any
      assert.ok(clarificationError)
      assert.equal(clarificationError.details.optionSelection, 'B')
      const clarificationText = firstEvents.find(event => event.type === 'result') as any
      assert.ok(clarificationText)
      assert.equal(clarificationText.success, true)
      assert.match(clarificationText.message, /Reply "B" again to confirm/)

      fetchCalls.length = 0
      await storage.appendEvent(sessionId, {
        type: 'user_message',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: '2026-06-12T00:00:02.000Z',
        text: 'B',
      })
      const confirmedEvents = await collectEvents(runtime.executeStream({
        sessionId,
        prompt: 'B',
        cwd,
        skipPermissionCheck: true,
      }))

      assert.equal(fetchCalls.length, 2)
      const confirmedBody = JSON.parse(String(fetchCalls[1].init?.body))
      assert.deepEqual(confirmedBody.tools.map((tool: any) => tool.name), ['Read'])
      assert.ok(confirmedEvents.some(event => event.type === 'tool_started' && (event as any).name === 'Read'))
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('suppresses generic tool-shaped text while tools are hidden and retries final answer', async () => {
    globalThis.fetch = async (url, init) => {
      const body = parseRequestBody(init)
      if (isIntakeRequestBody(body)) {
        return {
          ok: true,
          status: 200,
          body: createMockStream([
            'event: content_block_start\n',
            'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"intent\\":\\"greeting\\",\\"confidence\\":0.9,\\"continuity\\":0.7,\\"contextScope\\":\\"full\\",\\"actionHint\\":\\"respond_only\\",\\"requiresTools\\":false,\\"reason\\":\\"Greeting.\\",\\"guidance\\":\\"Reply directly.\\",\\"explicitPaths\\":[]}"}}\n\n',
            'event: content_block_stop\n',
            'data: {"index":0}\n\n',
          ]),
          text: async () => 'mock intake response text',
        } as Response
      }
      fetchCalls.push({ url: typeof url === 'string' ? url : (url as Request).url, init })
      return {
        ok: true,
        status: 200,
        body: fetchCalls.length === 1
          ? createMockStream([
              'event: content_block_start\n',
              'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
              'event: content_block_delta\n',
              'data: {"index":0,"delta":{"type":"text_delta","text":"<tool_call><invoke name=\\"Bash\\"><command>pwd</command></invoke></tool_call>"}}\n\n',
              'event: content_block_stop\n',
              'data: {"index":0}\n\n',
            ])
          : createMockStream([
              'event: content_block_start\n',
              'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
              'event: content_block_delta\n',
              'data: {"index":0,"delta":{"type":"text_delta","text":"可以，直接回答即可，不需要执行命令。"}}\n\n',
              'event: content_block_stop\n',
              'data: {"index":0}\n\n',
            ]),
        text: async () => 'mock response text',
      } as Response
    }

    const runtime = new LLMCodingRuntime(toolsRegistry, allowAllTools(), null as any, configManager)
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-generic-tool-shaped-text-suppressed',
        prompt: '你的意思是可以这样做？',
        cwd: tmpdir(),
      }),
    )

    assert.equal(fetchCalls.length, 2)
    assert.ok(!events.some(event =>
      event.type === 'assistant_delta' && JSON.stringify(event).includes('<tool_call>'),
    ))
    assert.ok(!events.some(event => event.type === 'tool_started'))

    const leakError = events.find(event => event.type === 'error' && (event as any).code === 'TOOL_CALL_TEXT_LEAK_SUPPRESSED') as any
    assert.ok(leakError)
    assert.equal(leakError.details.phase, 'respond_only')
    assert.match(leakError.details.pattern, /<\/?tool_call/)
    assert.doesNotMatch(leakError.details.redactedPreview, /<command>pwd<\/command>/)
    assert.equal(leakError.details.retryAttempted, true)

    const secondBody = JSON.parse(String(fetchCalls[1].init?.body))
    assert.match(JSON.stringify(secondBody), /tool-call-shaped text/)
    assert.doesNotMatch(JSON.stringify(secondBody), /<command>pwd<\/command>/)

    const resultEvent = events.find(event => event.type === 'result') as any
    assert.ok(resultEvent)
    assert.equal(resultEvent.success, true)
    assert.doesNotMatch(resultEvent.message, /tool_call|invoke name|pwd/)
  })

  test('normalizes MiniMax text-encoded tool calls before runtime rendering', async () => {
    configManager.setProviderConfig('minimax', {
      apiKey: 'minimax-test-key',
      baseUrl: 'https://api.test-minimax.com/anthropic',
    })
    configManager.setDefaultModel('minimax/MiniMax-M2.7-highspeed')

    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"<minimax:tool_call>\\n<invoke name=\\"Bash\\">\\n<parameter name=\\"command\\">git commit -m x</parameter>\\n</invoke>\\n</minimax:tool_call>"}}\n\n',
      ]),
    )

    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowlistedTools(['Read']),
      null as any,
      configManager,
    )
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-minimax-text-tool-call-normalized',
        prompt: 'run a command',
        cwd: tmpdir(),
      }),
    )

    assert.ok(!events.some(event =>
      event.type === 'assistant_delta' && (event as any).text.includes('<minimax:tool_call>'),
    ))

    const toolStarted = events.find(event => event.type === 'tool_started') as any
    assert.ok(toolStarted)
    assert.equal(toolStarted.name, 'Bash')
    assert.equal(toolStarted.input.command, 'git commit -m x')

    const toolDenied = events.find(event => event.type === 'tool_denied') as any
    assert.ok(toolDenied)
    assert.equal(toolDenied.name, 'Bash')
  })

  test('keeps malformed OpenAI tool-call arguments recoverable at runtime', async () => {
    configManager.setProviderConfig('openai', {
      apiKey: 'openai-test-key',
      baseUrl: 'https://api.test-openai.com/v1',
    })
    configManager.setDefaultModel('openai/gpt-4o')

    fetchStreamResponses.push(
      createMockStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"Read","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"README.md"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    )

    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowlistedTools(['Read']),
      null as any,
      configManager,
    )
    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-openai-malformed-tool-call-recoverable',
        prompt: 'read a file',
        cwd: tmpdir(),
      }),
    )

    assert.ok(!events.some(event =>
      event.type === 'assistant_delta' && JSON.stringify(event).includes('tool_calls'),
    ))

    const toolStarted = events.find(event => event.type === 'tool_started') as any
    assert.ok(toolStarted)
    assert.equal(toolStarted.name, 'Read')
    assert.equal(toolStarted.toolUseId, 'call_bad')
    assert.equal(toolStarted.input._parseError, true)
    assert.equal(toolStarted.input.rawPreview, '{"path":README.md')

    const toolCompleted = events.find(event => event.type === 'tool_completed') as any
    assert.ok(toolCompleted)
    assert.equal(toolCompleted.name, 'Read')
    assert.equal(toolCompleted.toolUseId, 'call_bad')
    assert.equal(toolCompleted.success, false)
    assert.equal(toolCompleted.output.code, 'TOOL_INPUT_PARSE_ERROR')
    assert.match(toolCompleted.output.repairHint, /pathMatches/)
    assert.equal(toolCompleted.output.rawPreview, '{"path":README.md')

    assert.ok(events.indexOf(toolStarted) < events.indexOf(toolCompleted))
  })

  test('summarizes suppressed tool-shaped text without raw command bodies', () => {
    const events: NexusEvent[] = [
      {
        type: 'error',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: 'session-id',
        timestamp: '2026-06-05T00:00:00.000Z',
        code: 'TOOL_CALL_TEXT_LEAK_SUPPRESSED',
        message: 'Suppressed tool-call-shaped assistant text while tools are unavailable for this turn.',
        details: {
          phase: 'respond_only',
          pattern: '<tool_call',
          redactedPreview: '<tool_call><invoke name="Bash"><command>[REDACTED]</command></invoke></tool_call>',
        },
      },
    ]

    const summary = summarizeSessionEvents(events)

    assert.match(summary, /TOOL_CALL_TEXT_LEAK_SUPPRESSED/)
    assert.match(summary, /phase respond_only/)
    assert.match(summary, /\[REDACTED\]/)
    assert.doesNotMatch(summary, /pwd|cat package\.json|git remote/)
    assert.equal(isRecoveryBoundaryError('TOOL_CALL_TEXT_LEAK_SUPPRESSED'), true)
  })

  test('blocks disallowed tools and yields tool_denied event', async () => {
    // Stream 1: Request execute-risk Bash, which is not in our allowlist.
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-bash","name":"Bash","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"git commit -m x\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"Bash is not allowed, so I will answer without running it."}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])
    )

    const runtime = new LLMCodingRuntime(
      toolsRegistry,
      allowlistedTools(['Read', 'Write']), // Bash is blocked
      null as any,
      configManager
    )

    const events = await collectEvents(
      runtime.executeStream({
        sessionId: 'test-session-denied',
        prompt: 'run bash',
        cwd: tmpdir(),
      })
    )

    // Verify tool was blocked
    const toolStarted = events.find(e => e.type === 'tool_started') as any
    assert.ok(toolStarted)
    assert.equal(toolStarted.name, 'Bash')

    const toolDenied = events.find(e => e.type === 'tool_denied') as any
    assert.ok(toolDenied)
    assert.equal(toolDenied.name, 'Bash')

    const resultEvent = events.find(e => e.type === 'result') as any
    assert.equal(resultEvent.success, true)
    assert.match(resultEvent.message, /without running it/)
  })
})

describe('mapEventsToMessages', () => {
  test('correctly maps event logs to model messages', () => {
    const events: NexusEvent[] = [
      {
        type: 'user_message',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.123Z',
        text: 'hello',
      },
      {
        type: 'assistant_delta',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.124Z',
        text: 'Hello, let me run a tool ',
      },
      {
        type: 'assistant_delta',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.125Z',
        text: 'now.',
      },
      {
        type: 'tool_started',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.126Z',
        toolUseId: 'call-1',
        name: 'read',
        input: { path: 'sample.txt' },
      },
      {
        type: 'tool_completed',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.127Z',
        toolUseId: 'call-1',
        name: 'read',
        success: true,
        output: 'file content here',
      },
    ]

    const messages = mapEventsToMessages(events, 'hello')

    // Initial prompt + events
    assert.equal(messages.length, 3)

    // User message
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[0].content, 'hello')

    // Assistant message containing text block + tool_use block
    assert.equal(messages[1].role, 'assistant')
    const assistantContent = messages[1].content as any[]
    assert.equal(assistantContent.length, 2)
    assert.equal(assistantContent[0].type, 'text')
    assert.equal(assistantContent[0].text, 'Hello, let me run a tool now.')
    assert.equal(assistantContent[1].type, 'tool_use')
    assert.equal(assistantContent[1].id, 'call-1')
    assert.equal(assistantContent[1].name, 'read')
    assert.deepEqual(assistantContent[1].input, { path: 'sample.txt' })

    // User response message containing tool_result block
    assert.equal(messages[2].role, 'user')
    const userContent = messages[2].content as any[]
    assert.equal(userContent.length, 1)
    assert.equal(userContent[0].type, 'tool_result')
    assert.equal(userContent[0].toolUseId, 'call-1')
    assert.equal(userContent[0].content, 'file content here')
  })

  test('does not replay historical thinking_delta as provider reasoning content', () => {
    const messages = mapEventsToMessages([
      {
        type: 'user_message',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.123Z',
        text: 'first task',
      },
      {
        type: 'thinking_delta',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.124Z',
        text: '<file_contents>stale hidden analysis</file_contents>',
      },
      {
        type: 'assistant_delta',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.125Z',
        text: 'visible answer',
      },
      {
        type: 'user_message',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.126Z',
        text: 'follow up',
      },
    ], 'first task')

    assert.equal(messages.length, 3)
    assert.equal(messages[1].role, 'assistant')
    assert.equal(messages[1].content, 'visible answer')
    assert.ok(!messages[1].reasoningContent)
    assert.doesNotMatch(JSON.stringify(messages), /file_contents/)
  })

  test('deduplicates repeated adjacent user messages from empty historical turns', () => {
    const messages = mapEventsToMessages([
      {
        type: 'user_message',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.123Z',
        text: '架构性能差异',
      },
      {
        type: 'result',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.124Z',
        success: true,
        message: '',
      },
      {
        type: 'user_message',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.125Z',
        text: '架构性能差异',
      },
    ], '架构性能差异')

    assert.deepEqual(messages, [{ role: 'user', content: '架构性能差异' }])
  })

  test('synthetically completes incomplete tool calls to satisfy model validation schemas', () => {
    const events: NexusEvent[] = [
      {
        type: 'tool_started',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.126Z',
        toolUseId: 'call-1',
        name: 'read',
        input: { path: 'sample.txt' },
      },
      // Note: No tool_completed event for call-1 (e.g. denied or interrupted)
    ]

    const messages = mapEventsToMessages(events, 'initial prompt')

    assert.equal(messages.length, 3)

    // Assistant message contains the tool_use
    assert.equal(messages[1].role, 'assistant')
    const assistantContent = messages[1].content as any[]
    assert.equal(assistantContent[0].type, 'tool_use')
    assert.equal(assistantContent[0].id, 'call-1')

    // User message contains a synthetic tool_result with error status
    assert.equal(messages[2].role, 'user')
    const userContent = messages[2].content as any[]
    assert.equal(userContent[0].type, 'tool_result')
    assert.equal(userContent[0].toolUseId, 'call-1')
    assert.equal(userContent[0].isError, true)
    assert.match(userContent[0].content, /denied or interrupted/)
  })

  test('skips orphan tool_completed events whose tool_started was compacted away', () => {
    const messages = mapEventsToMessages([
      {
        type: 'user_message',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.123Z',
        text: 'continue',
      },
      {
        type: 'tool_completed',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.127Z',
        toolUseId: 'call-orphan',
        name: 'Read',
        success: true,
        output: 'file content here',
      },
    ], 'continue')

    assert.equal(messages.length, 1)
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[0].content, 'continue')
    assert.doesNotMatch(JSON.stringify(messages), /call-orphan/)
  })

  test('repairs completed-before-started tool order during provider replay', () => {
    const timestamp = '2026-05-22T05:40:00.126Z'
    const messages = mapEventsToMessages([
      {
        type: 'user_message',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.123Z',
        text: 'inspect',
      },
      {
        type: 'tool_completed',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp,
        toolUseId: 'call-repair',
        name: 'Bash',
        success: true,
        output: 'ok',
      },
      {
        type: 'tool_started',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp,
        toolUseId: 'call-repair',
        name: 'Bash',
        input: { command: 'echo ok' },
      },
    ], 'inspect')

    assert.equal(messages.length, 3)
    assert.equal(messages[1].role, 'assistant')
    const assistantContent = messages[1].content as any[]
    assert.equal(assistantContent[0].type, 'tool_use')
    assert.equal(assistantContent[0].id, 'call-repair')
    assert.equal(messages[2].role, 'user')
    const userContent = messages[2].content as any[]
    assert.equal(userContent.length, 1)
    assert.equal(userContent[0].type, 'tool_result')
    assert.equal(userContent[0].toolUseId, 'call-repair')
    assert.equal(userContent[0].content, 'ok')
    assert.doesNotMatch(JSON.stringify(messages), /denied or interrupted/)
  })

  test('replays timeout warnings as convergence constraints for provider continuation', () => {
    const messages = mapEventsToMessages([
      {
        type: 'user_message',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-06-13T00:00:00.000Z',
        text: 'analyze deeply',
      },
      {
        type: 'assistant_delta',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-06-13T00:00:01.000Z',
        text: 'Partial analysis collected from Read and Grep.',
      },
      {
        type: 'near_timeout_warning',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-06-13T00:02:24.000Z',
        timeoutMs: 180_000,
        elapsedMs: 144_000,
        thresholdRatio: 0.8,
        partialSummary: 'Read A and Grep B are verified.',
        message: 'Execution is near its timeout budget.',
      },
    ], 'analyze deeply')

    const last = messages.at(-1)
    assert.equal(last?.role, 'user')
    assert.match(String(last?.content), /Runtime timeout convergence warning/)
    assert.match(String(last?.content), /Do not start new exploratory tool calls/)
    assert.match(String(last?.content), /at most one explicitly bounded final check/)
    assert.match(String(last?.content), /Mark unverified claims as unverified/)
    assert.match(String(last?.content), /Read A and Grep B are verified/)
  })

  test('replays soft timeout extension as wrap-up constraint', () => {
    const messages = mapEventsToMessages([
      {
        type: 'user_message',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-06-13T00:00:00.000Z',
        text: 'analyze deeply',
      },
      {
        type: 'timeout_budget_exceeded',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-06-13T00:01:00.000Z',
        requestId: 'req-1',
        timeoutMs: 60_000,
        elapsedMs: 60_100,
        policy: 'soft',
        partialSummary: 'Some evidence has been collected.',
        suggestedActions: ['summarize', 'narrow_scope'],
        message: 'Soft timeout budget reached.',
      },
      {
        type: 'timeout_extension_granted',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-06-13T00:01:00.001Z',
        requestId: 'req-1',
        extensionCount: 1,
        maxExtensions: 1,
        additionalMs: 60_000,
        totalSoftBudgetMs: 120_000,
        elapsedMs: 60_100,
        policy: 'soft',
        reason: 'auto-first-budget-exhausted',
        message: 'Automatic soft-timeout extension granted.',
      },
    ], 'analyze deeply')

    const budgetMessage = messages.at(-2)
    assert.equal(budgetMessage?.role, 'user')
    assert.match(String(budgetMessage?.content), /Runtime soft timeout budget reached/)
    assert.match(String(budgetMessage?.content), /not permission for broad discovery/)
    assert.match(String(budgetMessage?.content), /Some evidence has been collected/)

    const extensionMessage = messages.at(-1)
    assert.equal(extensionMessage?.role, 'user')
    assert.match(String(extensionMessage?.content), /extension 1\/1/)
    assert.match(String(extensionMessage?.content), /Use this extension to wrap up/)
    assert.match(String(extensionMessage?.content), /Run at most one explicitly bounded final check/)
  })

  test('groups consecutive tool calls into one assistant turn and one tool result turn', () => {
    const messages = mapEventsToMessages([
      {
        type: 'user_message',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.123Z',
        text: 'inspect files',
      },
      {
        type: 'assistant_delta',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.124Z',
        text: 'I will inspect both files.',
      },
      {
        type: 'tool_started',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.125Z',
        toolUseId: 'call-1',
        name: 'Read',
        input: { path: 'a.ts' },
      },
      {
        type: 'tool_completed',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.126Z',
        toolUseId: 'call-1',
        name: 'Read',
        success: true,
        output: 'a',
      },
      {
        type: 'tool_started',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.127Z',
        toolUseId: 'call-2',
        name: 'Read',
        input: { path: 'b.ts' },
      },
      {
        type: 'tool_completed',
        schemaVersion: '2026-05-21.babel-o.v1',
        sessionId: 'session-id',
        timestamp: '2026-05-22T05:40:00.128Z',
        toolUseId: 'call-2',
        name: 'Read',
        success: true,
        output: 'b',
      },
    ], 'inspect files')

    assert.equal(messages.length, 3)
    const assistantContent = messages[1].content as any[]
    const toolResultContent = messages[2].content as any[]
    assert.deepEqual(assistantContent.map(block => block.type), ['text', 'tool_use', 'tool_use'])
    assert.deepEqual(assistantContent.slice(1).map(block => block.id), ['call-1', 'call-2'])
    assert.deepEqual(toolResultContent.map(block => block.toolUseId), ['call-1', 'call-2'])
  })
})

function createEverCoreRuntimeTestConfig(overrides: Partial<EverCoreRuntimeConfig> = {}): EverCoreRuntimeConfig {
  return {
    appId: 'babel-o',
    projectId: 'project-1',
    agentId: 'agent-1',
    retrieveMethod: 'hybrid',
    topK: 5,
    uploadOnSessionEnd: false,
    maxMessages: 8,
    maxContentChars: 120,
    mcpToolsEnabled: false,
    ...overrides,
  }
}

function createMockEverCoreClient(overrides: Partial<EverCoreClient> = {}): EverCoreClient {
  return {
    async search() {
      return { data: {} }
    },
    async addAgentMessages() {
      return { data: {} }
    },
    async flushAgentSession() {
      return { data: {} }
    },
    ...overrides,
  }
}

describe('Agent role structured output', () => {
  test('role output JSON schemas expose required fields', () => {
    const plannerSchema = zodRoleOutputSchemaToJsonSchema(PLANNER_ROLE.outputSchema) as any
    const executorSchema = zodRoleOutputSchemaToJsonSchema(EXECUTOR_ROLE.outputSchema) as any
    const criticSchema = zodRoleOutputSchemaToJsonSchema(CRITIC_ROLE.outputSchema) as any

    assert.deepEqual(plannerSchema.required, ['summary', 'tasks'])
    assert.deepEqual(executorSchema.required, ['taskId', 'success', 'result'])
    assert.deepEqual(criticSchema.required, ['approved'])
    assert.ok(plannerSchema.properties?.tasks)
    assert.ok(executorSchema.properties?.result)
    assert.ok(criticSchema.properties?.approved)
  })

  test('PlannerOutputSchema normalizes provider task variants', () => {
    const parsed = parseStructuredAgentOutput(
      undefined,
      JSON.stringify({
        goal: 'Optimize project cleanup',
        tasks: [
          {
            id: 1,
            description: 'Create package.json with TypeScript build dependencies',
            action: 'write',
            file: 'package.json',
            status: 'pending',
          },
          {
            id: 2,
            action: 'edit',
            file: 'src/app.ts',
          },
        ],
      }),
      PLANNER_ROLE.outputSchema,
    ) as any

    assert.equal(parsed.summary, 'Optimize project cleanup')
    assert.equal(parsed.tasks[0].title, 'Create package.json with TypeScript build dependencies')
    assert.equal(parsed.tasks[0].metadata.action, 'write')
    assert.equal(parsed.tasks[1].title, 'edit src/app.ts')
  })

  test('ExecutorOutputSchema accepts delegated subTasks', () => {
    const parsed = parseStructuredAgentOutput(
      undefined,
      JSON.stringify({
        taskId: '1',
        success: true,
        result: 'Delegated implementation subtasks',
        needsReview: false,
        subTasks: [
          {
            title: 'Implement parser',
            description: 'Add parser changes',
            requiresIsolation: true,
            metadata: { area: 'runtime' },
          },
        ],
      }),
      EXECUTOR_ROLE.outputSchema,
    ) as any

    assert.equal(parsed.taskId, '1')
    assert.equal(parsed.subTasks.length, 1)
    assert.equal(parsed.subTasks[0].title, 'Implement parser')
    assert.equal(parsed.subTasks[0].requiresIsolation, true)
  })

  test('ExecutorOutputSchema normalizes partial provider results with input taskId', () => {
    const parsed = parseStructuredAgentOutput(
      undefined,
      JSON.stringify({
        status: 'completed',
        message: 'Cleaned up the helper function and verified the tiny project.',
      }),
      EXECUTOR_ROLE.outputSchema,
      undefined,
      { taskId: 'task-from-input' },
    ) as any

    assert.equal(parsed.taskId, 'task-from-input')
    assert.equal(parsed.success, true)
    assert.match(parsed.result, /Cleaned up/)
    assert.equal(parsed.metadata.status, 'completed')
  })

  test('PlannerOutputSchema falls back to numbered natural language plans', () => {
    const parsed = parseStructuredAgentOutput(
      undefined,
      [
        'Plan for cleanup:',
        '1. Simplify add function: remove redundant temporary result variable.',
        '2. Verify TypeScript syntax: inspect sample.ts after the edit.',
      ].join('\n'),
      PLANNER_ROLE.outputSchema,
    ) as any

    assert.equal(parsed.summary, 'Plan for cleanup:')
    assert.equal(parsed.tasks.length, 2)
    assert.equal(parsed.tasks[0].title, 'Simplify add function')
    assert.match(parsed.tasks[0].description, /remove redundant/)
  })

  test('PlannerOutputSchema falls back from empty JSON objects', () => {
    const parsed = parseStructuredAgentOutput(
      undefined,
      '{}',
      PLANNER_ROLE.outputSchema,
    ) as any

    assert.match(parsed.summary, /empty plan/)
    assert.equal(parsed.tasks.length, 1)
    assert.equal(parsed.tasks[0].metadata.generatedFallback, 'empty-planner-output')
  })
})
