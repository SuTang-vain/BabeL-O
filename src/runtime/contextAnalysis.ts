import type { NexusEvent } from '../shared/events.js'
import type {
  ModelMessage,
  ModelToolDefinition,
} from '../providers/adapters/ModelAdapter.js'
import type { RuntimeExecuteOptions } from './Runtime.js'
import {
  assembleContext,
  isRecoveryBoundaryError,
  type AssembledContext,
} from './contextAssembler.js'
import { shouldSuppressToolsForIntent } from './intentGuidance.js'
import {
  estimateContextTokens,
  getContextWindowState,
  type ContextTokenEstimate,
  type ContextWindowState,
} from './tokenEstimator.js'
import { getAutoCompactDecision } from './compact.js'
import {
  buildCacheAwareCompactPolicy,
  computeSystemPromptCacheableRatio,
  summarizeCacheAwareUsage,
  type CacheAwareCompactPolicy,
} from './cacheAwareCompactPolicy.js'
import { buildSessionMemoryLiteStatus, type SessionMemoryLiteStatus } from './sessionMemoryLite.js'
import { buildRuntimeDiagnostics, statusFromSignals, type RuntimeDiagnosticsEnvelope } from './runtimeDiagnostics.js'
import { extractAbsolutePaths } from './systemPromptBuilder.js'
import type { ContextSelectionDiagnostics } from './contextManager.js'

export type ContextDiagnosticSignal = {
  type: 'near_capacity' | 'large_tool_result' | 'repeated_tool_input' | 'memory_bloat' | 'auto_compact_fuse' | 'microcompact_savings' | 'retained_segment_fallback' | 'resume_recovery_boundary'
  severity: 'info' | 'warning' | 'critical'
  message: string
}

export type ContextAnalysisDiagnostics = {
  remainingTokens: number
  remainingPercent: number
  compactRemainingTokens: number
  blockingRemainingTokens: number
  usageSummary: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
    estimatedReasoningTokens: number
  }
  autoCompact: {
    enabled: boolean
    shouldCompact: boolean
    thresholdPercent: number
    failureCount: number
    failureLimit: number
    fuseOpen: boolean
  }
  memory: {
    projectMemoryChars: number
    projectMemoryBudgetChars: number
    pressurePercent: number
    truncated: boolean
  }
  sessionMemoryLite: SessionMemoryLiteStatus
  compactRetention: {
    hasBoundary: boolean
    retainedEventCount: number
    retainedSegmentValid: boolean
    retainedSegmentWarning: string
    fallbackToFullHistory: boolean
  }
  resumeRecovery: {
    active: boolean
    code: string
    timestamp: string
    message: string
  }
  workingSetPaths: Array<{
    path: string
    source: 'prompt' | 'user_message' | 'tool_input'
    touches: number
    latestTimestamp: string
  }>
  autoCompactFloor: {
    thresholdPercent: number
    thresholdTokens: number
    currentTokens: number
    remainingTokens: number
    assemblyBudgetTokens: number
    explanation: string
  }
  cacheEconomics: {
    cacheReadRatio: number
    cacheableSystemPromptRatio: number
    cachePreservationMode: boolean
    longContextUtilizationMode: boolean
    effectiveContextCeiling: number
    legacyContextCeiling: number
    reservedOutputTokens: number
    providerSafetyBufferTokens: number
    reason: string
  }
  compactTokenDelta: {
    hasBoundary: boolean
    beforeEventCount: number
    afterEventCount: number
    eventCountDelta: number
    beforeEstimatedTokens: number
    afterEstimatedTokens: number
    estimatedTokensSaved: number
  }
  largeToolResults: Array<{
    name: string
    toolUseId: string
    inputPreview: string
    outputChars: number
    timestamp: string
  }>
  repeatedToolInputs: Array<{
    name: string
    inputPreview: string
    count: number
    latestTimestamp: string
  }>
  selection: ContextSelectionDiagnostics
  signals: ContextDiagnosticSignal[]
}

