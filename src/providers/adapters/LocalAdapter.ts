import type {
  ModelAdapter,
  ModelQueryParams,
  StreamDelta,
} from './ModelAdapter.js'

export class LocalAdapter implements ModelAdapter {
  async *queryStream(
    params: ModelQueryParams,
    options?: { signal?: AbortSignal }
  ): AsyncIterable<StreamDelta> {
    const lastMsg = params.messages[params.messages.length - 1]
    const prompt = typeof lastMsg?.content === 'string'
      ? lastMsg.content
      : JSON.stringify(lastMsg?.content || '')

    yield {
      type: 'text',
      text: `Local mock response for: ${prompt}`,
    }
  }
}
