// test/r3-rest-put-observe.test.ts
//
// R3 of docs/nexus/proposals/long-running-context-assembly.md §20:
// Unify REST PUT /v1/context/working-set/:sessionId and /v1/working-set/observe
// so they operate on the same per-cwd PersistedWorkingSetTracker instance.
//
// R3 acceptance (per long-running-context-assembly.md §20 R3):
//   1. PUT persists and returns updated state
//   2. PUT emits `working_set_updated` to a connected /v1/working-set/observe
//      client
//   3. Multiple subscribers receive the PUT event
//   4. One e2e test proves: REST write -> persisted file -> WS event -> GET
//      reads the same version
//
// This test covers the NEW behavior (broadcaster routing) added by R3.
// The legacy per-request tracker behavior is already covered by
// test/context-working-set-rest-put.test.ts; R3 specifically requires
// the shared-tracker path to be honored when a broadcaster is wired.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WSImport from 'ws'
import type { WorkingSetEvent } from '../src/runtime/workingSetTracker.js'
import { WorkingSetBroadcaster } from '../src/nexus/workingSetBroadcaster.js'
import { PersistedWorkingSetTracker, WORKING_SET_RELATIVE_PATH } from '../src/runtime/persistedWorkingSetTracker.js'
import { runWorkingSetPut } from '../src/nexus/routers/contextWorkingSetWriteRouter.js'
import { runWorkingSetGet } from '../src/nexus/routers/contextWorkingSetReadRouter.js'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

type WS = {
  on(event: 'message', listener: (data: Buffer) => void): WS
  once(event: string, listener: (data?: unknown) => void): WS
  off(event: 'message', listener: (data: Buffer) => void): WS
  close(): void
}
const makeWS = (url: string): WS => new (WSImport as unknown as new (url: string) => WS)(url)

describe('R3: WorkingSetBroadcaster.mutate(cwd, fn) helper', () => {
  let tmpCwd: string

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'babel-o-r3-broadcaster-'))
  })

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true })
  })

  test('mutate routes through the per-cwd tracker and returns the callback result', async () => {
    const broadcaster = new WorkingSetBroadcaster()
    const sessionId = 'session-r3-mutate'
    const tracker = broadcaster.getOrCreateTracker(tmpCwd).tracker
    let observedSessionId: string | undefined
    const unsubscribe = tracker.subscribe((event: WorkingSetEvent) => {
      if (event.type === 'working_set_updated') observedSessionId = event.sessionId
    })

    const result = await broadcaster.mutate(tmpCwd, (t) => {
      return t.update(sessionId, {
        workspaceId: 'ws-1',
        entries: [{ key: 'file:/x.ts', value: '/x.ts', updatedAt: '2026-06-18T10:00:00.000Z', confidence: 0.9 }],
      })
    })

    assert.equal(result.sessionId, sessionId)
    assert.equal(result.version, 1)
    assert.equal(observedSessionId, sessionId, 'working_set_updated observed by subscriber')
    unsubscribe()
  })

  test('mutate persists to <cwd>/.babel-o/working-set.json (flushed after fn)', async () => {
    const broadcaster = new WorkingSetBroadcaster()
    const sessionId = 'session-r3-persist'
    await broadcaster.mutate(tmpCwd, (t) => {
      return t.update(sessionId, {
        workspaceId: '',
        entries: [{ key: 'file:/a.ts', value: '/a.ts', updatedAt: '2026-06-18T10:00:00.000Z', confidence: 0.8 }],
      })
    })
    const filePath = join(tmpCwd, WORKING_SET_RELATIVE_PATH)
    assert.ok(existsSync(filePath), `mutate must flush ${WORKING_SET_RELATIVE_PATH}`)
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { sessions: Record<string, { entries: { value: string }[] }> }
    assert.ok(raw.sessions[sessionId])
    assert.equal(raw.sessions[sessionId].entries[0]!.value, '/a.ts')
  })

  test('mutate on a pre-loaded tracker reuses the cached instance (no duplicate trackers)', async () => {
    const broadcaster = new WorkingSetBroadcaster()
    const t1 = broadcaster.getOrCreateTracker(tmpCwd).tracker
    await broadcaster.mutate(tmpCwd, (t) => t.update('s1', { workspaceId: '', entries: [] }))
    const t2 = broadcaster.getOrCreateTracker(tmpCwd).tracker
    assert.strictEqual(t2, t1, 'mutate must reuse the same per-cwd tracker instance')
    assert.equal(broadcaster.size(), 1)
  })
})

