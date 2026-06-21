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

/**
 * Path 1 helper (2026-06-21): split a large assistant text delta
 * into smaller chunks at sentence / clause / word boundaries. The
 * Anthropic-compatible provider stream hands us one big `delta.text`
 * after all `thinking_delta` chunks (real e2e captured this for
 * DeepSeek V4 — 21 thinking_delta events followed by 1 ~80-char
 * assistant_delta). The Go TUI then sees one giant frame at the
 * end of the turn and renders it as a non-progressive dump.
 *
 * Splitting at natural boundaries preserves the model's pacing
 * (operators see commas / sentence breaks, not arbitrary mid-word
 * splits) and keeps event ordering stable. The threshold (>50
 * chars) ensures normal providers that already emit small deltas
 * aren't fragmented. We never add artificial delay — the goal is
 * better *granularity* on the wire, not slower streaming.
 *
 * Boundary priority: paragraph > sentence > clause > word > hard
 * split. Each chunk returned preserves the original spacing
 * (trailing whitespace / newlines stay attached to the chunk
 * that contains them so the joined output equals the input).
 */
function* chunkTextDelta(input: string): Generator<{ type: 'text'; text: string }> {
  if (input.length <= 50) {
    yield { type: 'text', text: input }
    return
  }
  // Boundary priority: paragraph > sentence > clause > word.
  // We pick the highest-priority boundary within the search window
  // [20, remaining.length - 30] so the chunker prefers sentence
  // breaks over word breaks even when a word break is closer to
  // position 20. The lower bound leaves the first 20 chars intact
  // (avoids fragmenting short prefixes). The upper bound leaves at
  // least 30 chars in the next iteration so the recursive cut can
  // find another boundary — without this the chunker would cut at
  // the very last punctuation mark and emit a single chunk
  // instead of N.
  //
  // Boundaries are ordered highest-priority first so the loop picks
  // the first boundary it finds in priority order. Within a single
  // priority, ties broken by lowest index (earliest break).
  const boundaries: Array<{ re: RegExp; priority: number }> = [
    { re: /\n\n+/g, priority: 0 },
    { re: /[.!?]+\s*/g, priority: 1 },
    { re: /[,;:]+\s*/g, priority: 2 },
    { re: /\s+/g, priority: 3 },
  ]
  let remaining = input
  while (remaining.length > 50) {
    const windowEnd = Math.max(20, remaining.length - 30)
    let chosen: { re: RegExp; priority: number; index: number; len: number } | null = null
    for (const b of boundaries) {
      // Search for the first match whose start index is in
      // [20, windowEnd]. Setting `lastIndex = 20` before exec
      // makes the regex engine skip past any earlier matches.
      b.re.lastIndex = 20
      const m = b.re.exec(remaining)
      if (m && m.index >= 20 && m.index <= windowEnd) {
        if (chosen === null || b.priority < chosen.priority ||
            (b.priority === chosen.priority && m.index < chosen.index)) {
          chosen = { re: b.re, priority: b.priority, index: m.index, len: m[0].length }
        }
      }
    }
    let cutAt: number
    let cutLen: number
    if (chosen !== null) {
      cutAt = chosen.index
      cutLen = chosen.len
    } else {
      // No natural boundary in [20, windowEnd] — hard split at
      // 60 chars to keep chunks bounded.
      cutAt = 60
      cutLen = 0
    }
    const chunk = remaining.slice(0, cutAt + cutLen)
    if (chunk.length > 0) yield { type: 'text', text: chunk }
    remaining = remaining.slice(cutAt + cutLen)
  }
  if (remaining.length > 0) yield { type: 'text', text: remaining }
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
              // Path 1 fix (2026-06-21): some providers (Anthropic-
              // compatible DeepSeek V4 captured in real e2e
              // session_ff3a874d-4d25-4e53-b0eb-02744b6bfaa2) emit
              // the entire assistant answer as a single large
              // text_delta AFTER all thinking_delta. The Go TUI
              // then sees one giant assistant_delta frame at the
              // end of the turn and renders it as a single
              // non-progressive dump — the operator can't see the
              // model "writing". Split long text deltas at
              // sentence/word boundaries so the TUI gets multiple
              // smaller frames and can show progressive text.
              //
              // Threshold: only chunk deltas > 50 chars; small
              // deltas are emitted verbatim to avoid fragmenting
              // normal streaming providers.
              const text = delta.text
              if (text.length > 50) {
                yield* chunkTextDelta(text)
              } else {
                yield {
                  type: 'text',
                  text,
                }
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
