export async function* parseSSE(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
): AsyncGenerator<{ event?: string; data: string }, void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent: string | undefined

  const iterator = (Symbol.asyncIterator in stream)
    ? (stream as AsyncIterable<Uint8Array>)
    : ('getReader' in stream && typeof (stream as ReadableStream<Uint8Array>).getReader === 'function')
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
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}