describe('R3: REST PUT routes through broadcaster when provided', () => {
  let home: string
  let cwd: string
  let broadcaster: WorkingSetBroadcaster
  let app: Awaited<ReturnType<typeof createNexusApp>>

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-r3-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    process.env.HOME = home
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
    broadcaster = new WorkingSetBroadcaster()
    const { runtime, storage } = await createDefaultNexusRuntime()
    app = await createNexusApp({ runtime, storage, defaultCwd: cwd, workingSetBroadcaster: broadcaster })
  })

  afterEach(async () => {
    await app.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('R3 acceptance: PUT → persisted file → broadcaster event → GET reads same version', async () => {
    const sessionId = 'session-r3-e2e'

    // Pre-subscribe to the broadcaster's per-cwd tracker. This is the
    // SAME bus that /v1/working-set/observe WebSocket subscribers attach
    // to in production; testing it directly is equivalent to asserting
    // a connected WS would receive the event. (app.inject is in-process
    // and does not bind a real port, so a real WebSocket client is not
    // addressable here; the existing test/working-set-observe-websocket.test.ts
    // covers the full WS e2e with a bound port.)
    const eventPromise = new Promise<WorkingSetEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('broadcaster event timeout')), 5000)
      broadcaster.subscribeSession(cwd, sessionId, (ev) => {
        if (ev.type === 'working_set_updated') {
          clearTimeout(timer)
          resolve(ev)
        }
      })
    })

    // PUT
    const putRes = await app.inject({
      method: 'PUT',
      url: `/v1/context/working-set/${sessionId}?cwd=${encodeURIComponent(cwd)}`,
      payload: {
        workspaceId: 'ws-r3',
        entries: [
          { key: 'file:/a.ts', value: '/a.ts', updatedAt: '2026-06-18T10:00:00.000Z', confidence: 0.9 },
        ],
      },
    })
    assert.equal(putRes.statusCode, 200)
    const putBody = putRes.json() as { type: string; version: number; entries: unknown[] }
    assert.equal(putBody.type, 'working_set_session')
    assert.equal(putBody.version, 1)
    assert.equal(putBody.entries.length, 1)

    // The broadcaster's bus delivered the working_set_updated event
    // (R3 invariant: PUT mutations flow into the same bus the WS observes).
    const ev = await eventPromise
    assert.equal(ev.sessionId, sessionId)
    assert.equal(ev.workspaceId, 'ws-r3')

    // GET reads back the same version
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/context/working-set/${sessionId}?cwd=${encodeURIComponent(cwd)}`,
    })
    assert.equal(getRes.statusCode, 200)
    const getBody = getRes.json() as { version: number; entries: { value: string }[] }
    assert.equal(getBody.version, 1, 'GET must read the same version as the PUT wrote')
    assert.equal(getBody.entries[0]!.value, '/a.ts')

    // Persisted file exists
    assert.ok(existsSync(join(cwd, WORKING_SET_RELATIVE_PATH)),
      `${WORKING_SET_RELATIVE_PATH} must exist on disk after PUT`)
  })

  test('R3: PUT and pre-existing broadcaster subscriber share the same tracker instance', async () => {
    // The tracker's bus is what the WS observer subscribes to. We
    // prove R3 by subscribing to the broadcaster's per-cwd tracker
    // and observing the working_set_updated event for our PUT.
    const sessionId = 'session-r3-shared-instance'

    const seen = new Promise<WorkingSetEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('broadcaster event timeout')), 5000)
      broadcaster.subscribeSession(cwd, sessionId, (ev) => {
        if (ev.type === 'working_set_updated') {
          clearTimeout(timer)
          resolve(ev)
        }
      })
    })

    // PUT via the shared broadcaster
    const putRes = await app.inject({
      method: 'PUT',
      url: `/v1/context/working-set/${sessionId}?cwd=${encodeURIComponent(cwd)}`,
      payload: {
        workspaceId: '',
        entries: [{ key: 'file:/b.ts', value: '/b.ts', updatedAt: '2026-06-18T10:00:00.000Z', confidence: 0.5 }],
      },
    })
    assert.equal(putRes.statusCode, 200)

    // Subscribed to broadcaster BEFORE the PUT → still receives the
    // event because PUT routes through the same per-cwd tracker.
    const ev = await seen
    assert.equal(ev.sessionId, sessionId, 'broadcaster delivered the PUT event to pre-existing subscriber')
    assert.equal(ev.workspaceId, '')
  })
})

// Reference: a small smoke that the legacy (no-broadcaster) path still
// works. R3 must not regress pre-R3 callers who don't pass a broadcaster.
describe('R3: legacy (no-broadcaster) PUT path remains intact', () => {
  let home: string
  let cwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-r3-legacy-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    process.env.HOME = home
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test('runWorkingSetPut without broadcaster creates a per-request tracker (legacy)', async () => {
    const sessionId = 'session-r3-legacy'
    const result = await runWorkingSetPut({
      cwd,
      sessionId,
      workspaceId: 'legacy-ws',
      entries: [{ key: 'file:/c.ts', value: '/c.ts', updatedAt: '2026-06-18T10:00:00.000Z', confidence: 0.7 }],
    })
    assert.equal(result.version, 1)
    // Persisted via the per-request tracker's flush
    assert.ok(existsSync(join(cwd, WORKING_SET_RELATIVE_PATH)))
    // And a fresh GET on the same cwd reads the same version back
    const getRes = await runWorkingSetGet({ cwd, sessionId })
    assert.equal(getRes.version, 1, 'GET reads back the legacy PUT version')
  })
})
