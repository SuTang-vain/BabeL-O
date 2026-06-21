// test/runtime-context-tools-registry-gate.test.ts
//
// Phase A Follow-up (2026-06-18) integration: storage-aware gate in
// createDefaultToolRegistry. When the registry is built with
// `storage: null` (e.g. Go TUI local mode / Explore agent with no
// storage), the 4 context* tools MUST NOT be registered — otherwise the
// model prompt advertises tools that always return
// CONTEXT_STORAGE_UNAVAILABLE, wasting turns and corrupting session
// recall (session_cf361f04 event_seq=16671).
//
// When storage IS provided (default Nexus path), the 4 tools ARE
// registered, and `contextSearch` should function normally.
//
// 2026-06-20: extended to 4 tools (added contextSessions for Bug 1.1
// cross-session metadata search).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { NEXUS_EVENT_SCHEMA_VERSION } from '../src/shared/events.js'
import { randomUUID } from 'node:crypto'

describe('createDefaultToolRegistry storage gate', () => {
  test('default (no opts) keeps all 4 context tools for back-compat', () => {
    const reg = createDefaultToolRegistry()
    assert.ok(reg.has('contextSearch'), 'contextSearch registered by default')
    assert.ok(reg.has('contextSummarize'), 'contextSummarize registered by default')
    assert.ok(reg.has('contextRecent'), 'contextRecent registered by default')
    assert.ok(reg.has('contextSessions'), 'contextSessions registered by default')
  })

  test('storage: null hides all 4 context tools', () => {
    const reg = createDefaultToolRegistry({ storage: null })
    assert.ok(!reg.has('contextSearch'), 'contextSearch hidden when no storage')
    assert.ok(!reg.has('contextSummarize'), 'contextSummarize hidden when no storage')
    assert.ok(!reg.has('contextRecent'), 'contextRecent hidden when no storage')
    assert.ok(!reg.has('contextSessions'), 'contextSessions hidden when no storage')
    // Non-context tools still present
    assert.ok(reg.has('Read'), 'Read still present')
    assert.ok(reg.has('Bash'), 'Bash still present')
    assert.ok(reg.has('Write'), 'Write still present')
  })

  test('storage: <MemoryStorage instance> registers context tools and they execute', async () => {
    const storage = new MemoryStorage()
    const sessionId = `reg-gate-${randomUUID()}`
    await storage.saveSession({
      sessionId,
      cwd: '/tmp',
      prompt: 'test',
      phase: 'executing',
      createdAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:00.000Z',
      events: [
        { type: 'session_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-18T10:00:00.000Z', cwd: '/tmp' },
        { type: 'user_message', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-18T10:00:01.000Z', text: 'first' },
        { type: 'user_message', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-18T10:00:02.000Z', text: 'second' },
      ],
    })

    const reg = createDefaultToolRegistry({ storage })
    const tool = reg.get('contextRecent')!
    assert.ok(tool, 'contextRecent registered when storage is provided')

    const result = await tool.execute({ n: 5 }, {
      cwd: '/tmp', sessionId,
      maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000, storage,
    })
    assert.equal(result.success, true, 'contextRecent execute succeeds with storage')
  })

  test('no-storage registry has fewer tools than full registry', () => {
    const full = createDefaultToolRegistry({ storage: new MemoryStorage() })
    const minimal = createDefaultToolRegistry({ storage: null })
    assert.ok(
      minimal.size < full.size,
      `minimal=${minimal.size} should be < full=${full.size}`,
    )
    assert.equal(full.size - minimal.size, 4, 'exactly 4 tools (context*) hidden')
  })
})
