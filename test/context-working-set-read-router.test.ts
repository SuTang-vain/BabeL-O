import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { createNexusApp } from '../src/nexus/app.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('ContextWorkingSetReadRouter', () => {
  let home: string
  let cwd: string
  let sessionId: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-working-set-read-router-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    sessionId = `ws-read-router-${randomUUID()}`
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

  function seedWorkingSet(): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'working-set.json'),
      JSON.stringify({
        schemaVersion: '2026-06-16.working-set.v1',
        sessions: {
          [sessionId]: {
            sessionId,
            workspaceId: 'ws-read-router',
            entries: [{
              key: 'task:router',
              value: 'prove read router wiring',
              updatedAt: '2026-06-18T00:00:00.000Z',
              confidence: 0.9,
            }],
            version: 2,
            updatedAt: '2026-06-18T00:00:00.000Z',
          },
        },
      }, null, 2),
      'utf8',
    )
  }

  test('GET /v1/context/working-set returns persisted sessions', async () => {
    seedWorkingSet()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/context/working-set?cwd=${encodeURIComponent(cwd)}`,
      })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.type, 'working_set_list')
      assert.equal(body.sessions.length, 1)
      assert.equal(body.sessions[0].sessionId, sessionId)
    } finally {
      await app.close()
    }
  })

  test('GET /v1/context/working-set/:sessionId returns one persisted session', async () => {
    seedWorkingSet()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/context/working-set/${encodeURIComponent(sessionId)}?cwd=${encodeURIComponent(cwd)}`,
      })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.type, 'working_set_session')
      assert.equal(body.sessionId, sessionId)
      assert.equal(body.entries[0].key, 'task:router')
    } finally {
      await app.close()
    }
  })

  test('GET /v1/context/working-set requires cwd', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/context/working-set',
      })
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body)
      assert.ok(body.error.includes('cwd'))
    } finally {
      await app.close()
    }
  })
})
