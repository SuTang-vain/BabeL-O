// test/context-working-set-edit-cli.test.ts
//
// PR-19 unit tests: bbl context working-set-edit (write op, user-approved 2026-06-17).
// Covers:
//   1. --add adds entry
//   2. --remove removes entry
//   3. --update updates existing
//   4. multiple ops atomic (one call → many changes)
//   5. --dry-run no writes
//   6. validation: --add duplicate key → error
//   7. validation: --update missing key → error
//   8. validation: --remove missing key → error
//   9. validation: --session-id required
//  10. validation: at least one of --add/--remove/--update
//  11. empty cwd: creates new session
//  12. HOME isolation
//  13. event bus emits working_set_updated
//  14. invalid --add format → error
//  15. --json mode prints valid JSON

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { runWorkingSetEdit, type WorkingSetEditOptions } from '../src/cli/commands/context.js'
import { registerContextCommand } from '../src/cli/commands/context.js'
import { Command } from 'commander'
import { PersistedWorkingSetTracker } from '../src/runtime/persistedWorkingSetTracker.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const origLog = console.log
  let buf = ''
  console.log = (...args: unknown[]) => {
    buf += args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'
  }
  return Promise.resolve()
    .then(() => fn())
    .finally(() => { console.log = origLog })
    .then(() => buf)
}

