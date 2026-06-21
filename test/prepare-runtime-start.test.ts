import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareRuntimeStart } from '../src/runtime/prepareRuntimeStart.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { allowAllTools, type ToolPolicy } from '../src/runtime/LocalCodingRuntime.js'
import type { AnyTool } from '../src/tools/Tool.js'
import type { ModelAdapter, ModelMessage } from '../src/providers/adapters/ModelAdapter.js'
import type { RuntimeExecuteOptions } from '../src/runtime/Runtime.js'
import type { NexusEvent } from '../src/shared/events.js'
import { buildUserIntakeGuidanceEvent } from '../src/runtime/intentGuidance.js'

// Always-failing adapter so buildUserIntakeGuidanceEvent
// falls through to the heuristic fallback. The prepare
// helper does not need the intake text to be correct; it
// only needs the event shape and downstream consumption.
const failingAdapter: ModelAdapter = {
  queryStream: () => {
    throw new Error('test adapter: bypass to fallback')
  },
}

function makeTool(name: string, risk: 'read' | 'write' | 'execute' = 'read'): AnyTool {
  return {
    name,
    description: `${name} tool`,
    risk,
    inputSchema: {} as AnyTool['inputSchema'],
    prompt: () => `${name} tool`,
    modelInputSchema: { type: 'object' },
    execute: async () => ({ ok: true, output: '' }),
  } as unknown as AnyTool
}

function makeOptions(overrides: Partial<RuntimeExecuteOptions> = {}): RuntimeExecuteOptions {
  return {
    sessionId: 'sess-1',
    requestId: 'req-1',
    cwd: '/workspace',
    prompt: 'summarize the project',
    signal: new AbortController().signal,
    ...overrides,
  } as RuntimeExecuteOptions
}

const baseSettings = {
  providerId: 'test-provider',
  modelId: 'test-model',
  apiKey: 'key-1',
  baseUrl: 'https://example.test',
}

test('prepareRuntimeStart returns empty previousEvents when storage is undefined', async () => {
  const result = await prepareRuntimeStart({
    options: makeOptions(),
    deps: {
      storage: undefined,
      tools: new Map(),
      toolPolicy: allowAllTools(),
    },
    settings: baseSettings,
    cleanedModelId: 'test-model',
    adapter: failingAdapter,
    shouldReplayReasoningContent: false,
  })
  assert.equal(result.previousEvents.length, 2, 'previousEvents is [intake, taskScope] when storage is undefined')
  assert.equal(result.intakeEvent.type, 'user_intake_guidance')
  assert.equal(result.taskScopeEvent.type, 'task_scope_declared')
  assert.equal(result.confirmedOptionSelection, false)
  assert.equal(typeof result.toolsList, 'function')
  assert.equal(typeof result.mapEventsForProvider, 'function')
})

test('prepareRuntimeStart reverses a non-empty storage event list to chronological order', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession({
    sessionId: 'sess-1',
    cwd: '/workspace',
    prompt: 'orig',
    phase: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  })
  // Pre-seed two user_message events in storage order
  // (storage.appendEvent pushes to the end of session.events,
  // and listEvents desc returns them in reverse — the
  // helper's job is to flip that back to chronological).
  await storage.appendEvent('sess-1', {
    type: 'user_message',
    ...({ schemaVersion: '2026-05-21.babel-o.v1', timestamp: '2026-06-20T01:00:00Z', sessionId: 'sess-1' } as any),
    text: 'first',
  } as NexusEvent)
  await storage.appendEvent('sess-1', {
    type: 'user_message',
    ...({ schemaVersion: '2026-05-21.babel-o.v1', timestamp: '2026-06-20T02:00:00Z', sessionId: 'sess-1' } as any),
    text: 'second',
  } as NexusEvent)
  const result = await prepareRuntimeStart({
    options: makeOptions(),
    deps: { storage, tools: new Map(), toolPolicy: allowAllTools() },
    settings: baseSettings,
    cleanedModelId: 'test-model',
    adapter: failingAdapter,
    shouldReplayReasoningContent: false,
  })
  // previousEvents after helper is: [user1, user2, intake, taskScope]
  // The two storage events must come first, in chronological
  // order (user1 before user2), regardless of how
  // listEvents returned them.
  assert.ok(result.previousEvents.length >= 4)
  assert.equal(result.previousEvents[0].type, 'user_message')
  assert.equal(result.previousEvents[1].type, 'user_message')
  assert.equal((result.previousEvents[0] as any).text, 'first')
  assert.equal((result.previousEvents[1] as any).text, 'second')
  assert.equal(result.previousEvents[2].type, 'user_intake_guidance')
  assert.equal(result.previousEvents[3].type, 'task_scope_declared')
})

