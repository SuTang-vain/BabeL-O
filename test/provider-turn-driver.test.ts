import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProviderTurnDriver } from '../src/runtime/ProviderTurnDriver.js'
import type {
  ModelAdapter,
  ModelQueryParams,
  StreamDelta,
} from '../src/providers/adapters/ModelAdapter.js'
import type { NexusEvent } from '../src/shared/events.js'

async function collectProviderTurn(driverStream: ReturnType<ProviderTurnDriver['run']>) {
  const events: NexusEvent[] = []
  let next = await driverStream.next()
  while (!next.done) {
    events.push(next.value)
    next = await driverStream.next()
  }
  return { events, turn: next.value }
}

const queryParams: ModelQueryParams = {
  model: 'test/model',
  messages: [{ role: 'user', content: 'hello' }],
}

test('ProviderTurnDriver forwards adapter options and collects provider deltas', async () => {
  const abortController = new AbortController()
  let capturedParams: ModelQueryParams | undefined
  let capturedOptions: Parameters<ModelAdapter['queryStream']>[1] | undefined
  const adapter: ModelAdapter = {
    async *queryStream(params, options): AsyncIterable<StreamDelta> {
      capturedParams = params
      capturedOptions = options
      yield { type: 'thinking', text: 'considering' }
      yield { type: 'text', text: 'hello back' }
      yield { type: 'usage', inputTokens: 11, outputTokens: 3, cacheReadInputTokens: 5 }
      yield { type: 'finish', reason: 'end_turn' }
    },
  }
  const driver = new ProviderTurnDriver()

  const { events, turn } = await collectProviderTurn(driver.run({
    adapter,
    queryParams,
    adapterOptions: {
      signal: abortController.signal,
      apiKey: 'test-key',
      baseUrl: 'https://provider.example',
    },
    sessionId: 'session-provider-driver',
    signal: abortController.signal,
    executionStartMs: 0,
    queryStartMs: 0,
    finalResponseOnlyMode: false,
    suppressToolsForCurrentIntent: false,
    modelVisibleToolCount: 1,
    memoryCapabilityAnswerLeakGuard: false,
  }))

  assert.equal(capturedParams, queryParams)
  assert.equal(capturedOptions?.signal, abortController.signal)
  assert.equal(capturedOptions?.apiKey, 'test-key')
  assert.equal(capturedOptions?.baseUrl, 'https://provider.example')
  assert.deepEqual(events.map(event => event.type), ['thinking_delta', 'assistant_delta', 'usage'])
  assert.equal(turn.assistantText, 'hello back')
  assert.equal(turn.reasoningText, 'considering')
  assert.equal(turn.usage.inputTokens, 11)
  assert.equal(turn.usage.outputTokens, 3)
  assert.equal(turn.usage.cacheReadInputTokens, 5)
})

test('ProviderTurnDriver applies tool-call text leak guard for final-response-only turns', async () => {
  const adapter: ModelAdapter = {
    async *queryStream(): AsyncIterable<StreamDelta> {
      yield { type: 'text', text: '<tool_call><command>rm -rf /tmp/example</command></tool_call>' }
      yield { type: 'finish', reason: 'end_turn' }
    },
  }
  const driver = new ProviderTurnDriver()

  const { events, turn } = await collectProviderTurn(driver.run({
    adapter,
    queryParams,
    sessionId: 'session-provider-driver-leak',
    executionStartMs: 0,
    queryStartMs: 0,
    finalResponseOnlyMode: true,
    suppressToolsForCurrentIntent: false,
    modelVisibleToolCount: 1,
    memoryCapabilityAnswerLeakGuard: false,
  }))

  assert.deepEqual(events.map(event => event.type), [])
  assert.equal(turn.assistantText, '')
  assert.equal(turn.toolCallTextLeakSuppression?.phase, 'final_response_only')
  assert.match(turn.toolCallTextLeakSuppression?.redactedPreview ?? '', /REDACTED/)
})

test('ProviderTurnDriver suppresses full-width (DSML) tool-call text leak', async () => {
  // Phase B (dsml_fullwidth_tool_calls): full-width brackets must not bypass
  // the leak guard when tools are hidden. See runtime-tool-loop-governance-plan.md.
  const adapter: ModelAdapter = {
    async *queryStream(): AsyncIterable<StreamDelta> {
      yield { type: 'text', text: '＜tool_call＞＜command＞rm -rf /tmp/example＜/command＞＜/tool_call＞' }
      yield { type: 'finish', reason: 'end_turn' }
    },
  }
  const driver = new ProviderTurnDriver()

  const { events, turn } = await collectProviderTurn(driver.run({
    adapter,
    queryParams,
    sessionId: 'session-provider-driver-leak-fullwidth',
    executionStartMs: 0,
    queryStartMs: 0,
    finalResponseOnlyMode: true,
    suppressToolsForCurrentIntent: false,
    modelVisibleToolCount: 1,
    memoryCapabilityAnswerLeakGuard: false,
  }))

  assert.deepEqual(events.map(event => event.type), [], 'full-width tool-call text must not leak as events')
  assert.equal(turn.assistantText, '', 'full-width tool-call text must be suppressed from assistant text')
  assert.equal(turn.toolCallTextLeakSuppression?.phase, 'final_response_only')
  assert.match(turn.toolCallTextLeakSuppression?.redactedPreview ?? '', /REDACTED/, 'full-width command body must be redacted')
})
