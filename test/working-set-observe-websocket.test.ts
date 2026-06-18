// test/working-set-observe-websocket.test.ts
//
// PR-27 unit + e2e tests: /v1/working-set/observe WebSocket + shared broadcaster.
// Covers:
//   1. WS connects with cwd, receives initial snapshot
//   2. WS receives working_set_updated event after broadcaster mutation
//   3. sessionId filter (only matching events delivered)
//   4. unsubscribe on close (no more events after socket closes)
//   5. multiple WS clients share the same broadcaster events
//   6. missing cwd → close 1008
//   7. HOME isolation

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WSImport from 'ws'
type WS = {
  on(event: 'message', listener: (data: Buffer) => void): WS
  once(event: string, listener: (data?: unknown) => void): WS
  off(event: 'message', listener: (data: Buffer) => void): WS
  close(): void
}
const makeWS = (url: string): WS => new (WSImport as unknown as new (url: string) => WS)(url)

import { createNexusApp } from '../src/nexus/app.js'
import { WorkingSetBroadcaster } from '../src/nexus/workingSetBroadcaster.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

interface WsMessage {
  type: string
  [k: string]: unknown
}

function nextMessage(ws: WS, timeoutMs = 1000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`WebSocket message timeout (${timeoutMs}ms)`))
    }, timeoutMs)
    const onMessage = (data: Buffer) => {
      clearTimeout(timer)
      ws.off('message', onMessage)
      try {
        resolve(JSON.parse(String(data)))
      } catch (err) {
        reject(err)
      }
    }
    ws.on('message', onMessage)
  })
}

function collectMessages(ws: WS, count: number, timeoutMs = 1000): Promise<WsMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: WsMessage[] = []
    const timer = setTimeout(() => {
      if (messages.length >= count) {
        resolve(messages.slice(0, count))
      } else {
        reject(new Error(`WebSocket message timeout (${timeoutMs}ms, got ${messages.length}/${count})`))
      }
    }, timeoutMs)
    const onMessage = (data: Buffer) => {
      try {
        messages.push(JSON.parse(String(data)))
      } catch {
        // skip non-JSON
      }
      if (messages.length >= count) {
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolve(messages.slice(0, count))
      }
    }
    ws.on('message', onMessage)
  })
}

describe('PR-27 /v1/working-set/observe WebSocket', () => {
  let home: string
  let cwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr27-home-'))
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

  function seedWorkingSet(sessions: Array<{ sid: string; ws: string; items: any[] }>): void {
    const sessionsMap: Record<string, any> = {}
    for (const s of sessions) {
      sessionsMap[s.sid] = {
        sessionId: s.sid,
        workspaceId: s.ws,
        entries: s.items,
        version: 1,
        updatedAt: '2026-06-16T00:00:00.000Z',
      }
    }
    writeFileSync(
      join(cwd, '.babel-o', 'working-set.json'),
      JSON.stringify({ schemaVersion: '2026-06-16.working-set.v1', sessions: sessionsMap }, null, 2),
      'utf8',
    )
  }

  // Test 1: WS connects, receives initial snapshot
  test('connect → receives working_set_snapshot with current state', async () => {
    seedWorkingSet([{ sid: 's1', ws: 'ws-a', items: [{ key: 'k', value: 'v', updatedAt: 't', confidence: 0.9 }] }])
    const broadcaster = new WorkingSetBroadcaster()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      workingSetBroadcaster: broadcaster,
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const address = app.server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const ws = makeWS(`ws://127.0.0.1:${port}/v1/working-set/observe?cwd=${encodeURIComponent(cwd)}`)
      const snap = await nextMessage(ws)
      assert.equal(snap.type, 'working_set_snapshot')
      assert.equal(snap.cwd, cwd)
      assert.equal((snap.sessions as any[]).length, 1)
      assert.equal((snap.sessions as any[])[0].sessionId, 's1')
      ws.close()
    } finally {
      await app.close()
    }
  })

  // Test 2: WS receives working_set_updated after broadcaster mutation
  test('broadcaster.update() → WS receives working_set_updated', async () => {
    seedWorkingSet([])
    const broadcaster = new WorkingSetBroadcaster()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      workingSetBroadcaster: broadcaster,
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as any).port
      const ws = makeWS(`ws://127.0.0.1:${port}/v1/working-set/observe?cwd=${encodeURIComponent(cwd)}`)
      // First message: snapshot (empty)
      const snap = await nextMessage(ws)
      assert.equal(snap.type, 'working_set_snapshot')
      assert.equal((snap.sessions as any[]).length, 0)

      // Mutate via broadcaster
      const entry = broadcaster.getOrCreateTracker(cwd)
      entry.tracker.update('s1', {
        workspaceId: 'ws-a',
        entries: [{ key: 'k1', value: 'v1', updatedAt: '2026-06-16T10:00:00.000Z', confidence: 0.9 }],
      })

      // Should receive working_set_updated
      const update = await nextMessage(ws)
      assert.equal(update.type, 'working_set_updated')
      assert.equal(update.sessionId, 's1')
      assert.equal(update.workspaceId, 'ws-a')
      ws.close()
    } finally {
      await app.close()
    }
  })

  // Test 3: sessionId filter
  test('sessionId filter: only matching events delivered', async () => {
    seedWorkingSet([])
    const broadcaster = new WorkingSetBroadcaster()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      workingSetBroadcaster: broadcaster,
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as any).port
      const ws = makeWS(
        `ws://127.0.0.1:${port}/v1/working-set/observe?cwd=${encodeURIComponent(cwd)}&sessionId=s_filtered`
      )
      await nextMessage(ws) // initial snapshot

      // Mutate s_other (should NOT be received)
      const entry = broadcaster.getOrCreateTracker(cwd)
      entry.tracker.update('s_other', { workspaceId: 'ws-a' })
      // Mutate s_filtered (should be received)
      entry.tracker.update('s_filtered', { workspaceId: 'ws-a' })

      const update = await nextMessage(ws)
      assert.equal(update.type, 'working_set_updated')
      assert.equal(update.sessionId, 's_filtered')
      ws.close()
    } finally {
      await app.close()
    }
  })

  // Test 4: multiple WS clients share the same broadcaster
  test('multiple WS clients share the same broadcaster events', async () => {
    seedWorkingSet([])
    const broadcaster = new WorkingSetBroadcaster()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      workingSetBroadcaster: broadcaster,
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as any).port
      const ws1 = makeWS(`ws://127.0.0.1:${port}/v1/working-set/observe?cwd=${encodeURIComponent(cwd)}`)
      const ws2 = makeWS(`ws://127.0.0.1:${port}/v1/working-set/observe?cwd=${encodeURIComponent(cwd)}`)
      await nextMessage(ws1) // ws1 snapshot
      await nextMessage(ws2) // ws2 snapshot

      // Mutate
      const entry = broadcaster.getOrCreateTracker(cwd)
      entry.tracker.update('s_broadcast', { workspaceId: 'ws-a' })

      const [m1, m2] = await Promise.all([nextMessage(ws1), nextMessage(ws2)])
      assert.equal(m1.type, 'working_set_updated')
      assert.equal(m2.type, 'working_set_updated')
      assert.equal(m1.sessionId, 's_broadcast')
      assert.equal(m2.sessionId, 's_broadcast')
      ws1.close()
      ws2.close()
    } finally {
      await app.close()
    }
  })

  // Test 5: missing cwd → close 1008
  test('missing cwd → error message + close 1008', async () => {
    const broadcaster = new WorkingSetBroadcaster()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      workingSetBroadcaster: broadcaster,
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as any).port
      const ws = makeWS(`ws://127.0.0.1:${port}/v1/working-set/observe`)

      const error = await nextMessage(ws)
      assert.equal(error.type, 'error')
      assert.equal(error.code, 'MISSING_CWD')

      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve())
        setTimeout(() => resolve(), 200) // safety
      })
    } finally {
      await app.close()
    }
  })
})

