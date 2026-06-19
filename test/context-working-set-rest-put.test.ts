// test/context-working-set-rest-put.test.ts
//
// PR-A1 unit tests: PUT /v1/context/working-set/:sessionId
//
// Covers:
//   - runWorkingSetPut helper (pure-function behavior): create, update, empty,
//     workspaceId preservation
//   - PUT route validation: missing cwd / entries / key / confidence shape
//   - Persistence: write-through to .babel-o/working-set.json
//   - HOME isolation: project cwd vs. $HOME working-set.json
//   - Event bus: working_set_updated emitted on PUT
//
// The helper is exported from src/nexus/app.js. The persistence class
// (PersistedWorkingSetTracker / _2 alias) lives in src/runtime/persistedWorkingSetTracker.ts.
// subscribe() is inherited from the base WorkingSetTracker and emits
// { type: 'working_set_updated', sessionId, workspaceId, ws, timestamp }.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  runWorkingSetPut,
  createNexusApp,
} from '../src/nexus/app.js'
import { PersistedWorkingSetTracker as PersistedWorkingSetTracker_2 } from '../src/runtime/persistedWorkingSetTracker.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-A1 PUT /v1/context/working-set/:sessionId (write op, user-approved)', () => {
  let home: string
  let cwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr-a1-home-'))
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

  function seedWorkingSet(sessions: Array<{ sid: string; workspaceId?: string; items: any[]; version?: number }>): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    const map: Record<string, any> = {}
    for (const s of sessions) {
      map[s.sid] = {
        sessionId: s.sid,
        workspaceId: s.workspaceId ?? cwd,
        entries: s.items,
        version: s.version ?? 1,
        updatedAt: '2026-06-16T00:00:00.000Z',
      }
    }
    writeFileSync(
      join(dir, 'working-set.json'),
      JSON.stringify({ schemaVersion: '2026-06-16.working-set.v1', sessions: map }, null, 2),
      'utf8',
    )
  }

  function readPersisted(): any {
    const file = join(cwd, '.babel-o', 'working-set.json')
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  }

  // ─── T1: helper creates a new session when none exists ─────────────────
  test('T1: runWorkingSetPut creates a new session when none exists', async () => {
    const sessionId = `t1-${randomUUID()}`
    const result = await runWorkingSetPut({
      cwd,
      sessionId,
      workspaceId: 'ws-new',
      entries: [
        { key: 'task:plan', value: 'draft plan', updatedAt: '2026-06-17T00:00:00.000Z', confidence: 0.9 },
      ],
    })
    assert.equal(result.type, 'working_set_session')
    assert.equal(result.sessionId, sessionId)
    assert.equal(result.workspaceId, 'ws-new')
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0]!.key, 'task:plan')
    assert.equal(result.version, 1)

    // Persisted file must exist with the new session + entry
    const file = join(cwd, '.babel-o', 'working-set.json')
    assert.ok(existsSync(file), 'working-set.json should be written')
    const persisted = readPersisted()
    assert.ok(persisted.sessions[sessionId], 'persisted file contains the new session')
    assert.equal(persisted.sessions[sessionId].workspaceId, 'ws-new')
    assert.equal(persisted.sessions[sessionId].entries.length, 1)
    assert.equal(persisted.sessions[sessionId].entries[0].key, 'task:plan')
  })

  // ─── T2: helper updates an existing session; version bumps ───────────
  test('T2: runWorkingSetPut updates an existing session and bumps version', async () => {
    const sessionId = `t2-${randomUUID()}`
    seedWorkingSet([{
      sid: sessionId,
      items: [{ key: 'old:key', value: 'old value', updatedAt: 't-old', confidence: 0.5 }],
      version: 1,
    }])
    const result = await runWorkingSetPut({
      cwd,
      sessionId,
      workspaceId: 'ws-2',
      entries: [
        { key: 'new:key', value: 'new value', updatedAt: 't-new', confidence: 0.95 },
      ],
    })
    // Entries must be replaced (write-through, not merge)
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0]!.key, 'new:key')
    assert.equal(result.entries[0]!.value, 'new value')
    // Version must be >= 2 (existing was 1, update bumps)
    assert.ok(result.version >= 2, `version should be bumped, got ${result.version}`)
    // File reflects the replacement
    const persisted = readPersisted()
    assert.equal(persisted.sessions[sessionId].entries.length, 1)
    assert.equal(persisted.sessions[sessionId].entries[0].key, 'new:key')
  })

  // ─── T3: empty entries array is allowed (clears the session) ─────────
  test('T3: runWorkingSetPut with empty entries array is allowed', async () => {
    const sessionId = `t3-${randomUUID()}`
    const result = await runWorkingSetPut({
      cwd,
      sessionId,
      workspaceId: 'ws-3',
      entries: [],
    })
    assert.equal(result.type, 'working_set_session')
    assert.equal(result.sessionId, sessionId)
    assert.equal(result.entries.length, 0)
    // Persisted file should exist and contain the session with no entries
    const persisted = readPersisted()
    assert.ok(persisted.sessions[sessionId], 'session persisted even with empty entries')
    assert.equal(persisted.sessions[sessionId].entries.length, 0)
  })

  // ─── T4: PUT without cwd query param → 400 mentioning 'cwd' ──────────
  test('T4: PUT without cwd query param returns 400 mentioning cwd', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/context/working-set/some-sid',
        payload: { entries: [{ key: 'k', value: 'v', updatedAt: 't', confidence: 0.5 }] },
      })
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body)
      assert.ok(body.error.toLowerCase().includes('cwd'), `error should mention cwd, got: ${body.error}`)
    } finally {
      await app.close()
    }
  })

  // ─── T5: PUT with valid cwd but missing body.entries → 400 ───────────
  test('T5: PUT with valid cwd but missing body.entries returns 400 mentioning entries', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/context/working-set/some-sid?cwd=${encodeURIComponent(cwd)}`,
        payload: { workspaceId: 'ws' },
      })
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body)
      assert.ok(body.error.toLowerCase().includes('entries'), `error should mention entries, got: ${body.error}`)
    } finally {
      await app.close()
    }
  })

  // ─── T6: PUT with body.entries not an array → 400 mentioning 'array' ──
  test('T6: PUT with body.entries not an array returns 400 mentioning array', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/context/working-set/some-sid?cwd=${encodeURIComponent(cwd)}`,
        payload: { entries: 'not-an-array' },
      })
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body)
      assert.ok(body.error.toLowerCase().includes('array'), `error should mention array, got: ${body.error}`)
    } finally {
      await app.close()
    }
  })

  // ─── T7: PUT with entries[0].key not a string → 400 mentioning 'key' ──
  test('T7: PUT with entries[0].key not a string returns 400 mentioning key', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/context/working-set/some-sid?cwd=${encodeURIComponent(cwd)}`,
        payload: { entries: [{ key: 123, value: 'v', updatedAt: 't', confidence: 0.5 }] },
      })
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body)
      assert.ok(body.error.toLowerCase().includes('key'), `error should mention key, got: ${body.error}`)
    } finally {
      await app.close()
    }
  })

  // ─── T8: PUT with entries[0].confidence out of [0,1] → 400 ───────────
  test('T8: PUT with entries[0].confidence = 1.5 returns 400 mentioning confidence', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/context/working-set/some-sid?cwd=${encodeURIComponent(cwd)}`,
        payload: { entries: [{ key: 'k', value: 'v', updatedAt: 't', confidence: 1.5 }] },
      })
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body)
      assert.ok(body.error.toLowerCase().includes('confidence'), `error should mention confidence, got: ${body.error}`)
    } finally {
      await app.close()
    }
  })

  // ─── T9: HOME isolation — HOME file unchanged after a project PUT ────
  test('T9: HOME isolation — HOME working-set.json is not mutated by project PUT', async () => {
    // Pre-write a HOME working-set.json with a homeS session
    const homeFile = join(home, 'working-set.json')
    writeFileSync(homeFile, JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: {
        homeS: {
          sessionId: 'homeS',
          workspaceId: home,
          entries: [{ key: 'home:k', value: 'home:v', updatedAt: 't', confidence: 0.5 }],
          version: 1,
          updatedAt: '2026-06-16T00:00:00.000Z',
        },
      },
    }), 'utf8')
    const before = readFileSync(homeFile, 'utf8')

    // Run helper for a different session in a project cwd
    const projectSid = `t9-proj-${randomUUID()}`
    await runWorkingSetPut({
      cwd,
      sessionId: projectSid,
      workspaceId: 'ws-proj',
      entries: [{ key: 'proj:k', value: 'proj:v', updatedAt: 't', confidence: 0.7 }],
    })

    // HOME file must be byte-identical (no project session leaked into HOME)
    const after = readFileSync(homeFile, 'utf8')
    assert.equal(after, before, 'HOME working-set.json must be unchanged')
    const parsed = JSON.parse(after)
    assert.equal(Object.keys(parsed.sessions).length, 1, 'HOME still has exactly one session')
    assert.ok(parsed.sessions.homeS, 'homeS still present')
    assert.equal(parsed.sessions[projectSid], undefined, 'project session must NOT be in HOME file')
  })

  // ─── T10: working_set_updated event emitted on update ────────────────
  // Note: runWorkingSetPut internally constructs a fresh tracker per call,
  // so a subscriber on an external tracker never sees its event. To assert
  // the event shape end-to-end, we drive the local tracker directly with
  // the same patch the helper would apply, then verify the event.
  test('T10: PersistedWorkingSetTracker emits working_set_updated on update', async () => {
    const tracker = new PersistedWorkingSetTracker_2(cwd)
    await tracker.load()
    const events: any[] = []
    const unsubscribe = tracker.subscribe((event) => {
      events.push(event)
    })

    const sessionId = `t10-${randomUUID()}`
    const entries = [
      { key: 'evt:k', value: 'evt:v', updatedAt: 't', confidence: 0.8 },
    ]
    tracker.update(sessionId, { workspaceId: 'ws-evt', entries })

    unsubscribe()

    // Exactly one working_set_updated event for our session
    const matching = events.filter(
      (e) => e.type === 'working_set_updated' && e.sessionId === sessionId,
    )
    assert.equal(matching.length, 1, `expected exactly 1 event, got ${matching.length}`)
    assert.equal(matching[0]!.workspaceId, 'ws-evt')
    assert.equal(matching[0]!.ws.entries.length, 1)
    assert.equal(matching[0]!.ws.entries[0].key, 'evt:k')
    assert.equal(matching[0]!.ws.entries[0].value, 'evt:v')
  })

  // ─── T11: persisted file reflects the PUT (write-through) ───────────
  test('T11: PUT writes through to working-set.json with submitted key + value', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    const sessionId = `t11-${randomUUID()}`
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/context/working-set/${sessionId}?cwd=${encodeURIComponent(cwd)}`,
        payload: {
          workspaceId: 'ws-11',
          entries: [
            { key: 'task:write-through', value: 'persisted-value', updatedAt: '2026-06-17T01:00:00.000Z', confidence: 0.85 },
          ],
        },
      })
      assert.equal(res.statusCode, 200)
    } finally {
      await app.close()
    }

    const persisted = readPersisted()
    assert.ok(persisted.sessions[sessionId], 'session must be persisted')
    const entry = persisted.sessions[sessionId].entries[0]
    assert.equal(entry.key, 'task:write-through')
    assert.equal(entry.value, 'persisted-value')
  })

  // ─── T12: workspaceId is preserved when omitted on subsequent PUT ────
  test('T12: workspaceId is preserved when omitted on the second PUT', async () => {
    const sessionId = `t12-${randomUUID()}`

    // First PUT establishes workspaceId 'ws-a'
    const first = await runWorkingSetPut({
      cwd,
      sessionId,
      workspaceId: 'ws-a',
      entries: [{ key: 'k:first', value: 'v:first', updatedAt: 't', confidence: 0.6 }],
    })
    assert.equal(first.workspaceId, 'ws-a')

    // Second PUT omits workspaceId but supplies new entries
    const second = await runWorkingSetPut({
      cwd,
      sessionId,
      entries: [{ key: 'k:second', value: 'v:second', updatedAt: 't', confidence: 0.7 }],
    })
    assert.equal(second.workspaceId, 'ws-a', 'workspaceId from first PUT must be preserved')
    assert.equal(second.entries.length, 1)
    assert.equal(second.entries[0]!.key, 'k:second')
  })
})