describe('PR-19 bbl context working-set-edit (write op)', () => {
  let home: string
  let cwd: string
  const sessionId = `pr19-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr19-home-'))
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

  function opts(partial: Partial<WorkingSetEditOptions> = {}): WorkingSetEditOptions {
    return {
      cwd,
      sessionId,
      add: [],
      remove: [],
      update: [],
      dryRun: false,
      json: false,
      ...partial,
    }
  }

  function readPersisted(): any {
    const path = join(cwd, '.babel-o', 'working-set.json')
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  }

  // Test 1: --add
  test('--add adds a new entry and persists', async () => {
    await captureStdout(() => runWorkingSetEdit(opts({ add: ['task:foo=bar'] })))
    const persisted = readPersisted()
    assert.ok(persisted)
    assert.equal(persisted.sessions[sessionId].entries.length, 1)
    assert.equal(persisted.sessions[sessionId].entries[0].key, 'task:foo')
    assert.equal(persisted.sessions[sessionId].entries[0].value, 'bar')
    assert.equal(persisted.sessions[sessionId].entries[0].confidence, 1)
  })

  // Test 2: --remove
  test('--remove deletes an existing entry', async () => {
    // Pre-seed
    writeFileSync(join(cwd, '.babel-o', 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { [sessionId]: { sessionId, workspaceId: 'ws-a', entries: [
        { key: 'task:remove-me', value: 'v', updatedAt: 't', confidence: 0.9 },
        { key: 'task:keep', value: 'k', updatedAt: 't', confidence: 0.9 },
      ], version: 1, updatedAt: 't' } },
    }, null, 2), 'utf8')

    await captureStdout(() => runWorkingSetEdit(opts({ remove: ['task:remove-me'] })))
    const persisted = readPersisted()
    assert.equal(persisted.sessions[sessionId].entries.length, 1)
    assert.equal(persisted.sessions[sessionId].entries[0].key, 'task:keep')
  })

  // Test 3: --update
  test('--update changes an existing entry value', async () => {
    writeFileSync(join(cwd, '.babel-o', 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { [sessionId]: { sessionId, workspaceId: 'ws-a', entries: [
        { key: 'count', value: '1', updatedAt: 't', confidence: 0.9 },
      ], version: 1, updatedAt: 't' } },
    }, null, 2), 'utf8')

    await captureStdout(() => runWorkingSetEdit(opts({ update: ['count=2'] })))
    const persisted = readPersisted()
    assert.equal(persisted.sessions[sessionId].entries[0].value, '2')
  })

  // Test 4: multiple ops
  test('multiple --add + --remove + --update in one call', async () => {
    writeFileSync(join(cwd, '.babel-o', 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { [sessionId]: { sessionId, workspaceId: 'ws-a', entries: [
        { key: 'a', value: '1', updatedAt: 't', confidence: 0.9 },
        { key: 'b', value: '2', updatedAt: 't', confidence: 0.9 },
      ], version: 1, updatedAt: 't' } },
    }, null, 2), 'utf8')

    await captureStdout(() => runWorkingSetEdit(opts({
      add: ['c=3'],
      remove: ['a'],
      update: ['b=22'],
    })))
    const persisted = readPersisted()
    const keys = persisted.sessions[sessionId].entries.map((e: any) => `${e.key}=${e.value}`).sort()
    assert.deepEqual(keys, ['b=22', 'c=3'])
  })

  // Test 5: --dry-run
  test('--dry-run: no writes, no version bump', async () => {
    writeFileSync(join(cwd, '.babel-o', 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { [sessionId]: { sessionId, workspaceId: 'ws-a', entries: [], version: 5, updatedAt: 't' } },
    }, null, 2), 'utf8')

    await captureStdout(() => runWorkingSetEdit(opts({ add: ['x=1'], dryRun: true })))
    const persisted = readPersisted()
    assert.equal(persisted.sessions[sessionId].entries.length, 0)
    assert.equal(persisted.sessions[sessionId].version, 5, 'version unchanged')
  })

  // Test 6: --add duplicate
  test('--add with existing key → exits with error', async () => {
    writeFileSync(join(cwd, '.babel-o', 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { [sessionId]: { sessionId, workspaceId: 'ws-a', entries: [
        { key: 'k', value: 'v', updatedAt: 't', confidence: 0.9 },
      ], version: 1, updatedAt: 't' } },
    }, null, 2), 'utf8')

    const origExit = process.exitCode
    await captureStdout(() => runWorkingSetEdit(opts({ add: ['k=other'] })))
    assert.equal(process.exitCode, 2)
    process.exitCode = origExit
  })

  // Test 7: --update missing
  test('--update with non-existent key → exits with error', async () => {
    const origExit = process.exitCode
    await captureStdout(() => runWorkingSetEdit(opts({ update: ['missing=x'] })))
    assert.equal(process.exitCode, 2)
    process.exitCode = origExit
  })

  // Test 8: --remove missing
  test('--remove with non-existent key → exits with error', async () => {
    const origExit = process.exitCode
    await captureStdout(() => runWorkingSetEdit(opts({ remove: ['missing'] })))
    assert.equal(process.exitCode, 2)
    process.exitCode = origExit
  })

  // Test 9: --session-id required
  test('--session-id required → exits with error', async () => {
    const origExit = process.exitCode
    await captureStdout(() => runWorkingSetEdit(opts({ sessionId: undefined, add: ['x=1'] })))
    assert.equal(process.exitCode, 2)
    process.exitCode = origExit
  })

  // Test 10: at least one op required
  test('no --add/--remove/--update → exits with error', async () => {
    const origExit = process.exitCode
    await captureStdout(() => runWorkingSetEdit(opts({})))
    assert.equal(process.exitCode, 2)
    process.exitCode = origExit
  })

  // Test 11: empty cwd creates new session
  test('empty cwd: creates new session with given workspaceId', async () => {
    const emptyCwd = mkdtempSync(join(home, 'empty-'))
    try {
      await captureStdout(() => runWorkingSetEdit({ ...opts(), cwd: emptyCwd, workspaceId: 'ws-new', add: ['k=v'] }))
      const persisted = JSON.parse(readFileSync(join(emptyCwd, '.babel-o', 'working-set.json'), 'utf8'))
      assert.equal(persisted.sessions[sessionId].workspaceId, 'ws-new')
      assert.equal(persisted.sessions[sessionId].entries[0].key, 'k')
    } finally {
      rmSync(emptyCwd, { recursive: true, force: true })
    }
  })

  // Test 12: HOME isolation
  test('HOME isolation: HOME working-set.json not touched', async () => {
    writeFileSync(join(home, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { homeS: { sessionId: 'homeS', workspaceId: 'ws', entries: [], version: 1, updatedAt: 't' } },
    }), 'utf8')
    await captureStdout(() => runWorkingSetEdit(opts({ add: ['k=v'] })))
    const homeData = JSON.parse(readFileSync(join(home, 'working-set.json'), 'utf8'))
    assert.equal(homeData.sessions.homeS.entries.length, 0, 'HOME file not touched')
  })

  // Test 13: event bus emits working_set_updated
  test('event bus: working_set_updated event emitted on update()', async () => {
    const events: any[] = []
    // Manually wire: load tracker first via runWorkingSetEdit, then subscribe
    await captureStdout(() => runWorkingSetEdit(opts({ add: ['k1=v1'] })))
    // Now reload tracker and subscribe
    const tracker = new PersistedWorkingSetTracker(cwd)
    await tracker.load()
    tracker.subscribe((e) => { events.push(e) })
    tracker.update(sessionId, { entries: [{ key: 'k2', value: 'v2', updatedAt: 't', confidence: 1 }] })
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'working_set_updated')
    assert.equal(events[0].sessionId, sessionId)
  })

  // Test 14: invalid format
  test('invalid --add format (no =) → exits with error', async () => {
    const origExit = process.exitCode
    await captureStdout(() => runWorkingSetEdit(opts({ add: ['no-equals-sign'] })))
    assert.equal(process.exitCode, 2)
    process.exitCode = origExit
  })

  // Test 15: --json mode
  test('--json: prints valid JSON with operations array', async () => {
    const out = await captureStdout(() => runWorkingSetEdit(opts({ add: ['k=v'], json: true })))
    const parsed = JSON.parse(out)
    assert.equal(parsed.sessionId, sessionId)
    assert.equal(parsed.operations.length, 1)
    assert.equal(parsed.operations[0].op, 'add')
    assert.equal(parsed.operations[0].key, 'k')
    assert.equal(parsed.operations[0].value, 'v')
    assert.equal(parsed.entryCount, 1)
  })

  // Test 16: --workspace-id override
  test('--workspace-id: assigns workspace to session', async () => {
    await captureStdout(() => runWorkingSetEdit(opts({ workspaceId: 'ws-explicit', add: ['k=v'] })))
    const persisted = readPersisted()
    assert.equal(persisted.sessions[sessionId].workspaceId, 'ws-explicit')
  })
})

describe('PR-19 working-set-edit subcommand registration', () => {
  test('registers bbl context working-set-edit as a sub-subcommand', () => {
    const program = new Command()
    registerContextCommand(program)
    const ctx = program.commands.find((c) => c.name() === 'context')!
    const wsEdit = ctx.commands.find((c) => c.name() === 'working-set-edit')
    assert.ok(wsEdit, 'working-set-edit subcommand registered')
  })
})
