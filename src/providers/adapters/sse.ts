// Phase 1 (provider-stream-silent-hang-abort-propagation-plan.md):
// The hard watchdog (executionPreparation.ts prepareExecution) aborts the
// request signal at watchdogTimeoutMs. But a silent SSE connection's blocked
// `reader.read()` never observes that abort passively — undici does not reject
// a half-open read — so `for await (const delta of options.stream)` in
// providerTurn.ts hangs for hours (real session_3c3ec27c: 8h; reproduced live
// 2026-06-21 session_06308b17: 29min). The fix mirrors toolExecutor.ts's
// active-listener pattern: when an AbortSignal is provided, acquire the reader
// explicitly via getReader() so we hold the lock, and on abort call
// `reader.cancel()` which settles the pending read() locally so the for-await
// chain (parseSSE → queryStream → providerTurn) unblocks.
//
// Two subtleties the original Phase 1 commit got wrong, fixed here:
//  1. ReadableStream is itself async-iterable (Symbol.asyncIterator), so
//     checking `Symbol.asyncIterator in stream` FIRST would skip the cancel
//     wiring even when a signal is threaded. Gate on `signal` and take the
//     getReader() path when one is present; native iteration is back-compat
//     only. (The prior commit already gated on `signal && hasGetReader`, so
//     this is preserved.)
//  2. reader.cancel() CLOSES the stream — the pending read() resolves with
//     {done:true}, it does NOT reject (verified empirically on Node 26). The
//     prior commit's `if (done) break` therefore exited the loop cleanly with
//     NO throw, so the runtime never classified the watchdog abort as a
//     timeout and the turn ended silently instead of emitting REQUEST_TIMEOUT.
//     Fix: convert an abort-induced done into a thrown Aborted so
//     LLMCodingRuntime classifies signal-aborted + timeoutSignal-aborted →
//     REQUEST_TIMEOUT. A natural provider finish has signal.aborted === false
//     → break (unchanged).
export async function* parseSSE(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }, void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent: string | undefined

  const hasGetReader = typeof (stream as ReadableStream<Uint8Array>).getReader === 'function'
  const iterator: AsyncIterable<Uint8Array> | null =
    signal && hasGetReader
      ? readerToAsyncIterable((stream as ReadableStream<Uint8Array>).getReader(), signal)
      : (Symbol.asyncIterator in stream)
        ? (stream as AsyncIterable<Uint8Array>)
        : hasGetReader
          ? readerToAsyncIterable((stream as ReadableStream<Uint8Array>).getReader())
          : null

  if (!iterator) {
    throw new Error('Response body is not readable or iterable')
  }

  for await (const chunk of iterator) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      if (trimmed.startsWith(':')) {
        continue
      }
      const colonIndex = trimmed.indexOf(':')
      if (colonIndex === -1) {
        continue
      }
      const field = trimmed.slice(0, colonIndex).trim()
      const value = trimmed.slice(colonIndex + 1).trim()
      if (field === 'event') {
        currentEvent = value
      } else if (field === 'data') {
        yield { event: currentEvent, data: value }
        currentEvent = undefined
      }
    }
  }

  if (buffer) {
    const trimmed = buffer.trim()
    if (trimmed && !trimmed.startsWith(':')) {
      const colonIndex = trimmed.indexOf(':')
      if (colonIndex !== -1) {
        const field = trimmed.slice(0, colonIndex).trim()
        const value = trimmed.slice(colonIndex + 1).trim()
        if (field === 'data') {
          yield { data: value }
        }
      }
    }
  }
}

async function* readerToAsyncIterable(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
) {
  // Active abort propagation: register a listener that cancels the reader
  // when the signal aborts. Only the reader holding the lock can cancel,
  // which is why parseSSE acquires via getReader() when a signal is present.
  let onAbort: (() => void) | undefined
  if (signal) {
    if (signal.aborted) {
      void reader.cancel(new Error('Aborted')).catch(() => {})
      throw new Error('Aborted')
    }
    onAbort = () => {
      void reader.cancel(new Error('Aborted')).catch(() => {})
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        // reader.cancel() resolves a pending read() with {done:true} — it
        // CLOSES the stream, it does NOT error it (verified Node 26). So when
        // the abort listener cancelled the reader to unblock a silent stream,
        // we land here with done=true. Convert that into a thrown Aborted so
        // the runtime classifies the watchdog abort as REQUEST_TIMEOUT
        // (LLMCodingRuntime maps signal-aborted + timeoutSignal-aborted →
        // timeout) instead of treating the turn as a clean empty completion.
        // A natural provider finish has signal.aborted === false → break.
        if (signal?.aborted) throw new Error('Aborted')
        break
      }
      yield value
    }
  } finally {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // reader may already be canceled/closed
    }
  }
}
