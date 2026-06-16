// test/working-set-tracker.test.ts
//
// PR-4a unit tests: minimal in-memory WorkingSetTracker.
// Covers get/update/rebuild/reset/has + deriveEntriesFromEvents.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  WorkingSetTracker,
  deriveEntriesFromEvents,
  type WorkingSetEntry,
} from '../src/nexus/workingSetTracker.js'
import { assembleContext } from '../src/runtime/contextAssembler.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'

function newSessionId(): string {
  return `wst-${randomUUID()}`
}

function mkEntry(key: string, value: string, confidence = 0.9): WorkingSetEntry {
  return { key, value, updatedAt: new Date().toISOString(), confidence }
}

describe('PR-4a WorkingSetTracker (in-memory)', () => {
  test('get() returns null for unknown session', () => {
    const t = new WorkingSetTracker()
    assert.equal(t.get('unknown'), null)
    assert.equal(t.has('unknown'), false)
    assert.equal(t.size(), 0)
  })

  test('update() creates a new working set when none exists', () => {
    const t = new WorkingSetTracker()
    const sessionId = newSessionId()
    const ws = t.update(sessionId, {
      workspaceId: '/tmp/proj',
      entries: [mkEntry('task', 'investigate bug')],
    })
    assert.equal(ws.sessionId, sessionId)
    assert.equal(ws.workspaceId, '/tmp/proj')
    assert.equal(ws.version, 1)
    assert.equal(ws.entries.length, 1)
    assert.equal(ws.entries[0]!.key, 'task')
    assert.equal(t.has(sessionId), true)
    assert.equal(t.size(), 1)
  })

  test('update() bumps version on subsequent updates', () => {
    const t = new WorkingSetTracker()
    const sessionId = newSessionId()
    const a = t.update(sessionId, { entries: [mkEntry('a', 'A')] })
    const b = t.update(sessionId, { entries: [mkEntry('b', 'B')] })
    const c = t.update(sessionId, { entries: [mkEntry('c', 'C')] })
    assert.equal(a.version, 1)
    assert.equal(b.version, 2)
    assert.equal(c.version, 3)
    assert.equal(c.entries.length, 1, 'replace, not merge')
    assert.equal(c.entries[0]!.key, 'c')
  })

  test('rebuild() replaces wholesale', () => {
    const t = new WorkingSetTracker()
    const sessionId = newSessionId()
    t.update(sessionId, { entries: [mkEntry('a', 'A')] })
    const rebuilt = t.rebuild(sessionId, '/tmp/proj2', [
      mkEntry('x', 'X'),
      mkEntry('y', 'Y'),
      mkEntry('z', 'Z'),
    ])
    assert.equal(rebuilt.workspaceId, '/tmp/proj2')
    assert.equal(rebuilt.entries.length, 3)
    assert.equal(rebuilt.version, 2)
  })

  test('reset() removes a session', () => {
    const t = new WorkingSetTracker()
    const sessionId = newSessionId()
    t.update(sessionId, { entries: [mkEntry('a', 'A')] })
    assert.equal(t.has(sessionId), true)
    t.reset(sessionId)
    assert.equal(t.has(sessionId), false)
    assert.equal(t.get(sessionId), null)
  })

  test('clampEntries: confidence 0..1, value ≤ 200 chars', () => {
    const t = new WorkingSetTracker()
    const sessionId = newSessionId()
    const longValue = 'x'.repeat(500)
    const ws = t.update(sessionId, {
      entries: [
        { key: 'a', value: longValue, updatedAt: '2026-06-16T00:00:00.000Z', confidence: 1.5 },
        { key: 'b', value: 'short', updatedAt: '2026-06-16T00:00:00.000Z', confidence: -0.5 },
      ],
    })
    assert.equal(ws.entries[0]!.value.length, 200, 'value clamped to 200 chars')
    assert.equal(ws.entries[0]!.confidence, 1, 'confidence clamped to 1')
    assert.equal(ws.entries[1]!.confidence, 0, 'confidence clamped to 0')
  })

  test('deriveEntriesFromEvents: only paths under cwd, latest first, dedup', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wst-derive-'))
    try {
      const events: NexusEvent[] = [
        { type: 'session_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId: 's', timestamp: '2026-06-16T00:00:00.000Z', cwd },
        { type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId: 's', timestamp: '2026-06-16T00:00:01.000Z', toolUseId: 'tu_1', name: 'Read', input: { path: join(cwd, 'a.ts') } },
        { type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId: 's', timestamp: '2026-06-16T00:00:02.000Z', toolUseId: 'tu_2', name: 'Read', input: { path: join(cwd, 'b.ts') } },
        // duplicate of a.ts
        { type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId: 's', timestamp: '2026-06-16T00:00:03.000Z', toolUseId: 'tu_3', name: 'Read', input: { path: join(cwd, 'a.ts') } },
        // outside cwd
        { type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId: 's', timestamp: '2026-06-16T00:00:04.000Z', toolUseId: 'tu_4', name: 'Read', input: { path: '/etc/passwd' } },
        // non-string path
        { type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId: 's', timestamp: '2026-06-16T00:00:05.000Z', toolUseId: 'tu_5', name: 'Read', input: { path: 42 } },
      ]
      const entries = deriveEntriesFromEvents(events, cwd)
      const values = entries.map(e => e.value)
      assert.equal(entries.length, 2, 'deduped + filtered')
      assert.ok(values.includes(join(cwd, 'a.ts')))
      assert.ok(values.includes(join(cwd, 'b.ts')))
      assert.ok(!values.includes('/etc/passwd'), 'outside cwd excluded')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('PR-4a assembleContext workingSetOverride', () => {
  test('when workingSetOverride is provided, that string is used verbatim', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wst-ac-override-'))
    try {
      const events: NexusEvent[] = [
        { type: 'session_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId: 's', timestamp: '2026-06-16T00:00:00.000Z', cwd },
      ]
      const override = '## Working Set (PERSISTED)\n- task: investigate\n- scope: /tmp/proj'
      const result = await assembleContext({
        runtimeOptions: { sessionId: 's', prompt: 'go', cwd },
        events,
        modelId: 'test-model',
        buildSystemPrompt: () => 'system',
        mapEventsToMessages: () => [],
        workingSetOverride: override,
      })
      // The override should appear in the assembled system prompt
      assert.ok(result.systemPrompt.includes('PERSISTED'), 'override content appears in systemPrompt')
      assert.ok(result.systemPrompt.includes('investigate'))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('when workingSetOverride is undefined, derive path is used (backward compatible)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wst-ac-default-'))
    try {
      const events: NexusEvent[] = [
        { type: 'session_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId: 's', timestamp: '2026-06-16T00:00:00.000Z', cwd },
      ]
      const result = await assembleContext({
        runtimeOptions: { sessionId: 's', prompt: 'go', cwd },
        events,
        modelId: 'test-model',
        buildSystemPrompt: () => 'system',
        mapEventsToMessages: () => [],
        // no workingSetOverride → derive path
      })
      // Just confirm it completes without error and has system prompt
      assert.equal(typeof result.systemPrompt, 'string')
      assert.ok(result.systemPrompt.length > 0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('WorkingSetTracker.update → assembleContext integration', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wst-ac-integ-'))
    try {
      const sessionId = newSessionId()
      const events: NexusEvent[] = [
        { type: 'session_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-16T00:00:00.000Z', cwd },
        // Mention a file in user message (so derive would pick it up)
        { type: 'user_message', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-16T00:00:01.000Z', text: 'check the file structure' },
        { type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-16T00:00:02.000Z', toolUseId: 'tu_1', name: 'Read', input: { path: join(cwd, 'src', 'main.ts') } },
      ]

      const tracker = new WorkingSetTracker()
      // Build working set from events using tracker helpers
      const entries = deriveEntriesFromEvents(events, cwd)
      tracker.update(sessionId, { workspaceId: cwd, entries })
      const tracked = tracker.get(sessionId)
      assert.ok(tracked, 'tracker has the session')
      assert.ok(tracked!.entries.length >= 1)

      // Build a workingSet string from tracker entries (caller-side composition)
      const override = tracked!.entries
        .map(e => `- ${e.key}: ${e.value}`)
        .join('\n')

      // Feed that override back into assembleContext
      const result = await assembleContext({
        runtimeOptions: { sessionId, prompt: 'check the file structure', cwd },
        events,
        modelId: 'test-model',
        buildSystemPrompt: () => 'system',
        mapEventsToMessages: () => [],
        workingSetOverride: `## Persisted Working Set\n${override}`,
      })
      assert.ok(result.systemPrompt.includes('Persisted Working Set'))
      assert.ok(result.systemPrompt.includes(join(cwd, 'src', 'main.ts')))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
