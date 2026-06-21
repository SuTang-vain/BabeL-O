import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventBase, type NexusEvent } from '../src/shared/events.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { PersistedWorkingSetTracker } from '../src/runtime/persistedWorkingSetTracker.js'
import { loadWorkingSetOverride } from '../src/runtime/loadWorkingSetOverride.js'

const SESSION = 'test-ws-override-session'

function makeTempCwd(): { cwd: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-ws-override-'))
  return {
    cwd: dir,
    // maxRetries=3 lets the OS settle any in-flight fs writes from
    // PersistedWorkingSetTracker's background flush before rmSync.
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }),
  }
}

function toolStarted(toolUseId: string, name: string, input: unknown, sessionId = SESSION): NexusEvent {
  return { type: 'tool_started', ...eventBase(sessionId), toolUseId, name, input }
}

test('loadWorkingSetOverride returns undefined when tracker is undefined', async () => {
  // Legacy / test-only path with no resumeDeps — assembler falls back
  // to its transient derive.
  const result = await loadWorkingSetOverride(undefined, undefined, SESSION, '/tmp')
  assert.equal(result, undefined)
})

test('loadWorkingSetOverride returns formatted working set when tracker already has the session', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    // Seed the tracker with a session entry
    tracker.update(SESSION, {
      workspaceId: '',
      entries: [{ key: 'k1', value: '/tmp/file1.ts', updatedAt: new Date().toISOString(), confidence: 1 }],
    })
    const result = await loadWorkingSetOverride(tracker, undefined, SESSION, cwd)
    assert.ok(result, 'result must be a formatted working set string')
    assert.match(result!, /Working Set:/)
    assert.match(result!, /\/tmp\/file1\.ts/)
  } finally {
    cleanup()
  }
})

test('loadWorkingSetOverride returns undefined when tracker is empty and storage is also undefined', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    // No session in tracker, no storage → can't rebuild → undefined
    const result = await loadWorkingSetOverride(tracker, undefined, SESSION, cwd)
    assert.equal(result, undefined)
  } finally {
    cleanup()
  }
})

test('loadWorkingSetOverride returns undefined when tracker + storage both produce no entries', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    const storage = new MemoryStorage()
    // No events in storage → deriveEntriesFromEvents returns [] → undefined
    const result = await loadWorkingSetOverride(tracker, storage, SESSION, cwd)
    assert.equal(result, undefined)
  } finally {
    cleanup()
  }
})

test('loadWorkingSetOverride rebuilds from storage event tail when tracker has no session entry', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    const storage = new MemoryStorage()
    // MemoryStorage requires the session to exist before appendEvent will
    // accept events; create the session first.
    await storage.saveSession({
      sessionId: SESSION,
      cwd,
      prompt: 'test prompt',
      phase: 'created',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
    })
    // Seed storage with a tool_started event whose path lives under cwd
    // (deriveEntriesFromEvents filters paths by cwd prefix).
    const seedPath = join(cwd, 'from-event-tail.ts')
    await storage.appendEvent(SESSION, toolStarted('tool-1', 'Read', { path: seedPath }))
    const result = await loadWorkingSetOverride(tracker, storage, SESSION, cwd)
    assert.ok(result, 'result must be a formatted working set string after rebuild')
    assert.match(result!, /from-event-tail\.ts/)
  } finally {
    cleanup()
  }
})

test('loadWorkingSetOverride returns undefined when storage.listEvents throws (best-effort)', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    // Stub storage that throws on listEvents
    const throwingStorage = {
      listEvents: async () => { throw new Error('storage unavailable') },
      // Other methods not exercised in this test
    } as any
    const result = await loadWorkingSetOverride(tracker, throwingStorage, SESSION, cwd)
    assert.equal(result, undefined, 'storage failures must surface as undefined, never throw')
  } finally {
    cleanup()
  }
})

test('loadWorkingSetOverride prefers the existing tracker entry over a rebuild', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    // Seed tracker with one path
    const trackerPath = join(cwd, 'from-tracker.ts')
    tracker.update(SESSION, {
      workspaceId: '',
      entries: [{ key: 'k1', value: trackerPath, updatedAt: new Date().toISOString(), confidence: 1 }],
    })
    // Seed storage with a different path that would derive via rebuild
    const storage = new MemoryStorage()
    await storage.saveSession({
      sessionId: SESSION,
      cwd,
      prompt: 'test prompt',
      phase: 'created',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
    })
    const rebuildPath = join(cwd, 'from-event-tail.ts')
    await storage.appendEvent(SESSION, toolStarted('tool-1', 'Read', { path: rebuildPath }))
    const result = await loadWorkingSetOverride(tracker, storage, SESSION, cwd)
    assert.ok(result)
    assert.match(result!, /from-tracker\.ts/)
    assert.doesNotMatch(result!, /from-event-tail\.ts/, 'must not include rebuild-derived entry when tracker already has the session')
  } finally {
    cleanup()
  }
})

test('loadWorkingSetOverride normalizes multi-entry working set with formatWorkingSet shape', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    tracker.update(SESSION, {
      workspaceId: '',
      entries: [
        { key: 'k1', value: '/tmp/file1.ts', updatedAt: new Date().toISOString(), confidence: 1 },
        { key: 'k2', value: '/tmp/file2.ts', updatedAt: new Date().toISOString(), confidence: 1 },
        { key: 'k3', value: '/tmp/file3.ts', updatedAt: new Date().toISOString(), confidence: 1 },
      ],
    })
    const result = await loadWorkingSetOverride(tracker, undefined, SESSION, cwd)
    assert.ok(result)
    assert.match(result!, /\/tmp\/file1\.ts/)
    assert.match(result!, /\/tmp\/file2\.ts/)
    assert.match(result!, /\/tmp\/file3\.ts/)
  } finally {
    cleanup()
  }
})
