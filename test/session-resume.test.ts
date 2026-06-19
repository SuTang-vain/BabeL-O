// test/session-resume.test.ts
//
// PR-28b unit tests: resumeSession() standalone helper (doc §6.2).
// Covers:
//   1. Load persisted working set (rebuilt=false)
//   2. Missing working set returns rebuilt=true with empty placeholder
//   3. Latency is reported
//   4. Multiple sessions are independent
//   5. Empty cwd
//   6. rebuildEventLimit reserved
//
// PR-28a: ContextAssemblerOptions include* flags (doc §5.2).

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resumeSession } from '../src/runtime/sessionResume.js'
import { PersistedWorkingSetTracker } from '../src/runtime/persistedWorkingSetTracker.js'
import type { ContextAssemblerOptions } from '../src/runtime/contextAssembler.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-28b resumeSession (standalone helper, doc §6.2)', () => {
  let home: string
  let cwd: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr28b-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    mkdirSync(join(cwd, '.babel-o'), { recursive: true })
    for (const key of ['HOME', 'BABEL_O_TEST_CONFIG_WRITE_GUARD']) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.HOME = home
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  function seedPersistedWorkingSet(sessions: Array<{ sid: string; ws: string; items: Array<{ key: string; value: string; updatedAt: string; confidence: number }> }>): void {
    const map: Record<string, any> = {}
    for (const s of sessions) {
      map[s.sid] = {
        sessionId: s.sid,
        workspaceId: s.ws,
        entries: s.items,
        version: 1,
        updatedAt: '2026-06-16T00:00:00.000Z',
      }
    }
    writeFileSync(
      join(cwd, '.babel-o', 'working-set.json'),
      JSON.stringify({ schemaVersion: '2026-06-16.working-set.v1', sessions: map }, null, 2),
      'utf8',
    )
  }

  test('load persisted working set (rebuilt=false)', async () => {
    seedPersistedWorkingSet([{
      sid: 's1',
      ws: 'ws-a',
      items: [{ key: 'task:resume', value: 'pick up where left', updatedAt: '2026-06-16T10:00:00.000Z', confidence: 0.95 }],
    }])
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    const result = await resumeSession({ sessionId: 's1', cwd, workingSetTracker: tracker })
    assert.equal(result.rebuilt, false, 'should NOT signal rebuild when persisted state exists')
    assert.equal(result.workingSet.sessionId, 's1')
    assert.equal(result.workingSet.workspaceId, 'ws-a')
    assert.equal(result.workingSet.entries.length, 1)
    assert.equal(result.workingSet.entries[0]!.key, 'task:resume')
    assert.equal(result.rebuildEventTail.length, 0, 'no event tail needed when load succeeds')
  })

  test('missing working set returns rebuilt=true with empty placeholder', async () => {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    const result = await resumeSession({ sessionId: 's_missing', cwd, workingSetTracker: tracker })
    assert.equal(result.rebuilt, true, 'should signal rebuild when no persisted state')
    assert.equal(result.workingSet.sessionId, 's_missing')
    assert.equal(result.workingSet.entries.length, 0, 'placeholder has no entries')
    assert.equal(result.workingSet.version, 0, 'placeholder version 0')
  })

  test('latencyMs is a non-negative number', async () => {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    const result = await resumeSession({ sessionId: 's_any', cwd, workingSetTracker: tracker })
    assert.ok(typeof result.latencyMs === 'number')
    assert.ok(result.latencyMs >= 0)
  })

  test('multiple sessions load independently', async () => {
    seedPersistedWorkingSet([
      { sid: 's1', ws: 'ws-a', items: [{ key: 'k1', value: 'v1', updatedAt: 't', confidence: 0.9 }] },
      { sid: 's2', ws: 'ws-b', items: [{ key: 'k2', value: 'v2', updatedAt: 't', confidence: 0.8 }] },
    ])
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    const r1 = await resumeSession({ sessionId: 's1', cwd, workingSetTracker: tracker })
    const r2 = await resumeSession({ sessionId: 's2', cwd, workingSetTracker: tracker })
    assert.equal(r1.workingSet.workspaceId, 'ws-a')
    assert.equal(r2.workingSet.workspaceId, 'ws-b')
    assert.equal(r1.workingSet.entries[0]!.key, 'k1')
    assert.equal(r2.workingSet.entries[0]!.key, 'k2')
  })

  test('empty cwd: any session returns rebuilt=true', async () => {
    const emptyCwd = mkdtempSync(join(home, 'empty-'))
    try {
      const tracker = new PersistedWorkingSetTracker(emptyCwd)
      await tracker.load()
      const result = await resumeSession({ sessionId: 's', cwd: emptyCwd, workingSetTracker: tracker })
      assert.equal(result.rebuilt, true)
    } finally {
      rmSync(emptyCwd, { recursive: true, force: true })
    }
  })

  test('rebuildEventLimit option accepted (reserved for future)', async () => {
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    const result = await resumeSession({
      sessionId: 's_x',
      cwd,
      workingSetTracker: tracker,
      rebuildEventLimit: 500,
    })
    assert.equal(result.rebuilt, true)
  })
})

describe('PR-28a ContextAssemblerOptions include* flags (doc §5.2)', () => {
  test('all 4 include flags are accepted as optional', () => {
    const opts: ContextAssemblerOptions = {
      runtimeOptions: {} as any,
      events: [],
      modelId: 'test',
      buildSystemPrompt: () => '',
      mapEventsToMessages: () => [],
      includeBehaviorTrace: true,
      includeLongTerm: true,
      includeProjectMemory: true,
      includeLiveHints: true,
    }
    assert.equal(opts.includeBehaviorTrace, true)
    assert.equal(opts.includeLongTerm, true)
    assert.equal(opts.includeProjectMemory, true)
    assert.equal(opts.includeLiveHints, true)
  })

  test('all 4 include flags are optional (backward compatible)', () => {
    const opts: ContextAssemblerOptions = {
      runtimeOptions: {} as any,
      events: [],
      modelId: 'test',
      buildSystemPrompt: () => '',
      mapEventsToMessages: () => [],
    }
    assert.equal(opts.includeBehaviorTrace, undefined)
    assert.equal(opts.includeLongTerm, undefined)
    assert.equal(opts.includeProjectMemory, undefined)
    assert.equal(opts.includeLiveHints, undefined)
  })
})
