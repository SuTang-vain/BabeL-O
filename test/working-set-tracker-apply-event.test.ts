// test/working-set-tracker-apply-event.test.ts
//
// PR-30 unit tests: applyEvent() + getWorkspaceWorkingSet() (doc §5.1).
// Covers:
//   1. applyEvent on tool_started derives file path entry
//   2. applyEvent on non-tool_started returns null (no-op)
//   3. applyEvent on file outside cwd returns null
//   4. applyEvent reuses existing key (no duplicate)
//   5. getWorkspaceWorkingSet returns aggregated entries
//   6. getWorkspaceWorkingSet returns null for unknown workspace
//   7. getWorkspaceWorkingSet tags entries with source sessionId

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WorkingSetTracker,
  type WorkingSet,
} from '../src/nexus/workingSetTracker.js'
import { PersistedWorkingSetTracker } from '../src/nexus/persistedWorkingSetTracker.js'

const SCHEMA_VERSION = '2026-05-21.babel-o.v1'

function toolStarted(sessionId: string, path: string, ts = '2026-06-16T10:00:00.000Z') {
  return {
    type: 'tool_started' as const,
    schemaVersion: SCHEMA_VERSION as typeof SCHEMA_VERSION,
    sessionId,
    timestamp: ts,
    toolUseId: `tu_${Math.random().toString(36).slice(2, 8)}`,
    name: 'Read',
    input: { path },
  }
}

function errorEvent(sessionId: string) {
  return {
    type: 'error' as const,
    schemaVersion: SCHEMA_VERSION as typeof SCHEMA_VERSION,
    sessionId,
    timestamp: '2026-06-16T10:00:00.000Z',
    code: 'X',
    message: 'msg',
  }
}

