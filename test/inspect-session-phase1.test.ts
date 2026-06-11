import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'

/**
 * Phase 1 of `docs/nexus/reference/go-tui-session-observability-governance-plan.md`:
 * `POST /v1/sessions` end-to-end tests. The endpoint allocates a
 * server-side `session_<uuid>` and optionally records
 * `clientSessionId` + metadata for cross-reference.
 *
 * Hard invariants (per memory `babel-o-test-config-isolation.md`):
 *  - Test isolation: every test uses `mkdtempSync` + a per-test
 *    storage path; the real `~/.babel-o/config.json` is never touched.
 *  - Pure side-effect scope: each test creates its own
 *    `LocalCodingRuntime` + `MemoryStorage`-like fallback (we use
 *    sqlite with a temp db file, then close the app).
 */

function withTempNexus<T>(fn: (ctx: { app: Awaited<ReturnType<typeof createNexusApp>>; storage: any; cwd: string; storagePath: string }) => Promise<T>): Promise<T> {
  const prevConfigFile = process.env.BABEL_O_CONFIG_FILE
  const prevConfigDir = process.env.BABEL_O_CONFIG_DIR
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-o-phase1-'))
  const storagePath = join(tempDir, 'db.sqlite')
  process.env.BABEL_O_CONFIG_DIR = tempDir
  delete process.env.BABEL_O_CONFIG_FILE
  return (async () => {
    const cwd = join(tempDir, 'workspace')
    const { runtime, storage } = await createDefaultNexusRuntime({ storagePath, cwd })
    const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
    try {
      return await fn({ app, storage, cwd, storagePath })
    } finally {
      try { await app.close() } catch { /* ignore */ }
      if (prevConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
      else process.env.BABEL_O_CONFIG_FILE = prevConfigFile
      if (prevConfigDir === undefined) delete process.env.BABEL_O_CONFIG_DIR
      else process.env.BABEL_O_CONFIG_DIR = prevConfigDir
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })()
}

test('POST /v1/sessions allocates a server-uuid and records it in SQLite', async () => {
  await withTempNexus(async ({ app, storage, cwd }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: {
        cwd,
        clientSessionId: 'session_go_1781146359507755000',
        metadata: { client: 'go-tui', phase: 'session_allocate' },
      },
    })
    assert.equal(res.statusCode, 201)
    const body = res.json()
    assert.equal(body.type, 'session_created')
    assert.match(body.sessionId, /^session_[0-9a-f-]+/)
    assert.equal(body.clientSessionId, 'session_go_1781146359507755000')
    assert.match(body.createdAt, /^\d{4}-\d{2}-\d{2}T/)

    // The session must be in storage with the right metadata.
    const stored = await storage.getSession(body.sessionId, { includeEvents: false })
    assert.ok(stored, 'session should be persisted in SQLite after allocation')
    assert.equal(stored.sessionId, body.sessionId)
    assert.equal(stored.cwd, cwd)
    assert.equal(stored.phase, 'created')
    assert.equal(stored.metadata?.clientSessionId, 'session_go_1781146359507755000')
    assert.equal(stored.metadata?.client, 'go-tui')
  })
})

test('POST /v1/sessions falls back to defaultCwd when cwd is omitted', async () => {
  await withTempNexus(async ({ app, storage, cwd }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: {},
    })
    assert.equal(res.statusCode, 201)
    const body = res.json()
    const stored = await storage.getSession(body.sessionId, { includeEvents: false })
    assert.ok(stored)
    assert.equal(stored.cwd, cwd, 'omitted cwd should fall back to defaultCwd')
  })
})

test('POST /v1/sessions is round-trippable via GET /v1/sessions list', async () => {
  // The whole point of Phase 1: after allocation, the session is
  // findable through the same `GET /v1/sessions` listing that
  // `bbl sessions list` uses, with the canonical server-uuid.
  await withTempNexus(async ({ app, storage }) => {
    const r1 = await app.inject({ method: 'POST', url: '/v1/sessions', payload: { clientSessionId: 'session_go_a' } })
    const r2 = await app.inject({ method: 'POST', url: '/v1/sessions', payload: { clientSessionId: 'session_go_b' } })
    assert.equal(r1.statusCode, 201)
    assert.equal(r2.statusCode, 201)
    const id1 = r1.json().sessionId
    const id2 = r2.json().sessionId
    assert.notEqual(id1, id2, 'two POST calls should yield distinct uuids')

    const list = await app.inject({ method: 'GET', url: '/v1/sessions?limit=10' })
    assert.equal(list.statusCode, 200)
    const listBody = list.json()
    const ids = (listBody.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId)
    assert.ok(ids.includes(id1), 'list should include id1')
    assert.ok(ids.includes(id2), 'list should include id2')
  })
})

test('POST /v1/sessions stores clientSessionIdSetAt timestamp alongside clientSessionId', async () => {
  await withTempNexus(async ({ app, storage }) => {
    const before = Date.now()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { clientSessionId: 'session_go_x' },
    })
    const after = Date.now()
    assert.equal(res.statusCode, 201)
    const stored = await storage.getSession(res.json().sessionId, { includeEvents: false })
    assert.ok(stored)
    const setAt = stored.metadata?.clientSessionIdSetAt
    assert.ok(typeof setAt === 'string')
    const ts = Date.parse(setAt as string)
    assert.ok(ts >= before && ts <= after, `clientSessionIdSetAt=${setAt} should be in [${before}, ${after}]`)
  })
})

test('POST /v1/sessions with only metadata (no clientSessionId) is allowed', async () => {
  await withTempNexus(async ({ app, storage }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { metadata: { source: 'unit-test', ticket: 'phase1' } },
    })
    assert.equal(res.statusCode, 201)
    const stored = await storage.getSession(res.json().sessionId, { includeEvents: false })
    assert.ok(stored)
    assert.equal(stored.metadata?.source, 'unit-test')
    assert.equal(stored.metadata?.ticket, 'phase1')
    assert.equal(stored.metadata?.clientSessionId, undefined)
  })
})
