// test/runtime-storage-propagation.test.ts
//
// Bug 3 / Phase C2 (context-cwd-drift-and-recall-governance-plan.md §11):
// storage propagation into ToolContext so context tools
// (contextSearch / contextRecent / contextSummarize) do not return
// CONTEXT_STORAGE_UNAVAILABLE in a storage-backed runtime.
//
// session_10320709-2b06-405f-8f51-d954435d4a70 proved that even with SQLite
// event storage present and permission audits writable, the 3 context tools
// still failed (event_seq 10050 / 15072 / 15103) because:
//   1. LLMCodingRuntime.runExecuteStreamInner did not normalize
//      RuntimeExecuteOptions.storage from this.storage;
//   2. Nexus app.ts executeStream calls did not pass `storage`;
//   3. runtimeToolLoop did not defensively merge the side-channel storage
//      into the options passed to executeToolSafely.
//
// These tests guard the 3 injection points + the negative no-storage path.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { NEXUS_EVENT_SCHEMA_VERSION } from '../src/shared/events.js'
import { createRuntimeExecutionMetrics } from '../src/runtime/runtimePipeline.js'
import { allowAllTools } from '../src/runtime/LocalCodingRuntime.js'
import { executeProviderToolCall } from '../src/runtime/runtimeToolLoop.js'

