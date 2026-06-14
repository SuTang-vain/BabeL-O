import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { AnthropicAdapter } from '../src/providers/adapters/AnthropicAdapter.js'
import { OpenAIAdapter } from '../src/providers/adapters/OpenAIAdapter.js'
import { getAdapter } from '../src/providers/registry.js'
import { ProviderError } from '../src/shared/errors.js'

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

function createHangingMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
    },
  })
}

async function collectStream<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iterable) {
    result.push(item)
  }
  return result
}

describe('Model Adapters & Factory', () => {
  let originalFetch: typeof fetch
  let lastFetchUrl: string | undefined
  let lastFetchInit: RequestInit | undefined
  let mockResponseBody: ReadableStream<Uint8Array> | null = null
  let mockResponseOk = true
  let mockResponseStatus = 200
  let mockResponseText = 'Error message'

  beforeEach(() => {
    originalFetch = globalThis.fetch
    lastFetchUrl = undefined
    lastFetchInit = undefined
    mockResponseBody = null
    mockResponseOk = true
    mockResponseStatus = 200
    mockResponseText = 'Error message'

    globalThis.fetch = async (url, init) => {
      lastFetchUrl = typeof url === 'string' ? url : (url as Request).url
      lastFetchInit = init
      return {
        ok: mockResponseOk,
        status: mockResponseStatus,
        text: async () => mockResponseText,
        body: mockResponseBody,
      } as Response
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('factory resolves expected adapters', () => {
    const local = getAdapter('local')
    assert.ok(local)

    const anthropic = getAdapter('anthropic')
    assert.ok(anthropic instanceof AnthropicAdapter)

    const openai = getAdapter('openai')
    assert.ok(openai instanceof OpenAIAdapter)
  })

  describe('AnthropicAdapter', () => {
    test('resolves bedrock and vertex model strings under env flags', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([])

      // 1. Bedrock
      process.env.AGENT_CLI_USE_BEDROCK = 'true'
      await collectStream(
        adapter.queryStream({
          model: 'anthropic/claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'hello' }],
        })
      )
      delete process.env.AGENT_CLI_USE_BEDROCK
      let body = JSON.parse(lastFetchInit?.body as string)
      assert.strictEqual(body.model, 'anthropic.agent_cli-3-5-sonnet-20241022-v2:0')

      // 2. Vertex
      process.env.AGENT_CLI_USE_VERTEX = 'true'
      await collectStream(
        adapter.queryStream({
          model: 'anthropic/claude-3-7-sonnet',
          messages: [{ role: 'user', content: 'hello' }],
        })
      )
      delete process.env.AGENT_CLI_USE_VERTEX
      body = JSON.parse(lastFetchInit?.body as string)
      assert.strictEqual(body.model, 'claude-3-7-sonnet@20250219')

      // 3. Fallback to default firstParty
      await collectStream(
        adapter.queryStream({
          model: 'anthropic/claude-3-opus',
          messages: [{ role: 'user', content: 'hello' }],
        })
      )
      body = JSON.parse(lastFetchInit?.body as string)
      assert.strictEqual(body.model, 'claude-3-opus-20240229')
    })

    test('adds ephemeral prompt cache headers and thinking parameters', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([])

      await collectStream(
        adapter.queryStream({
          model: 'anthropic/claude-3-5-sonnet',
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'how are you' },
          ],
          systemPrompt: 'You are a coder',
          tools: [{ name: 'test', description: 'test tool', inputSchema: {} }],
          enablePromptCaching: true,
          thinking: { budgetTokens: 2048 },
        })
      )

      const body = JSON.parse(lastFetchInit?.body as string)
      assert.ok(body.thinking)
      assert.strictEqual(body.thinking.budget_tokens, 2048)
      assert.strictEqual(body.thinking.type, 'enabled')
      assert.strictEqual(body.temperature, undefined) // temperature must be deleted when thinking is enabled

      // Cache controls are added
      assert.deepStrictEqual(body.system[0].cache_control, { type: 'ephemeral' })
      assert.deepStrictEqual(body.tools[0].cache_control, { type: 'ephemeral' })
      assert.deepStrictEqual(body.messages[2].content[0].cache_control, {
        type: 'ephemeral',
      })
    })

    test('parses anthropic SSE streams including thinking and tool calls', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_start\n',
        'data: {"index":1,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":1,"delta":{"type":"thinking_delta","thinking":"Let me think"}}\n\n',
        'event: content_block_start\n',
        'data: {"index":2,"content_block":{"type":"tool_use","id":"tool_123","name":"Read","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"R"}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":2,"delta":{"type":"input_json_delta","partial_json":"EADME.md\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":2}\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'anthropic/claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.deepStrictEqual(deltas, [
        { type: 'text', text: 'Hello' },
        { type: 'thinking', text: 'Let me think' },
        { type: 'tool_use_start', id: 'tool_123', name: 'Read' },
        { type: 'tool_use_delta', id: 'tool_123', inputDelta: '{"path": "R' },
        { type: 'tool_use_delta', id: 'tool_123', inputDelta: 'EADME.md"}' },
        { type: 'tool_use_end', id: 'tool_123', input: { path: 'README.md' } },
      ])
    })

    test('stops Anthropic-compatible streams on provider message_stop', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createHangingMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"{\\"approved\\":true}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'minimax/MiniMax-M3',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.deepStrictEqual(deltas, [
        { type: 'text', text: '{"approved":true}' },
        { type: 'finish', reason: 'end_turn' },
      ])
    })

    test('keeps malformed Anthropic tool input JSON as parse-error input', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool_bad","name":"Read","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'anthropic/claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.deepStrictEqual(deltas, [
        { type: 'tool_use_start', id: 'tool_bad', name: 'Read' },
        { type: 'tool_use_delta', id: 'tool_bad', inputDelta: '{"path":' },
        {
          type: 'tool_use_end',
          id: 'tool_bad',
          input: { _parseError: true, _rawInput: '{"path":' },
        },
      ])
    })

    test('throws ProviderError on non-200 response', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseOk = false
      mockResponseStatus = 400

      await assert.rejects(
        async () => {
          for await (const chunk of adapter.queryStream({
            model: 'anthropic/claude-3-5-sonnet',
            messages: [{ role: 'user', content: 'test' }],
          })) {}
        },
        (err: any) => {
              assert.strictEqual(err.name, 'ProviderError')
          assert.strictEqual(err.providerId, 'anthropic')
          assert.strictEqual(err.httpStatus, 400)
          return true
        }
      )
    })

    test('yields usage stats on message_start and message_delta events', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([
        'event: message_start\n',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1,"cache_creation_input_tokens":10,"cache_read_input_tokens":20}}}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","usage":{"output_tokens":15}}\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'anthropic/claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.deepStrictEqual(deltas, [
        {
          type: 'usage',
          inputTokens: 100,
          outputTokens: 1,
          cacheCreationInputTokens: 10,
          cacheReadInputTokens: 20,
        },
        {
          type: 'usage',
          inputTokens: 0,
          outputTokens: 15,
        },
      ])
    })

    test('zhipu model uses x-api-key and omits anthropic-beta', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([])

      await collectStream(
        adapter.queryStream(
          {
            model: 'zhipu/glm-5.1',
            messages: [{ role: 'user', content: 'test' }],
          },
          { apiKey: 'sk-zhipu-test' }
        )
      )

      assert.ok(lastFetchInit)
      const headers = lastFetchInit.headers as Record<string, string>
      assert.strictEqual(headers['x-api-key'], 'sk-zhipu-test')
      assert.strictEqual(headers['Authorization'], undefined)
      assert.strictEqual(headers['anthropic-version'], '2023-06-01')
      assert.strictEqual(headers['anthropic-beta'], undefined)
    })

    test('minimax model uses x-api-key and omits anthropic-beta', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([])

      await collectStream(
        adapter.queryStream(
          {
            model: 'minimax/MiniMax-M2.7',
            messages: [{ role: 'user', content: 'test' }],
          },
          { apiKey: 'sk-minimax-test' }
        )
      )

      assert.ok(lastFetchInit)
      const headers = lastFetchInit.headers as Record<string, string>
      assert.strictEqual(headers['x-api-key'], 'sk-minimax-test')
      assert.strictEqual(headers['Authorization'], undefined)
      assert.strictEqual(headers['anthropic-version'], '2023-06-01')
      assert.strictEqual(headers['anthropic-beta'], undefined)
    })

    test('rejects orphan Anthropic-compatible tool_result before fetch', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([])

      await assert.rejects(
        async () => {
          await collectStream(adapter.queryStream({
            model: 'minimax/MiniMax-M3',
            messages: [{
              role: 'user',
              content: [{ type: 'tool_result', toolUseId: 'call_missing', content: 'orphan' }],
            }],
          }))
        },
        /PROVIDER_REPLAY_INVALID_TOOL_SEQUENCE: orphan tool_result call_missing/,
      )
      assert.equal(lastFetchInit, undefined)
    })

    test('rejects duplicate Anthropic-compatible tool_result before fetch', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([])

      await assert.rejects(
        async () => {
          await collectStream(adapter.queryStream({
            model: 'minimax/MiniMax-M3',
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'call_dup', name: 'Read', input: { path: 'README.md' } }],
              },
              {
                role: 'user',
                content: [
                  { type: 'tool_result', toolUseId: 'call_dup', content: 'one' },
                  { type: 'tool_result', toolUseId: 'call_dup', content: 'two' },
                ],
              },
            ],
          }))
        },
        /PROVIDER_REPLAY_INVALID_TOOL_SEQUENCE: duplicate tool_result call_dup/,
      )
      assert.equal(lastFetchInit, undefined)
    })

    test('minimax text-encoded tool calls are normalized instead of streamed as text', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"<minimax:tool_call>\\n<invoke name=\\"Bash\\">\\n<parameter name=\\"command\\">ls &amp;&amp; pwd</parameter>\\n"}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"<parameter name=\\"timeoutMs\\">15000</parameter>\\n</invoke>\\n</minimax:tool_call>"}}\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'minimax/MiniMax-M2.7-highspeed',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.deepStrictEqual(deltas, [
        { type: 'tool_use_start', id: 'minimax_tool_1', name: 'Bash' },
        {
          type: 'tool_use_delta',
          id: 'minimax_tool_1',
          inputDelta: JSON.stringify({ command: 'ls && pwd', timeoutMs: '15000' }),
        },
        {
          type: 'tool_use_end',
          id: 'minimax_tool_1',
          input: { command: 'ls && pwd', timeoutMs: '15000' },
        },
        { type: 'finish', reason: 'tool_use' },
      ])
    })

    test('minimax bracket-wrapped tool calls with direct child tags are normalized', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"]<]minimax[>[<tool_call>\\n]<]minimax[>[<invoke name=\\"Bash\\">]<]minimax[>[<command>pwd</command>]"}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"]<]minimax[>[<timeoutMs>10000</timeoutMs>]\\n]<]minimax[>[</invoke>\\n]<]minimax[>[</tool_call>"}}\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'minimax/MiniMax-M3',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.deepStrictEqual(deltas, [
        { type: 'tool_use_start', id: 'minimax_tool_1', name: 'Bash' },
        {
          type: 'tool_use_delta',
          id: 'minimax_tool_1',
          inputDelta: JSON.stringify({ command: 'pwd', timeoutMs: '10000' }),
        },
        {
          type: 'tool_use_end',
          id: 'minimax_tool_1',
          input: { command: 'pwd', timeoutMs: '10000' },
        },
        { type: 'finish', reason: 'tool_use' },
      ])
      assert.ok(!deltas.some(delta => delta.type === 'text' && delta.text.includes(']<]minimax[>[')))
      assert.ok(!deltas.some(delta => delta.type === 'text' && delta.text.includes('<tool_call>')))
    })

    test('minimax text around encoded tool calls stays text while tool XML is suppressed', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"Before <minimax:tool_call>\\n<invoke name=\\"Read\\">\\n<parameter name=\\"path\\">README.md</parameter>\\n</invoke>\\n</minimax:tool_call> after"}}\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'minimax/MiniMax-M2.7-highspeed',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.deepStrictEqual(deltas, [
        { type: 'text', text: 'Before ' },
        { type: 'tool_use_start', id: 'minimax_tool_1', name: 'Read' },
        {
          type: 'tool_use_delta',
          id: 'minimax_tool_1',
          inputDelta: JSON.stringify({ path: 'README.md' }),
        },
        { type: 'tool_use_end', id: 'minimax_tool_1', input: { path: 'README.md' } },
        { type: 'finish', reason: 'tool_use' },
        { type: 'text', text: ' after' },
      ])
      assert.ok(!deltas.some(delta => delta.type === 'text' && delta.text.includes('<minimax:tool_call>')))
    })

    test('minimax incomplete text-encoded tool calls are not converted into tool invocations', async () => {
      const adapter = new AnthropicAdapter()
      mockResponseBody = createMockStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"<minimax:tool_call>\\n<invoke name=\\"Bash\\">\\n<parameter name=\\"command\\">pwd</parameter>"}}\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'minimax/MiniMax-M2.7-highspeed',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.ok(!deltas.some(delta => delta.type === 'tool_use_start'))
      assert.deepStrictEqual(deltas, [
        {
          type: 'text',
          text: '<minimax:tool_call>\n<invoke name="Bash">\n<parameter name="command">pwd</parameter>',
        },
      ])
    })
  })

  describe('OpenAIAdapter', () => {
    test('translates messages, tools, and parses OpenAI SSE stream', async () => {
      const adapter = new OpenAIAdapter()
      mockResponseBody = createMockStream([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"Deep thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'openai/gpt-4o',
          systemPrompt: 'System rule',
          messages: [
            { role: 'user', content: 'Hi' },
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Output' },
                { type: 'tool_use', id: 'call_old', name: 'Read', input: { path: 'old' } },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', toolUseId: 'call_old', content: 'success' },
              ],
            },
          ],
          tools: [{ name: 'Read', description: 'Read tool', inputSchema: {} }],
        })
      )

      const body = JSON.parse(lastFetchInit?.body as string)

      // Verify messages translation
      assert.strictEqual(body.messages[0].role, 'system')
      assert.strictEqual(body.messages[0].content, 'System rule')
      assert.strictEqual(body.messages[1].role, 'user')
      assert.strictEqual(body.messages[1].content, 'Hi')
      assert.strictEqual(body.messages[2].role, 'assistant')
      assert.strictEqual(body.messages[2].content, 'Output')
      assert.strictEqual(body.messages[2].tool_calls[0].id, 'call_old')
      assert.strictEqual(body.messages[3].role, 'tool')
      assert.strictEqual(body.messages[3].tool_call_id, 'call_old')
      assert.strictEqual(body.messages[3].content, 'success')

      // Verify tools translation
      assert.strictEqual(body.tools[0].type, 'function')
      assert.strictEqual(body.tools[0].function.name, 'Read')

      // Verify SSE stream events mapping
      assert.deepStrictEqual(deltas, [
        { type: 'text', text: 'Hi' },
        { type: 'thinking', text: 'Deep thinking' },
        { type: 'tool_use_start', id: 'call_1', name: 'Read' },
        { type: 'tool_use_delta', id: 'call_1', inputDelta: '{"pa' },
        { type: 'tool_use_delta', id: 'call_1', inputDelta: 'th":"a"}' },
        { type: 'tool_use_end', id: 'call_1', input: { path: 'a' } },
      ])
    })

    test('keeps malformed OpenAI tool call arguments as parse-error input', async () => {
      const adapter = new OpenAIAdapter()
      mockResponseBody = createMockStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"Read","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"README.md"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'openai/gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.deepStrictEqual(deltas, [
        { type: 'tool_use_start', id: 'call_bad', name: 'Read' },
        { type: 'tool_use_delta', id: 'call_bad', inputDelta: '{"path":' },
        { type: 'tool_use_delta', id: 'call_bad', inputDelta: 'README.md' },
        {
          type: 'tool_use_end',
          id: 'call_bad',
          input: { _parseError: true, _rawInput: '{"path":README.md' },
        },
      ])
    })

    test('keeps concurrent OpenAI tool calls separated by index', async () => {
      const adapter = new OpenAIAdapter()
      mockResponseBody = createMockStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","function":{"name":"Read","arguments":"{\\"pa"}},{"index":1,"id":"call_glob","function":{"name":"Glob","arguments":"{\\"pat"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"tern\\":\\"*.ts\\"}"}},{"index":0,"function":{"arguments":"th\\":\\"README.md\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'openai/gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.deepStrictEqual(deltas, [
        { type: 'tool_use_start', id: 'call_read', name: 'Read' },
        { type: 'tool_use_delta', id: 'call_read', inputDelta: '{"pa' },
        { type: 'tool_use_start', id: 'call_glob', name: 'Glob' },
        { type: 'tool_use_delta', id: 'call_glob', inputDelta: '{"pat' },
        { type: 'tool_use_delta', id: 'call_glob', inputDelta: 'tern":"*.ts"}' },
        { type: 'tool_use_delta', id: 'call_read', inputDelta: 'th":"README.md"}' },
        { type: 'tool_use_end', id: 'call_read', input: { path: 'README.md' } },
        { type: 'tool_use_end', id: 'call_glob', input: { pattern: '*.ts' } },
      ])
    })

    test('uses Moonshot seed defaults for OpenAI-compatible requests', async () => {
      const adapter = new OpenAIAdapter()
      mockResponseBody = createMockStream([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ])

      const oldOpenAiBaseUrl = process.env.OPENAI_BASE_URL
      let deltas
      try {
        process.env.OPENAI_BASE_URL = 'https://wrong-openai-env.example/v1'
        deltas = await collectStream(
          adapter.queryStream(
            {
              model: 'moonshot/moonshot-v1-128k',
              messages: [{ role: 'user', content: 'test' }],
            },
            { apiKey: 'sk-moonshot-test' }
          )
        )
      } finally {
        if (oldOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
        else process.env.OPENAI_BASE_URL = oldOpenAiBaseUrl
      }

      assert.equal(lastFetchUrl, 'https://api.moonshot.cn/v1/chat/completions')
      assert.ok(lastFetchInit)
      const headers = lastFetchInit.headers as Record<string, string>
      assert.equal(headers.Authorization, 'Bearer sk-moonshot-test')
      const body = JSON.parse(lastFetchInit.body as string)
      assert.equal(body.model, 'moonshot-v1-128k')
      assert.equal(body.max_tokens, 8192)
      assert.deepEqual(deltas, [{ type: 'text', text: 'ok' }])
    })

    test('uses Ollama OpenAI-compatible seed without Authorization header', async () => {
      const adapter = new OpenAIAdapter()
      mockResponseBody = createMockStream([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'ollama/qwen2.5-coder:7b',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.equal(lastFetchUrl, 'http://localhost:11434/v1/chat/completions')
      assert.ok(lastFetchInit)
      const headers = lastFetchInit.headers as Record<string, string>
      assert.equal(headers.Authorization, undefined)
      const body = JSON.parse(lastFetchInit.body as string)
      assert.equal(body.model, 'qwen2.5-coder:7b')
      assert.equal(body.max_tokens, 8192)
      assert.deepEqual(deltas, [{ type: 'text', text: 'ok' }])
    })

    test('throws ProviderError with parsed provider-specific error metadata', async () => {
      const adapter = new OpenAIAdapter()
      mockResponseOk = false
      mockResponseStatus = 401
      mockResponseText = JSON.stringify({
        error: {
          code: 'invalid_api_key',
          type: 'authentication_error',
          message: 'Incorrect API key provided.',
        },
        request_id: 'req_provider_123',
      })

      await assert.rejects(
        async () => {
          for await (const chunk of adapter.queryStream({
            model: 'openai/gpt-4o',
            messages: [{ role: 'user', content: 'test' }],
          })) {}
        },
        (err: any) => {
          assert.strictEqual(err.name, 'ProviderError')
          assert.strictEqual(err.providerId, 'openai')
          assert.strictEqual(err.httpStatus, 401)
          assert.deepStrictEqual(err.metadata, {
            code: 'invalid_api_key',
            type: 'authentication_error',
            message: 'Incorrect API key provided.',
            requestId: 'req_provider_123',
          })
          assert.match(err.message, /code=invalid_api_key/)
          assert.match(err.message, /request_id=req_provider_123/)
          return true
        }
      )
    })

    test('yields usage stats when stream_options are set', async () => {
      const adapter = new OpenAIAdapter()
      mockResponseBody = createMockStream([
        'data: {"choices":[]}\n\n',
        'data: {"usage":{"prompt_tokens":150,"completion_tokens":40}}\n\n',
        'data: [DONE]\n\n',
      ])

      const deltas = await collectStream(
        adapter.queryStream({
          model: 'openai/gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        })
      )

      assert.deepStrictEqual(deltas, [
        {
          type: 'usage',
          inputTokens: 150,
          outputTokens: 40,
        },
      ])
    })

    test('deepseek serialization replays real reasoning_content without fabricating fallback', async () => {
      const adapter = new OpenAIAdapter()
      mockResponseBody = createMockStream([])

      // 1. With reasoningContent
      await collectStream(
        adapter.queryStream({
          model: 'deepseek/deepseek-v4-pro',
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'thinking', reasoningContent: 'my thinking process' },
          ],
        })
      )
      let body = JSON.parse(lastFetchInit?.body as string)
      assert.strictEqual(body.messages[1].reasoning_content, 'my thinking process')

      // 2. Missing reasoningContent in a tool call must not fabricate a placeholder.
      // DeepSeek rejects mismatched reasoning replay; runtime should preserve real
      // reasoning for live tool loops instead.
      await collectStream(
        adapter.queryStream({
          model: 'deepseek/deepseek-v4-pro',
          messages: [
            { role: 'user', content: 'hello' },
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'call' },
                { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
              ],
            },
          ],
        })
      )
      body = JSON.parse(lastFetchInit?.body as string)
      assert.strictEqual(body.messages[1].reasoning_content, undefined)
    })

    test('rejects orphan tool_result before OpenAI-compatible fetch', async () => {
      const adapter = new OpenAIAdapter()
      await assert.rejects(
        async () => {
          for await (const _chunk of adapter.queryStream({
            model: 'openai/gpt-4o',
            messages: [
              { role: 'user', content: 'continue' },
              {
                role: 'user',
                content: [
                  { type: 'tool_result', toolUseId: 'missing-call', content: 'orphan result' },
                ],
              },
            ],
          })) {}
        },
        /PROVIDER_REPLAY_INVALID_TOOL_SEQUENCE: orphan tool_result missing-call/,
      )
      assert.equal(lastFetchUrl, undefined)
    })
  })
})
