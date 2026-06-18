import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { isGoTuiClientSessionId, goTuiClientSessionPersistenceHint } from '../src/shared/session.js'

/**
 * Phase 3 / §3 goal 5 of
 * `docs/nexus/proposals/go-tui-session-observability-governance-plan.md`:
 * `GET /v1/sessions/:sessionId` must return a redacted persistence
 * hint (not a bare `SESSION_NOT_FOUND`) when the operator queries a
 * Go TUI client placeholder `session_go_<unixnano>` directly.
 *
 * This is the exact failure mode of the real sample
 * `session_go_1781146359507755000`: the server persists under a
 * canonical `session_<uuid>` and carries the placeholder only as
 * `metadata.clientSessionId`. A bare 404 gave the operator no way
 * to know the id was a placeholder rather than a typo.
 */

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof createNexusApp>>) => Promise<T>): Promise<T> {
  const cwd = join(tmpdir(), `babel-o-placeholder-hint-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    return await fn(app)
  } finally {
    await app.close()
  }
}

test('isGoTuiClientSessionId: matches session_go_<unixnano> placeholders', () => {
  assert.equal(isGoTuiClientSessionId('session_go_1781146359507755000'), true)
  assert.equal(isGoTuiClientSessionId('session_go_1781708347923161088'), true)
  // Too short / non-digit tail → not a placeholder.
  assert.equal(isGoTuiClientSessionId('session_go_123'), false)
  assert.equal(isGoTuiClientSessionId('session_go_short'), false)
  // Canonical server uuids are NOT placeholders.
  assert.equal(isGoTuiClientSessionId('session_328733b8-05bb-4bd5-af08-56f136cedaf6'), false)
  assert.equal(isGoTuiClientSessionId('session_abc'), false)
  assert.equal(isGoTuiClientSessionId(''), false)
})

test('goTuiClientSessionPersistenceHint: redacted, names the placeholder + reverse-resolve paths', () => {
  const hint = goTuiClientSessionPersistenceHint('session_go_1781146359507755000')
  // Names the placeholder id verbatim so the operator can correlate.
  assert.match(hint, /session_go_1781146359507755000/)
  // Explains the root cause (embedded Nexus memory storage).
  assert.match(hint, /memory storage/i)
  // Points at the two reverse-resolve paths.
  assert.match(hint, /bbl inspect-session/)
  // Does NOT leak storage paths or other session ids (redacted).
  assert.doesNotMatch(hint, /db\.sqlite/)
  assert.doesNotMatch(hint, /\.babel-o/)
})

test('GET /v1/sessions/<placeholder> returns 404 with go_tui_client_placeholder subtype + hint', async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sessions/session_go_1781146359507755000',
    })
    assert.equal(response.statusCode, 404)
    const body = response.json()
    assert.equal(body.code, 'SESSION_NOT_FOUND')
    assert.equal(body.subtype, 'go_tui_client_placeholder')
    assert.equal(body.sessionId, 'session_go_1781146359507755000')
    assert.match(body.hint, /session_go_1781146359507755000/)
    assert.match(body.hint, /bbl inspect-session/)
    assert.match(body.message, /session_go_1781146359507755000/)
  })
})

test('GET /v1/sessions/<unknown uuid> still returns bare SESSION_NOT_FOUND (no hint regression)', async () => {
  // A canonical-looking but absent server uuid must NOT get the
  // placeholder hint — it's just a normal miss (typo or expired).
  await withApp(async (app) => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sessions/session_328733b8-05bb-4bd5-af08-56f136cedaf6',
    })
    assert.equal(response.statusCode, 404)
    const body = response.json()
    assert.equal(body.code, 'SESSION_NOT_FOUND')
    assert.equal(body.subtype, undefined)
    assert.equal(body.hint, undefined)
    assert.match(body.message, /Session not found/)
  })
})

test('GET /v1/sessions/<real session> returns 200 (hint path only fires on miss)', async () => {
  await withApp(async (app) => {
    // Allocate a real session via POST /v1/sessions.
    const create = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { cwd: '/tmp', clientSessionId: 'session_go_1781146359507755000' },
    })
    assert.equal(create.statusCode, 201)
    const serverId = create.json().sessionId as string
    // The real server uuid resolves.
    const fetch = await app.inject({ method: 'GET', url: `/v1/sessions/${serverId}` })
    assert.equal(fetch.statusCode, 200)
    assert.equal(fetch.json().session.sessionId, serverId)
    // The placeholder still 404s with the hint (it's metadata, not a row key).
    const placeholderFetch = await app.inject({
      method: 'GET',
      url: '/v1/sessions/session_go_1781146359507755000',
    })
    assert.equal(placeholderFetch.statusCode, 404)
    assert.equal(placeholderFetch.json().subtype, 'go_tui_client_placeholder')
  })
})