export type ContextAnalysisDiagnosticEnvelope = RuntimeDiagnosticsEnvelope<{
  sessionId: string
  cwd: string
  modelId: string
  maxTokens: number
  tokenEstimate: number
  remainingTokens: number
  compactHasBoundary: boolean
  toolsVisible: boolean
  retainedContextItems: number
  droppedContextItems: number
}>

export type ContextAnalysis = {
  type: 'context_analysis'
  sessionId: string
  cwd: string
  modelId: string
  budget: AssembledContext['budget']
  estimate: ContextTokenEstimate
  window: ContextWindowState
  sections: {
    systemPromptChars: number
    projectMemoryChars: number
    sessionSummaryChars: number
    activeSkillsChars: number
    messageCount: number
    selectedEventCount: number
    omittedEventCount: number
    snippedEventCount: number
    microcompactedEventCount: number
    microcompactDeduplicatedToolResultCount: number
    microcompactBytesSaved: number
    microcompactEstimatedTokensSaved: number
    memoryTruncated: boolean
    toolDefinitionCount: number
  }
  compact: {
    hasBoundary: boolean
    trigger?: 'manual' | 'auto' | 'reactive'
    summaryChars?: number
    retainedEventCount: number
    retainedSegmentValid: boolean
    retainedSegmentWarning: string
    beforeEventCount?: number
    afterEventCount?: number
  }
  postCompactState: AssembledContext['postCompactState']
  userIntentGuidance: AssembledContext['userIntentGuidance']
  runtimePolicy: {
    toolsVisible: boolean
    toolSuppressionReason: string
    recoveryBoundaryActive: boolean
    recoveryBoundaryCode: string
    recoveryBoundaryTimestamp: string
    recoveryBoundaryMessage: string
  }
  diagnostics: ContextAnalysisDiagnostics
  diagnostic: ContextAnalysisDiagnosticEnvelope
  recommendations: string[]
}

