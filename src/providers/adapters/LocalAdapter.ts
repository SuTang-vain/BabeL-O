import type {
  ModelAdapter,
  ModelQueryParams,
  NonStreamCompletion,
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

  async queryNonStream(
    params: ModelQueryParams,
    _options?: { signal?: AbortSignal; apiKey?: string; baseUrl?: string },
  ): Promise<NonStreamCompletion> {
    const lastMsg = params.messages[params.messages.length - 1]
    const prompt = typeof lastMsg?.content === 'string'
      ? lastMsg.content
      : JSON.stringify(lastMsg?.content || '')

    return {
      content: `Local mock response for: ${prompt}`,
      usage: { inputTokens: 1, outputTokens: 1 },
    }
  }
}
