// test/working-set-event-bus.test.ts
//
// PR-26 unit tests: WorkingSetTracker event bus (per design §6.3 + §7.3 WebSocket).
// Covers:
//   1. subscribe receives update event
//   2. subscribe receives rebuild event (which calls update internally)
//   3. subscribe receives reset event
//   4. unsubscribe works
//   5. multiple subscribers
//   6. error in one handler does not block others
//   7. PersistedWorkingSetTracker inherits bus
//   8. linkToWorkspace + sessionsInWorkspace tracking
//   9. reset cleans up workspaceIndex
//  10. event payload shape (type/sessionId/workspaceId/ws/timestamp)

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WorkingSetTracker,
  type WorkingSetEvent,
} from '../src/runtime/workingSetTracker.js'
import { PersistedWorkingSetTracker } from '../src/runtime/persistedWorkingSetTracker.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-26 WorkingSetTracker event bus', () => {
  beforeEach(() => {
    for (const key of ['HOME', 'BABEL_O_TEST_CONFIG_WRITE_GUARD']) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
  })

  // Test 1: update event
  test('update emits working_set_updated with full payload', () => {
    const tracker = new WorkingSetTracker()
    const events: WorkingSetEvent[] = []
    tracker.subscribe((e) => { events.push(e) })

    tracker.update('s1', { workspaceId: 'ws-a', entries: [{ key: 'k', value: 'v', updatedAt: 't', confidence: 0.9 }] })
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, 'working_set_updated')
    assert.equal(events[0]!.sessionId, 's1')
    assert.equal(events[0]!.workspaceId, 'ws-a')
    assert.ok((events[0] as any).ws)
    assert.equal((events[0] as any).ws.entries[0].key, 'k')
    assert.equal((events[0] as any).ws.version, 1)
    assert.ok(typeof (events[0] as any).timestamp === 'string')
  })

  // Test 2: rebuild
  test('rebuild emits working_set_updated (rebuild calls update)', () => {
    const tracker = new WorkingSetTracker()
    const events: WorkingSetEvent[] = []
    tracker.subscribe((e) => { events.push(e) })

    tracker.rebuild('s1', 'ws-a', [{ key: 'k', value: 'v', updatedAt: 't', confidence: 0.5 }])
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, 'working_set_updated')
  })

  // Test 3: reset
  test('reset emits working_set_reset', () => {
    const tracker = new WorkingSetTracker()
    tracker.update('s1', { workspaceId: 'ws-a' })
    const events: WorkingSetEvent[] = []
    tracker.subscribe((e) => { events.push(e) })

    tracker.reset('s1')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, 'working_set_reset')
    assert.equal(events[0]!.sessionId, 's1')
    assert.equal(events[0]!.workspaceId, 'ws-a')
  })

  // Test 4: unsubscribe
  test('unsubscribe stops receiving events', () => {
    const tracker = new WorkingSetTracker()
    const events: WorkingSetEvent[] = []
    const unsub = tracker.subscribe((e) => { events.push(e) })

    tracker.update('s1', { workspaceId: 'ws-a' })
    assert.equal(events.length, 1)

    unsub()
    assert.equal(tracker.subscriberCount(), 0)

    tracker.update('s1', { workspaceId: 'ws-a' })
    assert.equal(events.length, 1, 'no event after unsubscribe')
  })

  // Test 5: multiple subscribers
  test('multiple subscribers all receive events', () => {
    const tracker = new WorkingSetTracker()
    const a: WorkingSetEvent[] = []
    const b: WorkingSetEvent[] = []
    tracker.subscribe((e) => { a.push(e) })
    tracker.subscribe((e) => { b.push(e) })

    tracker.update('s1', { workspaceId: 'ws-a' })
    assert.equal(a.length, 1)
    assert.equal(b.length, 1)
    assert.equal(tracker.subscriberCount(), 2)
  })

  // Test 6: error in one handler does not block others
  test('error in one handler does not block other handlers', () => {
    const tracker = new WorkingSetTracker()
    const events: WorkingSetEvent[] = []
    tracker.subscribe(() => { throw new Error('boom') })
    tracker.subscribe((e) => { events.push(e) })

    // Should not throw, second handler still receives event
    tracker.update('s1', { workspaceId: 'ws-a' })
    assert.equal(events.length, 1)
  })

  // Test 7: PersistedWorkingSetTracker inherits bus
  test('PersistedWorkingSetTracker inherits the bus (via parent class)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'babel-o-pr26-'))
    try {
      const tracker = new PersistedWorkingSetTracker(cwd)
      await tracker.load()
      const events: WorkingSetEvent[] = []
      tracker.subscribe((e) => { events.push(e) })

      tracker.update('s1', { workspaceId: 'ws-a', entries: [{ key: 'k', value: 'v', updatedAt: 't', confidence: 0.9 }] })
      assert.equal(events.length, 1)
      assert.equal(events[0]!.type, 'working_set_updated')
      assert.equal(events[0]!.sessionId, 's1')
      assert.equal(events[0]!.workspaceId, 'ws-a')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  // Test 8: linkToWorkspace + sessionsInWorkspace
  test('linkToWorkspace tracks sessionId under workspaceId', () => {
    const tracker = new WorkingSetTracker()
    tracker.linkToWorkspace('s1', 'ws-a')
    tracker.linkToWorkspace('s2', 'ws-a')
    tracker.linkToWorkspace('s3', 'ws-b')

    assert.equal(tracker.workspaceCount(), 2)
    const inA = tracker.sessionsInWorkspace('ws-a')
    assert.deepEqual(inA.sort(), ['s1', 's2'])
    assert.deepEqual(tracker.sessionsInWorkspace('ws-b'), ['s3'])
  })

  // Test 9: update keeps workspaceIndex in sync
  test('update() automatically registers sessionId under new workspaceId', () => {
    const tracker = new WorkingSetTracker()
    tracker.update('s1', { workspaceId: 'ws-a' })
    assert.deepEqual(tracker.sessionsInWorkspace('ws-a'), ['s1'])

    tracker.update('s1', { workspaceId: 'ws-b' })
    assert.equal(tracker.sessionsInWorkspace('ws-a').length, 0, 'old workspace cleaned up')
    assert.deepEqual(tracker.sessionsInWorkspace('ws-b'), ['s1'], 'new workspace populated')
  })

  // Test 10: reset cleans up workspaceIndex
  test('reset() cleans up workspaceIndex for the session', () => {
    const tracker = new WorkingSetTracker()
    tracker.update('s1', { workspaceId: 'ws-a' })
    tracker.update('s2', { workspaceId: 'ws-a' })
    assert.equal(tracker.sessionsInWorkspace('ws-a').length, 2)

    tracker.reset('s1')
    assert.deepEqual(tracker.sessionsInWorkspace('ws-a'), ['s2'])
    assert.equal(tracker.workspaceCount(), 1, 'workspace still exists because s2 is there')
  })

  // Test 11: reset removes workspace when last session leaves
  test('reset() removes workspace from index when last session leaves', () => {
    const tracker = new WorkingSetTracker()
    tracker.update('s1', { workspaceId: 'ws-only' })
    assert.equal(tracker.workspaceCount(), 1)
    tracker.reset('s1')
    assert.equal(tracker.workspaceCount(), 0)
    assert.deepEqual(tracker.sessionsInWorkspace('ws-only'), [])
  })

  // Test 12: linkToWorkspace is idempotent
  test('linkToWorkspace is idempotent', () => {
    const tracker = new WorkingSetTracker()
    tracker.linkToWorkspace('s1', 'ws-a')
    tracker.linkToWorkspace('s1', 'ws-a')
    tracker.linkToWorkspace('s1', 'ws-a')
    assert.deepEqual(tracker.sessionsInWorkspace('ws-a'), ['s1'])
  })
})
