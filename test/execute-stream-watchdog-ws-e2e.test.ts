import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'
import { eventBase, type NexusEvent } from '../src/shared/events.js'
import { NexusMetrics } from '../src/nexus/metrics.js'
import { ExecutionGate } from '../src/nexus/executionGate.js'
import { ActiveExecutionRegistry } from '../src/nexus/activeExecutionRegistry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { registerExecuteStreamRoute } from '../src/nexus/executeStreamRoute.js'
import type { NexusRuntime, RuntimeExecuteOptions } from '../src/runtime/Runtime.js'

// End-to-end wire verification for the provider-stream-silent-hang fix
// (docs/nexus/proposals/provider-stream-silent-hang-abort-propagation-plan.md).
//
// WHY THIS TEST EXISTS:
// The Go TUI (`clients/go-tui`, internal/tui/stream.go runStream) consumes
// /v1/stream over a raw WebSocket with NO read deadline — its
// `conn.ReadMessage()` loop only returns when the server sends a `result`
// or `error` event (stream.go:298). Before this branch, a silent provider
// stream meant the server's hard watchdog fired `abortController.abort()`
// but the abort never reached the blocked SSE reader, so the runtime never
// threw, so no error event was ever sent, so the TUI's ReadMessage() blocked
// for 8 hours (session_3c3ec27c). The TUI already had graceful handling for
// the error event (tui.go:3909 formatErrorEventWithSoftContext + m.running=false);
// the only broken link was the event not arriving.
//
// This test proves the link is closed: over a REAL listening socket (not
// @fastify/websocket's injectWS, which auto-closes the mock socket before
// the watchdog can fire), a silent runtime + the single-source watchdog
// delivers a `details.kind='watchdog'` REQUEST_TIMEOUT to a kept-open WS
// client within ~watchdogTimeoutMs. That is the exact wire the TUI reads.
//
// The mock runtime mimics the real LLMCodingRuntime abort path
// (src/runtime/LLMCodingRuntime.ts:1039-1054): it hangs silent until the
// watchdog aborts the timeout signal, then YIELDS (not throws) a
// REQUEST_TIMEOUT error event — the shape processRuntimeExecutionEvent
// decorates with details.kind='watchdog' and forwardProcessedRuntimeEvent
// ships to the client.

