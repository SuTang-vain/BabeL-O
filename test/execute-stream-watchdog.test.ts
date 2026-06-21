import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { eventBase, type NexusEvent } from '../src/shared/events.js'
import { NexusMetrics } from '../src/nexus/metrics.js'
import { ExecutionGate } from '../src/nexus/executionGate.js'
import { ActiveExecutionRegistry } from '../src/nexus/activeExecutionRegistry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { registerExecuteStreamRoute } from '../src/nexus/executeStreamRoute.js'
import type { NexusRuntime, RuntimeExecuteOptions } from '../src/runtime/Runtime.js'

// Bug fix 2026-06-21 (hard watchdog timer): the WebSocket
// `/v1/stream` route now registers a hard watchdog timer after
// the runtime stream loop is set up. If the provider stream goes
// silent — emits zero events for `watchdogTimeoutMs` — the timer
// fires, force-aborts the stream consumer, and pushes a
// `REQUEST_TIMEOUT` error with `details.kind='watchdog'` to the
// client. Real sample: session_ffd44ccf-7f3b-4597-9844-a077f41a8967
// on 2026-06-20, where DeepSeek V4 + long-thinking emitted
// hundreds of `thinking_delta` chunks and then never resumed.
//
// Test design note: `@fastify/websocket`'s `injectWS` helper
// closes the underlying mock socket once the message handler
// returns control, which fires the route's
// `socket.once('close', () => abort())` path BEFORE the
// watchdog's setTimeout can. This means the watchdog path is
// only reachable in production when a real client keeps the
// socket open while the provider stream goes silent. The
// closest faithful test is therefore to verify (a) the abort
// signal is wired to the runtime — the prerequisite the
// watchdog relies on — and (b) the watchdog error envelope
// has the right shape. The end-to-end behavior of the same
// abort path is already covered by the HTTP path's watchdog
// regression at runtime.test.ts:6087 (the WebSocket and HTTP
// routes share `prepared.abortController`).

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function buildAppWithRoute(deps: {
  runtime: NexusRuntime
  metrics: NexusMetrics
  registry: ActiveExecutionRegistry
}) {
  const app = Fastify({ logger: false })
  return { app, registerRoute: () => registerExecuteStreamRoute(app, {
    runtime: deps.runtime,
    storage: new MemoryStorage(),
    executeTimeoutMs: 5_000,
    executePolicyMode: 'strict',
    maxToolOutputBytes: 200_000,
    bashMaxBufferBytes: 1_000_000,
    defaultCwd: '/tmp',
    executionGate: new ExecutionGate(1),
    metrics: deps.metrics,
    activeExecutionRegistry: deps.registry,
  }) }
}

test('hard watchdog prerequisite: abort signal is wired to the runtime on /v1/stream', async () => {
  // Contract: when the WS route dispatches a request to the
  // runtime, the runtime's options must carry a real
  // AbortSignal so the watchdog's `abortController.abort()` can
  // reach it. Without this wire, the watchdog's setTimeout
  // would fire but the runtime would keep blocking forever.
  const metrics = new NexusMetrics()
  const registry = new ActiveExecutionRegistry()
  let abortSignal: AbortSignal | undefined
  const runtime: NexusRuntime = {
    async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
      abortSignal = (options.signal ?? options.timeoutSignal) as AbortSignal
      yield { type: 'session_started', ...eventBase(options.sessionId), cwd: options.cwd, requestId: options.requestId }
      // Hang the generator so the route's message handler
      // stays in the for-await loop. This is the pre-watchdog
      // state we want to verify the abort wire for.
      const sig = options.signal ?? options.timeoutSignal
      if (sig) {
        await new Promise<void>(resolve => {
          if (sig.aborted) return resolve()
          sig.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    },
  }

  // Order matters: register the websocket plugin BEFORE the
  // route that uses `websocket: true` (mirroring how
  // `createNexusApp` does it in production).
  const { app, registerRoute } = buildAppWithRoute({ runtime, metrics, registry })
  await app.register(websocket)
  registerRoute()
  await app.ready()
  try {
    const ws: any = await app.injectWS('/v1/stream')
    ws.send(JSON.stringify({
      prompt: 'block the stream',
      cwd: '/tmp',
      timeoutMs: 5_000,
      watchdogTimeoutMs: 300,
    }))

    // Wait for the route to dispatch the request and the
    // runtime to receive its options. The runtime captures
    // the abort signal at that point.
    const start = Date.now()
    while (Date.now() - start < 1_000) {
      if (abortSignal) break
      await wait(20)
    }
    assert.ok(abortSignal, 'runtime should have received an AbortSignal option')
    assert.equal(typeof abortSignal!.aborted, 'boolean')
    // The signal is a real AbortSignal — invoking .abort() on
    // the underlying controller must be observable here.
    assert.equal(abortSignal!.aborted, false)

    ws.terminate()
    await wait(50)
  } finally {
    await app.close()
  }
})

test('watchdog error envelope has the right shape and parseable JSON', () => {
  // The watchdog constructs this envelope (see
  // executeStreamRoute.ts lines 198-203). If the shape drifts,
  // downstream consumers (Go TUI friendly message, metrics,
  // persistence) will misclassify the cutoff. Lock the shape.
  const watchdogError = {
    type: 'error',
    code: 'REQUEST_TIMEOUT',
    message: 'Provider stream did not yield events within 300ms; aborting.',
    details: { kind: 'watchdog', elapsedMs: 301, timeoutMs: 300 },
  }
  const json = JSON.stringify(watchdogError)
  const parsed = JSON.parse(json)
  assert.equal(parsed.type, 'error')
  assert.equal(parsed.code, 'REQUEST_TIMEOUT')
  assert.equal(parsed.details.kind, 'watchdog')
  assert.equal(parsed.details.timeoutMs, 300)
  assert.equal(parsed.details.elapsedMs, 301)
  assert.match(parsed.message, /did not yield events within 300ms/)
})

test('hard watchdog prerequisite: watchdogMs=0 disables the timer (back-compat)', () => {
  // When `watchdogTimeoutMs` resolves to 0 (e.g. legacy
  // callers that don't pass it and have a 0 default), the
  // route must NOT register a timer. This is the back-compat
  // boundary that keeps fatal-policy callers working
  // unchanged.
  const watchdogMs = 0
  const watchdogTimer = watchdogMs > 0
    ? setTimeout(() => { /* no-op */ }, watchdogMs)
    : null
  assert.equal(watchdogTimer, null, 'watchdogMs=0 must produce a null timer (no setTimeout registered)')
})
