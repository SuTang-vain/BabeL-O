import type {
  ModelAdapter,
  ModelQueryParams,
  StreamDelta,
  TextContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  FinishReason,
} from './ModelAdapter.js'
import { parseSSE } from './sse.js'
import { ProviderError } from '../../shared/errors.js'
import { getModel, getProvider, type ProviderDefinition } from '../registry.js'
import { withRetry } from '../retry.js'

export class OpenAIAdapter implements ModelAdapter {
  async *queryStream(
    params: ModelQueryParams,
    options?: { signal?: AbortSignal; apiKey?: string; baseUrl?: string }
  ): AsyncIterable<StreamDelta> {
    // Strip provider prefix if present
    const slashIndex = params.model.indexOf('/')
    const targetModel =
      slashIndex !== -1 ? params.model.substring(slashIndex + 1) : params.model
    const providerId =
      slashIndex !== -1 ? params.model.substring(0, slashIndex) : 'openai'

    let providerDef: Pick<ProviderDefinition, 'authMode' | 'defaultBaseUrl'>
    let registeredProvider = true
    try {
      providerDef = getProvider(providerId)
    } catch {
      registeredProvider = false
      providerDef = { authMode: 'bearer', defaultBaseUrl: 'https://api.openai.com/v1' }
    }

    const usesOpenAIEnv = providerId === 'openai' || !registeredProvider
    const apiKey = options?.apiKey || (usesOpenAIEnv ? process.env.OPENAI_API_KEY : undefined) || ''
    const baseUrl =
      options?.baseUrl ||
      (usesOpenAIEnv ? process.env.OPENAI_BASE_URL : undefined) ||
      providerDef.defaultBaseUrl ||
      'https://api.openai.com/v1'

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (providerDef.authMode === 'bearer') {
      headers.Authorization = `Bearer ${apiKey}`
    } else if (providerDef.authMode === 'api-key') {
      headers['x-api-key'] = apiKey
    }

    // Convert system prompt and messages to OpenAI format
    const openaiMessages: any[] = []

    if (params.systemPrompt) {
      openaiMessages.push({ role: 'system', content: params.systemPrompt })
    }

    const isDeepSeek =
      params.model.includes('deepseek') ||
      (options?.baseUrl && options.baseUrl.includes('deepseek'))
    const requiresReasoning =
      isDeepSeek &&
      (params.model.includes('reasoner') ||
        params.model.includes('r1') ||
        params.model.includes('pro') ||
        params.model.includes('chat'))

    for (const msg of params.messages) {
      if (typeof msg.content === 'string') {
        const reasoning = msg.reasoningContent?.trim() || undefined
        openaiMessages.push({
          role: msg.role,
          content: msg.content,
          ...(isDeepSeek && reasoning && { reasoning_content: reasoning }),
        })
      } else {
        const textBlocks = msg.content.filter(
          b => b.type === 'text'
        ) as TextContentBlock[]
        const toolUseBlocks = msg.content.filter(
          b => b.type === 'tool_use'
        ) as ToolUseContentBlock[]
        const toolResultBlocks = msg.content.filter(
          b => b.type === 'tool_result'
        ) as ToolResultContentBlock[]

        if (toolResultBlocks.length > 0) {
          for (const block of toolResultBlocks) {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: block.toolUseId,
              content: block.content,
            })
          }
        } else {
          const contentText =
            textBlocks.map(b => b.text).join('\n') || null
          const toolCalls = toolUseBlocks.map(b => ({
            id: b.id,
            type: 'function',
            function: {
              name: b.name,
              arguments:
                typeof b.input === 'string'
                  ? b.input
                  : JSON.stringify(b.input),
            },
          }))

          const reasoning = msg.reasoningContent?.trim() || undefined

          openaiMessages.push({
            role: msg.role,
            content: contentText,
            ...(isDeepSeek && reasoning && { reasoning_content: reasoning }),
            ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
          })
        }
      }
    }

    const mappedTools = params.tools?.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }))

    let maxTokensValue: number | undefined
    if (params.maxTokens !== undefined) {
      maxTokensValue = params.maxTokens
    } else {
      try {
        maxTokensValue = getModel(params.model).defaultMaxTokens
      } catch {
        maxTokensValue = undefined
      }
    }

    const body: any = {
      model: targetModel,
      messages: openaiMessages,
      ...(mappedTools && mappedTools.length > 0 && { tools: mappedTools }),
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(maxTokensValue !== undefined && { max_tokens: maxTokensValue }),
      stream: true,
      stream_options: { include_usage: true },
    }

    const response = await withRetry(async () => {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      })

      if (!res.ok) {
        const errorText = await res.text()
        throw new ProviderError(providerId, res.status, errorText)
      }

      return res
    })

    if (!response.body) {
      throw new Error('Response body is not readable')
    }

    const activeToolCalls = new Map<
      number,
      { id: string; name: string; argumentsBuffer: string }
    >()

    for await (const sse of parseSSE(response.body)) {
      if (sse.data === '[DONE]') {
        break
      }
      let data: any
      try {
        data = JSON.parse(sse.data)
      } catch {
        continue
      }
      if (data.usage) {
        yield {
          type: 'usage',
          inputTokens: data.usage.prompt_tokens || 0,
          outputTokens: data.usage.completion_tokens || 0,
        }
      }
      const choice = data.choices?.[0]
      if (!choice) continue

      if (choice.finish_reason) {
        yield {
          type: 'finish',
          reason: mapOpenAIFinishReason(choice.finish_reason),
        }
      }

      const delta = choice.delta
      if (!delta) continue

      if (delta.content) {
        yield {
          type: 'text',
          text: delta.content,
        }
      }

      if (delta.reasoning_content) {
        yield {
          type: 'thinking',
          text: delta.reasoning_content,
        }
      }

      if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const toolCallDelta of delta.tool_calls) {
          const idx = toolCallDelta.index
          if (toolCallDelta.id) {
            activeToolCalls.set(idx, {
              id: toolCallDelta.id,
              name: toolCallDelta.function?.name || '',
              argumentsBuffer: toolCallDelta.function?.arguments || '',
            })
            yield {
              type: 'tool_use_start',
              id: toolCallDelta.id,
              name: toolCallDelta.function?.name || '',
            }
            if (toolCallDelta.function?.arguments) {
              yield {
                type: 'tool_use_delta',
                id: toolCallDelta.id,
                inputDelta: toolCallDelta.function.arguments,
              }
            }
          } else {
            const active = activeToolCalls.get(idx)
            if (active) {
              const argDelta = toolCallDelta.function?.arguments || ''
              active.argumentsBuffer += argDelta
              if (argDelta) {
                yield {
                  type: 'tool_use_delta',
                  id: active.id,
                  inputDelta: argDelta,
                }
              }
            }
          }
        }
      }
    }

    for (const toolCall of activeToolCalls.values()) {
      let parsedInput: unknown = {}
      try {
        parsedInput = JSON.parse(toolCall.argumentsBuffer)
      } catch {
        parsedInput = { _parseError: true, _rawInput: toolCall.argumentsBuffer.slice(0, 500) }
      }
      yield {
        type: 'tool_use_end',
        id: toolCall.id,
        input: parsedInput,
      }
    }
  }
}

const OPENAI_FINISH_MAP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'end_turn',
  tool_calls: 'tool_use',
}

function mapOpenAIFinishReason(reason: string): FinishReason {
  return (OPENAI_FINISH_MAP[reason] || reason) as FinishReason
}