export async function analyzeContext(options: {
  runtimeOptions: RuntimeExecuteOptions
  events: NexusEvent[]
  modelId: string
  buildSystemPrompt: (
    options: RuntimeExecuteOptions,
    projectMemory?: string,
    sessionSummary?: string,
    activeSkills?: string,
  ) => string
  mapEventsToMessages: (events: NexusEvent[], initialPrompt: string) => ModelMessage[]
  tools?: ModelToolDefinition[]
  warningPercent?: number
}): Promise<ContextAnalysis> {
  const assembled = await assembleContext({
    runtimeOptions: options.runtimeOptions,
    events: options.events,
    modelId: options.modelId,
    buildSystemPrompt: options.buildSystemPrompt,
    mapEventsToMessages: options.mapEventsToMessages,
  })
  const estimate = estimateContextTokens({
    systemPrompt: assembled.systemPrompt,
    messages: assembled.messages,
    tools: options.tools ?? [],
    conservative: true,
  })
  const cacheAwareCompactPolicy = buildCacheAwareCompactPolicy({
    modelId: options.modelId,
    tokenEstimate: estimate.totalTokens,
    usage: summarizeCacheAwareUsage(options.events),
    cacheableSystemPromptRatio: computeSystemPromptCacheableRatio(assembled.systemPromptBlocks),
    warningPercent: options.warningPercent ?? 70,
    maxOutputTokens: options.runtimeOptions.maxOutputTokens,
    providerContextError: hasRecentProviderContextError(options.events),
  })
  const window = getContextWindowState({
    tokenEstimate: estimate.totalTokens,
    maxTokens: cacheAwareCompactPolicy.effectiveContextCeiling,
    warningPercent: cacheAwareCompactPolicy.warningThresholdPercent,
    compactPercent: cacheAwareCompactPolicy.compactThresholdPercent,
  })
  const runtimePolicy = buildRuntimePolicyDiagnostics(assembled.userIntentGuidance, options.events)
  const autoCompact = getAutoCompactDecision({
    events: options.events,
    tokenEstimate: window.tokenEstimate,
    maxTokens: window.maxTokens,
    thresholdPercent: cacheAwareCompactPolicy.compactThresholdPercent,
  })
  const compact = assembled.compactBoundary
    ? {
        hasBoundary: true,
        trigger: assembled.compactBoundary.trigger,
        summaryChars: assembled.compactBoundary.summaryChars,
        retainedEventCount: assembled.compactRetainedEventCount,
        retainedSegmentValid: assembled.compactRetainedSegmentValid,
        retainedSegmentWarning: assembled.compactRetainedSegmentWarning,
        beforeEventCount: assembled.compactBoundary.beforeEventCount,
        afterEventCount: assembled.compactBoundary.afterEventCount,
      }
    : {
        hasBoundary: false,
        retainedEventCount: 0,
        retainedSegmentValid: true,
        retainedSegmentWarning: '',
      }
  const diagnostics = buildContextDiagnostics({
    events: options.events,
    prompt: options.runtimeOptions.prompt,
    assembled,
    window,
    autoCompact,
    compact,
    runtimePolicy,
    cacheAwareCompactPolicy,
  })
  const recommendations = buildContextRecommendations({ window, hasCompactBoundary: compact.hasBoundary, diagnostics })

  return {
    type: 'context_analysis',
    sessionId: options.runtimeOptions.sessionId,
    cwd: options.runtimeOptions.cwd,
    modelId: options.modelId,
    budget: assembled.budget,
    estimate,
    window,
    sections: {
      systemPromptChars: assembled.systemPrompt.length,
      projectMemoryChars: assembled.projectMemory.length,
      sessionSummaryChars: assembled.sessionSummary.length,
      activeSkillsChars: assembled.activeSkills.length,
      messageCount: assembled.messages.length,
      selectedEventCount: assembled.selectedEventCount,
      omittedEventCount: assembled.omittedEventCount,
      snippedEventCount: assembled.snippedEventCount,
      microcompactedEventCount: assembled.microcompactedEventCount,
      microcompactDeduplicatedToolResultCount: assembled.microcompactMetrics.deduplicatedToolResultCount,
      microcompactBytesSaved: assembled.microcompactMetrics.bytesSaved,
      microcompactEstimatedTokensSaved: assembled.microcompactMetrics.estimatedTokensSaved,
      memoryTruncated: assembled.memoryTruncated,
      toolDefinitionCount: options.tools?.length ?? 0,
    },
    compact,
    postCompactState: assembled.postCompactState,
    userIntentGuidance: assembled.userIntentGuidance,
    runtimePolicy,
    diagnostics,
    diagnostic: buildContextDiagnosticEnvelope({
      sessionId: options.runtimeOptions.sessionId,
      cwd: options.runtimeOptions.cwd,
      modelId: options.modelId,
      window,
      compact,
      runtimePolicy,
      diagnostics,
      recommendations,
    }),
    recommendations,
  }
}

function buildContextDiagnosticEnvelope(options: {
  sessionId: string
  cwd: string
  modelId: string
  window: ContextWindowState
  compact: ContextAnalysis['compact']
  runtimePolicy: ContextAnalysis['runtimePolicy']
  diagnostics: ContextAnalysisDiagnostics
  recommendations: string[]
}): ContextAnalysisDiagnosticEnvelope {
  return buildRuntimeDiagnostics({
    domain: 'context',
    name: 'context_analysis',
    status: statusFromSignals(options.diagnostics.signals, options.window.isBlocking ? 'critical' : 'ok'),
    summary: `context ${options.window.tokenEstimate}/${options.window.maxTokens} tokens; ${options.diagnostics.remainingTokens} remaining`,
    signals: options.diagnostics.signals,
    recommendations: options.recommendations,
    details: {
      sessionId: options.sessionId,
      cwd: options.cwd,
      modelId: options.modelId,
      maxTokens: options.window.maxTokens,
      tokenEstimate: options.window.tokenEstimate,
      remainingTokens: options.diagnostics.remainingTokens,
      compactHasBoundary: options.compact.hasBoundary,
      toolsVisible: options.runtimePolicy.toolsVisible,
      retainedContextItems: options.diagnostics.selection.retained.length,
      droppedContextItems: options.diagnostics.selection.dropped.length,
    },
  })
}

