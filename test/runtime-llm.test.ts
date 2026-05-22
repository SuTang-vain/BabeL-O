import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConfigManager } from '../src/shared/config.js'
import { LLMCodingRuntime, mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { allowAllTools, allowlistedTools } from '../src/runtime/LocalCodingRuntime.js'
import type { NexusEvent } from '../src/shared/events.js'

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

describe('ConfigManager', () => {
  let tempConfigPath: string

  beforeEach(() => {
    tempConfigPath = join(tmpdir(), `babel-o-test-config-${Date.now()}-${Math.random()}.json`)
  })

  afterEach(() => {
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
      assert.equal(resolvedFromConfig.baseUrl, 'https://config.openai.com')

      // 2. Env variable fallback for API key
      process.env.OPENAI_API_KEY = 'env-openai-key'
      const resolvedFromProviderEnv = configManager.resolveSettings()
      assert.equal(resolvedFromProviderEnv.apiKey, 'env-openai-key')

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
})

describe('LLMCodingRuntime', () => {
  let tempConfigPath: string
  let configManager: ConfigManager
  let toolsRegistry: ReturnType<typeof createDefaultToolRegistry>
  let originalFetch: typeof globalThis.fetch
  let fetchCalls: { url: string; init?: RequestInit }[]
  let fetchStreamResponses: ReadableStream<Uint8Array>[]

  beforeEach(() => {
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
})