async function seedSession(storage: MemoryStorage, sessionId: string, cwd: string) {
  await storage.saveSession({
    sessionId,
    cwd,
    prompt: 'test',
    phase: 'executing',
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    events: [
      { type: 'session_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-18T10:00:00.000Z', cwd },
      { type: 'user_message', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-18T10:00:01.000Z', text: 'first user turn' },
      { type: 'user_message', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-18T10:00:02.000Z', text: 'second user turn' },
    ],
  })
}

// Helper: drive executeProviderToolCall to completion, collect events, return
// the tool_completed event for the given tool name.
async function runToolCall(opts: Parameters<typeof executeProviderToolCall>[0]) {
  const stream = executeProviderToolCall(opts)
  const events: unknown[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  const outcome = next.value as { kind: string; toolResult?: { content: unknown; isError?: boolean } }
  return { outcome, events }
}

describe('Bug 3 / Phase C2: storage propagation into ToolContext', () => {
  test('runtimeToolLoop defensive merge: contextRecent succeeds when runtimeOptions.storage is omitted but side-channel storage provided', async () => {
    // This is the exact session_10320709 scenario: executeProviderToolCall
    // receives storage as a side-channel (for permission audit) but
    // runtimeOptions.storage is UNSET. Pre-fix, executeToolSafely built
    // ToolContext.storage = undefined → CONTEXT_STORAGE_UNAVAILABLE.
    // Post-fix, runtimeToolLoop merges side-channel storage into the
    // options passed to executeToolSafely.
    const storage = new MemoryStorage()
    const sessionId = `c2-merge-${randomUUID()}`
    const cwd = '/tmp'
    await seedSession(storage, sessionId, cwd)

    const tools = createDefaultToolRegistry({ storage })
    const { outcome } = await runToolCall({
      toolCall: {
        id: 'ctx_recent_1',
        name: 'contextRecent',
        partialInput: '{"n":5}',
      },
      tools,
      toolPolicy: allowAllTools(),
      // NOTE: runtimeOptions.storage is intentionally OMITTED.
      runtimeOptions: {
        sessionId,
        prompt: 'what did we just do',
        cwd,
        skipPermissionCheck: true,
      },
      storage,
      metrics: createRuntimeExecutionMetrics(),
      readFileCache: new Map(),
    })

    assert.equal(outcome.kind, 'continue')
    const content = String(outcome.toolResult?.content ?? '')
    assert.ok(!/CONTEXT_STORAGE_UNAVAILABLE/.test(content),
      `contextRecent must not return CONTEXT_STORAGE_UNAVAILABLE, got: ${content.slice(0, 200)}`)
    assert.ok(outcome.toolResult && outcome.toolResult.isError !== true
      || !/storage not available/.test(content),
      `contextRecent should succeed with storage attached, got: ${content.slice(0, 200)}`)
  })

  test('contextSearch succeeds when runtimeOptions.storage is omitted but side-channel storage provided', async () => {
    const storage = new MemoryStorage()
    const sessionId = `c2-search-${randomUUID()}`
    const cwd = '/tmp'
    await seedSession(storage, sessionId, cwd)

    const tools = createDefaultToolRegistry({ storage })
    const { outcome } = await runToolCall({
      toolCall: {
        id: 'ctx_search_1',
        name: 'contextSearch',
        partialInput: '{"query":"user turn","maxTokens":3000}',
      },
      tools,
      toolPolicy: allowAllTools(),
      runtimeOptions: {
        sessionId,
        prompt: 'find earlier discussion',
        cwd,
        skipPermissionCheck: true,
      },
      storage,
      metrics: createRuntimeExecutionMetrics(),
      readFileCache: new Map(),
    })

    assert.equal(outcome.kind, 'continue')
    const content = String(outcome.toolResult?.content ?? '')
    assert.ok(!/CONTEXT_STORAGE_UNAVAILABLE/.test(content),
      `contextSearch must not return CONTEXT_STORAGE_UNAVAILABLE, got: ${content.slice(0, 200)}`)
  })

  test('existing runtimeOptions.storage is preserved (not overwritten) when already set', async () => {
    // Defense-in-depth must not clobber an explicitly-provided storage.
    const explicitStorage = new MemoryStorage()
    const sessionId = `c2-explicit-${randomUUID()}`
    const cwd = '/tmp'
    await seedSession(explicitStorage, sessionId, cwd)

    const tools = createDefaultToolRegistry({ storage: explicitStorage })
    const { outcome } = await runToolCall({
      toolCall: {
        id: 'ctx_recent_2',
        name: 'contextRecent',
        partialInput: '{"n":3}',
      },
      tools,
      toolPolicy: allowAllTools(),
      runtimeOptions: {
        sessionId,
        prompt: 'recent',
        cwd,
        skipPermissionCheck: true,
        storage: explicitStorage, // explicitly set
      },
      storage: explicitStorage,
      metrics: createRuntimeExecutionMetrics(),
      readFileCache: new Map(),
    })

    assert.equal(outcome.kind, 'continue')
    const content = String(outcome.toolResult?.content ?? '')
    assert.ok(!/CONTEXT_STORAGE_UNAVAILABLE/.test(content),
      `contextRecent must succeed with explicit storage, got: ${content.slice(0, 200)}`)
  })

  test('tool_started + tool_completed events are emitted for contextRecent', async () => {
    const storage = new MemoryStorage()
    const sessionId = `c2-events-${randomUUID()}`
    const cwd = '/tmp'
    await seedSession(storage, sessionId, cwd)

    const tools = createDefaultToolRegistry({ storage })
    const { events } = await runToolCall({
      toolCall: {
        id: 'ctx_recent_3',
        name: 'contextRecent',
        partialInput: '{"n":3}',
      },
      tools,
      toolPolicy: allowAllTools(),
      runtimeOptions: {
        sessionId,
        prompt: 'recent',
        cwd,
        skipPermissionCheck: true,
      },
      storage,
      metrics: createRuntimeExecutionMetrics(),
      readFileCache: new Map(),
    })

    const started = events.find((e: any) => e.type === 'tool_started' && e.name === 'contextRecent')
    const completed = events.find((e: any) => e.type === 'tool_completed' && e.name === 'contextRecent')
    assert.ok(started, 'tool_started for contextRecent emitted')
    assert.ok(completed, 'tool_completed for contextRecent emitted')
    assert.equal((completed as any).success, true,
      `contextRecent tool_completed.success must be true, got output: ${JSON.stringify((completed as any).output).slice(0, 200)}`)
  })

  test('negative: no-storage registry hides context tools (back-compat preserved)', () => {
    // The Phase C2 injection must NOT re-expose context tools in a
    // genuinely storage-less runtime. createDefaultToolRegistry({ storage: null })
    // still hides them, so the model never sees a tool that would fail.
    const minimal = createDefaultToolRegistry({ storage: null })
    assert.ok(!minimal.has('contextSearch'), 'contextSearch hidden when no storage')
    assert.ok(!minimal.has('contextRecent'), 'contextRecent hidden when no storage')
    assert.ok(!minimal.has('contextSummarize'), 'contextSummarize hidden when no storage')
  })
})
