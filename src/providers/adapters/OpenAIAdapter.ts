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
    validateOpenAIToolMessageSequence(openaiMessages)

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

    for await (const sse of parseSSE(response.body, options?.signal)) {
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
        // Path 1 fix (2026-06-21): some providers (DeepSeek V4
        // observed in real e2e session_ff3a874d-4d25-4e53-b0eb-02744b6bfaa2)
        // emit the entire assistant answer as a single large
        // `delta.content` AFTER all `delta.reasoning_content`
        // chunks. The Go TUI then sees one giant assistant_delta
        // frame at the end of the turn and renders it as a
        // non-progressive dump — the operator can't see the model
        // "writing". Split long content deltas at sentence / clause
        // / word boundaries so the TUI gets multiple smaller frames
        // and can show progressive text.
        //
        // Threshold: only chunk deltas > 50 chars; small deltas are
        // emitted verbatim to avoid fragmenting normal streaming
        // providers. The same chunker is shared with AnthropicAdapter
        // — defined inline here to avoid a cross-adapter dependency.
        const content = delta.content
        if (content.length > 50) {
          yield* chunkOpenAITextDelta(content)
        } else {
          yield {
            type: 'text',
            text: content,
          }
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

function validateOpenAIToolMessageSequence(messages: any[]): void {
  const knownToolCalls = new Set<string>()
  const completedToolCalls = new Set<string>()

  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = String(call?.id ?? '')
        if (id) knownToolCalls.add(id)
      }
      continue
    }

    if (message?.role !== 'tool') continue

    const toolCallId = String(message.tool_call_id ?? '')
    if (!toolCallId || !knownToolCalls.has(toolCallId)) {
      throw new Error(`PROVIDER_REPLAY_INVALID_TOOL_SEQUENCE: orphan tool_result ${toolCallId || '<missing>'}`)
    }
    if (completedToolCalls.has(toolCallId)) {
      throw new Error(`PROVIDER_REPLAY_INVALID_TOOL_SEQUENCE: duplicate tool_result ${toolCallId}`)
    }
    completedToolCalls.add(toolCallId)
  }
}

function mapOpenAIFinishReason(reason: string): FinishReason {
  return (OPENAI_FINISH_MAP[reason] || reason) as FinishReason
}

/**
 * Path 1 helper (2026-06-21): identical algorithm to
 * AnthropicAdapter.chunkTextDelta. See AnthropicAdapter for the
 * full rationale. Duplicated here to avoid a cross-adapter
 * import dependency; both adapters stay self-contained.
 */
function* chunkOpenAITextDelta(input: string): Generator<{ type: 'text'; text: string }> {
  if (input.length <= 50) {
    yield { type: 'text', text: input }
    return
  }
  const boundaries: Array<{ re: RegExp; priority: number }> = [
    { re: /\n\n+/g, priority: 0 },
    { re: /[.!?]+\s*/g, priority: 1 },
    { re: /[,;:]+\s*/g, priority: 2 },
    { re: /\s+/g, priority: 3 },
  ]
  let remaining = input
  while (remaining.length > 50) {
    const windowEnd = Math.max(20, remaining.length - 30)
    let chosen: { priority: number; index: number; len: number } | null = null
    for (const b of boundaries) {
      b.re.lastIndex = 20
      const m = b.re.exec(remaining)
      if (m && m.index >= 20 && m.index <= windowEnd) {
        if (chosen === null || b.priority < chosen.priority ||
            (b.priority === chosen.priority && m.index < chosen.index)) {
          chosen = { priority: b.priority, index: m.index, len: m[0].length }
        }
      }
    }
    let cutAt: number
    let cutLen: number
    if (chosen !== null) {
      cutAt = chosen.index
      cutLen = chosen.len
    } else {
      cutAt = 60
      cutLen = 0
    }
    const chunk = remaining.slice(0, cutAt + cutLen)
    if (chunk.length > 0) yield { type: 'text', text: chunk }
    remaining = remaining.slice(cutAt + cutLen)
  }
  if (remaining.length > 0) yield { type: 'text', text: remaining }
}
