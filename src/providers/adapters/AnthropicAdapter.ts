import type {
  ModelAdapter,
  ModelQueryParams,
  StreamDelta,
  ModelMessage,
  ContentBlock,
  FinishReason,
} from './ModelAdapter.js'
import { parseSSE } from './sse.js'
import { ProviderError } from '../../shared/errors.js'
import { getProvider, getModel } from '../registry.js'
import { withRetry } from '../retry.js'

const MINIMAX_TOOL_CALL_OPEN = '<minimax:tool_call'
const MINIMAX_TOOL_CALL_CLOSE = '</minimax:tool_call>'
const MINIMAX_BRACKET_MARKER = ']<]minimax[>['
const MINIMAX_BRACKET_TOOL_CALL_OPEN = '<tool_call'
const MINIMAX_BRACKET_TOOL_CALL_CLOSE = '</tool_call>'

const MODEL_MAPPING: Record<
  string,
  { firstParty: string; bedrock: string; vertex: string; foundry: string }
> = {
  'anthropic/claude-3-5-sonnet': {
    firstParty: 'claude-3-5-sonnet-20241022',
    bedrock: 'anthropic.agent_cli-3-5-sonnet-20241022-v2:0',
    vertex: 'claude-3-5-sonnet-v2@20241022',
    foundry: 'claude-3-5-sonnet',
  },
  'anthropic/claude-3-opus': {
    firstParty: 'claude-3-opus-20240229',
    bedrock: 'anthropic.claude-3-opus-20240229-v1:0',
    vertex: 'claude-3-opus@20240229',
    foundry: 'claude-3-opus',
  },
  'anthropic/claude-3-7-sonnet': {
    firstParty: 'claude-3-7-sonnet-20250219',
    bedrock: 'us.anthropic.agent_cli-3-7-sonnet-20250219-v1:0',
    vertex: 'claude-3-7-sonnet@20250219',
    foundry: 'claude-3-7-sonnet',
  },
}

function resolveModelName(canonicalId: string): string {
  const mapping = MODEL_MAPPING[canonicalId]
  const provider = process.env.AGENT_CLI_USE_BEDROCK
    ? 'bedrock'
    : process.env.AGENT_CLI_USE_VERTEX
      ? 'vertex'
      : process.env.AGENT_CLI_USE_FOUNDRY
        ? 'foundry'
        : 'firstParty'

  if (mapping) {
    return mapping[provider]
  }

  const slashIndex = canonicalId.indexOf('/')
  return slashIndex !== -1 ? canonicalId.substring(slashIndex + 1) : canonicalId
}

function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

function createMinimaxTextToolParser(): {
  handleText(text: string): StreamDelta[]
  flush(): StreamDelta[]
} {
  let buffer = ''
  let counter = 0

  const parseCompleteCalls = (): StreamDelta[] => {
    const deltas: StreamDelta[] = []
    while (true) {
      const knownCall = findNextMinimaxTextToolCall(buffer)
      if (!knownCall) {
        const keepChars = Math.max(MINIMAX_TOOL_CALL_OPEN.length, MINIMAX_BRACKET_MARKER.length + MINIMAX_BRACKET_TOOL_CALL_OPEN.length) - 1
        if (buffer.length > keepChars) {
          const emitText = buffer.slice(0, buffer.length - keepChars)
          if (emitText) deltas.push({ type: 'text', text: emitText })
          buffer = buffer.slice(buffer.length - keepChars)
        }
        break
      }

      const before = buffer.slice(0, knownCall.start)
      if (before) deltas.push({ type: 'text', text: before })
      buffer = buffer.slice(knownCall.start)

      const close = buffer.indexOf(knownCall.closeTag)
      if (close === -1) break

      const rawCall = buffer.slice(0, close + knownCall.closeTag.length)
      buffer = buffer.slice(rawCall.length)
      const parsed = parseMinimaxTextToolCall(rawCall, counter++)
      deltas.push(...parsed)
    }
    return deltas
  }

  return {
    handleText(text: string) {
      buffer += text
      return parseCompleteCalls()
    },
    flush() {
      const deltas = parseCompleteCalls()
      if (buffer) {
        deltas.push({ type: 'text', text: buffer })
        buffer = ''
      }
      return deltas
    },
  }
}

