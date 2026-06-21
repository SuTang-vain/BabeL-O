import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emitMemoryRetrieval, type EmitMemoryRetrievalInput } from '../src/runtime/emitMemoryRetrieval.js'
import { type MemoryProvider, type MemoryProviderDiagnostics } from '../src/runtime/memoryProvider.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import type { NexusEvent } from '../src/shared/events.js'

const SESSION = 'test-emit-memory-retrieval-session'

function makeFullDiagnostics(): MemoryProviderDiagnostics {
  return {
    provider: 'everos',
    enabled: true,
    hitCount: 5,
    injectedChars: 1024,
    budgetChars: 4096,
    maxHitChars: 512,
    truncated: false,
    scope: 'project',
    namespaceId: 'ns-1',
    namespaceSource: 'workspace',
    isolationKey: 'projectId',
    autoSearch: {
      triggered: true,
      reason: 'explicit_memory_cue',
      cue: 'long-term preference',
    },
    searchLatencyMs: 42,
  }
}

const dummyProvider: MemoryProvider = { name: 'everos', retrieve: async () => ({ content: '', diagnostics: makeFullDiagnostics() }) }

function makeInput(overrides: Partial<EmitMemoryRetrievalInput> = {}): EmitMemoryRetrievalInput {
  return {
    sessionId: SESSION,
    cwd: '/tmp/workspace',
    prompt: 'tell me about the project',
    diagnostics: makeFullDiagnostics(),
    ...overrides,
  }
}

test('emitMemoryRetrieval is a no-op when memoryProvider is undefined', async () => {
  const storage = new MemoryStorage()
  await emitMemoryRetrieval(undefined, storage, makeInput())
  // No session saved => storage should have no events.
  const result = await storage.listEvents(SESSION)
  assert.equal(result.events.length, 0, 'no memory_retrieval event must be appended when memoryProvider is undefined')
})

test('emitMemoryRetrieval appends a fully populated memory_retrieval event', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession({
    sessionId: SESSION,
    cwd: '/tmp/workspace',
    prompt: 'test prompt',
    phase: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  })
  await emitMemoryRetrieval(dummyProvider, storage, makeInput())
  const result = await storage.listEvents(SESSION)
  assert.equal(result.events.length, 1, 'exactly one memory_retrieval event must be appended')
  const ev = result.events[0]
  assert.equal(ev.type, 'memory_retrieval')
  const m = ev as Extract<NexusEvent, { type: 'memory_retrieval' }>
  assert.equal(m.provider, 'everos')
  assert.equal(m.enabled, true)
  assert.equal(m.hitCount, 5)
  assert.equal(m.injectedChars, 1024)
  assert.equal(m.budgetChars, 4096)
  assert.equal(m.maxHitChars, 512)
  assert.equal(m.truncated, false)
  assert.equal(m.namespaceId, 'ns-1')
  assert.equal(m.namespaceSource, 'workspace')
  assert.equal(m.isolationKey, 'projectId')
  assert.equal(m.autoSearchTriggered, true)
  assert.equal(m.autoSearchReason, 'explicit_memory_cue')
  assert.equal(m.autoSearchCue, 'long-term preference')
  assert.equal(m.searchLatencyMs, 42)
  assert.equal(m.prompt, 'tell me about the project')
  assert.equal(m.cwd, '/tmp/workspace')
})

test('emitMemoryRetrieval omits optional fields when diagnostics has no namespace metadata', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession({
    sessionId: SESSION,
    cwd: '/tmp/workspace',
    prompt: 'p',
    phase: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  })
  const diag: MemoryProviderDiagnostics = {
    provider: 'no-op',
    enabled: false,
    hitCount: 0,
    injectedChars: 0,
    budgetChars: 4096,
    maxHitChars: 512,
    truncated: false,
    scope: 'user',
    // no namespaceId / namespaceSource / isolationKey / autoSearch / searchLatencyMs
  }
  await emitMemoryRetrieval(dummyProvider, storage, makeInput({ diagnostics: diag }))
  const result = await storage.listEvents(SESSION)
  assert.equal(result.events.length, 1)
  const m = result.events[0] as Extract<NexusEvent, { type: 'memory_retrieval' }>
  assert.equal(m.scope, 'user')
  assert.equal(m.provider, 'no-op')
  assert.equal(m.enabled, false)
  // conditional spreads must NOT inject undefined values
  assert.equal((m as Record<string, unknown>).namespaceId, undefined)
  assert.equal((m as Record<string, unknown>).namespaceSource, undefined)
  assert.equal((m as Record<string, unknown>).isolationKey, undefined)
  assert.equal(m.autoSearchTriggered, false, 'autoSearchTriggered must default to false when no autoSearch block')
  assert.equal(m.autoSearchReason, 'no_memory_cue', 'autoSearchReason must default to no_memory_cue when no autoSearch block')
  assert.equal((m as Record<string, unknown>).autoSearchCue, undefined)
  assert.equal((m as Record<string, unknown>).searchLatencyMs, undefined)
  assert.equal((m as Record<string, unknown>).error, undefined)
})

test('emitMemoryRetrieval preserves error and searchLatencyMs when diagnostics has them', async () => {
  const storage = new MemoryStorage()
  await storage.saveSession({
    sessionId: SESSION,
    cwd: '/tmp/workspace',
    prompt: 'p',
    phase: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  })
  const diag: MemoryProviderDiagnostics = {
    provider: 'everos',
    enabled: true,
    hitCount: 0,
    injectedChars: 0,
    budgetChars: 4096,
    maxHitChars: 512,
    truncated: false,
    scope: 'project',
    searchLatencyMs: 7,
    error: 'everos timeout',
  }
  await emitMemoryRetrieval(dummyProvider, storage, makeInput({ diagnostics: diag }))
  const result = await storage.listEvents(SESSION)
  assert.equal(result.events.length, 1)
  const m = result.events[0] as Extract<NexusEvent, { type: 'memory_retrieval' }>
  assert.equal(m.searchLatencyMs, 7)
  assert.equal(m.error, 'everos timeout')
})

test('emitMemoryRetrieval swallows storage.appendEvent failure and does not throw', async () => {
  // Build a stub storage that throws on appendEvent.
  // We never let a real MemoryStorage fail here because
  // appendEvent silently skips when the session is missing —
  // the throw path is the real failure mode the function
  // is contracted to absorb.
  const appendEventCalls: NexusEvent[] = []
  const throwingStorage = {
    appendEvent: async (_sessionId: string, event: NexusEvent) => {
      appendEventCalls.push(event)
      throw new Error('disk full')
    },
    listEvents: async () => [],
  } as unknown as Parameters<typeof emitMemoryRetrieval>[1]

  // Capture stderr to keep the test output clean.
  const originalWrite = process.stderr.write.bind(process.stderr)
  const captured: string[] = []
  process.stderr.write = ((chunk: unknown) => {
    captured.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as typeof process.stderr.write

  try {
    await assert.doesNotReject(async () => {
      await emitMemoryRetrieval(dummyProvider, throwingStorage, makeInput())
    }, 'emitMemoryRetrieval must absorb storage failures')
    assert.equal(appendEventCalls.length, 1, 'storage.appendEvent must be called exactly once')
    assert.ok(
      captured.some((line) => line.includes('memory_retrieval event append failed: disk full')),
      'failure must be reported on stderr so the operator can grep it; captured: ' + captured.join('\\n'),
    )
  } finally {
    process.stderr.write = originalWrite
  }
})
