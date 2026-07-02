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
  finalCheckPhase: boolean
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
  // Phase D: when true, the one bounded read-only check has been used and the
  // runtime must fall through from `final_check` to `must_respond`.
  finalCheckUsed?: boolean
  // Phase C: top repeated tool-input entries (from findRepeatedToolInputs) to
  // surface in the model-visible execution state block when phase >= synthesize.
  repeatedToolInputs?: Array<{ name: string; inputPreview: string; count: number; latestTimestamp: string }>
}): RuntimeProviderLoopRequestState {
  const finalResponseOnlyMode = options.finalResponseOnlyMode ?? shouldEnterFinalResponseOnlyMode({
    loopCount: options.loopCount,
    maxLoops: options.maxLoops,
    remainingLoops: options.finalResponseOnlyRemainingLoops,
  })
  const finalCheckPhase = shouldEnterFinalCheckPhase({
    finalResponseOnlyMode,
    finalCheckUsed: options.finalCheckUsed,
  })
  const mustRespond = finalResponseOnlyMode && !finalCheckPhase
  // Tool visibility: intent suppression or must_respond hides all tools;
  // final_check narrows to the read-only whitelist; otherwise full list.
  const modelVisibleTools = (options.suppressToolsForUserIntent || mustRespond)
    ? []
    : finalCheckPhase
      ? options.currentToolsList.filter(tool => FINAL_CHECK_READ_ONLY.has(tool.name))
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
    finalCheckPhase,
    finalResponseOnlyRemainingLoops: options.finalResponseOnlyRemainingLoops,
    repeatedToolInputs: options.repeatedToolInputs,
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
  finalCheckPhase?: boolean
  finalResponseOnlyRemainingLoops?: number
  repeatedToolInputs?: Array<{ name: string; inputPreview: string; count: number; latestTimestamp: string }>
}): RuntimeProviderLoopState {
  const finalResponseOnlyMode = options.finalResponseOnlyMode ?? shouldEnterFinalResponseOnlyMode({
    loopCount: options.loopCount,
    maxLoops: options.maxLoops,
    remainingLoops: options.finalResponseOnlyRemainingLoops,
  })
  const finalCheckPhase = options.finalCheckPhase ?? shouldEnterFinalCheckPhase({
    finalResponseOnlyMode,
    finalCheckUsed: false,
  })
  return {
    finalResponseOnlyMode,
    finalCheckPhase,
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
      finalCheckPhase,
      finalResponseOnlyRemainingLoops: options.finalResponseOnlyRemainingLoops,
      repeatedToolInputs: options.repeatedToolInputs,
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

/**
 * Read-only tool whitelist for the `final_check` phase. Per
 * runtime-tool-loop-governance-plan.md Phase D, `final_check` allows at most
 * one bounded read-only check (Read / Grep / Glob / ListDir) before
 * `must_respond`. Write / execute / task / skill-save / MCP-write / agent
 * lifecycle tools are never granted `final_check`.
 */
export const FINAL_CHECK_READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'ListDir'])

/**
 * `final_check` is the sub-state of the finalization reserve window where the
 * one bounded read-only check has not yet been used. It is active when the
 * runtime is in the reserve window (`finalResponseOnlyMode`) AND the
 * `finalCheckUsed` flag has not been set by a prior read-only execution.
 */
export function shouldEnterFinalCheckPhase(options: {
  finalResponseOnlyMode: boolean
  finalCheckUsed?: boolean
}): boolean {
  return options.finalResponseOnlyMode && !(options.finalCheckUsed ?? false)
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
  finalCheckPhase?: boolean
  finalResponseOnlyRemainingLoops?: number
  repeatedToolInputs?: Array<{ name: string; inputPreview: string; count: number; latestTimestamp: string }>
}): string {
  const filesRead = [...state.readFileCache.keys()]
  const remaining = state.maxLoops - state.loopCount
  const pctUsed = state.contextMaxTokens > 0 ? Math.round(state.contextTokenEstimate / state.contextMaxTokens * 100) : 0
  const finalCheckPhase = state.finalCheckPhase ?? false
  let phase = 'gathering'
  if (state.finalResponseOnlyMode || remaining <= (state.finalResponseOnlyRemainingLoops ?? 3)) {
    phase = finalCheckPhase ? 'final_check' : 'must_respond'
  } else if (state.toolCallCount >= 10) {
    phase = 'synthesize'
  }

  const lines = [
    `## Execution State (iteration ${state.loopCount}/${state.maxLoops})`,
    `- Files read: ${filesRead.length > 0 ? filesRead.join(', ') : 'none'}`,
    `- Tool calls: ${state.toolCallCount} | Remaining iterations: ${remaining}`,
    `- Context: ${Math.round(state.contextTokenEstimate / 1000)}K/${Math.round(state.contextMaxTokens / 1000)}K tokens (${pctUsed}%)`,
    `- Phase: ${phase}`,
  ]
  if (phase === 'synthesize') {
    lines.push('  → Present your findings now. Only read more if critical information is missing.')
  } else if (phase === 'final_check') {
    lines.push('  → You get ONE bounded read-only check (Read/Grep/Glob/ListDir) before the runtime hides all tools. Write/execute tools are denied. Use it to confirm a missing detail, then answer.')
  } else if (phase === 'must_respond') {
    lines.push('  → Runtime has hidden all tools for this request. You MUST produce your final answer immediately.')
  }
  // Phase C: surface concrete repeated-tool evidence so the model can break
  // out of a re-run loop (e.g. re-running the same test) instead of re-running.
  if ((phase === 'synthesize' || phase === 'final_check' || phase === 'must_respond') && state.repeatedToolInputs && state.repeatedToolInputs.length > 0) {
    const top = state.repeatedToolInputs[0]!
    const preview = top.inputPreview.length <= 80 ? top.inputPreview : `${top.inputPreview.slice(0, 77)}...`
    lines.push(`- Repeated tool inputs: ${top.name} \`${preview}\` ×${top.count} — reuse the latest result instead of re-running.`)
  }
  return lines.join('\n')
}