function buildRuntimePolicyDiagnostics(
  guidance: AssembledContext['userIntentGuidance'],
  events: NexusEvent[],
): ContextAnalysis['runtimePolicy'] {
  const toolsVisible = !shouldSuppressToolsForIntent(guidance)
  const recoveryBoundary = findLatestRecoveryBoundary(events)
  return {
    toolsVisible,
    toolSuppressionReason: toolsVisible ? '' : `intent:${guidance.intent}:${guidance.actionHint}`,
    recoveryBoundaryActive: recoveryBoundary !== null,
    recoveryBoundaryCode: recoveryBoundary?.code ?? '',
    recoveryBoundaryTimestamp: recoveryBoundary?.timestamp ?? '',
    recoveryBoundaryMessage: recoveryBoundary?.message ?? '',
  }
}

function findLatestRecoveryBoundary(events: NexusEvent[]): Extract<NexusEvent, { type: 'error' }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'error' && isRecoveryBoundaryError(event.code)) {
      return event
    }
  }
  return null
}

function hasRecentProviderContextError(events: NexusEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue
    if (event.type === 'compact_boundary') return false
    if (event.type !== 'error') continue
    if (event.code === 'CONTEXT_LIMIT_EXCEEDED') return true
    const text = `${event.code} ${event.message}`.toLowerCase()
    if (text.includes('context') && (text.includes('too long') || text.includes('limit') || text.includes('window'))) return true
  }
  return false
}

function buildContextDiagnostics(options: {
  events: NexusEvent[]
  prompt: string
  assembled: AssembledContext
  window: ContextWindowState
  autoCompact: ContextAnalysisDiagnostics['autoCompact']
  compact: ContextAnalysis['compact']
  runtimePolicy: ContextAnalysis['runtimePolicy']
  cacheAwareCompactPolicy: CacheAwareCompactPolicy
}): ContextAnalysisDiagnostics {
  const remainingTokens = Math.max(0, options.window.maxTokens - options.window.tokenEstimate)
  const diagnostics: ContextAnalysisDiagnostics = {
    remainingTokens,
    remainingPercent: Math.round((remainingTokens / Math.max(1, options.window.maxTokens)) * 100),
    compactRemainingTokens: Math.max(0, options.window.compactThresholdTokens - options.window.tokenEstimate),
    blockingRemainingTokens: Math.max(0, options.window.blockingLimitTokens - options.window.tokenEstimate),
    usageSummary: summarizeUsage(options.events),
    autoCompact: options.autoCompact,
    memory: {
      projectMemoryChars: options.assembled.projectMemory.length,
      projectMemoryBudgetChars: options.assembled.budget.layerBudgets.memory * 4,
      pressurePercent: Math.round((options.assembled.projectMemory.length / Math.max(1, options.assembled.budget.layerBudgets.memory * 4)) * 100),
      truncated: options.assembled.memoryTruncated,
    },
    sessionMemoryLite: buildSessionMemoryLiteStatus(options.events),
    compactRetention: {
      hasBoundary: options.compact.hasBoundary,
      retainedEventCount: options.compact.retainedEventCount,
      retainedSegmentValid: options.compact.retainedSegmentValid,
      retainedSegmentWarning: options.compact.retainedSegmentWarning,
      fallbackToFullHistory: options.compact.hasBoundary && !options.compact.retainedSegmentValid,
    },
    resumeRecovery: {
      active: options.runtimePolicy.recoveryBoundaryActive,
      code: options.runtimePolicy.recoveryBoundaryCode,
      timestamp: options.runtimePolicy.recoveryBoundaryTimestamp,
      message: options.runtimePolicy.recoveryBoundaryMessage,
    },
    workingSetPaths: findWorkingSetPaths(options.events, options.prompt),
    autoCompactFloor: buildAutoCompactFloor(options.window, options.autoCompact, options.assembled, options.cacheAwareCompactPolicy),
    cacheEconomics: buildCacheEconomicsDiagnostics(options.cacheAwareCompactPolicy),
    compactTokenDelta: buildCompactTokenDelta(options.events, options.compact, options.window),
    largeToolResults: findLargeToolResults(options.events, options.assembled.budget.snipToolOutputChars),
    repeatedToolInputs: findRepeatedToolInputs(options.events),
    selection: options.assembled.selectionDiagnostics,
    signals: [],
  }

  diagnostics.signals = buildDiagnosticSignals({
    diagnostics,
    window: options.window,
    microcompactMetrics: options.assembled.microcompactMetrics,
  })
  return diagnostics
}