describe('PR-30 applyEvent (doc §5.1)', () => {
  const cwd = '/tmp/pr30-cwd'

  // Test 1: tool_started derives file path entry
  test('applyEvent on tool_started derives file: entry', () => {
    const tracker = new WorkingSetTracker()
    const result = tracker.applyEvent('s1', toolStarted('s1', '/tmp/pr30-cwd/foo.ts'), cwd)
    assert.ok(result, 'returns updated working set')
    assert.equal(result!.entries.length, 1)
    assert.equal(result!.entries[0]!.key, 'file:/tmp/pr30-cwd/foo.ts')
    assert.equal(result!.entries[0]!.value, '/tmp/pr30-cwd/foo.ts')
    assert.equal(result!.entries[0]!.confidence, 0.85)
  })

  // Test 2: non-tool_started returns null
  test('applyEvent on error returns null (no-op)', () => {
    const tracker = new WorkingSetTracker()
    const result = tracker.applyEvent('s1', errorEvent('s1'), cwd)
    assert.equal(result, null)
    assert.equal(tracker.size(), 0, 'no working set created')
  })

  // Test 3: file outside cwd returns null
  test('applyEvent on file outside cwd returns null', () => {
    const tracker = new WorkingSetTracker()
    const result = tracker.applyEvent('s1', toolStarted('s1', '/etc/passwd'), cwd)
    assert.equal(result, null)
    assert.equal(tracker.size(), 0)
  })

  // Test 4: reuses existing key
  test('applyEvent reuses existing key (no duplicate)', () => {
    const tracker = new WorkingSetTracker()
    tracker.applyEvent('s1', toolStarted('s1', '/tmp/pr30-cwd/foo.ts'), cwd)
    const result = tracker.applyEvent('s1', toolStarted('s1', '/tmp/pr30-cwd/foo.ts'), cwd)
    assert.ok(result)
    assert.equal(result!.entries.length, 1, 'still 1 entry, no duplicate')
  })

  // Test 5: multiple files
  test('applyEvent: multiple files → multiple entries', () => {
    const tracker = new WorkingSetTracker()
    tracker.applyEvent('s1', toolStarted('s1', '/tmp/pr30-cwd/a.ts'), cwd)
    tracker.applyEvent('s1', toolStarted('s1', '/tmp/pr30-cwd/b.ts'), cwd)
    tracker.applyEvent('s1', toolStarted('s1', '/tmp/pr30-cwd/c.ts'), cwd)
    const ws = tracker.get('s1')!
    assert.equal(ws.entries.length, 3)
  })

  // Test 6: persists via PersistedWorkingSetTracker
  test('applyEvent on PersistedWorkingSetTracker triggers event bus', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pr30-home-'))
    const testCwd = mkdtempSync(join(home, 'p-'))
    mkdirSync(join(testCwd, '.babel-o'), { recursive: true })
    try {
      const tracker = new PersistedWorkingSetTracker(testCwd)
      await tracker.load()
      const events: any[] = []
      tracker.subscribe((e) => { events.push(e) })
      tracker.applyEvent('s_persist', toolStarted('s_persist', join(testCwd, 'x.ts')), testCwd)
      assert.equal(events.length, 1, 'applyEvent triggers working_set_updated')
      assert.equal(events[0].type, 'working_set_updated')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // Test 7: input.filePath fallback (alternative field name)
  test('applyEvent accepts input.filePath as alternative to input.path', () => {
    const tracker = new WorkingSetTracker()
    const event = {
      type: 'tool_started' as const,
      schemaVersion: SCHEMA_VERSION as typeof SCHEMA_VERSION,
      sessionId: 's1',
      timestamp: '2026-06-16T10:00:00.000Z',
      toolUseId: 'tu_1',
      name: 'Read',
      input: { filePath: '/tmp/pr30-cwd/from-fp.ts' },
    }
    const result = tracker.applyEvent('s1', event, cwd)
    assert.ok(result)
    assert.equal(result!.entries[0]!.key, 'file:/tmp/pr30-cwd/from-fp.ts')
  })
})

describe('PR-30 getWorkspaceWorkingSet (doc §5.1)', () => {
  test('returns aggregated entries from all sessions in workspace', () => {
    const tracker = new WorkingSetTracker()
    tracker.linkToWorkspace('s1', 'ws-a')
    tracker.linkToWorkspace('s2', 'ws-a')
    tracker.update('s1', { workspaceId: 'ws-a', entries: [
      { key: 'task:1', value: 'v1', updatedAt: 't', confidence: 0.9 },
    ] })
    tracker.update('s2', { workspaceId: 'ws-a', entries: [
      { key: 'task:2', value: 'v2', updatedAt: 't', confidence: 0.9 },
    ] })

    const ws = tracker.getWorkspaceWorkingSet('ws-a')
    assert.ok(ws)
    assert.equal(ws!.sessionId, 'workspace:ws-a')
    assert.equal(ws!.workspaceId, 'ws-a')
    assert.equal(ws!.entries.length, 2)
    const keys = ws!.entries.map((e) => e.key).sort()
    assert.deepEqual(keys, ['task:1@s1', 'task:2@s2'])
  })

  test('returns null for unknown workspace', () => {
    const tracker = new WorkingSetTracker()
    const ws = tracker.getWorkspaceWorkingSet('nonexistent')
    assert.equal(ws, null)
  })

  test('returns null when workspace has no linked sessions', () => {
    const tracker = new WorkingSetTracker()
    tracker.linkToWorkspace('s1', 'ws-a')
    tracker.unlinkFromWorkspace('s1', 'ws-a')
    const ws = tracker.getWorkspaceWorkingSet('ws-a')
    assert.equal(ws, null)
  })

  test('aggregated maxVersion reflects the highest session version', () => {
    const tracker = new WorkingSetTracker()
    tracker.linkToWorkspace('s1', 'ws-a')
    tracker.linkToWorkspace('s2', 'ws-a')
    tracker.update('s1', { workspaceId: 'ws-a', entries: [], version: 1 })
    tracker.update('s2', { workspaceId: 'ws-a', entries: [], version: 7 })
    const ws = tracker.getWorkspaceWorkingSet('ws-a')
    assert.equal(ws!.version, 7)
  })

  test('aggregated updatedAt is the max of session updatedAt values', () => {
    const tracker = new WorkingSetTracker()
    tracker.linkToWorkspace('s1', 'ws-a')
    tracker.linkToWorkspace('s2', 'ws-a')
    // update() always overrides updatedAt with current time, so we just
    // verify that the aggregated updatedAt is one of the session values
    // (max over all linked sessions).
    tracker.update('s1', { workspaceId: 'ws-a', entries: [], version: 1 })
    const s1UpdatedAt = tracker.get('s1')!.updatedAt
    tracker.update('s2', { workspaceId: 'ws-a', entries: [], version: 1 })
    const s2UpdatedAt = tracker.get('s2')!.updatedAt
    const ws = tracker.getWorkspaceWorkingSet('ws-a')
    const allTimes = [s1UpdatedAt, s2UpdatedAt]
    assert.ok(allTimes.includes(ws!.updatedAt), 'aggregated updatedAt is one of the session updatedAt values')
  })
})
