import type { NexusEvent } from '../shared/events.js'
import type {
  ModelAdapter,
  ModelQueryParams,
} from '../providers/adapters/ModelAdapter.js'
import {
  streamProviderTurn,
  type RuntimeProviderTurn,
  type ToolCallTextLeakPhase,
} from './runtimePipeline.js'

type ProviderAdapterOptions = Parameters<ModelAdapter['queryStream']>[1]

export type ProviderTurnDriverOptions = {
  adapter: ModelAdapter
  queryParams: ModelQueryParams
  adapterOptions?: ProviderAdapterOptions
  sessionId: string
  signal?: AbortSignal
  executionStartMs: number
  queryStartMs: number
  finalResponseOnlyMode: boolean
  suppressToolsForCurrentIntent: boolean
  modelVisibleToolCount: number
  memoryCapabilityAnswerLeakGuard: boolean
}

export class ProviderTurnDriver {
  run(options: ProviderTurnDriverOptions): AsyncGenerator<NexusEvent, RuntimeProviderTurn> {
    const toolCallTextLeakPhase = resolveToolCallTextLeakPhase({
      finalResponseOnlyMode: options.finalResponseOnlyMode,
      suppressToolsForCurrentIntent: options.suppressToolsForCurrentIntent,
      modelVisibleToolCount: options.modelVisibleToolCount,
    })
    return streamProviderTurn({
      stream: options.adapter.queryStream(options.queryParams, options.adapterOptions),
      sessionId: options.sessionId,
      signal: options.signal,
      executionStartMs: options.executionStartMs,
      queryStartMs: options.queryStartMs,
      ...(toolCallTextLeakPhase && { toolCallTextLeakGuard: { phase: toolCallTextLeakPhase } }),
      ...(options.memoryCapabilityAnswerLeakGuard && { memoryCapabilityAnswerLeakGuard: true }),
    })
  }
}

function resolveToolCallTextLeakPhase(options: {
  finalResponseOnlyMode: boolean
  suppressToolsForCurrentIntent: boolean
  modelVisibleToolCount: number
}): ToolCallTextLeakPhase | undefined {
  if (options.finalResponseOnlyMode) return 'final_response_only'
  if (options.suppressToolsForCurrentIntent) return 'respond_only'
  if (options.modelVisibleToolCount === 0) return 'tools_hidden'
  return undefined
}
