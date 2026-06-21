export async function* parseSSE(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }, void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent: string | undefined

  // When an AbortSignal is provided, acquire the reader explicitly
  // so readerToAsyncIterable can cancel a blocked read() on abort.
  // response.body.cancel() cannot be used once a reader is acquired
  // (it throws "locked"); only the reader that holds the lock can
  // cancel. Without a signal, prefer the stream's native async
  // iterator to preserve the previous behavior.
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
  // Cancel the reader on abort so a blocked read() rejects promptly.
  // This closes the silent-stream hang: a provider that emits deltas
  // then goes silent leaves reader.read() pending forever, and the
  // hard watchdog's abortController.abort() only reaches the fetch
  // signal — which does not reliably interrupt a half-open SSE
  // reader. reader.cancel() forces the pending read() to reject,
  // unblocking the for-await chain up through the adapter and
  // providerTurn into the runtime's recovery path.
  const onAbort = () => {
    void reader.cancel(new Error('Aborted')).catch(() => {})
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      yield value
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // reader may already be canceled/closed
    }
  }
}