function summarizeUsage(events: NexusEvent[]): ContextAnalysisDiagnostics['usageSummary'] {
  return events.reduce<ContextAnalysisDiagnostics['usageSummary']>((summary, event) => {
    if (event.type === 'usage') {
      summary.inputTokens += event.inputTokens
      summary.outputTokens += event.outputTokens
      summary.cacheCreationInputTokens += event.cacheCreationInputTokens ?? 0
      summary.cacheReadInputTokens += event.cacheReadInputTokens ?? 0
    } else if (event.type === 'thinking_delta') {
      summary.estimatedReasoningTokens += Math.ceil(event.text.length / 4)
    }
    return summary
  }, {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    estimatedReasoningTokens: 0,
  })
}

function findWorkingSetPaths(events: NexusEvent[], prompt: string): ContextAnalysisDiagnostics['workingSetPaths'] {
  const paths = new Map<string, {
    path: string
    source: 'prompt' | 'user_message' | 'tool_input'
    touches: number
    latestTimestamp: string
    latestIndex: number
  }>()
  const addPath = (path: string, source: 'prompt' | 'user_message' | 'tool_input', timestamp: string, index: number) => {
    const normalized = normalizePathCandidate(path)
    if (!normalized) return
    const existing = paths.get(normalized)
    if (existing) {
      existing.touches += 1
      if (index >= existing.latestIndex) {
        existing.source = source
        existing.latestTimestamp = timestamp
        existing.latestIndex = index
      }
    } else {
      paths.set(normalized, {
        path: normalized,
        source,
        touches: 1,
        latestTimestamp: timestamp,
        latestIndex: index,
      })
    }
  }

  for (const path of findPathCandidatesInText(prompt)) {
    addPath(path, 'prompt', '', events.length)
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'user_message') {
      for (const path of findPathCandidatesInText(event.text)) {
        addPath(path, 'user_message', event.timestamp, index)
      }
    } else if (event?.type === 'tool_started') {
      for (const path of findPathCandidatesInToolInput(event.input)) {
        addPath(path, 'tool_input', event.timestamp, index)
      }
    }
  }

  return [...paths.values()]
    .sort((left, right) => {
      if (right.touches !== left.touches) return right.touches - left.touches
      if (right.latestIndex !== left.latestIndex) return right.latestIndex - left.latestIndex
      return left.path.localeCompare(right.path)
    })
    .slice(0, 16)
    .map(entry => ({
      path: entry.path,
      source: entry.source,
      touches: entry.touches,
      latestTimestamp: entry.latestTimestamp,
    }))
}

function buildAutoCompactFloor(
  window: ContextWindowState,
  autoCompact: ContextAnalysisDiagnostics['autoCompact'],
  assembled: AssembledContext,
  policy: CacheAwareCompactPolicy,
): ContextAnalysisDiagnostics['autoCompactFloor'] {
  const thresholdTokens = Math.floor(window.maxTokens * (autoCompact.thresholdPercent / 100))
  return {
    thresholdPercent: autoCompact.thresholdPercent,
    thresholdTokens,
    currentTokens: window.tokenEstimate,
    remainingTokens: Math.max(0, thresholdTokens - window.tokenEstimate),
    assemblyBudgetTokens: assembled.budget.maxTokens,
    explanation: `Auto compact is measured against the cache-aware effective ceiling (${policy.effectiveContextCeiling} tokens): ${policy.reason}`,
  }
}

