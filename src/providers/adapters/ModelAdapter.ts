export type MessageRole = 'user' | 'assistant'

export type TextContentBlock = {
  type: 'text'
  text: string
}

export type ToolUseContentBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type ToolResultContentBlock = {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
  toolName?: string
}

export type ContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock

export type ModelMessage = {
  role: MessageRole
  content: string | ContentBlock[]
  reasoningContent?: string
}

export type ModelToolDefinition = {
  name: string
  description: string
  inputSchema: unknown // JSON Schema object
}

export type SystemPromptBlock = {
  text: string
  cacheable: boolean
}

export type ModelQueryParams = {
  model: string // Canonical model ID, e.g. 'anthropic/claude-3-5-sonnet'
  systemPrompt?: string
  systemPromptBlocks?: SystemPromptBlock[]
  messages: ModelMessage[]
  tools?: ModelToolDefinition[]
  temperature?: number
  maxTokens?: number
  enablePromptCaching?: boolean
  thinking?: {
    budgetTokens: number
  }
  // OpenAI-compatible structured output passthrough (used by the
  // chat completions gateway). Only honored by adapters that support
  // it (openai-compatible); others ignore it.
  responseFormat?: {
    type: 'json_object' | 'json_schema'
    json_schema?: unknown
  }
}

export type TextDelta = {
  type: 'text'
  text: string
}

export type ThinkingDelta = {
  type: 'thinking'
  text: string
}

export type ToolUseStart = {
  type: 'tool_use_start'
  id: string
  name: string
}

export type ToolUseDelta = {
  type: 'tool_use_delta'
  id: string
  inputDelta: string
}

export type ToolUseEnd = {
  type: 'tool_use_end'
  id: string
  input: unknown
}

export type UsageDelta = {
  type: 'usage'
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

export type FinishReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause'

export type FinishDelta = {
  type: 'finish'
  reason: FinishReason
}

export type StreamDelta =
  | TextDelta
  | ThinkingDelta
  | ToolUseStart
  | ToolUseDelta
  | ToolUseEnd
  | UsageDelta
  | FinishDelta

export type NonStreamCompletion = {
  content: string
  reasoningContent?: string
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

export interface ModelAdapter {
  queryStream(
    params: ModelQueryParams,
    options?: { signal?: AbortSignal; apiKey?: string; baseUrl?: string }
  ): AsyncIterable<StreamDelta>
  /**
   * Optional non-streaming fast path (llm-gateway-service-plan.md Phase 1):
   * a single round-trip completion without SSE. Consumers that do not need
   * streaming (e.g. AetheL fast-json tasks) avoid the streaming tax this way.
   * Adapters that do not implement it fall back to collecting queryStream.
   */
  queryNonStream?(
    params: ModelQueryParams,
    options?: { signal?: AbortSignal; apiKey?: string; baseUrl?: string }
  ): Promise<NonStreamCompletion>
}
