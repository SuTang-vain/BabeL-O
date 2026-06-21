import type {
  ModelMessage,
  ModelQueryParams,
  ModelToolDefinition,
} from '../../providers/adapters/ModelAdapter.js'
import type { CacheAwareCompactPolicy } from '../cacheAwareCompactPolicy.js'
import { normalizeMessages } from '../messageNormalizer.js'
import { computePrefixCacheDiagnostics, type PrefixCacheDiagnostics } from '../prefixCache.js'
import type { ReadFileCacheEntry } from '../runtimeToolLoop.js'
import { estimateContextTokens, getContextWindowState, type ContextWindowState } from '../tokenEstimator.js'

export type RuntimeProviderLoopState = {
  finalResponseOnlyMode: boolean
  turnContextCharsIn: number
  executionStateBlock: string
}

export type RuntimeProviderLoopRequestState = RuntimeProviderLoopState & {
  currentToolsList: ModelToolDefinition[]
  modelVisibleTools: ModelToolDefinition[]
  contextWindowState: ContextWindowState
}

export function buildProviderLoopRequestState(options: {
  loopCount: number
  maxLoops: number
  readFileCache: Map<string, ReadFileCacheEntry>
  toolCallCount: number
  systemPrompt: string
  messages: ModelMessage[]
  currentToolsList: ModelToolDefinition[]
  contextMaxTokens: number
  warningPercent: number
  compactPercent: number
  suppressToolsForUserIntent: boolean
  cacheAwareCompactPolicy?: CacheAwareCompactPolicy
  finalResponseOnlyMode?: boolean
  finalResponseOnlyRemainingLoops?: number
}): RuntimeProviderLoopRequestState {
  const finalResponseOnlyMode = options.finalResponseOnlyMode ?? shouldEnterFinalResponseOnlyMode({
    loopCount: options.loopCount,
    maxLoops: options.maxLoops,
    remainingLoops: options.finalResponseOnlyRemainingLoops,
  })
  const modelVisibleTools = finalResponseOnlyMode || options.suppressToolsForUserIntent
    ? []
    : options.currentToolsList
  const contextTokenEstimate = estimateContextTokens({
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    tools: modelVisibleTools,
    conservative: true,
  }).totalTokens
  const contextWindowState = getContextWindowState({
    tokenEstimate: contextTokenEstimate,
    maxTokens: options.cacheAwareCompactPolicy?.effectiveContextCeiling ?? options.contextMaxTokens,
    warningPercent: options.cacheAwareCompactPolicy?.warningThresholdPercent ?? options.warningPercent,
    compactPercent: options.cacheAwareCompactPolicy?.compactThresholdPercent ?? options.compactPercent,
  })
  const loopState = buildProviderLoopState({
    loopCount: options.loopCount,
    maxLoops: options.maxLoops,
    readFileCache: options.readFileCache,
    toolCallCount: options.toolCallCount,
    contextTokenEstimate: contextWindowState.tokenEstimate,
    contextMaxTokens: contextWindowState.maxTokens,
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    finalResponseOnlyMode,
    finalResponseOnlyRemainingLoops: options.finalResponseOnlyRemainingLoops,
  })

  return {
    ...loopState,
    currentToolsList: options.currentToolsList,
    modelVisibleTools,
    contextWindowState,
  }
}

export function buildProviderQueryParams(options: {
  modelId: string
  systemPrompt: string
  systemPromptBlocks?: { text: string; cacheable: boolean }[]
  executionStateBlock: string
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
  maxTokens?: number
  providerId: string
  thinkingBudget?: number
}): ModelQueryParams {
  const systemPromptBlocks = buildProviderSystemPromptBlocks(options.systemPromptBlocks, options.executionStateBlock)
  return {
    model: options.modelId,
    systemPrompt: options.systemPrompt,
    systemPromptBlocks,
    messages: normalizeMessages(options.messages),
    tools: options.tools,
    maxTokens: options.maxTokens,
    enablePromptCaching: options.providerId === 'anthropic',
    ...(options.thinkingBudget !== undefined &&
      options.thinkingBudget > 0 && {
        thinking: { budgetTokens: options.thinkingBudget },
      }),
  }
}