function buildCacheEconomicsDiagnostics(policy: CacheAwareCompactPolicy): ContextAnalysisDiagnostics['cacheEconomics'] {
  return {
    cacheReadRatio: policy.cacheReadRatio,
    cacheableSystemPromptRatio: policy.cacheableSystemPromptRatio,
    cachePreservationMode: policy.cachePreservationMode,
    longContextUtilizationMode: policy.longContextUtilizationMode,
    effectiveContextCeiling: policy.effectiveContextCeiling,
    legacyContextCeiling: policy.legacyContextCeiling,
    reservedOutputTokens: policy.reservedOutputTokens,
    providerSafetyBufferTokens: policy.providerSafetyBufferTokens,
    reason: policy.reason,
  }
}

function buildCompactTokenDelta(
  events: NexusEvent[],
  compact: ContextAnalysis['compact'],
  window: ContextWindowState,
): ContextAnalysisDiagnostics['compactTokenDelta'] {
  if (!compact.hasBoundary) {
    return {
      hasBoundary: false,
      beforeEventCount: 0,
      afterEventCount: 0,
      eventCountDelta: 0,
      beforeEstimatedTokens: 0,
      afterEstimatedTokens: window.tokenEstimate,
      estimatedTokensSaved: 0,
    }
  }

  const boundaryIndex = findLatestCompactBoundaryIndex(events)
  const boundary = boundaryIndex >= 0 ? events[boundaryIndex] : undefined
  const beforeEvents = boundaryIndex >= 0 ? events.slice(0, boundaryIndex) : []
  const retainedEvents = boundary?.type === 'compact_boundary'
    ? normalizeRetainedEvents((boundary as { retainedEvents?: unknown[] }).retainedEvents)
    : []
  const beforeEstimatedTokens = estimateEventsAsTokens(beforeEvents)
  const afterEstimatedTokens = Math.ceil((compact.summaryChars ?? 0) / 4) + estimateEventsAsTokens(retainedEvents)
  const beforeEventCount = compact.beforeEventCount ?? beforeEvents.length
  const afterEventCount = compact.afterEventCount ?? retainedEvents.length + 1

  return {
    hasBoundary: true,
    beforeEventCount,
    afterEventCount,
    eventCountDelta: Math.max(0, beforeEventCount - afterEventCount),
    beforeEstimatedTokens,
    afterEstimatedTokens,
    estimatedTokensSaved: Math.max(0, beforeEstimatedTokens - afterEstimatedTokens),
  }
}

function findPathCandidatesInText(text: string): string[] {
  const paths = new Set<string>()
  for (const path of extractAbsolutePaths(text)) {
    if (isStandalonePathInText(text, path)) paths.add(path)
  }
  const pathLikePattern = /(?:\.{1,2}\/|\/)?[A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+-]+)+(?:\.[A-Za-z0-9_+-]+)?|[A-Za-z0-9_@+-]+\.[A-Za-z0-9_+-]{1,12}/g
  for (const match of text.matchAll(pathLikePattern)) {
    paths.add(match[0])
  }
  return [...paths]
}

function findPathCandidatesInToolInput(input: unknown): string[] {
  const paths: string[] = []
  const visit = (value: unknown, key: string, depth: number) => {
    if (depth > 5) return
    if (typeof value === 'string') {
      const lowerKey = key.toLowerCase()
      if (lowerKey.includes('path') || lowerKey.includes('file')) {
        paths.push(...findPathCandidatesInText(value))
        paths.push(value)
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, key, depth + 1))
      return
    }
    if (value && typeof value === 'object') {
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        visit(nestedValue, nestedKey, depth + 1)
      }
    }
  }
  visit(input, '', 0)
  return [...new Set(paths)]
}

function normalizePathCandidate(path: string): string {
  const normalized = path.trim().replace(/[.,;:!?，。！？；：、）\])}<>]+$/u, '')
  if (normalized.length === 0 || normalized.length > 240) return ''
  if (!normalized.includes('/') && !/\.[A-Za-z0-9_+-]{1,12}$/u.test(normalized)) return ''
  return normalized
}

