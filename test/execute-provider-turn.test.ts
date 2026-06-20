import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeProviderTurn } from '../src/runtime/executeProviderTurn.js'
import { ProviderTurnDriver } from '../src/runtime/ProviderTurnDriver.js'
import type { NexusEvent } from '../src/shared/events.js'

// ─── fixtures ──────────────────────────────────────────────

function makeStubDriver(events: NexusEvent[], finalValue: any): ProviderTurnDriver {
  return {
    run: async function* () {
      for (const e of events) yield e
      return finalValue
    },
  } as unknown as ProviderTurnDriver
}

const stubInput = {
  adapter: {} as any,
  queryParams: {} as any,
  adapterOptions: {} as any,
  sessionId: 'sess-1',
  signal: new AbortController().signal,
  executionStartMs: 0,
  queryStartMs: 0,
  finalResponseOnlyMode: false,
  suppressToolsForCurrentIntent: false,
  modelVisibleToolCount: 0,
  memoryCapabilityAnswerLeakGuard: undefined as any,
} as any

// ─── tests ──────────────────────────────────────────────────

test('executeProviderTurn returns empty events array and the final value when the driver yields nothing', async () => {
  const driver = makeStubDriver([], { kind: 'continue', toolCalls: [] })
  const result = await executeProviderTurn(driver, stubInput)
  assert.equal(result.events.length, 0)
  assert.equal(result.providerTurn.kind, 'continue')
})

test('executeProviderTurn returns all events in order', async () => {
  const events: NexusEvent[] = [
    { type: 'thinking_delta', ...({} as any), text: 'hmm' } as unknown as NexusEvent,
    { type: 'tool_use_start', ...({} as any), id: 't1' } as unknown as NexusEvent,
    { type: 'tool_use_end', ...({} as any), id: 't1' } as unknown as NexusEvent,
    { type: 'finish', ...({} as any), reason: 'end_turn' } as unknown as NexusEvent,
  ]
  const driver = makeStubDriver(events, { kind: 'terminal', toolCalls: [] })
  const result = await executeProviderTurn(driver, stubInput)
  assert.equal(result.events.length, 4)
  assert.deepEqual(
    result.events.map((e) => e.type),
    ['thinking_delta', 'tool_use_start', 'tool_use_end', 'finish'],
  )
  assert.equal(result.providerTurn.kind, 'terminal')
})

test('executeProviderTurn returns events from a multi-event provider stream', async () => {
  // Simulate a typical provider turn: a few thinking
  // deltas, a tool call, and a finish.
  const events: NexusEvent[] = Array.from({ length: 10 }, (_, i) =>
    ({ type: 'thinking_delta', text: `t${i}` } as unknown as NexusEvent),
  )
  const driver = makeStubDriver(events, { kind: 'continue', toolCalls: [] })
  const result = await executeProviderTurn(driver, stubInput)
  assert.equal(result.events.length, 10)
  assert.equal(result.providerTurn.kind, 'continue')
})

test('executeProviderTurn propagates errors from the driver', async () => {
  const errorDriver: ProviderTurnDriver = {
    run: () => {
      throw new Error('provider failure')
    },
  } as unknown as ProviderTurnDriver
  await assert.rejects(
    () => executeProviderTurn(errorDriver, stubInput),
    /provider failure/,
  )
})

test('executeProviderTurn returns no events when the driver returns a terminal value with no yields', async () => {
  const driver = makeStubDriver([], { kind: 'terminal', result: 'final' })
  const result = await executeProviderTurn(driver, stubInput)
  assert.equal(result.events.length, 0)
  assert.equal(result.providerTurn.kind, 'terminal')
  assert.equal((result.providerTurn as any).result, 'final')
})

test('executeProviderTurn does not modify the input bundle', async () => {
  const inputCopy = { ...stubInput }
  const driver = makeStubDriver([], { kind: 'continue', toolCalls: [] })
  await executeProviderTurn(driver, stubInput)
  // The input bundle's identity / fields are not
  // mutated by the helper — it only passes the bundle
  // through to the driver.
  assert.equal(stubInput.sessionId, inputCopy.sessionId)
  assert.equal(stubInput.queryStartMs, inputCopy.queryStartMs)
})
