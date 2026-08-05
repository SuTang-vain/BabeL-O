/**
 * LLM gateway (`POST /v1/chat/completions`) deterministic tests.
 *
 * Uses the `local` provider (no real API keys) for full determinism:
 * - non-stream requests exercise the queryNonStream fast path
 * - stream requests exercise the queryStream path
 * Plus error-path matrix and a concurrency check.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import http from 'node:http'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'

const originalConfigFile = process.env.BABEL_O_CONFIG_FILE
const testConfigDir = path.join(os.tmpdir(), `babel-o-gateway-${process.pid}`)
const testConfigFile = path.join(testConfigDir, 'config.json')
process.env.BABEL_O_CONFIG_FILE = testConfigFile

let app: Awaited<ReturnType<typeof createNexusApp>>
let failUpstream: http.Server
let failUpstreamPort = 0

const CHAT_URL = '/v1/chat/completions'

function openAiBody(overrides: Record<string, unknown> = {}) {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 20,
    ...overrides,
  }
}

before(async () => {
  // 上游 503 mock（用于错误路径测试）
  failUpstream = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'upstream down' } }))
  })
  await new Promise<void>((resolve) => failUpstream.listen(0, resolve))
  const address = failUpstream.address()
  assert(address && typeof address === 'object')
  failUpstreamPort = address.port

  await fs.mkdir(testConfigDir, { recursive: true })
  await fs.writeFile(
    testConfigFile,
    JSON.stringify({
      defaultModel: 'local/coding-runtime',
      providers: {
        mockfail: {
          apiKey: 'x',
          baseUrl: `http://127.0.0.1:${failUpstreamPort}/v1`,
          adapter: 'openai-compatible',
        },
      },
    }),
  )

  const { runtime, storage } = await createDefaultNexusRuntime()
  app = await createNexusApp({ runtime, storage, defaultCwd: os.tmpdir() })
  await app.ready()
})

after(async () => {
  await app.close()
  await new Promise<void>((resolve) => failUpstream.close(() => resolve()))
  if (originalConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
  else process.env.BABEL_O_CONFIG_FILE = originalConfigFile
  await fs.rm(testConfigDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

test('non-stream completion uses the deterministic fast path', async () => {
  const res = await app.inject({
    method: 'POST',
    url: CHAT_URL,
    payload: openAiBody({ model: 'local/coding-runtime' }),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.object, 'chat.completion')
  assert.equal(body.choices[0].message.content, 'Local mock response for: hi')
  assert.equal(body.choices[0].finish_reason, 'stop')
  assert.deepEqual(body.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
})

test('absent model falls back to defaultModel (local/coding-runtime)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: CHAT_URL,
    payload: openAiBody(),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.model, 'local/coding-runtime')
  assert.equal(body.choices[0].message.content, 'Local mock response for: hi')
})

test('empty model string is treated as absent', async () => {
  const res = await app.inject({
    method: 'POST',
    url: CHAT_URL,
    payload: openAiBody({ model: '' }),
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().model, 'local/coding-runtime')
})

test('stream request returns OpenAI SSE framing with [DONE]', async () => {
  const res = await app.inject({
    method: 'POST',
    url: CHAT_URL,
    payload: openAiBody({ model: 'local/coding-runtime', stream: true }),
  })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'] || '', /text\/event-stream/)
  const raw = res.body
  assert.match(raw, /data: \{/)
  assert.match(raw, /"delta":\{"content":"Local mock response for: hi"\}/)
  assert.match(raw, /"finish_reason":"stop"/)
  assert.match(raw, /data: \[DONE\]/)
})

test('response_format passthrough is accepted (local adapter ignores it)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: CHAT_URL,
    payload: openAiBody({
      model: 'local/coding-runtime',
      response_format: { type: 'json_object' },
    }),
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().choices[0].message.content, 'Local mock response for: hi')
})

test('unknown model -> 400 MODEL_NOT_FOUND', async () => {
  const res = await app.inject({
    method: 'POST',
    url: CHAT_URL,
    payload: openAiBody({ model: 'no/such-model' }),
  })
  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.error.code, 'MODEL_NOT_FOUND')
  assert.match(body.error.message, /no\/such-model/)
})

test('invalid body -> 400 invalid_request_error', async () => {
  const res = await app.inject({
    method: 'POST',
    url: CHAT_URL,
    payload: { messages: 'not-an-array' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error.type, 'invalid_request_error')
})

test('upstream 503 surfaces as gateway 503 with error envelope', async () => {
  const res = await app.inject({
    method: 'POST',
    url: CHAT_URL,
    payload: openAiBody({ model: 'mockfail/any-model' }),
  })
  assert.equal(res.statusCode, 503)
  const body = res.json()
  assert.equal(body.error.type, 'provider_error')
  assert.equal(body.error.code, 'PROVIDER_ERROR')
})

test('20 concurrent non-stream requests all succeed', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      app.inject({
        method: 'POST',
        url: CHAT_URL,
        payload: openAiBody({ model: 'local/coding-runtime' }),
      }),
    ),
  )
  assert.equal(results.every((r) => r.statusCode === 200), true)
  assert.equal(results[0].json().choices[0].message.content, 'Local mock response for: hi')
})
