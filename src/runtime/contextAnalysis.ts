import type { NexusEvent } from '../shared/events.js'
import type { SessionMessage } from '../shared/sessionChannel.js'
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
import { deriveTaskScope, extractToolTargetPaths } from './taskScope.js'
import type { ContextSelectionDiagnostics } from './contextManager.js'
import type { MemoryProvider, MemoryProviderDiagnostics } from './memoryProvider.js'

export type ContextDiagnosticSignal = {
  type: 'near_capacity' | 'large_tool_result' | 'repeated_tool_input' | 'memory_bloat' | 'auto_compact_fuse' | 'microcompact_savings' | 'retained_segment_fallback' | 'resume_recovery_boundary' | 'grounding_required' | 'workspace_dirty' | 'scope_boundary' | 'out_of_scope_evidence'
  severity: 'info' | 'warning' | 'critical'
  message: string
}

export type ContextVisualizationBucket = {
  kind: 'system' | 'memory' | 'git' | 'events' | 'tool_results' | 'compact_summary' | 'session_channel' | 'skills'
  estimatedTokens: number
  itemCount: number
  percentOfEstimate: number
}

export type ContextVisualizationTopItem = {
  kind: ContextVisualizationBucket['kind']
  label: string
  estimatedTokens: number
  source: string
}