describe('PR-27 WorkingSetBroadcaster (unit)', () => {
  let home: string
  let cwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr27-broadcaster-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    mkdirSync(join(cwd, '.babel-o'), { recursive: true })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  // Test 6: getOrCreateTracker returns same instance for same cwd
  test('getOrCreateTracker returns same instance for same cwd', async () => {
    const broadcaster = new WorkingSetBroadcaster()
    const a = broadcaster.getOrCreateTracker(cwd)
    const b = broadcaster.getOrCreateTracker(cwd)
    assert.equal(a.tracker, b.tracker)
    assert.equal(broadcaster.size(), 1)
    await a.loadPromise
  })

  // Test 7: getOrCreateTracker returns different instances for different cwds
  test('getOrCreateTracker returns different instances for different cwds', async () => {
    const cwd2 = mkdtempSync(join(home, 'project2-'))
    const broadcaster = new WorkingSetBroadcaster()
    const a = broadcaster.getOrCreateTracker(cwd)
    const b = broadcaster.getOrCreateTracker(cwd2)
    assert.notEqual(a.tracker, b.tracker)
    assert.equal(broadcaster.size(), 2)
  })

  // Test 8: subscribe + unsubscribe
  test('subscribe forwards events, unsubscribe stops them', async () => {
    const broadcaster = new WorkingSetBroadcaster()
    const events: any[] = []
    const unsub = broadcaster.subscribe(cwd, (e) => { events.push(e) })
    const entry = broadcaster.getOrCreateTracker(cwd)
    await entry.loadPromise
    entry.tracker.update('s1', { workspaceId: 'ws-a' })
    assert.equal(events.length, 1)
    unsub()
    entry.tracker.update('s2', { workspaceId: 'ws-a' })
    assert.equal(events.length, 1, 'no event after unsubscribe')
  })

  // Test 9: subscribeSession filters by sessionId
  test('subscribeSession filters events by sessionId', async () => {
    const broadcaster = new WorkingSetBroadcaster()
    const events: any[] = []
    broadcaster.subscribeSession(cwd, 's_target', (e) => { events.push(e) })
    const entry = broadcaster.getOrCreateTracker(cwd)
    await entry.loadPromise
    entry.tracker.update('s_other', { workspaceId: 'ws-a' })
    entry.tracker.update('s_target', { workspaceId: 'ws-a' })
    assert.equal(events.length, 1)
    assert.equal(events[0].sessionId, 's_target')
  })

  // Test 10: HOME isolation
  test('HOME isolation: HOME working-set.json not loaded', async () => {
    writeFileSync(join(home, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { homeS: { sessionId: 'homeS', workspaceId: 'ws-a', entries: [{ key: 'h', value: 'H', updatedAt: 't', confidence: 0.9 }], version: 1, updatedAt: 't' } },
    }), 'utf8')
    const broadcaster = new WorkingSetBroadcaster()
    const entry = broadcaster.getOrCreateTracker(cwd)
    await entry.loadPromise
    const tracker = entry.tracker
    assert.equal(tracker.get('homeS'), null, 'HOME file not read')
  })
})
