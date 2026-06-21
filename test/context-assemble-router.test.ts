import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { createNexusApp } from '../src/nexus/app.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('ContextAssembleRouter', () => {
  let home: string
  let cwd: string
  let sessionId: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-context-assemble-router-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    sessionId = `assemble-router-${randomUUID()}`
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
            workspaceId: cwd,
            entries: [{
              key: 'task:assemble-router',
              value: 'prove assemble router wiring',
              updatedAt: '2026-06-18T00:00:00.000Z',
              confidence: 0.9,
            }],
            version: 1,
            updatedAt: '2026-06-18T00:00:00.000Z',
          },
        },
      }, null, 2),
      'utf8',
    )
  }

  test('POST /v1/context/assemble returns a preview envelope', async () => {
    seedWorkingSet()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/context/assemble',
        payload: { cwd, sessionId, scope: 'minimal', maxTokens: 7500 },
      })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.type, 'context_assemble_result')
      assert.equal(body.cwd, cwd)
      assert.equal(body.preview.scope, 'minimal')
      assert.equal(body.preview.sections[0].kind, 'workingSet')
    } finally {
      await app.close()
    }
  })

  test('POST /v1/context/assemble rejects invalid scope', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/context/assemble',
        payload: { cwd, scope: 'invalid_scope' },
      })
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body)
      assert.ok(body.error.includes('Invalid scope'))
    } finally {
      await app.close()
    }
  })
})
