import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConfigManager } from '../src/shared/config.js'
import { LLMCodingRuntime, mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { allowAllTools, allowlistedTools } from '../src/runtime/LocalCodingRuntime.js'
import type { NexusEvent } from '../src/shared/events.js'
import { EXECUTOR_ROLE, PLANNER_ROLE } from '../src/nexus/agentRoles.js'
import { parseStructuredAgentOutput } from '../src/nexus/runtimeAgentStep.js'

const CONFIG_ENV_KEYS = [
  'BABEL_O_MODEL',
  'BABEL_O_PROVIDER',
  'BABEL_O_API_KEY',
  'BABEL_O_BASE_URL',
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

    assert.equal(fetchCalls.length, 1)
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    assert.equal(body.tools, undefined)
    assert.match(JSON.stringify(body.system), /User Intake Guidance/)
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

  test('only exposes policy-allowed tools to provider requests', async () => {
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
        sessionId: 'test-tool-policy-visible',
        prompt: 'inspect project',
        cwd: tmpdir(),
      })
    )

    const body = JSON.parse(String(fetchCalls[0].init?.body))
    const toolNames = body.tools.map((tool: any) => tool.name).sort()
    assert.deepEqual(toolNames, ['Glob', 'Read'])
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

  test('hides tools and refuses new tool calls in final-response-only mode', async () => {
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
    assert.equal(toolStartedEvents.length, 21)
    assert.ok(!toolStartedEvents.some(event => (event as any).toolUseId === 'tool-call-blocked'))

    const guardError = events.find(event => event.type === 'error' && (event as any).code === 'TOOL_LOOP_FINAL_RESPONSE_ONLY') as any
    assert.ok(guardError)
    assert.match(guardError.message, /ignored additional requested tools/)

    const finalOnlyBody = JSON.parse(String(fetchCalls[21].init?.body))
    assert.equal(finalOnlyBody.tools, undefined)
    assert.match(JSON.stringify(finalOnlyBody.system), /Runtime has hidden all tools/)

    const resultEvent = events.find(event => event.type === 'result') as any
    assert.ok(resultEvent)
    assert.equal(resultEvent.success, true)
    assert.match(resultEvent.message, /final answer/)
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
        'data: {"index":0,"delta":{"type":"text_delta","text":"<minimax:tool_call>\\n<invoke name=\\"Bash\\">\\n<parameter name=\\"command\\">pwd</parameter>\\n<parameter name=\\"timeoutMs\\">15000</parameter>\\n</invoke>\\n</minimax:tool_call>"}}\n\n',
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
    assert.equal(toolStarted.input.command, 'pwd')
    assert.equal(toolStarted.input.timeoutMs, '15000')

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

    assert.ok(!events.some(event => event.type === 'tool_started'))

    const toolCompleted = events.find(event => event.type === 'tool_completed') as any
    assert.ok(toolCompleted)
    assert.equal(toolCompleted.name, 'Read')
    assert.equal(toolCompleted.success, false)
    assert.equal(toolCompleted.output.code, 'PARSE_ERROR')
    assert.equal(toolCompleted.output.rawPreview, '{"path":README.md')
  })

  test('blocks disallowed tools and yields tool_denied event', async () => {
    // Stream 1: Request tool execution (bash tool which is not in our allowlist)
    fetchStreamResponses.push(
      createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool-call-bash","name":"Bash","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"pwd\\"}"}}\n\n',
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
    assert.equal(resultEvent.success, false)
    assert.match(resultEvent.message, /Tool denied/)
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

describe('Agent role structured output', () => {
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
