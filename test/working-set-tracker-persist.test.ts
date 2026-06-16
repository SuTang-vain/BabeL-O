// test/working-set-tracker-persist.test.ts
//
// PR-4b unit tests: PersistedWorkingSetTracker
// Covers load, flush, atomic write, recover-after-restart, in-memory mode,
// HOME isolation, schema versioning.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  PersistedWorkingSetTracker,
  WORKING_SET_RELATIVE_PATH,
} from '../src/nexus/persistedWorkingSetTracker.js'
import { WorkingSetTracker } from '../src/nexus/workingSetTracker.js'
import type { WorkingSetEntry } from '../src/nexus/workingSetTracker.js'

function mkEntry(key: string, value: string, confidence = 0.9): WorkingSetEntry {
  return { key, value, updatedAt: new Date().toISOString(), confidence }
}

describe('PR-4b PersistedWorkingSetTracker', () => {
  let home: string
  let cwd: string
  const ORIGINAL_ENV: Record<string, string | undefined> = {}

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pwst-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
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

  test('load() on empty dir is a no-op', async () => {
    const t = new PersistedWorkingSetTracker(cwd)
    await t.load()
    assert.equal(t.size(), 0)
    const path = join(cwd, WORKING_SET_RELATIVE_PATH)
    assert.equal(existsSync(path), false, 'no file written on load of empty dir')
  })

  test('update() then flush() writes .babel-o/working-set.json', async () => {
    const t = new PersistedWorkingSetTracker(cwd)
    await t.load()
    const sessionId = `s-${randomUUID()}`
    t.update(sessionId, { workspaceId: cwd, entries: [mkEntry('task', 'go')] })
    await t.flush()

    const path = join(cwd, WORKING_SET_RELATIVE_PATH)
    assert.equal(existsSync(path), true)
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(parsed.schemaVersion, '2026-06-16.working-set.v1')
    assert.ok(parsed.sessions[sessionId], 'session present in file')
    assert.equal(parsed.sessions[sessionId].entries[0].key, 'task')
  })

  test('recover after restart: new tracker instance reads existing file', async () => {
    const sessionId = `s-${randomUUID()}`
    // Phase 1: write
    const t1 = new PersistedWorkingSetTracker(cwd)
    await t1.load()
    t1.update(sessionId, { workspaceId: cwd, entries: [mkEntry('persisted', 'yes')] })
    await t1.flush()
    const v1 = t1.get(sessionId)
    assert.ok(v1)
    assert.equal(v1.entries[0]!.value, 'yes')

    // Phase 2: simulate process restart
    const t2 = new PersistedWorkingSetTracker(cwd)
    await t2.load()
    const v2 = t2.get(sessionId)
    assert.ok(v2, 'working set recovered from disk')
    assert.equal(v2.entries[0]!.value, 'yes')
    assert.equal(v2.workspaceId, cwd)
  })

  test('reset() then flush() removes session from file', async () => {
    const sessionId = `s-${randomUUID()}`
    const t = new PersistedWorkingSetTracker(cwd)
    await t.load()
    t.update(sessionId, { workspaceId: cwd, entries: [mkEntry('a', 'A')] })
    await t.flush()
    t.reset(sessionId)
    await t.flush()

    const parsed = JSON.parse(readFileSync(join(cwd, WORKING_SET_RELATIVE_PATH), 'utf8'))
    assert.equal(parsed.sessions[sessionId], undefined, 'session removed from file')
  })

  test('atomic write: no .tmp left behind on success', async () => {
    const t = new PersistedWorkingSetTracker(cwd)
    await t.load()
    t.update('s', { entries: [mkEntry('a', 'A')] })
    await t.flush()
    assert.equal(existsSync(join(cwd, '.babel-o', 'working-set.json.tmp')), false)
  })

  test('corrupt file: load() starts empty (does not throw)', async () => {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'working-set.json'), '{ not valid json', 'utf8')
    const t = new PersistedWorkingSetTracker(cwd)
    await t.load() // must not throw
    assert.equal(t.size(), 0, 'corrupt file → empty start')
  })

  test('isolation: file is written to cwd/.babel-o, never HOME', async () => {
    const t = new PersistedWorkingSetTracker(cwd)
    await t.load()
    t.update('s', { entries: [mkEntry('a', 'A')] })
    await t.flush()
    const homePath = join(home, WORKING_SET_RELATIVE_PATH)
    assert.equal(existsSync(homePath), false, 'must NOT write to HOME/.babel-o')
    const cwdPath = join(cwd, WORKING_SET_RELATIVE_PATH)
    assert.equal(existsSync(cwdPath), true, 'must write to cwd/.babel-o')
  })

  test('in-memory WorkingSetTracker (no cwd) still works', () => {
    // PR-4a regression: the base class must still function without persistence
    const t = new WorkingSetTracker()
    t.update('s', { entries: [mkEntry('a', 'A')] })
    assert.equal(t.size(), 1)
  })

  test('PersistedWorkingSetTracker requires non-empty cwd', () => {
    assert.throws(() => new PersistedWorkingSetTracker(''), /non-empty cwd/)
  })

  test('multiple sessions persist correctly', async () => {
    const t = new PersistedWorkingSetTracker(cwd)
    await t.load()
    const a = `s-${randomUUID()}`
    const b = `s-${randomUUID()}`
    t.update(a, { entries: [mkEntry('a', 'A')] })
    t.update(b, { entries: [mkEntry('b', 'B')] })
    await t.flush()
    const parsed = JSON.parse(readFileSync(join(cwd, WORKING_SET_RELATIVE_PATH), 'utf8'))
    assert.ok(parsed.sessions[a])
    assert.ok(parsed.sessions[b])
    assert.equal(parsed.sessions[a].entries[0]!.value, 'A')
    assert.equal(parsed.sessions[b].entries[0]!.value, 'B')
  })
})
