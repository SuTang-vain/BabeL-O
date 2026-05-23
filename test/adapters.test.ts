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

  beforeEach(() => {
    originalFetch = globalThis.fetch
    lastFetchUrl = undefined
    lastFetchInit = undefined
    mockResponseBody = null
    mockResponseOk = true
    mockResponseStatus = 200

    globalThis.fetch = async (url, init) => {
      lastFetchUrl = typeof url === 'string' ? url : (url as Request).url
      lastFetchInit = init
      return {
        ok: mockResponseOk,
        status: mockResponseStatus,
        text: async () => 'Error message',
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

    test('throws ProviderError on non-200 response', async () => {
      const adapter = new OpenAIAdapter()
      mockResponseOk = false
      mockResponseStatus = 401

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
  })
})
