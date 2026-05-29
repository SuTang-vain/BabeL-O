import type { NexusEvent } from '../shared/events.js'
import type {
  ModelMessage,
  ModelToolDefinition,
} from '../providers/adapters/ModelAdapter.js'
import type { RuntimeExecuteOptions } from './Runtime.js'
import {
  assembleContext,
  type AssembledContext,
} from './contextAssembler.js'
import {
  estimateContextTokens,
  getContextWindowState,
  type ContextTokenEstimate,
  type ContextWindowState,
} from './tokenEstimator.js'

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
  })
  const window = getContextWindowState({
    tokenEstimate: estimate.totalTokens,
    maxTokens: assembled.budget.maxTokens,
    warningPercent: options.warningPercent ?? 70,
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
      memoryTruncated: assembled.memoryTruncated,
      toolDefinitionCount: options.tools?.length ?? 0,
    },
    compact,
    postCompactState: assembled.postCompactState,
    userIntentGuidance: assembled.userIntentGuidance,
    recommendations: buildContextRecommendations(window, compact.hasBoundary),
  }
}

function buildContextRecommendations(
  window: ContextWindowState,
  hasCompactBoundary: boolean,
): string[] {
  const recommendations: string[] = []
  if (window.isBlocking) {
    recommendations.push('Run /compact before sending another provider request.')
  } else if (window.isWarning) {
    recommendations.push('Context is near the warning threshold; consider /compact soon.')
  }
  if (!hasCompactBoundary) {
    recommendations.push('No compact boundary exists yet; /compact can create a recoverable summary point.')
  }
  if (recommendations.length === 0) {
    recommendations.push('Context is within the current model window.')
  }
  return recommendations
}
