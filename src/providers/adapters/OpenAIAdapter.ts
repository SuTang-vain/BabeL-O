import type {
  ModelAdapter,
  ModelQueryParams,
  StreamDelta,
  TextContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
} from './ModelAdapter.js'
import { parseSSE } from './sse.js'
import { ProviderError } from '../../shared/errors.js'

export class OpenAIAdapter implements ModelAdapter {
  async *queryStream(
    params: ModelQueryParams,
    options?: { signal?: AbortSignal; apiKey?: string; baseUrl?: string }
  ): AsyncIterable<StreamDelta> {
    // Strip provider prefix if present
    const slashIndex = params.model.indexOf('/')
    const targetModel =
      slashIndex !== -1 ? params.model.substring(slashIndex + 1) : params.model

    const apiKey = options?.apiKey || process.env.OPENAI_API_KEY || ''
    const baseUrl =
      options?.baseUrl ||
      process.env.OPENAI_BASE_URL ||
      'https://api.openai.com/v1'

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }

    // Convert system prompt and messages to OpenAI format
    const openaiMessages: any[] = []

    if (params.systemPrompt) {
      openaiMessages.push({ role: 'system', content: params.systemPrompt })
    }

    for (const msg of params.messages) {
      if (typeof msg.content === 'string') {
        openaiMessages.push({ role: msg.role, content: msg.content })
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

          openaiMessages.push({
            role: msg.role,
            content: contentText,
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

    const body: any = {
      model: targetModel,
      messages: openaiMessages,
      ...(mappedTools && mappedTools.length > 0 && { tools: mappedTools }),
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.maxTokens !== undefined && { max_tokens: params.maxTokens }),
      stream: true,
      stream_options: { include_usage: true },
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new ProviderError('openai', response.status, errorText)
    }

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
        try {
          parsedInput = (0, eval)(`(${toolCall.argumentsBuffer})`)
        } catch {
          parsedInput = { raw: toolCall.argumentsBuffer }
        }
      }
      yield {
        type: 'tool_use_end',
        id: toolCall.id,
        input: parsedInput,
      }
    }
  }
}