export function buildProviderSystemPromptBlocks(
  systemPromptBlocks: { text: string; cacheable: boolean }[] | undefined,
  executionStateBlock: string,
): { text: string; cacheable: boolean }[] {
  return [
    ...(systemPromptBlocks ?? []),
    { text: executionStateBlock, cacheable: false },
  ]
}

export function computeProviderPrefixCacheDiagnostics(options: {
  systemPromptBlocks?: { text: string; cacheable: boolean }[]
  executionStateBlock: string
  tools: ModelToolDefinition[]
}): PrefixCacheDiagnostics {
  return computePrefixCacheDiagnostics({
    systemPromptBlocks: buildProviderSystemPromptBlocks(options.systemPromptBlocks, options.executionStateBlock),
    tools: options.tools,
  })
}

export function buildProviderLoopState(options: {
  loopCount: number
  maxLoops: number
  readFileCache: Map<string, ReadFileCacheEntry>
  toolCallCount: number
  contextTokenEstimate: number
  contextMaxTokens: number
  systemPrompt: string
  messages: ModelMessage[]
  finalResponseOnlyMode?: boolean
  finalResponseOnlyRemainingLoops?: number
}): RuntimeProviderLoopState {
  const finalResponseOnlyMode = options.finalResponseOnlyMode ?? shouldEnterFinalResponseOnlyMode({
    loopCount: options.loopCount,
    maxLoops: options.maxLoops,
    remainingLoops: options.finalResponseOnlyRemainingLoops,
  })
  return {
    finalResponseOnlyMode,
    turnContextCharsIn: countRuntimeTurnContextChars({
      systemPrompt: options.systemPrompt,
      messages: options.messages,
    }),
    executionStateBlock: buildRuntimeExecutionStateBlock({
      loopCount: options.loopCount,
      maxLoops: options.maxLoops,
      readFileCache: options.readFileCache,
      toolCallCount: options.toolCallCount,
      contextTokenEstimate: options.contextTokenEstimate,
      contextMaxTokens: options.contextMaxTokens,
      finalResponseOnlyMode,
      finalResponseOnlyRemainingLoops: options.finalResponseOnlyRemainingLoops,
    }),
  }
}

export function shouldEnterFinalResponseOnlyMode(options: {
  loopCount: number
  maxLoops: number
  remainingLoops?: number
}): boolean {
  return options.maxLoops - options.loopCount <= (options.remainingLoops ?? 3)
}

export function countRuntimeTurnContextChars(options: {
  systemPrompt: string
  messages: ModelMessage[]
}): number {
  let chars = options.systemPrompt.length
  for (const msg of options.messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          chars += block.text.length
        } else if (block.type === 'tool_result') {
          chars += block.content.length
        }
      }
    }
  }
  return chars
}

export function buildRuntimeExecutionStateBlock(state: {
  loopCount: number
  maxLoops: number
  readFileCache: Map<string, ReadFileCacheEntry>
  toolCallCount: number
  contextTokenEstimate: number
  contextMaxTokens: number
  finalResponseOnlyMode?: boolean
  finalResponseOnlyRemainingLoops?: number
}): string {
  const filesRead = [...state.readFileCache.keys()]
  const remaining = state.maxLoops - state.loopCount
  const pctUsed = state.contextMaxTokens > 0 ? Math.round(state.contextTokenEstimate / state.contextMaxTokens * 100) : 0
  let phase = 'gathering'
  if (state.finalResponseOnlyMode || remaining <= (state.finalResponseOnlyRemainingLoops ?? 3)) phase = 'must_respond'
  else if (state.toolCallCount >= 10) phase = 'synthesize'

  const lines = [
    `## Execution State (iteration ${state.loopCount}/${state.maxLoops})`,
    `- Files read: ${filesRead.length > 0 ? filesRead.join(', ') : 'none'}`,
    `- Tool calls: ${state.toolCallCount} | Remaining iterations: ${remaining}`,
    `- Context: ${Math.round(state.contextTokenEstimate / 1000)}K/${Math.round(state.contextMaxTokens / 1000)}K tokens (${pctUsed}%)`,
    `- Phase: ${phase}`,
  ]
  if (phase === 'synthesize') {
    lines.push('  → Present your findings now. Only read more if critical information is missing.')
  } else if (phase === 'must_respond') {
    lines.push('  → Runtime has hidden all tools for this request. You MUST produce your final answer immediately.')
  }
  return lines.join('\n')
}
