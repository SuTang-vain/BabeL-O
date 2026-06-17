// test/context-workspace-working-set-rest.test.ts
//
// PR-20 unit tests: GET /v1/context/working-set/workspace/:wsId REST endpoint.
// Covers: runWorkspaceWorkingSetGet pure function, end-to-end via Fastify,
// validation errors, HOME isolation, multi-session aggregation.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  runWorkspaceWorkingSetGet,
} from '../src/nexus/app.js'
import { createNexusApp } from '../src/nexus/app.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-20 runWorkspaceWorkingSetGet', () => {
  let home: string
  let cwd: string
  const workspaceA = `ws-a-${randomUUID()}`
  const workspaceB = `ws-b-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr20-home-'))
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

  function seedWorkspace(sessions: Array<{ sid: string; ws: string; items: any[]; version?: number }>): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    const sessionsMap: Record<string, any> = {}
    for (const s of sessions) {
      sessionsMap[s.sid] = {
        sessionId: s.sid,
        workspaceId: s.ws,
        entries: s.items,
        version: s.version ?? 1,
        updatedAt: '2026-06-16T00:00:00.000Z',
      }
    }
    writeFileSync(
      join(dir, 'working-set.json'),
      JSON.stringify({ schemaVersion: '2026-06-16.working-set.v1', sessions: sessionsMap }, null, 2),
      'utf8',
    )
  }

  // Test 1: empty cwd
  test('empty cwd: no sessions, empty aggregateEntries', async () => {
    const result = await runWorkspaceWorkingSetGet({ cwd, workspaceId: workspaceA })
    assert.equal(result.type, 'workspace_working_set')
    assert.equal(result.workspaceId, workspaceA)
    assert.equal(result.sessions.length, 0)
    assert.equal(result.aggregateEntries.length, 0)
  })

  // Test 2: single session matching
  test('single session matching workspace: returns 1 session', async () => {
    seedWorkspace([{ sid: 's1', ws: workspaceA, items: [{ key: 'k1', value: 'v1', updatedAt: 't', confidence: 0.9 }] }])
    const result = await runWorkspaceWorkingSetGet({ cwd, workspaceId: workspaceA })
    assert.equal(result.sessions.length, 1)
    assert.equal(result.sessions[0]!.sessionId, 's1')
  })

  // Test 3: multi-session same workspace
  test('multi-session same workspace: returns all matching sessions', async () => {
    seedWorkspace([
      { sid: 's1', ws: workspaceA, items: [{ key: 'a', value: 'A', updatedAt: 't', confidence: 0.9 }] },
      { sid: 's2', ws: workspaceA, items: [{ key: 'b', value: 'B', updatedAt: 't', confidence: 0.7 }] },
      { sid: 's3', ws: workspaceB, items: [{ key: 'c', value: 'C', updatedAt: 't', confidence: 0.5 }] },
    ])
    const result = await runWorkspaceWorkingSetGet({ cwd, workspaceId: workspaceA })
    assert.equal(result.sessions.length, 2)
    const sids = result.sessions.map(s => s.sessionId).sort()
    assert.deepEqual(sids, ['s1', 's2'])
  })

  // Test 4: different workspace filtered out
  test('different workspace: filtered out', async () => {
    seedWorkspace([
      { sid: 's1', ws: workspaceA, items: [] },
      { sid: 's2', ws: workspaceB, items: [] },
    ])
    const result = await runWorkspaceWorkingSetGet({ cwd, workspaceId: workspaceB })
    assert.equal(result.sessions.length, 1)
    assert.equal(result.sessions[0]!.sessionId, 's2')
  })

  // Test 5: aggregateEntries by key
  test('aggregateEntries: groups by key with contributors from each session', async () => {
    seedWorkspace([
      { sid: 's1', ws: workspaceA, items: [
        { key: 'shared:file', value: '/p/file.ts', updatedAt: 't1', confidence: 0.9 },
        { key: 'task:only-s1', value: 'task1', updatedAt: 't1', confidence: 0.95 },
      ] },
      { sid: 's2', ws: workspaceA, items: [
        { key: 'shared:file', value: '/p/file.ts', updatedAt: 't2', confidence: 0.85 },
      ] },
    ])
    const result = await runWorkspaceWorkingSetGet({ cwd, workspaceId: workspaceA })
    assert.equal(result.aggregateEntries.length, 2)
    const sharedFile = result.aggregateEntries.find(a => a.key === 'shared:file')!
    assert.equal(sharedFile.contributors.length, 2, 'shared:file has 2 contributors')
    const contributorSids = sharedFile.contributors.map(c => c.sessionId).sort()
    assert.deepEqual(contributorSids, ['s1', 's2'])
  })

  // Test 6: HOME isolation
  test('HOME isolation: HOME working-set.json not read', async () => {
    writeFileSync(join(home, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { homeS: { sessionId: 'homeS', workspaceId: workspaceA, entries: [], version: 1, updatedAt: 't' } },
    }), 'utf8')
    const result = await runWorkspaceWorkingSetGet({ cwd, workspaceId: workspaceA })
    assert.equal(result.sessions.length, 0, 'HOME session not picked up')
  })

  // Test 7: unknown workspaceId returns empty (not error)
  test('unknown workspaceId: returns empty sessions (not 404)', async () => {
    seedWorkspace([{ sid: 's1', ws: workspaceA, items: [] }])
    const result = await runWorkspaceWorkingSetGet({ cwd, workspaceId: 'no-such-workspace' })
    assert.equal(result.sessions.length, 0)
    assert.equal(result.aggregateEntries.length, 0)
  })

  // Test 8: aggregateEntries sorted by key (stable order)
  test('aggregateEntries: stable order (sorted by key)', async () => {
    seedWorkspace([{ sid: 's1', ws: workspaceA, items: [
      { key: 'zebra', value: 'z', updatedAt: 't', confidence: 0.5 },
      { key: 'alpha', value: 'a', updatedAt: 't', confidence: 0.5 },
      { key: 'mike', value: 'm', updatedAt: 't', confidence: 0.5 },
    ] }])
    const result = await runWorkspaceWorkingSetGet({ cwd, workspaceId: workspaceA })
    assert.deepEqual(result.aggregateEntries.map(a => a.key), ['alpha', 'mike', 'zebra'])
  })
})

describe('PR-20 GET /v1/context/working-set/workspace/:wsId (e2e)', () => {
  let home: string
  let cwd: string
  const workspaceId = `ws-e2e-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr20-e2e-home-'))
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

  function seed(): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: {
        s_a1: { sessionId: 's_a1', workspaceId, entries: [
          { key: 'task:shared', value: 'aggregate this', updatedAt: 't1', confidence: 0.9 },
        ], version: 2, updatedAt: 't1' },
        s_a2: { sessionId: 's_a2', workspaceId, entries: [
          { key: 'task:shared', value: 'aggregate this', updatedAt: 't2', confidence: 0.85 },
          { key: 'task:only-s2', value: 's2-specific', updatedAt: 't2', confidence: 0.7 },
        ], version: 1, updatedAt: 't2' },
        s_b1: { sessionId: 's_b1', workspaceId: 'other-ws', entries: [
          { key: 'task:other', value: 'not aggregated', updatedAt: 't3', confidence: 0.5 },
        ], version: 1, updatedAt: 't3' },
      },
    }, null, 2), 'utf8')
  }

  // Test 9: end-to-end via Fastify
  test('GET /v1/context/working-set/workspace/:wsId returns aggregated sessions + entries', async () => {
    seed()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/context/working-set/workspace/${encodeURIComponent(workspaceId)}?cwd=${encodeURIComponent(cwd)}`,
      })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.type, 'workspace_working_set')
      assert.equal(body.workspaceId, workspaceId)
      assert.equal(body.sessions.length, 2, 's_a1 + s_a2 only (s_b1 filtered)')
      // Verify aggregation
      const shared = body.aggregateEntries.find((a: any) => a.key === 'task:shared')!
      assert.equal(shared.contributors.length, 2)
      const onlyS2 = body.aggregateEntries.find((a: any) => a.key === 'task:only-s2')!
      assert.equal(onlyS2.contributors.length, 1)
      // s_b1's "task:other" should NOT be present
      const other = body.aggregateEntries.find((a: any) => a.key === 'task:other')
      assert.equal(other, undefined)
    } finally {
      await app.close()
    }
  })

  // Test 10: missing cwd → 400
  test('GET /v1/context/working-set/workspace/:wsId returns 400 when cwd missing', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/context/working-set/workspace/${encodeURIComponent(workspaceId)}`,
      })
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body)
      assert.ok(body.error.includes('cwd'))
    } finally {
      await app.close()
    }
  })

  // Test 11: unknown workspaceId returns empty (200, not 404)
  test('GET /v1/context/working-set/workspace/:wsId unknown → 200 with empty sessions', async () => {
    seed()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/context/working-set/workspace/no-such-ws?cwd=${encodeURIComponent(cwd)}`,
      })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.sessions.length, 0)
      assert.equal(body.aggregateEntries.length, 0)
    } finally {
      await app.close()
    }
  })
})