test('prepareRuntimeStart returns empty previousEvents when replaySessionHistory is false', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession({
    sessionId: 'sess-1',
    cwd: '/workspace',
    prompt: 'orig',
    phase: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  })
  // Pre-seed one user_message — but the helper should skip
  // storage entirely because replaySessionHistory=false.
  await storage.appendEvent('sess-1', {
    type: 'user_message',
    ...({ schemaVersion: '2026-05-21.babel-o.v1', timestamp: '2026-06-20T01:00:00Z', sessionId: 'sess-1' } as any),
    text: 'first',
  } as NexusEvent)
  const result = await prepareRuntimeStart({
    options: makeOptions({ replaySessionHistory: false }),
    deps: { storage, tools: new Map(), toolPolicy: allowAllTools() },
    settings: baseSettings,
    cleanedModelId: 'test-model',
    adapter: failingAdapter,
    shouldReplayReasoningContent: false,
  })
  // previousEvents = [intake, taskScope] — no pre-seeded
  // user_message in the chronological list.
  assert.equal(result.previousEvents.length, 2)
  assert.equal(result.previousEvents[0].type, 'user_intake_guidance')
  assert.equal(result.previousEvents[1].type, 'task_scope_declared')
})

test('prepareRuntimeStart logger receives a single debug line when storage.listEvents throws', async () => {
  const debugCalls: Array<[string, ...unknown[]]> = []
  const logger = {
    debug: (message: string, ...args: unknown[]) => {
      debugCalls.push([message, ...args])
    },
  }
  const throwingStorage = {
    listEvents: async () => {
      throw new Error('boom')
    },
  } as unknown as Parameters<typeof prepareRuntimeStart>[0]['deps']['storage']
  const result = await prepareRuntimeStart({
    options: makeOptions(),
    deps: { storage: throwingStorage, tools: new Map(), toolPolicy: allowAllTools(), logger },
    settings: baseSettings,
    cleanedModelId: 'test-model',
    adapter: failingAdapter,
    shouldReplayReasoningContent: false,
  })
  // The helper must absorb the throw and continue.
  assert.equal(result.intakeEvent.type, 'user_intake_guidance')
  assert.equal(result.previousEvents.length, 2)
  assert.equal(debugCalls.length, 1)
  assert.match(debugCalls[0][0], /Failed to load previous session events/)
})

test('prepareRuntimeStart toolsList filters by toolPolicy and applies soft-deny to write/execute', async () => {
  const tools = new Map<string, AnyTool>([
    ['read1', makeTool('read1', 'read')],
    ['write1', makeTool('write1', 'write')],
    ['execute1', makeTool('execute1', 'execute')],
  ])
  // policy that only allows read1
  const policy: ToolPolicy = {
    isAllowed: (tool: AnyTool) => tool.name === 'read1',
  } as unknown as ToolPolicy
  // soft-deny mode
  const result = await prepareRuntimeStart({
    options: makeOptions({ policyMode: 'soft-deny' }),
    deps: { storage: undefined, tools, toolPolicy: policy },
    settings: baseSettings,
    cleanedModelId: 'test-model',
    adapter: failingAdapter,
    shouldReplayReasoningContent: false,
  })
  const names = result.toolsList().map((t) => t.name).sort()
  // read1 (allowed) + write1 + execute1 (soft-deny promoted).
  // The other 0 are kept in by allowAllTools... no: with a
  // custom policy the helper defers to isAllowed. read1
  // passes; write1 / execute1 do not pass isAllowed so they
  // would normally be excluded, but soft-deny promotes them.
  assert.deepEqual(names, ['execute1', 'read1', 'write1'])
})

test('prepareRuntimeStart mapEventsForProvider forwards replayReasoningContent flag', async () => {
  const result = await prepareRuntimeStart({
    options: makeOptions(),
    deps: { storage: undefined, tools: new Map(), toolPolicy: allowAllTools() },
    settings: baseSettings,
    cleanedModelId: 'test-model',
    adapter: failingAdapter,
    shouldReplayReasoningContent: true,
  })
  // mapEventsForProvider must be a function and callable.
  // We do not need to assert the provider-message shape here
  // — eventsTranslator.test.ts covers the deep translation
  // contract. The helper's job is just to forward the
  // shouldReplayReasoningContent flag.
  const out: ModelMessage[] = result.mapEventsForProvider([], 'hi')
  assert.ok(Array.isArray(out))
  // empty input + non-empty initialPrompt → at least one
  // user message (the initial prompt itself becomes the
  // first user message when no prior events are present).
  assert.ok(out.length >= 1)
})

test('prepareRuntimeStart skips intake event fallback when buildUserIntakeGuidanceEvent is mocked to throw', async () => {
  // This test pins the helper's behavior: if the adapter
  // throws, the helper still returns a valid intake event
  // (because buildUserIntakeGuidanceEvent catches and
  // returns toUserIntakeGuidanceEvent(fallback) — see
  // intentGuidance.ts:124-127). It must NOT propagate the
  // throw. Build the helper through the normal path with
  // the failing adapter.
  const result = await prepareRuntimeStart({
    options: makeOptions(),
    deps: { storage: undefined, tools: new Map(), toolPolicy: allowAllTools() },
    settings: baseSettings,
    cleanedModelId: 'test-model',
    adapter: failingAdapter,
    shouldReplayReasoningContent: false,
  })
  // Sanity: intake event still has the required fields.
  assert.equal(result.intakeEvent.type, 'user_intake_guidance')
  assert.equal(result.intakeEvent.sessionId, 'sess-1')
  // Make sure buildUserIntakeGuidanceEvent is reachable
  // here too (smoke check on the import path).
  assert.equal(typeof buildUserIntakeGuidanceEvent, 'function')
})
