import type {
  ContentBlock,
  FinishReason,
  ModelMessage,
} from '../../providers/adapters/ModelAdapter.js'
import type { CacheAwareCompactUsage } from '../cacheAwareCompactPolicy.js'

export type RuntimeProviderToolCall = {
  id: string
  name: string
  partialInput: string
  input?: unknown
}

export type ToolCallTextLeakPhase = 'respond_only' | 'tools_hidden' | 'final_response_only' | 'max_loop' | 'unknown'

export type ToolCallTextLeakSuppression = {
  phase: ToolCallTextLeakPhase
  pattern: string
  redactedPreview: string
}

export type MemoryCapabilityAnswerLeakSuppression = {
  pattern: string
  redactedPreview: string
}

export type RuntimeProviderTurn = {
  assistantText: string
  reasoningText: string
  finishReason?: FinishReason
  toolCalls: RuntimeProviderToolCall[]
  toolCallTextLeakSuppression?: ToolCallTextLeakSuppression
  memoryCapabilityAnswerLeakSuppression?: MemoryCapabilityAnswerLeakSuppression
  durationMs: number
  turnFirstTokenMs?: number
  providerFirstTokenMs?: number
  streamDeltaCount: number
  charsOut: number
  usage: CacheAwareCompactUsage
}

export function resolveProviderToolCallInput(toolCall: RuntimeProviderToolCall): unknown {
  if (toolCall.input !== undefined) return toolCall.input
  if (!toolCall.partialInput) return undefined
  try {
    return JSON.parse(toolCall.partialInput)
  } catch {
    return { _parseError: true, _rawInput: toolCall.partialInput.slice(0, 500) }
  }
}

export function buildProviderAssistantMessage(turn: Pick<RuntimeProviderTurn, 'assistantText' | 'reasoningText' | 'toolCalls'>): ModelMessage {
  const assistantContent: ContentBlock[] = []
  if (turn.assistantText) {
    assistantContent.push({ type: 'text', text: turn.assistantText })
  }
  for (const toolCall of turn.toolCalls) {
    assistantContent.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.name,
      input: resolveProviderToolCallInput(toolCall),
    })
  }

  return {
    role: 'assistant',
    content: assistantContent.length > 0 ? assistantContent : turn.assistantText,
    ...(turn.reasoningText.trim() && { reasoningContent: turn.reasoningText }),
  }
}

export function buildProviderToolResultsMessage(content: ContentBlock[]): ModelMessage {
  return {
    role: 'user',
    content,
  }
}
