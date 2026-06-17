// test/context-working-set-rest.test.ts
//
// PR-12 unit tests: /v1/context/working-set REST endpoints.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  runWorkingSetList,
  runWorkingSetGet,
} from '../src/nexus/app.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-12 runWorkingSetList', () => {
  let home: string
  let cwd: string
  const sessionId = `rest-ws-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-rest-ws-home-'))
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

  function seedWorkingSet(entries: Array<{ sid: string; workspaceId?: string; items: any[] }>): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    const sessions: Record<string, any> = {}
    for (const e of entries) {
      sessions[e.sid] = {
        sessionId: e.sid,
        workspaceId: e.workspaceId ?? cwd,
        entries: e.items,
        version: 1,
        updatedAt: '2026-06-16T00:00:00.000Z',
      }
    }
    writeFileSync(
      join(dir, 'working-set.json'),
      JSON.stringify({ schemaVersion: '2026-06-16.working-set.v1', sessions }, null, 2),
      'utf8',
    )
  }

  test('no file: returns empty array', async () => {
    const result = await runWorkingSetList({ cwd })
    assert.equal(result.type, 'working_set_list')
    assert.equal(result.cwd, cwd)
    assert.deepEqual(result.sessions, [])
  })

  test('one session: returns it', async () => {
    seedWorkingSet([{
      sid: sessionId,
      items: [{ key: 'task:x', value: 'do X', updatedAt: '2026-06-16T00:00:00.000Z', confidence: 0.9 }],
    }])
    const result = await runWorkingSetList({ cwd })
    assert.equal(result.sessions.length, 1)
    assert.equal(result.sessions[0]!.sessionId, sessionId)
    assert.equal(result.sessions[0]!.entries.length, 1)
    assert.equal(result.sessions[0]!.entries[0]!.key, 'task:x')
  })

  test('multiple sessions: returns all', async () => {
    seedWorkingSet([
      { sid: 's1', items: [] },
      { sid: 's2', items: [] },
      { sid: 's3', items: [] },
    ])
    const result = await runWorkingSetList({ cwd })
    assert.equal(result.sessions.length, 3)
    const sids = result.sessions.map(s => s.sessionId).sort()
    assert.deepEqual(sids, ['s1', 's2', 's3'])
  })

  test('HOME isolation: HOME working-set.json not read', async () => {
    writeFileSync(join(home, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { homeS: { sessionId: 'homeS', workspaceId: home, entries: [], version: 1, updatedAt: 't' } },
    }), 'utf8')
    const result = await runWorkingSetList({ cwd })
    assert.equal(result.sessions.length, 0, 'HOME file not read')
  })
})

describe('PR-12 runWorkingSetGet', () => {
  let home: string
  let cwd: string
  const sessionId = `rest-ws-get-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-rest-ws-get-home-'))
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

  function seedWorkingSet(entries: Array<{ sid: string; items: any[] }>): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    const sessions: Record<string, any> = {}
    for (const e of entries) {
      sessions[e.sid] = {
        sessionId: e.sid,
        workspaceId: cwd,
        entries: e.items,
        version: 1,
        updatedAt: '2026-06-16T00:00:00.000Z',
      }
    }
    writeFileSync(
      join(dir, 'working-set.json'),
      JSON.stringify({ schemaVersion: '2026-06-16.working-set.v1', sessions }, null, 2),
      'utf8',
    )
  }

  test('existing session: returns its data', async () => {
    seedWorkingSet([{
      sid: sessionId,
      items: [
        { key: 'task:investigate', value: 'review', updatedAt: 't', confidence: 0.95 },
        { key: 'file:src/main.ts', value: '/p/main.ts', updatedAt: 't', confidence: 0.8 },
      ],
    }])
    const result = await runWorkingSetGet({ cwd, sessionId })
    assert.equal(result.type, 'working_set_session')
    assert.equal(result.sessionId, sessionId)
    assert.equal(result.entries.length, 2)
    assert.equal(result.entries[0]!.key, 'task:investigate')
  })

  test('non-existent session: throws', async () => {
    seedWorkingSet([{ sid: 's1', items: [] }])
    await assert.rejects(
      () => runWorkingSetGet({ cwd, sessionId: 'nonexistent' }),
      /session not found/,
    )
  })

  test('no file at all: throws', async () => {
    await assert.rejects(
      () => runWorkingSetGet({ cwd, sessionId: 'anything' }),
      /session not found/,
    )
  })

  test('HOME isolation: HOME working-set.json not read', async () => {
    writeFileSync(join(home, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { homeS: { sessionId: 'homeS', workspaceId: home, entries: [], version: 1, updatedAt: 't' } },
    }), 'utf8')
    await assert.rejects(
      () => runWorkingSetGet({ cwd, sessionId: 'homeS' }),
      /session not found/,
    )
  })
})