function findNextMinimaxTextToolCall(buffer: string): { start: number; closeTag: string } | undefined {
  const standardStart = buffer.indexOf(MINIMAX_TOOL_CALL_OPEN)
  const bracketStart = buffer.indexOf(`${MINIMAX_BRACKET_MARKER}${MINIMAX_BRACKET_TOOL_CALL_OPEN}`)
  if (standardStart === -1 && bracketStart === -1) return undefined
  if (bracketStart !== -1 && (standardStart === -1 || bracketStart < standardStart)) {
    return { start: bracketStart, closeTag: `${MINIMAX_BRACKET_MARKER}${MINIMAX_BRACKET_TOOL_CALL_CLOSE}` }
  }
  return { start: standardStart, closeTag: MINIMAX_TOOL_CALL_CLOSE }
}

function parseMinimaxTextToolCall(rawCall: string, index: number): StreamDelta[] {
  const normalizedCall = normalizeMinimaxTextToolCall(rawCall)
  const name = extractXmlAttribute(normalizedCall, 'invoke', 'name')
  if (!name) return []
  const input = extractMinimaxToolInput(normalizedCall)
  const id = `minimax_tool_${index + 1}`
  return [
    { type: 'tool_use_start', id, name },
    { type: 'tool_use_delta', id, inputDelta: JSON.stringify(input) },
    { type: 'tool_use_end', id, input },
    { type: 'finish', reason: 'tool_use' },
  ]
}

function normalizeMinimaxTextToolCall(rawCall: string): string {
  if (!rawCall.includes(MINIMAX_BRACKET_MARKER)) return rawCall
  return rawCall.split(MINIMAX_BRACKET_MARKER).join('')
}

function extractMinimaxToolInput(rawCall: string): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  const parameterPattern = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g
  let match: RegExpExecArray | null
  while ((match = parameterPattern.exec(rawCall)) !== null) {
    input[match[1]!] = decodeXmlEntities(match[2] ?? '')
  }
  if (Object.keys(input).length > 0) return input

  const invokeBody = extractXmlBody(rawCall, 'invoke')
  if (!invokeBody) return input
  const directChildPattern = /<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/g
  while ((match = directChildPattern.exec(invokeBody)) !== null) {
    input[match[1]!] = decodeXmlEntities(match[2] ?? '')
  }
  return input
}

function extractXmlAttribute(raw: string, tag: string, attribute: string): string | undefined {
  const pattern = new RegExp(`<${tag}\\s+[^>]*${attribute}="([^"]+)"`)
  const match = pattern.exec(raw)
  return match?.[1]
}

