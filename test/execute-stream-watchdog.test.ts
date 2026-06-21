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
import { isPrepareError, prepareExecution } from '../src/nexus/executionPreparation.js'
import type { NexusRuntime, RuntimeExecuteOptions } from '../src/runtime/Runtime.js'

// Phase 2 of docs/nexus/proposals/provider-stream-silent-hang-abort-propagation-plan.md.
//
// The hard watchdog is a SINGLE source: `prepareExecution` registers one
// `setTimeout` (`prepared.timeout`) that fires at `watchdogTimeoutMs`,
// marks `prepared.watchdog.fired`, and aborts both the timeout and
// request controllers. The abort propagates through the provider stream
// reader (Phase 1) so the runtime catch yields a `REQUEST_TIMEOUT`;
// `processRuntimeExecutionEvent` then decorates it with
// `details.kind='watchdog'` (soft policy) and the WS forwarder delivers
// it to the client. The `/v1/stream` route no longer registers a second
// watchdog timer — that duplicate risked double error events and a
// direct socket write that bypassed persistence/decoration.
//
// Test design note: `@fastify/websocket`'s `injectWS` helper closes the
// underlying mock socket once the message handler returns control, which
// fires the route's `socket.once('close', () => abort())` path BEFORE
// `prepared.timeout` can fire. The watchdog path is therefore only
// reachable in production when a real client keeps the socket open while
// the provider stream goes silent. The closest faithful tests are
// (a) the abort signal is wired to the runtime — the prerequisite the
// watchdog relies on — and (b) the single-source watchdog contract on
// `prepareExecution`. The end-to-end decoration is covered by the HTTP
// path regression at runtime.test.ts:6087 (HTTP and WS share
// `prepared.timeout` + `processRuntimeExecutionEvent`).

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
  // runtime, the runtime's options must carry a real AbortSignal so
  // `prepared.timeout`'s `abortController.abort()` can reach it.
  // Without this wire, the watchdog's setTimeout would fire but the
  // runtime would keep blocking forever.
  const metrics = new NexusMetrics()
  const registry = new ActiveExecutionRegistry()
  let abortSignal: AbortSignal | undefined
  const runtime: NexusRuntime = {
    async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
      abortSignal = (options.signal ?? options.timeoutSignal) as AbortSignal
      yield { type: 'session_started', ...eventBase(options.sessionId), cwd: options.cwd, requestId: options.requestId }
      // Hang the generator so the route's message handler stays in
      // the for-await loop. This is the pre-watchdog state we want
      // to verify the abort wire for.
      const sig = options.signal ?? options.timeoutSignal
      if (sig) {
        await new Promise<void>(resolve => {
          if (sig.aborted) return resolve()
          sig.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    },
  }

  // Order matters: register the websocket plugin BEFORE the route
  // that uses `websocket: true` (mirroring how `createNexusApp` does
  // it in production).
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

    // Wait for the route to dispatch the request and the runtime to
    // receive its options.
    const start = Date.now()
    while (Date.now() - start < 1_000) {
      if (abortSignal) break
      await wait(20)
    }
    assert.ok(abortSignal, 'runtime should have received an AbortSignal option')
    assert.equal(typeof abortSignal!.aborted, 'boolean')
    assert.equal(abortSignal!.aborted, false)

    ws.terminate()
    await wait(50)
  } finally {
    await app.close()
  }
})

test('single-source watchdog: prepareExecution fires one timer that marks watchdog.fired and aborts both controllers', async () => {
  // Phase 2 contract: `prepared.timeout` is the ONLY hard watchdog.
  // When it fires it must (1) set `watchdog.fired = true` — the marker
  // `maybeDecorateWatchdogError` reads to attach `details.kind='watchdog'`
  // — and (2) abort both the timeout controller (so the runtime catch
  // classifies the error as `REQUEST_TIMEOUT`, not `REQUEST_CANCELLED`)
  // and the request controller (so Phase 1's reader.cancel() unblocks
  // the provider stream).
  const storage = new MemoryStorage()
  const prepared = await prepareExecution(
    {
      prompt: 'turn that outlives the watchdog',
      cwd: '/tmp',
      timeoutPolicy: 'soft',
      softTimeoutMs: 40,
      watchdogTimeoutMs: 80,
      maxSoftTimeoutExtensions: 0,
      softTimeoutExtensionMs: 40,
    },
    {
      storage,
      defaultCwd: '/tmp',
      remoteRunnerAvailable: false,
      executeTimeoutMs: 5_000,
      executePolicyMode: 'strict',
    },
  )
  assert.ok(!isPrepareError(prepared), 'prepareExecution should succeed for a valid soft-policy body')
  if (isPrepareError(prepared)) return

  assert.equal(prepared.watchdog.fired, false, 'watchdog must start unfired')
  assert.ok(prepared.timeout, 'prepareExecution must register a watchdog setTimeout handle')
  assert.equal(prepared.timeoutController.signal.aborted, false)
  assert.equal(prepared.abortController.signal.aborted, false)

  try {
    const start = Date.now()
    while (Date.now() - start < 1_000) {
      if (prepared.watchdog.fired) break
      await wait(10)
    }
    assert.ok(prepared.watchdog.fired, 'watchdog must fire within watchdogTimeoutMs')
    assert.equal(prepared.timeoutController.signal.aborted, true, 'watchdog must abort the timeout controller (drives REQUEST_TIMEOUT classification)')
    assert.equal(prepared.abortController.signal.aborted, true, 'watchdog must abort the request controller (drives Phase 1 reader.cancel)')
  } finally {
    clearTimeout(prepared.timeout)
  }
})

test('single-source watchdog: fatal policy still fires prepared.timeout and aborts (back-compat)', async () => {
  // Under fatal policy the watchdog collapses onto the legacy timeout
  // (`watchdogTimeoutMs === legacyTimeoutMs`). `prepared.timeout` must
  // still fire and abort so legacy HTTP/WS callers see the same
  // cutoff. The `details.kind='watchdog'` decoration is intentionally
  // skipped under fatal (back-compat, guarded by runtime.test.ts:6191);
  // this test only locks the firing + abort contract.
  const storage = new MemoryStorage()
  const prepared = await prepareExecution(
    {
      prompt: 'fatal cutoff turn',
      cwd: '/tmp',
      timeoutMs: 60,
    },
    {
      storage,
      defaultCwd: '/tmp',
      remoteRunnerAvailable: false,
      executeTimeoutMs: 5_000,
      executePolicyMode: 'strict',
    },
  )
  assert.ok(!isPrepareError(prepared))
  if (isPrepareError(prepared)) return

  try {
    const start = Date.now()
    while (Date.now() - start < 1_000) {
      if (prepared.watchdog.fired) break
      await wait(10)
    }
    assert.ok(prepared.watchdog.fired, 'fatal watchdog must fire')
    assert.equal(prepared.abortController.signal.aborted, true)
  } finally {
    clearTimeout(prepared.timeout)
  }
})
