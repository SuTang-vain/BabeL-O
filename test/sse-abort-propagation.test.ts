import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSSE } from '../src/providers/adapters/sse.js'

// Phase 1 of docs/nexus/proposals/provider-stream-silent-hang-abort-propagation-plan.md.
//
// Root cause this test pins: a provider stream that emits deltas then
// goes silent leaves `reader.read()` pending forever. The hard
// watchdog aborts the controller, but before this fix the abort only
// reached the fetch signal — which does not reliably interrupt a
// half-open SSE reader — and the for-await chain up through the
// adapter stayed blocked. Real sample: session_3c3ec27c (8h hang).
//
// The fix: parseSSE accepts an optional AbortSignal and, when
// provided, acquires the reader explicitly so readerToAsyncIterable
// can call reader.cancel() on abort, forcing the pending read() to
// reject. This test proves a silent stream unblocks within
// milliseconds of abort, not hours.

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function createSilentStream(): ReadableStream<Uint8Array> {
  // A stream that never enqueues a chunk and never closes —
  // mimics a provider SSE connection that went silent mid-stream.
  return new ReadableStream<Uint8Array>({
    start() {
      // intentionally never call controller.enqueue / controller.close
    },
  })
}

function createImmediateAbortStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'))
      controller.close()
    },
  })
}

test('parseSSE unblocks within milliseconds when signal aborts a silent stream', async () => {
  const stream = createSilentStream()
  const controller = new AbortController()

  const consume = (async () => {
    for await (const _ of parseSSE(stream, controller.signal)) {
      // should never yield — stream is silent
    }
  })()

  const start = Date.now()
  // Let the reader settle into a blocked read(), then abort.
  await wait(50)
  controller.abort()

  const outcome = await Promise.race([
    consume.then(() => 'settled', () => 'settled'),
    new Promise<'hang'>(resolve => setTimeout(() => resolve('hang'), 2000)),
  ])
  assert.equal(outcome, 'settled', 'parseSSE did not unblock within 2s — abort did not propagate to the silent reader')

  const elapsed = Date.now() - start
  assert.ok(elapsed < 1000, `abort should propagate in < 1s, took ${elapsed}ms`)
})

test('parseSSE with no signal keeps back-compat behavior on a completing stream', async () => {
  const stream = createImmediateAbortStream()
  const events: Array<{ event?: string; data: string }> = []
  for await (const sse of parseSSE(stream)) {
    events.push(sse)
  }
  assert.deepEqual(events, [{ event: undefined, data: '{"ok":true}' }])
})

test('parseSSE with signal on a completing stream yields all events', async () => {
  const stream = createImmediateAbortStream()
  const controller = new AbortController()
  const events: Array<{ event?: string; data: string }> = []
  for await (const sse of parseSSE(stream, controller.signal)) {
    events.push(sse)
  }
  assert.deepEqual(events, [{ event: undefined, data: '{"ok":true}' }])
  // stream completed normally; signal never aborted, listener removed in finally
  assert.equal(controller.signal.aborted, false)
})

test('parseSSE unblocks immediately if signal is already aborted before consumption', async () => {
  const stream = createSilentStream()
  const controller = new AbortController()
  controller.abort()

  const consume = (async () => {
    for await (const _ of parseSSE(stream, controller.signal)) {
      // silent
    }
  })()

  const outcome = await Promise.race([
    consume.then(() => 'settled', () => 'settled'),
    new Promise<'hang'>(resolve => setTimeout(() => resolve('hang'), 1000)),
  ])
  assert.equal(outcome, 'settled', 'pre-aborted signal must unblock the silent stream within 1s')
})
