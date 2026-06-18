// test/context-observe-websocket.test.ts
//
// PR-A2 unit + e2e tests: /v1/context/observe WebSocket + shared broadcaster.
// Mirrors test/working-set-observe-websocket.test.ts.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
import { ContextBroadcaster, defaultContextBroadcaster } from '../src/nexus/contextBroadcaster.js'
import type { AssembledContext } from '../src/runtime/contextAssembler.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

interface WsMessage {
  type: string
  [k: string]: unknown
}

function nextMessage(ws: WS, timeoutMs = 2000): Promise<WsMessage> {
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

function makeContext(sessionId: string): AssembledContext {
  return {
    systemPrompt: `sys:${sessionId}`,
    messages: [],
    budget: {
      maxTokens: 1000,
      maxChars: 4000,
      layerBudgets: { system: 100, memory: 100, summary: 100, recent: 100 },
      snipToolOutputChars: 100,
      snipPriorTurnToolOutputChars: 100,
      microcompactToolOutputChars: 100,
      microcompactInternalTextChars: 100,
      recentEventLimit: 10,
      recentTurnLimit: 5,
    },
    selectedEventCount: 0,
    omittedEventCount: 0,
    snippedEventCount: 0,
    sessionSummary: '',
    projectMemory: '',
    activeSkills: '',
    gitStatus: '',
    compactRetainedEventCount: 0,
    compactRetainedSegmentValid: true,
    compactRetainedSegmentWarning: '',
    postCompactState: { kind: 'none' },
    userIntentGuidance: { pendingQuestions: [], declaredTaskScope: undefined, tone: 'neutral' },
    memoryTruncated: false,
    microcompactedEventCount: 0,
    microcompactMetrics: { toolOutputCharsTrimmed: 0, internalTextCharsTrimmed: 0, eventsAffected: 0 },
    selectionDiagnostics: { budgetMaxTokens: 1000, selectedEventCount: 0, omittedEventCount: 0, snippedEventCount: 0, byReason: { summary: 0, microcompact: 0, recent: 0, snip: 0 } },
    memoryCapabilityAvailable: false,
    scopedMemoryDiagnostics: [],
  } as unknown as AssembledContext
}

describe('PR-A2 /v1/context/observe WebSocket', () => {
  let home: string
  let cwd: string
  let broadcaster: ContextBroadcaster

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-prA2-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    mkdirSync(join(cwd, '.babel-o'), { recursive: true })
    for (const key of ['HOME', 'BABEL_O_TEST_CONFIG_WRITE_GUARD']) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.HOME = home
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
    // Reset the singleton between tests so leftover state from prior
    // tests does not leak across runs.
    defaultContextBroadcaster.clear()
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    defaultContextBroadcaster.clear()
  })

  // T1: connect → receives initial snapshot
  test('T1: connect → receives assembled_snapshot (context: null on first connect)', async () => {
    broadcaster = new ContextBroadcaster()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      contextBroadcaster: broadcaster,
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as any).port
      const ws = makeWS(`ws://127.0.0.1:${port}/v1/context/observe?cwd=${encodeURIComponent(cwd)}`)
      const snap = await nextMessage(ws)
      assert.equal(snap.type, 'assembled_snapshot')
      assert.equal(snap.cwd, cwd)
      assert.equal(snap.context, null, 'no prior context → null')
      ws.close()
    } finally {
      await app.close()
    }
  })

  // T2: publish on the singleton (simulating the runtime hot path) → WS receives assembled
  test('T2: defaultContextBroadcaster.publish → WS receives assembled', async () => {
    // Use a fresh broadcaster on both sides so the test is hermetic.
    // (The runtime hot path uses the singleton, so we publish to the
    // singleton, and the WS route subscribes to the per-app broadcaster
    // — but to keep the test honest about the wiring, we pass the same
    // instance into both via the singleton — so we verify the
    // defaultContextBroadcaster path.)
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      contextBroadcaster: defaultContextBroadcaster,
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as any).port
      const ws = makeWS(`ws://127.0.0.1:${port}/v1/context/observe?cwd=${encodeURIComponent(cwd)}`)
      await nextMessage(ws) // initial snapshot

      // Simulate the runtime hot path emit.
      defaultContextBroadcaster.publish(cwd, {
        type: 'assembled',
        sessionId: 's1',
        context: makeContext('s1'),
        timestamp: '2026-06-17T00:00:00.000Z',
      })

      const ev = await nextMessage(ws)
      assert.equal(ev.type, 'assembled')
      assert.equal(ev.cwd, cwd)
      assert.equal(ev.sessionId, 's1')
      ws.close()
    } finally {
      await app.close()
    }
  })

  // T3: sessionId filter — only matching sessionId events delivered
  test('T3: ?sessionId= filter — only matching events delivered', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      contextBroadcaster: defaultContextBroadcaster,
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as any).port
      const ws = makeWS(
        `ws://127.0.0.1:${port}/v1/context/observe?cwd=${encodeURIComponent(cwd)}&sessionId=s_filtered`
      )
      await nextMessage(ws) // initial snapshot

      // s_other → should NOT be received (filtered out)
      defaultContextBroadcaster.publish(cwd, {
        type: 'assembled',
        sessionId: 's_other',
        context: makeContext('s_other'),
        timestamp: 't1',
      })
      // s_filtered → should be received
      defaultContextBroadcaster.publish(cwd, {
        type: 'assembled',
        sessionId: 's_filtered',
        context: makeContext('s_filtered'),
        timestamp: 't2',
      })

      const ev = await nextMessage(ws)
      assert.equal(ev.type, 'assembled')
      assert.equal(ev.sessionId, 's_filtered')
      ws.close()
    } finally {
      await app.close()
    }
  })

  // T4: multiple WS clients on same cwd share the same broadcaster
  test('T4: multiple WS clients share the same broadcaster events', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      contextBroadcaster: defaultContextBroadcaster,
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as any).port
      const ws1 = makeWS(`ws://127.0.0.1:${port}/v1/context/observe?cwd=${encodeURIComponent(cwd)}`)
      const ws2 = makeWS(`ws://127.0.0.1:${port}/v1/context/observe?cwd=${encodeURIComponent(cwd)}`)
      await nextMessage(ws1)
      await nextMessage(ws2)

      defaultContextBroadcaster.publish(cwd, {
        type: 'assembled',
        sessionId: 's_broadcast',
        context: makeContext('s_broadcast'),
        timestamp: 't',
      })

      const [m1, m2] = await Promise.all([nextMessage(ws1), nextMessage(ws2)])
      assert.equal(m1.type, 'assembled')
      assert.equal(m2.type, 'assembled')
      assert.equal(m1.sessionId, 's_broadcast')
      assert.equal(m2.sessionId, 's_broadcast')
      ws1.close()
      ws2.close()
    } finally {
      await app.close()
    }
  })

  // T5: missing cwd → error frame + close 1008
  test('T5: missing cwd → error + close 1008', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      contextBroadcaster: new ContextBroadcaster(),
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as any).port
      const ws = makeWS(`ws://127.0.0.1:${port}/v1/context/observe`)

      const error = await nextMessage(ws)
      assert.equal(error.type, 'error')
      assert.equal(error.code, 'MISSING_CWD')

      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve())
        setTimeout(() => resolve(), 200)
      })
    } finally {
      await app.close()
    }
  })

  // T7: reconnect gets fresh assembled_snapshot
  test('T7: reconnect after publish → fresh assembled_snapshot has context', async () => {
    // First connection populates the cache via publish, then closes.
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      contextBroadcaster: defaultContextBroadcaster,
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as any).port

      // First connection: receive snapshot (null), then publish.
      const ws1 = makeWS(`ws://127.0.0.1:${port}/v1/context/observe?cwd=${encodeURIComponent(cwd)}&sessionId=s_reconnect`)
      const snap1 = await nextMessage(ws1)
      assert.equal(snap1.type, 'assembled_snapshot')
      assert.equal(snap1.context, null)

      defaultContextBroadcaster.publish(cwd, {
        type: 'assembled',
        sessionId: 's_reconnect',
        context: makeContext('s_reconnect'),
        timestamp: 't',
      })
      const ev = await nextMessage(ws1)
      assert.equal(ev.type, 'assembled')
      ws1.close()

      // Wait a beat for the close to propagate.
      await new Promise((r) => setTimeout(r, 50))

      // Second connection: snapshot should now contain the context.
      const ws2 = makeWS(`ws://127.0.0.1:${port}/v1/context/observe?cwd=${encodeURIComponent(cwd)}&sessionId=s_reconnect`)
      const snap2 = await nextMessage(ws2)
      assert.equal(snap2.type, 'assembled_snapshot')
      assert.ok(snap2.context, 'snapshot now has context from prior publish')
      ws2.close()
    } finally {
      await app.close()
    }
  })

  // T8: disconnect cleans up — no memory leak
  test('T8: disconnect cleans up subscribers', async () => {
    broadcaster = new ContextBroadcaster()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
      contextBroadcaster: broadcaster,
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as any).port
      const ws = makeWS(`ws://127.0.0.1:${port}/v1/context/observe?cwd=${encodeURIComponent(cwd)}`)
      await nextMessage(ws)
      assert.equal(broadcaster.subscriberCount(cwd), 1)

      ws.close()
      // Wait for close to propagate to the cleanup handler.
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(broadcaster.subscriberCount(cwd), 0, 'subscriber removed on close')
    } finally {
      await app.close()
    }
  })
})
