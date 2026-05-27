import type {
  ContentBlock,
  ModelMessage,
  ModelToolDefinition,
} from '../providers/adapters/ModelAdapter.js'

export type ContextTokenEstimate = {
  totalTokens: number
  systemPromptTokens: number
  messageTokens: number
  toolDefinitionTokens: number
}

export type ContextWindowState = {
  tokenEstimate: number
  maxTokens: number
  percentUsed: number
  warningThresholdTokens: number
  compactThresholdTokens: number
  blockingLimitTokens: number
  isWarning: boolean
  isCompact: boolean
  isBlocking: boolean
}

const TOOL_DEFINITION_OVERHEAD_TOKENS = 500
const TOOL_USE_OVERHEAD_TOKENS = 24
const TOOL_RESULT_OVERHEAD_TOKENS = 18
const THINKING_BLOCK_OVERHEAD_TOKENS = 12
const IMAGE_OR_DOCUMENT_TOKENS = 2_000
const SERVER_TOOL_BLOCK_OVERHEAD_TOKENS = 64

export function estimateContextTokens(options: {
  systemPrompt?: string
  messages: ModelMessage[]
  tools?: ModelToolDefinition[]
}): ContextTokenEstimate {
  const systemPromptTokens = estimateTextTokens(options.systemPrompt ?? '')
  const messageTokens = estimateModelMessagesTokens(options.messages)
  const toolDefinitionTokens = estimateToolDefinitionsTokens(options.tools ?? [])

  return {
    totalTokens: systemPromptTokens + messageTokens + toolDefinitionTokens,
    systemPromptTokens,
    messageTokens,
    toolDefinitionTokens,
  }
}

export function getContextWindowState(options: {
  tokenEstimate: number
  maxTokens: number
  warningPercent?: number
  compactPercent?: number
  blockingBufferTokens?: number
}): ContextWindowState {
  const warningPercent = clampPercent(options.warningPercent ?? 70)
  const compactPercent = clampPercent(options.compactPercent ?? 85)
  const maxTokens = Math.max(1, Math.floor(options.maxTokens))
  const blockingBufferTokens = Math.max(0, Math.floor(options.blockingBufferTokens ?? 1_000))
  const warningThresholdTokens = Math.floor(maxTokens * (warningPercent / 100))
  const compactThresholdTokens = Math.floor(maxTokens * (compactPercent / 100))
  const blockingLimitTokens = Math.max(
    compactThresholdTokens,
    maxTokens - Math.min(blockingBufferTokens, Math.floor(maxTokens * 0.1)),
  )
  const tokenEstimate = Math.max(0, Math.ceil(options.tokenEstimate))
  const percentUsed = Math.round((tokenEstimate / maxTokens) * 100)

  return {
    tokenEstimate,
    maxTokens,
    percentUsed,
    warningThresholdTokens,
    compactThresholdTokens,
    blockingLimitTokens,
    isWarning: tokenEstimate >= warningThresholdTokens,
    isCompact: tokenEstimate >= compactThresholdTokens,
    isBlocking: tokenEstimate >= blockingLimitTokens,
  }
}

export function estimateModelMessagesTokens(messages: ModelMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += 4 // role and message framing overhead
    if (typeof message.content === 'string') {
      total += estimateTextTokens(message.content)
    } else {
      total += estimateContentBlocksTokens(message.content)
    }
    if (message.reasoningContent) {
      total += THINKING_BLOCK_OVERHEAD_TOKENS + estimateTextTokens(message.reasoningContent)
    }
  }
  return total
}

export function estimateToolDefinitionsTokens(tools: ModelToolDefinition[]): number {
  let total = 0
  for (const tool of tools) {
    total += TOOL_DEFINITION_OVERHEAD_TOKENS
    total += estimateTextTokens(tool.name)
    total += estimateTextTokens(tool.description)
    total += estimateJsonLikeTokens(tool.inputSchema)
  }
  return total
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let asciiLikeChars = 0
  let cjkChars = 0
  let denseJsonChars = 0
  let whitespaceChars = 0
  let otherChars = 0

  for (const char of text) {
    if (/\s/u.test(char)) {
      whitespaceChars += 1
    } else if (isCjk(char)) {
      cjkChars += 1
    } else if (/[{}[\]":,]/u.test(char)) {
      denseJsonChars += 1
    } else if (/[\x00-\x7F]/u.test(char)) {
      asciiLikeChars += 1
    } else {
      otherChars += 1
    }
  }

  return Math.ceil(
    asciiLikeChars / 4 +
    whitespaceChars / 8 +
    denseJsonChars / 2 +
    cjkChars / 1.35 +
    otherChars / 2,
  )
}

function estimateContentBlocksTokens(blocks: ContentBlock[]): number {
  let total = 0
  for (const block of blocks) {
    total += estimateUnknownBlockTokens(block)
  }
  return total
}

function estimateUnknownBlockTokens(block: unknown): number {
  if (!block || typeof block !== 'object') return estimateJsonLikeTokens(block)
  const record = block as Record<string, unknown>
  switch (record.type) {
    case 'text':
      return estimateTextTokens(String(record.text ?? ''))
    case 'tool_use':
      return TOOL_USE_OVERHEAD_TOKENS +
        estimateTextTokens(String(record.name ?? '')) +
        estimateJsonLikeTokens(record.input)
    case 'tool_result':
      return TOOL_RESULT_OVERHEAD_TOKENS +
        estimateTextTokens(String(record.content ?? '')) +
        (record.isError ? 4 : 0)
    case 'thinking':
      return THINKING_BLOCK_OVERHEAD_TOKENS + estimateTextTokens(String(record.thinking ?? ''))
    case 'redacted_thinking':
      return THINKING_BLOCK_OVERHEAD_TOKENS + estimateTextTokens(String(record.data ?? ''))
    case 'image':
    case 'document':
      return IMAGE_OR_DOCUMENT_TOKENS
    default:
      return SERVER_TOOL_BLOCK_OVERHEAD_TOKENS + estimateJsonLikeTokens(record)
  }
}

function estimateJsonLikeTokens(value: unknown): number {
  if (value === undefined || value === null) return 1
  if (typeof value === 'string') return estimateTextTokens(value)
  if (typeof value === 'number' || typeof value === 'boolean') {
    return estimateTextTokens(String(value))
  }
  try {
    return estimateTextTokens(JSON.stringify(value))
  } catch {
    return estimateTextTokens(String(value))
  }
}

function isCjk(char: string): boolean {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u.test(char)
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 85
  return Math.max(1, Math.min(99, value))
}