function isStandalonePathInText(text: string, path: string): boolean {
  const index = text.indexOf(path)
  if (index < 0) return false
  const previous = index > 0 ? text[index - 1] : ''
  return !previous || /\s|["'`([{<，。！？；：、]/u.test(previous)
}

function findLatestCompactBoundaryIndex(events: NexusEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'compact_boundary') return index
  }
  return -1
}

function normalizeRetainedEvents(retainedEvents: unknown[] | undefined): NexusEvent[] {
  if (!Array.isArray(retainedEvents)) return []
  return retainedEvents
    .map(raw => (typeof raw === 'object' && raw !== null && 'type' in raw ? raw : null))
    .filter((event): event is NexusEvent => event !== null)
}

function estimateEventsAsTokens(events: NexusEvent[]): number {
  const chars = events.reduce((sum, event) => sum + stableStringify(event).length, 0)
  return Math.ceil(chars / 4)
}

function findLargeToolResults(
  events: NexusEvent[],
  thresholdChars: number,
): ContextAnalysisDiagnostics['largeToolResults'] {
  const results: ContextAnalysisDiagnostics['largeToolResults'] = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type !== 'tool_completed') continue
    const output = stringifyOutput(event.output)
    if (output.length < thresholdChars) continue
    results.push({
      name: event.name,
      toolUseId: event.toolUseId,
      inputPreview: describeToolInput(events, index, event.toolUseId),
      outputChars: output.length,
      timestamp: event.timestamp,
    })
  }
  return results
    .sort((left, right) => right.outputChars - left.outputChars)
    .slice(0, 5)
}

function findRepeatedToolInputs(events: NexusEvent[]): ContextAnalysisDiagnostics['repeatedToolInputs'] {
  const counts = new Map<string, { name: string; inputPreview: string; count: number; latestTimestamp: string }>()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type !== 'tool_completed') continue
    const started = findToolStarted(events, index, event.toolUseId)
    if (!started) continue
    const inputText = stableStringify(started.input)
    const key = `${event.name}:${inputText}`
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      existing.latestTimestamp = event.timestamp
    } else {
      counts.set(key, {
        name: event.name,
        inputPreview: inputText.length <= 120 ? inputText : `${inputText.slice(0, 117)}...`,
        count: 1,
        latestTimestamp: event.timestamp,
      })
    }
  }
  return [...counts.values()]
    .filter(item => item.count > 1)
    .sort((left, right) => right.count - left.count)
    .slice(0, 5)
}

function buildDiagnosticSignals(options: {
  diagnostics: Omit<ContextAnalysisDiagnostics, 'signals'>
  window: ContextWindowState
  microcompactMetrics: AssembledContext['microcompactMetrics']
}): ContextDiagnosticSignal[] {
  const signals: ContextDiagnosticSignal[] = []
  if (options.window.isBlocking) {
    signals.push({
      type: 'near_capacity',
      severity: 'critical',
      message: `Context is at the blocking limit with ${options.diagnostics.remainingTokens} tokens remaining.`,
    })
  } else if (options.window.isCompact) {
    signals.push({
      type: 'near_capacity',
      severity: 'warning',
      message: `Context passed the compact threshold; ${options.diagnostics.blockingRemainingTokens} tokens remain before hard blocking.`,
    })
  } else if (options.window.isWarning) {
    signals.push({
      type: 'near_capacity',
      severity: 'warning',
      message: `Context is near capacity; ${options.diagnostics.compactRemainingTokens} tokens remain before auto compact threshold.`,
    })
  }
  if (options.diagnostics.autoCompact.fuseOpen) {
    signals.push({
      type: 'auto_compact_fuse',
      severity: 'critical',
      message: `Auto compact is paused after ${options.diagnostics.autoCompact.failureCount} consecutive failures.`,
    })
  }
  if (options.diagnostics.compactRetention.fallbackToFullHistory) {
    signals.push({
      type: 'retained_segment_fallback',
      severity: 'warning',
      message: `Compact retained segment failed validation: ${options.diagnostics.compactRetention.retainedSegmentWarning}`,
    })
  }
  if (options.diagnostics.resumeRecovery.active) {
    signals.push({
      type: 'resume_recovery_boundary',
      severity: 'info',
      message: `Resume recovery boundary is active after ${options.diagnostics.resumeRecovery.code}.`,
    })
  }
  if (options.diagnostics.largeToolResults.length > 0) {
    const largest = options.diagnostics.largeToolResults[0]!
    signals.push({
      type: 'large_tool_result',
      severity: 'warning',
      message: `Large ${largest.name} result detected (${largest.outputChars} chars).`,
    })
  }
  if (options.diagnostics.repeatedToolInputs.length > 0) {
    const repeated = options.diagnostics.repeatedToolInputs[0]!
    signals.push({
      type: 'repeated_tool_input',
      severity: 'info',
      message: `Repeated ${repeated.name} input detected ${repeated.count} times.`,
    })
  }
  if (options.diagnostics.memory.truncated || options.diagnostics.memory.pressurePercent >= 85) {
    signals.push({
      type: 'memory_bloat',
      severity: options.diagnostics.memory.truncated ? 'warning' : 'info',
      message: `Project memory is using ${options.diagnostics.memory.pressurePercent}% of its context budget.`,
    })
  }
  if (options.microcompactMetrics.estimatedTokensSaved > 0) {
    signals.push({
      type: 'microcompact_savings',
      severity: 'info',
      message: `Microcompact saved about ${options.microcompactMetrics.estimatedTokensSaved} tokens this assembly.`,
    })
  }
  return signals
}