export type ContextGroundingState = {
  state: 'source-confirmed' | 'summary-derived' | 'dirty-workspace'
  summaryDerived: boolean
  dirtyWorkspace: boolean
  changedFileCount: number
  changedFiles: string[]
  suggestedActions: Array<'inspect_changed_files' | 're_read_referenced_files' | 'inspect_git_status' | 'inspect_diff' | 'run_focused_tests' | 'inspect_event_log'>
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
  visualization: {
    buckets: ContextVisualizationBucket[]
    topItems: ContextVisualizationTopItem[]
    nextThreshold: {
      name: 'warning' | 'compact' | 'blocking' | 'none'
      thresholdTokens: number
      remainingTokens: number
      percent: number
    }
    grounding: ContextGroundingState
    suggestions: string[]
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
  longTermMemory: MemoryProviderDiagnostics
  longTermMemoryCapabilityAvailable: boolean
  scopedMemory: MemoryProviderDiagnostics[]
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
  taskScope: {
    cwd: string
    primaryRoot: string
    explicitRoots: string[]
    confirmedExternalRoots: string[]
    inferredCandidateRoots: string[]
    mode: 'single_root' | 'multi_root' | 'cross_project'
    source: 'cwd' | 'prompt_paths' | 'user_confirmation' | 'session_metadata'
    latestDeclaredAt: string
    pendingBoundaries: Array<{
      targetRoot: string
      boundaryKind: 'parent_scan' | 'sibling_repo' | 'external_absolute_path' | 'historical_session_path' | 'memory_hit_path' | 'global_cache_path'
      toolName: string
      toolUseId: string
      action: 'warn' | 'require_confirmation' | 'deny'
      reason: string
      timestamp: string
    }>
    confirmedBoundaries: Array<{
      targetRoot: string
      confirmationScope: 'once' | 'session' | 'task'
      confirmedBy: 'user' | 'policy'
      timestamp: string
    }>
    outOfScopeEvidence: Array<{
      toolUseId: string
      toolName: string
      targetRoot: string
      reason: string
      timestamp: string
    }>
  }
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
    modelContextWindow: number
    effectiveContextCeiling: number
    legacyContextCeiling: number
    envMaxContextTokens?: number
    policySource: 'legacy' | 'large_context' | 'env_cap'
    reservedOutputTokens: number
    providerSafetyBufferTokens: number
    warningThresholdPercent: number
    compactThresholdPercent: number
    warningThresholdTokens: number
    compactThresholdTokens: number
    blockingLimitTokens: number
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
  modelContextWindow: number
  maxTokens: number
  tokenEstimate: number
  effectiveContextCeiling: number
  legacyContextCeiling: number
  envMaxContextTokens?: number
  policySource: 'legacy' | 'large_context' | 'env_cap'
  reservedOutputTokens: number
  providerSafetyBufferTokens: number
  warningThresholdTokens: number
  compactThresholdTokens: number
  blockingLimitTokens: number
  remainingTokens: number
  compactHasBoundary: boolean
  toolsVisible: boolean
  retainedContextItems: number
  droppedContextItems: number
  longTermMemoryProvider: string
  longTermMemoryEnabled: boolean
  longTermMemoryHitCount: number
  longTermMemoryCapabilityAvailable: boolean
  longTermMemoryInjectedChars: number
  longTermMemoryBudgetChars: number
  longTermMemoryTruncated: boolean
  longTermMemoryScope: string
  longTermMemoryNamespaceId?: string
  longTermMemoryNamespaceSource?: string
  longTermMemoryIsolationKey?: string
  longTermMemorySearchLatencyMs?: number
  longTermMemoryError?: string
  scopedMemory: MemoryProviderDiagnostics[]
  groundingState: ContextGroundingState['state']
  taskScopeMode: ContextAnalysisDiagnostics['taskScope']['mode']
  taskPrimaryRoot: string
  taskExplicitRootCount: number
  taskConfirmedExternalRootCount: number
  pendingScopeBoundaryCount: number
  outOfScopeEvidenceCount: number
  contextBucketCount: number
  topContextItemCount: number
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
  memoryProvider?: MemoryProvider
  sessionInbox?: SessionMessage[]
  // §3.5 Memory Quality Metrics: forwarded to `assembleContext`'s
  // `onMemoryRetrieval` hook so the caller (e.g. Nexus context
  // route) can persist a `memory_retrieval` NexusEvent for the
  // dashboard. See `ContextAssemblerOptions.onMemoryRetrieval` for
  // the full contract.
  onMemoryRetrieval?: (input: {
    sessionId: string
    cwd: string
    prompt: string
    diagnostics: MemoryProviderDiagnostics
  }) => void | Promise<void>
}): Promise<ContextAnalysis> {
  const assembled = await assembleContext({
    runtimeOptions: options.runtimeOptions,
    events: options.events,
    modelId: options.modelId,
    buildSystemPrompt: options.buildSystemPrompt,
    mapEventsToMessages: options.mapEventsToMessages,
    memoryProvider: options.memoryProvider,
    sessionInbox: options.sessionInbox,
    ...(options.onMemoryRetrieval && { onMemoryRetrieval: options.onMemoryRetrieval }),
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
    cwd: options.runtimeOptions.cwd,
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
      modelContextWindow: options.diagnostics.cacheEconomics.modelContextWindow,
      maxTokens: options.window.maxTokens,
      tokenEstimate: options.window.tokenEstimate,
      effectiveContextCeiling: options.diagnostics.cacheEconomics.effectiveContextCeiling,
      legacyContextCeiling: options.diagnostics.cacheEconomics.legacyContextCeiling,
      envMaxContextTokens: options.diagnostics.cacheEconomics.envMaxContextTokens,
      policySource: options.diagnostics.cacheEconomics.policySource,
      reservedOutputTokens: options.diagnostics.cacheEconomics.reservedOutputTokens,
      providerSafetyBufferTokens: options.diagnostics.cacheEconomics.providerSafetyBufferTokens,
      warningThresholdTokens: options.diagnostics.cacheEconomics.warningThresholdTokens,
      compactThresholdTokens: options.diagnostics.cacheEconomics.compactThresholdTokens,
      blockingLimitTokens: options.diagnostics.cacheEconomics.blockingLimitTokens,
      remainingTokens: options.diagnostics.remainingTokens,
      compactHasBoundary: options.compact.hasBoundary,
      toolsVisible: options.runtimePolicy.toolsVisible,
      retainedContextItems: options.diagnostics.selection.retained.length,
      droppedContextItems: options.diagnostics.selection.dropped.length,
      longTermMemoryProvider: options.diagnostics.longTermMemory.provider,
      longTermMemoryEnabled: options.diagnostics.longTermMemory.enabled,
      longTermMemoryHitCount: options.diagnostics.longTermMemory.hitCount,
      longTermMemoryCapabilityAvailable: options.diagnostics.longTermMemoryCapabilityAvailable,
      longTermMemoryInjectedChars: options.diagnostics.longTermMemory.injectedChars,
      longTermMemoryBudgetChars: options.diagnostics.longTermMemory.budgetChars,
      longTermMemoryTruncated: options.diagnostics.longTermMemory.truncated,
      longTermMemoryScope: options.diagnostics.longTermMemory.scope,
      longTermMemoryNamespaceId: options.diagnostics.longTermMemory.namespaceId,
      longTermMemoryNamespaceSource: options.diagnostics.longTermMemory.namespaceSource,
      longTermMemoryIsolationKey: options.diagnostics.longTermMemory.isolationKey,
      longTermMemorySearchLatencyMs: options.diagnostics.longTermMemory.searchLatencyMs,
      longTermMemoryError: options.diagnostics.longTermMemory.error,
      scopedMemory: options.diagnostics.scopedMemory,
      groundingState: options.diagnostics.visualization.grounding.state,
      taskScopeMode: options.diagnostics.taskScope.mode,
      taskPrimaryRoot: options.diagnostics.taskScope.primaryRoot,
      taskExplicitRootCount: options.diagnostics.taskScope.explicitRoots.length,
      taskConfirmedExternalRootCount: options.diagnostics.taskScope.confirmedExternalRoots.length,
      pendingScopeBoundaryCount: options.diagnostics.taskScope.pendingBoundaries.length,
      outOfScopeEvidenceCount: options.diagnostics.taskScope.outOfScopeEvidence.length,
      contextBucketCount: options.diagnostics.visualization.buckets.length,
      topContextItemCount: options.diagnostics.visualization.topItems.length,
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
  cwd: string
  assembled: AssembledContext
  window: ContextWindowState
  autoCompact: ContextAnalysisDiagnostics['autoCompact']
  compact: ContextAnalysis['compact']
  runtimePolicy: ContextAnalysis['runtimePolicy']
  cacheAwareCompactPolicy: CacheAwareCompactPolicy
}): ContextAnalysisDiagnostics {
  const remainingTokens = Math.max(0, options.window.maxTokens - options.window.tokenEstimate)
  const compactRemainingTokens = Math.max(0, options.window.compactThresholdTokens - options.window.tokenEstimate)
  const blockingRemainingTokens = Math.max(0, options.window.blockingLimitTokens - options.window.tokenEstimate)
  const diagnostics: ContextAnalysisDiagnostics = {
    remainingTokens,
    remainingPercent: Math.round((remainingTokens / Math.max(1, options.window.maxTokens)) * 100),
    compactRemainingTokens,
    blockingRemainingTokens,
    usageSummary: summarizeUsage(options.events),
    visualization: buildContextVisualizationDiagnostics({
      events: options.events,
      assembled: options.assembled,
      window: options.window,
      compactRemainingTokens,
      blockingRemainingTokens,
    }),
    autoCompact: options.autoCompact,
    memory: {
      projectMemoryChars: options.assembled.projectMemory.length,
      projectMemoryBudgetChars: options.assembled.budget.layerBudgets.memory * 4,
      pressurePercent: Math.round((options.assembled.projectMemory.length / Math.max(1, options.assembled.budget.layerBudgets.memory * 4)) * 100),
      truncated: options.assembled.memoryTruncated,
    },
    longTermMemory: options.assembled.memoryProviderDiagnostics ?? {
      provider: 'noop',
      enabled: false,
      hitCount: 0,
      injectedChars: 0,
      budgetChars: 0,
      maxHitChars: 0,
      truncated: false,
      scope: 'unknown',
    },
    longTermMemoryCapabilityAvailable: options.assembled.memoryCapabilityAvailable,
    scopedMemory: options.assembled.scopedMemoryDiagnostics,
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
    taskScope: buildTaskScopeDiagnostics(options.events, options.prompt, options.cwd),
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

function buildContextVisualizationDiagnostics(options: {
  events: NexusEvent[]
  assembled: AssembledContext
  window: ContextWindowState
  compactRemainingTokens: number
  blockingRemainingTokens: number
}): ContextAnalysisDiagnostics['visualization'] {
  const buckets = buildVisualizationBuckets(options)
  const topItems = buildVisualizationTopItems(options)
  const grounding = buildGroundingState(options.events)
  return {
    buckets,
    topItems,
    nextThreshold: buildNextThreshold(options.window, options.compactRemainingTokens, options.blockingRemainingTokens),
    grounding,
    suggestions: buildVisualizationSuggestions({
      window: options.window,
      grounding,
      topItems,
      buckets,
      compactRemainingTokens: options.compactRemainingTokens,
    }),
  }
}

function buildVisualizationBuckets(options: {
  events: NexusEvent[]
  assembled: AssembledContext
  window: ContextWindowState
}): ContextVisualizationBucket[] {
  const totals = new Map<ContextVisualizationBucket['kind'], { estimatedTokens: number; itemCount: number }>()
  const add = (kind: ContextVisualizationBucket['kind'], estimatedTokens: number, itemCount = 1) => {
    if (estimatedTokens <= 0 && itemCount <= 0) return
    const existing = totals.get(kind) ?? { estimatedTokens: 0, itemCount: 0 }
    existing.estimatedTokens += Math.max(0, estimatedTokens)
    existing.itemCount += Math.max(0, itemCount)
    totals.set(kind, existing)
  }

  add('system', Math.ceil(options.assembled.systemPrompt.length / 4), options.assembled.systemPromptBlocks?.length ?? 1)
  add('memory', Math.ceil(options.assembled.projectMemory.length / 4), options.assembled.projectMemory ? 1 : 0)
  add('compact_summary', Math.ceil(options.assembled.sessionSummary.length / 4), options.assembled.sessionSummary ? 1 : 0)
  add('skills', Math.ceil(options.assembled.activeSkills.length / 4), options.assembled.activeSkills ? 1 : 0)
  add('git', Math.ceil(options.assembled.gitStatus.length / 4), options.assembled.gitStatus ? 1 : 0)
  add('events', estimateEventTokens(options.events.filter(event => event.type !== 'tool_completed')), options.events.filter(event => event.type !== 'tool_completed').length)
  add('tool_results', estimateEventTokens(options.events.filter(event => event.type === 'tool_completed')), options.events.filter(event => event.type === 'tool_completed').length)
  for (const diagnostic of options.assembled.scopedMemoryDiagnostics) {
    if (diagnostic.scope === 'channel') {
      add('session_channel', Math.ceil(diagnostic.injectedChars / 4), diagnostic.hitCount)
    }
  }

  return [...totals.entries()]
    .map(([kind, bucket]) => ({
      kind,
      estimatedTokens: bucket.estimatedTokens,
      itemCount: bucket.itemCount,
      percentOfEstimate: Math.round((bucket.estimatedTokens / Math.max(1, options.window.tokenEstimate)) * 100),
    }))
    .filter(bucket => bucket.estimatedTokens > 0 || bucket.itemCount > 0)
    .sort((left, right) => right.estimatedTokens - left.estimatedTokens || left.kind.localeCompare(right.kind))
}

function buildVisualizationTopItems(options: {
  events: NexusEvent[]
  assembled: AssembledContext
}): ContextVisualizationTopItem[] {
  const items: ContextVisualizationTopItem[] = []
  const push = (kind: ContextVisualizationTopItem['kind'], label: string, estimatedTokens: number, source: string) => {
    if (estimatedTokens <= 0) return
    items.push({ kind, label: truncateLabel(label), estimatedTokens, source })
  }

  for (const item of options.assembled.selectionDiagnostics.retained) {
    push(bucketKindForSelectionKind(item.kind), item.id, item.estimatedTokens, item.reason)
  }
  for (const item of options.assembled.selectionDiagnostics.dropped) {
    push(bucketKindForSelectionKind(item.kind), item.id, item.estimatedTokens, item.reason)
  }
  for (const event of options.events) {
    if (event.type !== 'tool_completed') continue
    push('tool_results', `${event.name}:${event.toolUseId}`, estimateEventTokens([event]), 'tool result output')
  }

  return items
    .sort((left, right) => right.estimatedTokens - left.estimatedTokens || left.label.localeCompare(right.label))
    .slice(0, 8)
}

function bucketKindForSelectionKind(kind: string): ContextVisualizationBucket['kind'] {
  switch (kind) {
    case 'system':
      return 'system'
    case 'memory':
      return 'memory'
    case 'git':
    case 'working_set':
      return 'git'
    case 'tool_result':
      return 'tool_results'
    case 'compact_summary':
      return 'compact_summary'
    case 'skill':
    case 'mcp':
      return 'skills'
    case 'task_state':
    case 'child_agent_state':
      return 'session_channel'
    default:
      return 'events'
  }
}

function buildNextThreshold(
  window: ContextWindowState,
  compactRemainingTokens: number,
  blockingRemainingTokens: number,
): ContextAnalysisDiagnostics['visualization']['nextThreshold'] {
  if (window.tokenEstimate < window.warningThresholdTokens) {
    return {
      name: 'warning',
      thresholdTokens: window.warningThresholdTokens,
      remainingTokens: Math.max(0, window.warningThresholdTokens - window.tokenEstimate),
      percent: Math.round((window.warningThresholdTokens / Math.max(1, window.maxTokens)) * 100),
    }
  }
  if (window.tokenEstimate < window.compactThresholdTokens) {
    return {
      name: 'compact',
      thresholdTokens: window.compactThresholdTokens,
      remainingTokens: compactRemainingTokens,
      percent: Math.round((window.compactThresholdTokens / Math.max(1, window.maxTokens)) * 100),
    }
  }
  if (window.tokenEstimate < window.blockingLimitTokens) {
    return {
      name: 'blocking',
      thresholdTokens: window.blockingLimitTokens,
      remainingTokens: blockingRemainingTokens,
      percent: Math.round((window.blockingLimitTokens / Math.max(1, window.maxTokens)) * 100),
    }
  }
  return {
    name: 'none',
    thresholdTokens: window.blockingLimitTokens,
    remainingTokens: 0,
    percent: 100,
  }
}

function buildGroundingState(events: NexusEvent[]): ContextGroundingState {
  const groundingIndex = findLastEventIndex(events, 'context_grounding_required')
  const dirtyIndex = findLastEventIndex(events, 'workspace_dirty_detected')
  const confirmedIndex = findLastEventIndex(events, 'context_grounding_confirmed')
  const gitConfirmedIndex = findLastEventIndex(events, 'context_grounding_confirmed', event => event.confirmedFor.includes('git_status'))
  const grounding = groundingIndex >= 0 ? events[groundingIndex] as Extract<NexusEvent, { type: 'context_grounding_required' }> : undefined
  const dirty = dirtyIndex >= 0 ? events[dirtyIndex] as Extract<NexusEvent, { type: 'workspace_dirty_detected' }> : undefined
  const confirmed = confirmedIndex >= 0 ? events[confirmedIndex] as Extract<NexusEvent, { type: 'context_grounding_confirmed' }> : undefined
  const summaryDerived = Boolean(grounding && groundingIndex > confirmedIndex)
  const dirtyWorkspace = Boolean(dirty && dirty.changedFileCount > 0 && dirtyIndex > gitConfirmedIndex)
  const suggestions = new Set<ContextGroundingState['suggestedActions'][number]>()
  if (summaryDerived) grounding?.suggestedActions.forEach(action => suggestions.add(action))
  if (dirtyWorkspace) dirty?.suggestedActions.forEach(action => suggestions.add(action))
  const state: ContextGroundingState['state'] = dirtyWorkspace ? 'dirty-workspace' : summaryDerived ? 'summary-derived' : 'source-confirmed'
  return {
    state,
    summaryDerived,
    dirtyWorkspace,
    changedFileCount: dirtyWorkspace ? dirty?.changedFileCount ?? 0 : 0,
    changedFiles: dirtyWorkspace ? dirty?.changedFiles ?? [] : [],
    suggestedActions: [...suggestions],
    message: dirtyWorkspace
      ? dirty?.message ?? 'Workspace has changed files; inspect status/diff before implementation claims.'
      : summaryDerived
        ? grounding?.message ?? 'Context was compacted; verify sources before conclusions.'
        : confirmed?.message ?? 'Current context has no pending compact-grounding guard.',
  }
}

function findLastEvent<T extends NexusEvent['type']>(events: NexusEvent[], type: T): Extract<NexusEvent, { type: T }> | undefined {
  const index = findLastEventIndex(events, type)
  return index >= 0 ? events[index] as Extract<NexusEvent, { type: T }> : undefined
}

function findLastEventIndex<T extends NexusEvent['type']>(
  events: NexusEvent[],
  type: T,
  predicate?: (event: Extract<NexusEvent, { type: T }>) => boolean,
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== type) continue
    const typedEvent = event as Extract<NexusEvent, { type: T }>
    if (!predicate || predicate(typedEvent)) return index
  }
  return -1
}

function buildVisualizationSuggestions(options: {
  window: ContextWindowState
  grounding: ContextGroundingState
  topItems: ContextVisualizationTopItem[]
  buckets: ContextVisualizationBucket[]
  compactRemainingTokens: number
}): string[] {
  const suggestions: string[] = []
  if (options.grounding.dirtyWorkspace) suggestions.push('inspect changed files')
  if (options.grounding.summaryDerived) suggestions.push('re-read referenced files before source/test/git conclusions')
  if (options.window.isBlocking || options.window.isCompact) suggestions.push('compact')
  else if (options.window.isWarning) suggestions.push('narrow scope or compact soon')
  else suggestions.push('continue')
  if (options.topItems.length > 0) suggestions.push('inspect largest items')
  if (options.buckets.some(bucket => bucket.kind === 'tool_results' && bucket.percentOfEstimate >= 20)) suggestions.push('reduce tool output')
  if (options.compactRemainingTokens <= 0) suggestions.push('split task')
  return [...new Set(suggestions)]
}

function estimateEventTokens(events: NexusEvent[]): number {
  return Math.ceil(events.reduce((sum, event) => sum + stableStringify(event).length, 0) / 4)
}

function truncateLabel(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`
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

function buildTaskScopeDiagnostics(events: NexusEvent[], prompt: string, cwd: string): ContextAnalysisDiagnostics['taskScope'] {
  const latestDeclared = findLastEvent(events, 'task_scope_declared')
  const derived = deriveTaskScope({
    sessionId: latestDeclared?.sessionId ?? 'context-analysis',
    cwd,
    prompt,
    events,
  })
  const confirmed = events
    .filter((event): event is Extract<NexusEvent, { type: 'scope_boundary_confirmed' }> => event.type === 'scope_boundary_confirmed')
    .map(event => ({
      targetRoot: event.targetRoot,
      confirmationScope: event.confirmationScope,
      confirmedBy: event.confirmedBy,
      timestamp: event.timestamp,
    }))
  const confirmedRoots = new Set(confirmed.map(event => event.targetRoot))
  const latestBoundaryByRoot = new Map<string, Extract<NexusEvent, { type: 'scope_boundary_detected' }>>()
  for (const event of events) {
    if (event.type !== 'scope_boundary_detected') continue
    latestBoundaryByRoot.set(event.targetRoot, event)
  }
  const pendingBoundaries = [...latestBoundaryByRoot.values()]
    .filter(event => !confirmedRoots.has(event.targetRoot))
    .map(event => ({
      targetRoot: event.targetRoot,
      boundaryKind: event.boundaryKind,
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      action: event.action,
      reason: event.reason,
      timestamp: event.timestamp,
    }))
  const scopeRoots = [derived.primaryRoot, ...derived.explicitRoots, ...derived.confirmedExternalRoots]
  return {
    cwd: derived.cwd,
    primaryRoot: derived.primaryRoot,
    explicitRoots: derived.explicitRoots,
    confirmedExternalRoots: derived.confirmedExternalRoots,
    inferredCandidateRoots: derived.inferredCandidateRoots,
    mode: latestDeclared?.mode ?? derived.mode,
    source: latestDeclared?.source ?? derived.source,
    latestDeclaredAt: latestDeclared?.timestamp ?? '',
    pendingBoundaries,
    confirmedBoundaries: confirmed,
    outOfScopeEvidence: findOutOfScopeToolEvidence(events, cwd, scopeRoots, latestBoundaryByRoot, confirmedRoots),
  }
}

function findOutOfScopeToolEvidence(
  events: NexusEvent[],
  cwd: string,
  scopeRoots: string[],
  boundaryByRoot: Map<string, Extract<NexusEvent, { type: 'scope_boundary_detected' }>>,
  confirmedRoots: Set<string>,
): ContextAnalysisDiagnostics['taskScope']['outOfScopeEvidence'] {
  const completedToolUseIds = new Set(events
    .filter((event): event is Extract<NexusEvent, { type: 'tool_completed' }> => event.type === 'tool_completed' && event.success)
    .map(event => event.toolUseId))
  const outOfScope: ContextAnalysisDiagnostics['taskScope']['outOfScopeEvidence'] = []
  for (const event of events) {
    if (event.type !== 'tool_started') continue
    if (!completedToolUseIds.has(event.toolUseId)) continue
    const paths = extractToolTargetPaths(event.name, event.input, cwd)
    for (const path of paths) {
      const root = rootForEvidencePath(path, scopeRoots, boundaryByRoot)
      if (!root || isPathWithinAnyRoot(path, scopeRoots) || confirmedRoots.has(root)) continue
      outOfScope.push({
        toolUseId: event.toolUseId,
        toolName: event.name,
        targetRoot: root,
        reason: `Successful ${event.name} evidence targeted ${root} outside current task scope.`,
        timestamp: event.timestamp,
      })
    }
  }
  return outOfScope
}

function rootForEvidencePath(
  path: string,
  scopeRoots: string[],
  boundaryByRoot: Map<string, Extract<NexusEvent, { type: 'scope_boundary_detected' }>>,
): string | undefined {
  const boundary = [...boundaryByRoot.values()].find(event => isPathWithinRoot(path, event.targetRoot))
  if (boundary) return boundary.targetRoot
  if (isPathWithinAnyRoot(path, scopeRoots)) return undefined
  return path
}

function isPathWithinAnyRoot(path: string, roots: string[]): boolean {
  return roots.some(root => isPathWithinRoot(path, root))
}

function isPathWithinRoot(path: string, root: string): boolean {
  const normalized = path.trim()
  const normalizedRoot = root.trim()
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`)
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
    modelContextWindow: policy.modelContextWindow,
    effectiveContextCeiling: policy.effectiveContextCeiling,
    legacyContextCeiling: policy.legacyContextCeiling,
    envMaxContextTokens: policy.envMaxContextTokens,
    policySource: policy.policySource,
    reservedOutputTokens: policy.reservedOutputTokens,
    providerSafetyBufferTokens: policy.providerSafetyBufferTokens,
    warningThresholdPercent: policy.warningThresholdPercent,
    compactThresholdPercent: policy.compactThresholdPercent,
    warningThresholdTokens: policy.warningThresholdTokens,
    compactThresholdTokens: policy.compactThresholdTokens,
    blockingLimitTokens: policy.blockingLimitTokens,
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

export function findRepeatedToolInputs(events: NexusEvent[]): ContextAnalysisDiagnostics['repeatedToolInputs'] {
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
  if (options.diagnostics.visualization.grounding.summaryDerived) {
    signals.push({
      type: 'grounding_required',
      severity: 'warning',
      message: 'Compact summary is acting as a recovery index; verify current sources before factual conclusions.',
    })
  }
  if (options.diagnostics.visualization.grounding.dirtyWorkspace) {
    signals.push({
      type: 'workspace_dirty',
      severity: 'warning',
      message: `Workspace has ${options.diagnostics.visualization.grounding.changedFileCount} changed file(s); inspect status/diff before implementation claims.`,
    })
  }
  if (options.diagnostics.taskScope.pendingBoundaries.length > 0) {
    const boundary = options.diagnostics.taskScope.pendingBoundaries[0]!
    signals.push({
      type: 'scope_boundary',
      severity: 'warning',
      message: `Scope boundary pending for ${boundary.targetRoot}; confirm before using it as task evidence.`,
    })
  }
  if (options.diagnostics.taskScope.outOfScopeEvidence.length > 0) {
    const evidence = options.diagnostics.taskScope.outOfScopeEvidence[0]!
    signals.push({
      type: 'out_of_scope_evidence',
      severity: 'critical',
      message: `Out-of-scope ${evidence.toolName} evidence targeted ${evidence.targetRoot}.`,
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
  if (options.diagnostics.taskScope.pendingBoundaries.length > 0) {
    recommendations.push('Confirm or reject pending scope boundaries before using external roots as evidence.')
  }
  if (options.diagnostics.taskScope.outOfScopeEvidence.length > 0) {
    recommendations.push('Discard or explicitly label out-of-scope tool evidence before making final claims.')
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
  if (options.diagnostics.longTermMemory.error) {
    recommendations.push('Long-term memory retrieval failed; continue from local session/context evidence.')
  } else if (options.diagnostics.longTermMemory.truncated) {
    recommendations.push('Long-term memory hits were truncated; ask a narrower follow-up or reduce memory retrieval budget pressure.')
  }
  if (options.diagnostics.visualization.grounding.dirtyWorkspace) {
    recommendations.push('Inspect changed files or git diff before reporting current implementation state.')
  } else if (options.diagnostics.visualization.grounding.summaryDerived) {
    recommendations.push('Re-read referenced files before making source, test, git, or task-completion claims.')
  }
  for (const suggestion of options.diagnostics.visualization.suggestions) {
    recommendations.push(`Context suggestion: ${suggestion}.`)
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
