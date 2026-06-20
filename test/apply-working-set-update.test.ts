import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventBase, type NexusEvent } from '../src/shared/events.js'
import { PersistedWorkingSetTracker } from '../src/runtime/persistedWorkingSetTracker.js'
import { applyWorkingSetUpdate } from '../src/runtime/applyWorkingSetUpdate.js'

const SESSION = 'test-apply-ws-session'

function makeTempCwd(): { cwd: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-apply-ws-'))
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

function assistantDelta(text: string, sessionId = SESSION): NexusEvent {
  return { type: 'assistant_delta', ...eventBase(sessionId), text }
}

test('applyWorkingSetUpdate is a no-op when tracker is undefined', () => {
  // Simulates the legacy path with no resumeDeps — must not throw.
  assert.doesNotThrow(() => {
    applyWorkingSetUpdate(undefined, SESSION, [toolStarted('tool-1', 'Read', { path: '/tmp/a.ts' })], '/tmp')
  })
})

test('applyWorkingSetUpdate with empty events list is a no-op', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    applyWorkingSetUpdate(tracker, SESSION, [], cwd)
    // No entries should have been added
    const ws = tracker.get(SESSION)
    assert.equal(ws, null, 'empty event list must not create a working set entry')
  } finally {
    cleanup()
  }
})

test('applyWorkingSetUpdate skips non-tool_started events', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    const events: NexusEvent[] = [
      assistantDelta('hello'),
      assistantDelta('world'),
    ]
    applyWorkingSetUpdate(tracker, SESSION, events, cwd)
    const ws = tracker.get(SESSION)
    assert.equal(ws, null, 'non-tool_started events must not create working set entries')
  } finally {
    cleanup()
  }
})

test('applyWorkingSetUpdate applies each tool_started event in order', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    const path1 = join(cwd, 'file1.ts')
    const path2 = join(cwd, 'file2.ts')
    const path3 = join(cwd, 'file3.ts')
    applyWorkingSetUpdate(tracker, SESSION, [
      toolStarted('tool-1', 'Read', { path: path1 }),
      toolStarted('tool-2', 'Read', { path: path2 }),
      toolStarted('tool-3', 'Read', { path: path3 }),
    ], cwd)
    const ws = tracker.get(SESSION)
    assert.ok(ws, 'tracker must have a working set for the session after applying events')
    const paths = ws!.entries.map((e) => e.value)
    assert.deepEqual(paths, [path1, path2, path3], 'entries must reflect all three tool_started events in order')
  } finally {
    cleanup()
  }
})

test('applyWorkingSetUpdate filters out out-of-cwd paths (delegated to tracker.applyEvent)', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    const inScope = join(cwd, 'inside.ts')
    const outOfScope = '/etc/passwd' // not under cwd
    applyWorkingSetUpdate(tracker, SESSION, [
      toolStarted('tool-1', 'Read', { path: inScope }),
      toolStarted('tool-2', 'Read', { path: outOfScope }),
    ], cwd)
    const ws = tracker.get(SESSION)
    assert.ok(ws)
    const paths = ws!.entries.map((e) => e.value)
    assert.deepEqual(paths, [inScope], 'out-of-cwd paths must be filtered by tracker.applyEvent')
  } finally {
    cleanup()
  }
})

test('applyWorkingSetUpdate filters out tool_started without a usable path', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    applyWorkingSetUpdate(tracker, SESSION, [
      toolStarted('tool-1', 'Read', {}), // no path / filePath
      toolStarted('tool-2', 'Bash', { command: 'ls' }), // bash tool, no path
    ], cwd)
    const ws = tracker.get(SESSION)
    assert.equal(ws, null, 'tool_started events without a path input must not produce entries')
  } finally {
    cleanup()
  }
})

test('applyWorkingSetUpdate preserves the full event batch ordering across mixed types', async () => {
  const { cwd, cleanup } = makeTempCwd()
  try {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    const path1 = join(cwd, 'first.ts')
    const path2 = join(cwd, 'second.ts')
    // Intersperse non-tool events; only tool_started ones must be applied.
    applyWorkingSetUpdate(tracker, SESSION, [
      toolStarted('tool-1', 'Read', { path: path1 }),
      assistantDelta('noise'),
      toolStarted('tool-2', 'Read', { path: path2 }),
      assistantDelta('more noise'),
    ], cwd)
    const ws = tracker.get(SESSION)
    assert.ok(ws)
    const paths = ws!.entries.map((e) => e.value)
    assert.deepEqual(paths, [path1, path2])
  } finally {
    cleanup()
  }
})