function buildContextRecommendations(options: {
  window: ContextWindowState
  hasCompactBoundary: boolean
  diagnostics: ContextAnalysisDiagnostics
}): string[] {
  const recommendations: string[] = []
  if (options.window.isBlocking) {
    recommendations.push('Run /compact before sending another provider request.')
  } else if (options.window.isWarning) {
    recommendations.push('Context is near the warning threshold; consider /compact soon.')
  }
  if (options.diagnostics.autoCompact.fuseOpen) {
    recommendations.push('Auto compact is paused after repeated failures; run /compact manually and inspect compact_failure events.')
  }
  if (options.diagnostics.compactRetention.fallbackToFullHistory) {
    recommendations.push('Compact retained segment validation failed; context fell back to full session history for this request.')
  }
  if (options.diagnostics.resumeRecovery.active) {
    recommendations.push('A recovery boundary is active; answer from the latest user turn and re-read files only when needed.')
  }
  if (options.diagnostics.largeToolResults.length > 0) {
    recommendations.push('Large tool results are present; re-read only specific file ranges or compact before continuing.')
  }
  if (options.diagnostics.repeatedToolInputs.length > 0) {
    recommendations.push('Repeated tool inputs are present; reuse the latest result instead of re-reading the same target.')
  }
  if (options.diagnostics.memory.truncated || options.diagnostics.memory.pressurePercent >= 85) {
    recommendations.push('Project memory is near its budget; trim stale memory entries before long runs.')
  }
  if (!options.hasCompactBoundary) {
    recommendations.push('No compact boundary exists yet; /compact can create a recoverable summary point.')
  }
  if (recommendations.length === 0) {
    recommendations.push('Context is within the current model window.')
  }
  return recommendations
}

function describeToolInput(events: NexusEvent[], completedIndex: number, toolUseId: string): string {
  const started = findToolStarted(events, completedIndex, toolUseId)
  if (!started) return 'unknown input'
  const text = stableStringify(started.input)
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`
}

function findToolStarted(
  events: NexusEvent[],
  completedIndex: number,
  toolUseId: string,
): Extract<NexusEvent, { type: 'tool_started' }> | undefined {
  for (let index = completedIndex - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'tool_started' && event.toolUseId === toolUseId) return event
    if (event?.type === 'user_message') return undefined
  }
  return undefined
}

function stringifyOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output)
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) {
        return nestedValue
      }
      return Object.fromEntries(
        Object.entries(nestedValue as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right)),
      )
    }) ?? ''
  } catch {
    return String(value)
  }
}
