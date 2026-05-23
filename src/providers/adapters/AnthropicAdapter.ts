import type {
  ModelAdapter,
  ModelQueryParams,
  StreamDelta,
  ModelMessage,
  ContentBlock,
} from './ModelAdapter.js'
import { parseSSE } from './sse.js'
import { ProviderError } from '../../shared/errors.js'

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
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': betas.join(','),
      ...getCustomHeaders(),
    }

    // Convert system prompt to block format supporting caching
    let formattedSystemPrompt: any[] | undefined
    if (params.systemPrompt) {
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

    const body: any = {
      model: targetModel,
      messages: formattedMessages,
      ...(formattedSystemPrompt && { system: formattedSystemPrompt }),
      ...(mappedTools && mappedTools.length > 0 && { tools: mappedTools }),
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.maxTokens !== undefined
        ? { max_tokens: params.maxTokens }
        : { max_tokens: 4096 }),
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

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new ProviderError('anthropic', response.status, errorText)
    }

    if (!response.body) {
      throw new Error('Response body is not readable')
    }

    const activeToolUses = new Map<
      number,
      { id: string; name: string; inputBuffer: string }
    >()

    for await (const sse of parseSSE(response.body)) {
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
      } else if (sse.event === 'content_block_start') {
        const data = JSON.parse(sse.data)
        const index = data.index
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
            yield {
              type: 'text',
              text: delta.text,
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
      } else if (sse.event === 'content_block_stop') {
        const data = JSON.parse(sse.data)
        const index = data.index
        const toolUse = activeToolUses.get(index)
        if (toolUse) {
          let parsedInput: unknown = {}
          try {
            parsedInput = JSON.parse(toolUse.inputBuffer)
          } catch {
            try {
              parsedInput = (0, eval)(`(${toolUse.inputBuffer})`)
            } catch {
              parsedInput = { raw: toolUse.inputBuffer }
            }
          }
          yield {
            type: 'tool_use_end',
            id: toolUse.id,
            input: parsedInput,
          }
          activeToolUses.delete(index)
        }
      }
    }
  }
}