function extractXmlBody(raw: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}\\s+[^>]*>[\\s\\S]*?<\\/${tag}>`)
  const match = pattern.exec(raw)
  if (!match?.[0]) return undefined
  const openEnd = match[0].indexOf('>')
  return match[0].slice(openEnd + 1, -`</${tag}>`.length)
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export class AnthropicAdapter implements ModelAdapter {
  async *queryStream(
    params: ModelQueryParams,
    options?: { signal?: AbortSignal; apiKey?: string; baseUrl?: string }
  ): AsyncIterable<StreamDelta> {
    const targetModel = resolveModelName(params.model)
    const apiKey = options?.apiKey || process.env.ANTHROPIC_API_KEY || ''
    const baseUrl =
      options?.baseUrl ||
      process.env.ANTHROPIC_BASE_URL ||
      'https://api.anthropic.com'

    const slashIdx = params.model.indexOf('/')
    const providerId = slashIdx !== -1 ? params.model.substring(0, slashIdx) : 'anthropic'

    let providerDef
    try {
      providerDef = getProvider(providerId)
    } catch {
      providerDef = { authMode: 'api-key' as const }
    }

    const betas = ['prompt-caching-2024-07-31']
    if (params.thinking && params.thinking.budgetTokens > 0) {
      betas.push('thinking-2025-02-19')
    }

    if (process.env.ANTHROPIC_BETA) {
      for (const beta of process.env.ANTHROPIC_BETA.split(',')) {
        const trimmed = beta.trim()
        if (trimmed && !betas.includes(trimmed)) {
          betas.push(trimmed)
        }
      }
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...getCustomHeaders(),
    }

    if (providerDef.authMode === 'bearer') {
      headers['Authorization'] = `Bearer ${apiKey}`
    } else if (providerDef.authMode === 'api-key') {
      headers['x-api-key'] = apiKey
    }

    headers['anthropic-version'] = '2023-06-01'

    const isNativeAnthropic = providerId === 'anthropic'
    if (isNativeAnthropic || process.env.ANTHROPIC_BETA) {
      headers['anthropic-beta'] = betas.join(',')
    }

    // Build system prompt blocks with segmented caching
    let formattedSystemPrompt: any[] | undefined
    if (params.systemPromptBlocks && params.systemPromptBlocks.length > 0) {
      const staticText = params.systemPromptBlocks
        .filter(b => b.cacheable)
        .map(b => b.text)
        .join('\n\n')
      const dynamicText = params.systemPromptBlocks
        .filter(b => !b.cacheable)
        .map(b => b.text)
        .join('\n\n')

      formattedSystemPrompt = []
      if (staticText) {
        formattedSystemPrompt.push({
          type: 'text',
          text: staticText,
          ...(params.enablePromptCaching && {
            cache_control: { type: 'ephemeral' },
          }),
        })
      }
      if (dynamicText) {
        formattedSystemPrompt.push({
          type: 'text',
          text: dynamicText,
        })
      }
    } else if (params.systemPrompt) {
      formattedSystemPrompt = [
        {
          type: 'text',
          text: params.systemPrompt,
          ...(params.enablePromptCaching && {
            cache_control: { type: 'ephemeral' },
          }),
        },
      ]
    }

    // Map messages
    const markerIndex = params.messages.length - 1
    const formattedMessages = params.messages.map((msg, index) => {
      const addCache = params.enablePromptCaching && index === markerIndex
      const content =
        typeof msg.content === 'string'
          ? [
              {
                type: 'text',
                text: msg.content,
                ...(addCache && { cache_control: { type: 'ephemeral' } }),
              },
            ]
          : msg.content.map((block, blockIdx) => {
              const isLastBlock = blockIdx === msg.content.length - 1
              const blockCache = addCache && isLastBlock
              if (block.type === 'text') {
                return {
                  type: 'text',
                  text: block.text,
                  ...(blockCache && { cache_control: { type: 'ephemeral' } }),
                }
              } else if (block.type === 'tool_use') {
                return {
                  type: 'tool_use',
                  id: block.id,
                  name: block.name,
                  input: block.input,
                  ...(blockCache && { cache_control: { type: 'ephemeral' } }),
                }
              } else {
                return {
                  type: 'tool_result',
                  tool_use_id: block.toolUseId,
                  content: block.content,
                  ...(block.isError && { is_error: true }),
                  ...(blockCache && { cache_control: { type: 'ephemeral' } }),
                }
              }
            })

      return {
        role: msg.role,
        content,
      }
    })
    validateAnthropicToolMessageSequence(formattedMessages)

    // Map tools
    const mappedTools = params.tools?.map((tool, idx) => {
      const isLastTool = idx === params.tools!.length - 1
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        ...(params.enablePromptCaching &&
          isLastTool && {
            cache_control: { type: 'ephemeral' },
          }),
      }
    })

    let resolvedMaxTokens: number
    if (params.maxTokens !== undefined) {
      resolvedMaxTokens = params.maxTokens
    } else {
      try {
        resolvedMaxTokens = getModel(params.model).defaultMaxTokens
      } catch {
        resolvedMaxTokens = 8192
      }
    }

    const body: any = {
      model: targetModel,
      messages: formattedMessages,
      ...(formattedSystemPrompt && { system: formattedSystemPrompt }),
      ...(mappedTools && mappedTools.length > 0 && { tools: mappedTools }),
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      max_tokens: resolvedMaxTokens,
      stream: true,
    }

    if (params.thinking && params.thinking.budgetTokens > 0) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budgetTokens,
      }
      body.max_tokens = Math.max(
        body.max_tokens,
        params.thinking.budgetTokens + 1024
      )
      delete body.temperature
    }

    const response = await withRetry(async () => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
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

    const activeToolUses = new Map<
      number,
      { id: string; name: string; inputBuffer: string }
    >()
    const activeContentBlocks = new Set<number>()
    const minimaxTextToolParser = providerId === 'minimax' ? createMinimaxTextToolParser() : undefined
    let pendingFinishReason: FinishReason | undefined

    for await (const sse of parseSSE(response.body)) {
      if (sse.data === '[DONE]') break
      let stopAfterEvent = false

      if (sse.event === 'message_start') {
        const data = JSON.parse(sse.data)
        const usage = data.message?.usage
        if (usage) {
          yield {
            type: 'usage',
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
            cacheReadInputTokens: usage.cache_read_input_tokens || 0,
          }
        }
      } else if (sse.event === 'message_delta') {
        const data = JSON.parse(sse.data)
        const usage = data.usage
        if (usage) {
          yield {
            type: 'usage',
            inputTokens: 0,
            outputTokens: usage.output_tokens || 0,
          }
        }
        const stopReason = data.delta?.stop_reason
        if (stopReason) {
          pendingFinishReason = stopReason as FinishReason
          if (activeContentBlocks.size === 0) {
            if (minimaxTextToolParser) {
              yield* minimaxTextToolParser.flush()
            }
            yield {
              type: 'finish',
              reason: pendingFinishReason,
            }
            pendingFinishReason = undefined
            stopAfterEvent = true
          }
        }
      } else if (sse.event === 'content_block_start') {
        const data = JSON.parse(sse.data)
        const index = data.index
        activeContentBlocks.add(index)
        const block = data.content_block
        if (block && block.type === 'tool_use') {
          activeToolUses.set(index, {
            id: block.id,
            name: block.name,
            inputBuffer: '',
          })
          yield {
            type: 'tool_use_start',
            id: block.id,
            name: block.name,
          }
        }
      } else if (sse.event === 'content_block_delta') {
        const data = JSON.parse(sse.data)
        const index = data.index
        const delta = data.delta
        if (delta) {
          if (delta.type === 'text_delta') {
            if (minimaxTextToolParser) {
              yield* minimaxTextToolParser.handleText(delta.text)
            } else {
              yield {
                type: 'text',
                text: delta.text,
              }
            }
          } else if (delta.type === 'thinking_delta') {
            yield {
              type: 'thinking',
              text: delta.thinking,
            }
          } else if (delta.type === 'input_json_delta') {
            const toolUse = activeToolUses.get(index)
            if (toolUse) {
              toolUse.inputBuffer += delta.partial_json
              yield {
                type: 'tool_use_delta',
                id: toolUse.id,
                inputDelta: delta.partial_json,
              }
            }
          }
        }
      } else if (sse.event === 'message_stop') {
        if (minimaxTextToolParser) {
          yield* minimaxTextToolParser.flush()
        }
        if (pendingFinishReason) {
          yield {
            type: 'finish',
            reason: pendingFinishReason,
          }
          pendingFinishReason = undefined
        }
        stopAfterEvent = true
      } else if (sse.event === 'content_block_stop') {
        const data = JSON.parse(sse.data)
        const index = data.index
        activeContentBlocks.delete(index)
        const toolUse = activeToolUses.get(index)
        if (toolUse) {
          let parsedInput: unknown = {}
          try {
            parsedInput = JSON.parse(toolUse.inputBuffer)
          } catch {
            parsedInput = { _parseError: true, _rawInput: toolUse.inputBuffer.slice(0, 500) }
          }
          yield {
            type: 'tool_use_end',
            id: toolUse.id,
            input: parsedInput,
          }
          activeToolUses.delete(index)
        }
        if (pendingFinishReason && activeContentBlocks.size === 0) {
          if (minimaxTextToolParser) {
            yield* minimaxTextToolParser.flush()
          }
          yield {
            type: 'finish',
            reason: pendingFinishReason,
          }
          pendingFinishReason = undefined
          stopAfterEvent = true
        }
      }

      if (stopAfterEvent) break
    }

    if (minimaxTextToolParser) {
      yield* minimaxTextToolParser.flush()
    }
    if (pendingFinishReason) {
      yield {
        type: 'finish',
        reason: pendingFinishReason,
      }
    }
  }
}

function validateAnthropicToolMessageSequence(messages: Array<{ role: string; content: any[] }>): void {
  const knownToolUses = new Set<string>()
  const completedToolUses = new Set<string>()

  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== 'tool_use') continue
        const id = String(block.id ?? '')
        if (id) knownToolUses.add(id)
      }
      continue
    }

    if (!Array.isArray(message?.content)) continue
    for (const block of message.content) {
      if (block?.type !== 'tool_result') continue
      const toolUseId = String(block.tool_use_id ?? '')
      if (!toolUseId || !knownToolUses.has(toolUseId)) {
        throw new Error(`PROVIDER_REPLAY_INVALID_TOOL_SEQUENCE: orphan tool_result ${toolUseId || '<missing>'}`)
      }
      if (completedToolUses.has(toolUseId)) {
        throw new Error(`PROVIDER_REPLAY_INVALID_TOOL_SEQUENCE: duplicate tool_result ${toolUseId}`)
      }
      completedToolUses.add(toolUseId)
    }
  }
}