function buildSilentThenWatchdogRuntime(captured: { abortFired: boolean }): NexusRuntime {
  return {
    async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
      yield {
        type: 'session_started',
        ...eventBase(options.sessionId),
        cwd: options.cwd,
        requestId: options.requestId,
      }
      // Silent: emit nothing more until the watchdog aborts. This is the
      // DeepSeek-V4-pro "think then go silent" failure mode.
      const sig = options.timeoutSignal
      if (sig && !sig.aborted) {
        await new Promise<void>(resolve => {
          sig.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      captured.abortFired = true
      // Mimic LLMCodingRuntime's catch: abort under soft policy → yield
      // REQUEST_TIMEOUT. The runtime never throws out of executeStream;
      // it catches and yields, so runExecutionStreamLoop's for-await
      // receives this event normally.
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: 'REQUEST_TIMEOUT',
        message: 'Provider stream went silent; watchdog aborted.',
      }
    },
  }
}

async function startServer(runtime: NexusRuntime): Promise<{ url: string; registry: ActiveExecutionRegistry; close: () => Promise<void> }> {
  const app = Fastify({ logger: false })
  await app.register(websocket)
  const registry = new ActiveExecutionRegistry()
  registerExecuteStreamRoute(app, {
    runtime,
    storage: new MemoryStorage(),
    executeTimeoutMs: 5_000,
    executePolicyMode: 'strict',
    maxToolOutputBytes: 200_000,
    bashMaxBufferBytes: 1_000_000,
    defaultCwd: '/tmp',
    executionGate: new ExecutionGate(1),
    metrics: new NexusMetrics(),
    activeExecutionRegistry: registry,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { url: `ws://127.0.0.1:${port}/v1/stream`, registry, close: () => app.close() }
}

function buildSilentUntilRequestAbortRuntime(captured: { abortFired: boolean }): NexusRuntime {
  // For the cancel test: hangs silent until the REQUEST signal
  // (prepared.abortController) is aborted — which is exactly what
  // /v1/sessions/:id/cancel does via activeExecutionRegistry.cancel.
  // Mimics LLMCodingRuntime:1040-1041: request-signal abort (not
  // timeout) → REQUEST_CANCELLED.
  return {
    async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
      yield {
        type: 'session_started',
        ...eventBase(options.sessionId),
        cwd: options.cwd,
        requestId: options.requestId,
      }
      const sig = options.signal
      if (sig && !sig.aborted) {
        await new Promise<void>(resolve => {
          sig.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      captured.abortFired = true
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: 'REQUEST_CANCELLED',
        message: 'Execution cancelled.',
      }
    },
  }
}

test('silent provider stream delivers details.kind=watchdog REQUEST_TIMEOUT to a kept-open WS client within watchdogTimeoutMs', async () => {
  const captured = { abortFired: false }
  const { url, close } = await startServer(buildSilentThenWatchdogRuntime(captured))

  const ws = new WebSocket(url)
  const received: NexusEvent[] = []
  const watchdogMs = 600

  await new Promise<void>((resolve, reject) => {
    const settle = (err?: unknown) => (err ? reject(err) : resolve())
    ws.on('open', () => {
      ws.send(JSON.stringify({
        prompt: 'silence after thinking',
        cwd: '/tmp',
        timeoutPolicy: 'soft',
        timeoutMs: 200,
        softTimeoutMs: 200,
        watchdogTimeoutMs: watchdogMs,
        maxSoftTimeoutExtensions: 0,
        softTimeoutExtensionMs: 200,
      }))
    })
    ws.on("message", (raw: Buffer) => {
      try {
        const event = JSON.parse(String(raw)) as NexusEvent
        received.push(event)
        if (event.type === 'error' && (event as any).code === 'REQUEST_TIMEOUT') {
          ws.close()
          settle()
        }
      } catch (err) {
        settle(err)
      }
    })
    ws.on('error', settle)
    // Hard ceiling: if the fix regresses, the client would hang for hours.
    // Fail fast at 3x the watchdog budget instead.
    setTimeout(() => settle(new Error(`timed out waiting for REQUEST_TIMEOUT; received ${received.length} events: ${received.map(e => e.type).join(',')}`)), watchdogMs * 3)
  })

  const errorEvents = received.filter(e => e.type === 'error' && (e as any).code === 'REQUEST_TIMEOUT')
  assert.equal(errorEvents.length, 1, 'exactly one REQUEST_TIMEOUT error event must reach the client')
  const err = errorEvents[0] as any
  assert.equal(err.details?.kind, 'watchdog', 'error event must be decorated with details.kind=watchdog (soft policy, watchdog fired)')
  assert.equal(err.details?.policy, 'soft')
  assert.equal(err.details?.watchdogTimeoutMs, watchdogMs)
  assert.ok(captured.abortFired, 'the watchdog must have aborted the runtime (prepared.timeout fired)')

  await close()
})

test('a healthy stream that completes before the watchdog never delivers a watchdog error', async () => {
  // Guard: the watchdog must not fire spuriously on a stream that finishes
  // normally. This pins the no-false-positive side of the fix — the TUI
  // should never see a watchdog error on a successful turn.
  const runtime: NexusRuntime = {
    async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
      yield { type: 'session_started', ...eventBase(options.sessionId), cwd: options.cwd, requestId: options.requestId }
      yield { type: 'assistant_delta', ...eventBase(options.sessionId), text: 'done' }
      yield { type: 'result', ...eventBase(options.sessionId), success: true, message: 'ok' }
    },
  }
  const { url, close } = await startServer(runtime)

  const ws = new WebSocket(url)
  const received: NexusEvent[] = []
  await new Promise<void>((resolve, reject) => {
    const settle = (err?: unknown) => (err ? reject(err) : resolve())
    ws.on('open', () => {
      ws.send(JSON.stringify({
        prompt: 'quick turn',
        cwd: '/tmp',
        timeoutPolicy: 'soft',
        timeoutMs: 5_000,
        softTimeoutMs: 5_000,
        watchdogTimeoutMs: 30_000,
        maxSoftTimeoutExtensions: 0,
        softTimeoutExtensionMs: 5_000,
      }))
    })
    ws.on('message', (raw: Buffer) => {
      const event = JSON.parse(String(raw)) as NexusEvent
      received.push(event)
      if (event.type === 'result') {
        ws.close()
        settle()
      }
    })
    ws.on('error', settle)
    setTimeout(() => settle(new Error('healthy stream did not complete')), 3_000)
  })

  const watchdogErrors = received.filter(e => e.type === 'error' && (e as any).details?.kind === 'watchdog')
  assert.equal(watchdogErrors.length, 0, 'a healthy stream must not produce a watchdog error')
  assert.ok(received.some(e => e.type === 'result' && (e as any).success === true), 'healthy stream must complete with a success result')

  await close()
})

test('cancel aborts a silent stream in real time: REQUEST_CANCELLED reaches the WS client within ~1s', async () => {
  // Addresses "Esc can't interrupt the backend in real time". The Go TUI's
  // cancel path POSTs /v1/sessions/:id/cancel → server cancelActiveExecution
  // → activeExecutionRegistry.cancel → prepared.abortController.abort() — the
  // SAME controller the watchdog uses. This test proves that abort reaches
  // the runtime and a REQUEST_CANCELLED is forwarded to the kept-open WS
  // client in ~1s. The companion fact — that the same abort also unblocks a
  // REAL silent SSE reader via reader.cancel() — is covered by
  // test/sse-abort-propagation.test.ts (cancel and watchdog share the
  // identical abortController → reader.cancel path); this test uses a mock
  // runtime that hangs on the request signal, so it pins the
  // registry→abort→event→WS-forward chain, not the SSE reader itself.
  const captured = { abortFired: false }
  const { url, registry, close } = await startServer(buildSilentUntilRequestAbortRuntime(captured))

  const ws = new WebSocket(url)
  const received: NexusEvent[] = []
  let sessionID = ''

  await new Promise<void>((resolve, reject) => {
    const settle = (err?: unknown) => (err ? reject(err) : resolve())
    ws.on('open', () => {
      ws.send(JSON.stringify({
        prompt: 'silence then cancel',
        cwd: '/tmp',
        timeoutPolicy: 'soft',
        timeoutMs: 30_000,
        softTimeoutMs: 30_000,
        watchdogTimeoutMs: 30_000,
        maxSoftTimeoutExtensions: 0,
        softTimeoutExtensionMs: 30_000,
      }))
    })
    ws.on('message', (raw: Buffer) => {
      const event = JSON.parse(String(raw)) as NexusEvent
      received.push(event)
      if (event.type === 'session_started') {
        sessionID = (event as any).sessionId
        // Simulate the operator pressing Esc→cancel: the cancel route's
        // cancelActiveExecution is exactly registry.cancel(sessionId).
        // Fire it once the stream is live + silent.
        setTimeout(() => registry.cancel(sessionID), 150)
      }
      if (event.type === 'error' && (event as any).code === 'REQUEST_CANCELLED') {
        ws.close()
        settle()
      }
    })
    ws.on('error', settle)
    setTimeout(() => settle(new Error(`cancel did not interrupt; received ${received.length} events: ${received.map(e => e.type).join(',')}`)), 3_000)
  })

  const cancelErrors = received.filter(e => e.type === 'error' && (e as any).code === 'REQUEST_CANCELLED')
  assert.equal(cancelErrors.length, 1, 'cancel must deliver exactly one REQUEST_CANCELLED to the client')
  assert.ok(captured.abortFired, 'the request-signal abort must have reached the runtime (cancel propagated, not just the WS socket)')
  assert.ok(sessionID, 'session_started must have arrived so the cancel could target the right session')

  await close()
})
