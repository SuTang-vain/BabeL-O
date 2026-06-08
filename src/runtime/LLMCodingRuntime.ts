import { z } from 'zod'
import { existsSync, lstatSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { eventBase, type NexusEvent } from '../shared/events.js'
import { logger } from '../shared/logger.js'
import type { AnyTool } from '../tools/Tool.js'
import type {
  NexusRuntime,
  RuntimeExecuteOptions,
  RuntimeToolAuditEntry,
} from './Runtime.js'
import type { ToolPolicy } from './LocalCodingRuntime.js'
import { buildSystemPromptSections, sectionsToPromptText, extractAbsolutePaths, resolvePromptPath } from './systemPromptBuilder.js'
import type { NexusStorage } from '../storage/Storage.js'
import { getAdapter } from '../providers/registry.js'
import type {
  ModelMessage,
  ContentBlock,
} from '../providers/adapters/ModelAdapter.js'
import { ConfigManager } from '../shared/config.js'
import {
  buildCompactFailureEvent,
  compactSession,
} from './compact.js'
import { queueSessionMemoryLiteUpdate } from './sessionMemoryLite.js'
import { estimateContextTokens } from './tokenEstimator.js'
import { classifyProviderRecovery } from './providerRecovery.js'
import {
  createReplacementState,
  enforceMessageBudget,
} from './toolResultBudget.js'
import {
  buildUserIntakeGuidanceEvent,
  shouldSuppressToolsForIntent,
} from './intentGuidance.js'
import {
  absorbCacheAwareCompactPolicyMetrics,
  absorbCompactSummaryLatencyMetrics,
  absorbPrefixCacheDiagnosticsMetrics,
  absorbProviderTurnMetrics,
  buildContextBlockingEvents,
  buildContextWarningEvent,
  buildProviderLoopRequestState,
  buildProviderQueryParams,
  buildProviderToolResultsMessage,
  buildRuntimeContextBlockingEventsForLoop,
  computeProviderPrefixCacheDiagnostics,
  buildRuntimeErrorEvent,
  buildRuntimeExecutionMetricsEvent,
  buildRuntimeResultEvent,
  createRuntimeExecutionMetrics,
  reduceProviderTurnOutcome,
  refreshRuntimeContextState,
  streamProviderTurn,
  type RuntimeProviderTurn,
} from './runtimePipeline.js'
import { executeProviderToolCall } from './runtimeToolLoop.js'
import { executeRuntimeHooks, type RuntimeHookInput } from './hooks.js'
import type { MemoryProvider } from './memoryProvider.js'

const FINAL_RESPONSE_ONLY_REMAINING_LOOPS = 3

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

export type MapEventsToMessagesOptions = {
  replayReasoningContent?: boolean
}

export class LLMCodingRuntime implements NexusRuntime {
  private readFileCache = new Map<string, { mtime: number; size: number }>()

  constructor(
    private readonly tools: Map<string, AnyTool>,
    private toolPolicy: ToolPolicy,
    private readonly storage: NexusStorage,
    private readonly configManager: ConfigManager = ConfigManager.getInstance(),
    private readonly memoryProvider?: MemoryProvider,
  ) {}

  listTools(): RuntimeToolAuditEntry[] {
    return [...this.tools.values()]
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        allowed: this.toolPolicy.isAllowed(tool),
        inputSchema: tool.modelInputSchema ?? z.toJSONSchema(tool.inputSchema),
        requiresApproval: tool.requiresApproval ?? (tool.risk === 'write' || tool.risk === 'execute'),
        suggestedAllowRule: tool.suggestedAllowRule ?? tool.name,
        mcpServerAllowed: tool.mcpServerAllowed,
        source: tool.source ?? { type: 'builtin' as const },
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  withToolPolicy<T>(toolPolicy: ToolPolicy, fn: () => T): T {
    const previousPolicy = this.toolPolicy
    this.toolPolicy = toolPolicy
    let result: T
    try {
      result = fn()
    } catch (error) {
      this.toolPolicy = previousPolicy
      throw error
    }
    this.toolPolicy = previousPolicy
    if (isAsyncIterable(result)) {
      const iterable = result
      const runtime = this
      return (async function* () {
        const activePolicy = runtime.toolPolicy
        runtime.toolPolicy = toolPolicy
        try {
          for await (const item of iterable) {
            yield item
          }
        } finally {
          runtime.toolPolicy = activePolicy
        }
      })() as T
    }
    return result
  }

  async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    const resolvedCwd = resolveCwdFromPrompt(options.prompt, options.cwd)
    if (resolvedCwd !== options.cwd) {
      options.cwd = resolvedCwd
    }
    if (!options.hooks) {
      options = { ...options, hooks: this.configManager.load().hooks }
    }

    yield {
      type: 'session_started',
      ...eventBase(options.sessionId),
      cwd: options.cwd,
      requestId: options.requestId,
      model: options.model,
      budget: options.budget,
    }

    const metrics = createRuntimeExecutionMetrics()

    try {
      // 1. Resolve connection and credential settings
      const settings = this.configManager.resolveSettings({
        model: options.model,
      })

      // 2. Load previous session events from storage (if any)
      let previousEvents: NexusEvent[] = []
      if (this.storage && options.replaySessionHistory !== false) {
        try {
          const result = await this.storage.listEvents(options.sessionId, {
            order: 'desc',
            limit: 1000,
          })
          previousEvents = [...(result?.events || [])].reverse()
        } catch (e) {
          logger.debug('Failed to load previous session events from storage', e)
        }
      }

      // Strip optional [1m] tag from canonical model name
      const activeModel = options.model || settings.modelId
      const cleanedModelId = activeModel.replace(/\[1m\]$/i, '')
      const adapter = getAdapter(settings.providerId)
      const shouldReplayReasoningContent =
        cleanedModelId.includes('deepseek') ||
        settings.modelId.includes('deepseek') ||
        settings.providerId === 'deepseek' ||
        Boolean(settings.baseUrl?.includes('deepseek'))
      const mapEventsForProvider = (events: NexusEvent[], initialPrompt: string): ModelMessage[] =>
        mapEventsToMessages(events, initialPrompt, {
          replayReasoningContent: shouldReplayReasoningContent,
        })

      const intakeEvent = await buildUserIntakeGuidanceEvent({
        adapter,
        modelId: cleanedModelId,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        sessionId: options.sessionId,
        events: previousEvents,
        latestPrompt: options.prompt,
        cwd: options.cwd,
        signal: options.signal,
      })
      yield intakeEvent
      previousEvents = [...previousEvents, intakeEvent]

      const toolsList = () => [...this.tools.values()]
        .filter(tool => this.toolPolicy.isAllowed(tool))
        .map(tool => ({
          name: tool.name,
          description: tool.prompt ? tool.prompt() : tool.description,
          inputSchema: tool.modelInputSchema ?? z.toJSONSchema(tool.inputSchema),
        }))
      const loadSessionInbox = async () => {
        try {
          return await this.storage.listSessionInbox(options.sessionId, { limit: 20 })
        } catch (error) {
          logger.debug('Failed to load session inbox from storage', error)
          return []
        }
      }
      const contextWarningPercent = 70
      const contextCompactPercent = 90
      let contextRefreshState = await refreshRuntimeContextState({
        runtimeOptions: options,
        events: previousEvents,
        modelId: cleanedModelId,
        buildSystemPrompt,
        mapEventsToMessages: mapEventsForProvider,
        tools: toolsList,
        warningPercent: contextWarningPercent,
        compactPercent: contextCompactPercent,
        suppressToolsForIntent: shouldSuppressToolsForIntent,
        memoryProvider: this.memoryProvider,
      })
      let assembledContext = contextRefreshState.assembledContext
      let messages = contextRefreshState.messages
      let currentToolsList = contextRefreshState.currentToolsList
      let modelVisibleTools = contextRefreshState.modelVisibleTools
      let contextWindowState = contextRefreshState.contextWindowState
      let autoCompactDecision = contextRefreshState.autoCompactDecision
      let cacheAwareCompactPolicy = contextRefreshState.cacheAwareCompactPolicy
      absorbCacheAwareCompactPolicyMetrics(metrics, cacheAwareCompactPolicy)
      const estimateVisibleContextTokens = () => estimateContextTokens({
        systemPrompt: assembledContext.systemPrompt,
        messages,
        tools: modelVisibleTools,
        conservative: true,
      }).totalTokens
      const applyContextRefreshState = (nextState: typeof contextRefreshState) => {
        contextRefreshState = nextState
        assembledContext = nextState.assembledContext
        messages = nextState.messages
        currentToolsList = nextState.currentToolsList
        modelVisibleTools = nextState.modelVisibleTools
        contextWindowState = nextState.contextWindowState
        cacheAwareCompactPolicy = nextState.cacheAwareCompactPolicy
        absorbCacheAwareCompactPolicyMetrics(metrics, cacheAwareCompactPolicy)
      }
      if (contextWindowState.isWarning || autoCompactDecision.fuseOpen) {
        const compactPercent = autoCompactDecision.enabled
          ? autoCompactDecision.thresholdPercent
          : contextCompactPercent
        yield buildContextWarningEvent({
          sessionId: options.sessionId,
          modelId: cleanedModelId,
          windowState: contextWindowState,
          thresholdPercent: compactPercent,
          message: autoCompactDecision.fuseOpen
            ? `Auto compact is paused after ${autoCompactDecision.failureCount} consecutive failures. Run /compact manually or inspect compact_failure events.`
            : contextWindowState.isCompact
              ? `Context has passed the compact threshold (${compactPercent}%). Auto-compact will trigger on this turn.`
              : `Context is approaching the compact threshold (${contextWarningPercent}%→${compactPercent}%). Consider /compact soon.`,
          cacheAwareCompactPolicy,
        })
      }
      let compactAttempted = false
      if (autoCompactDecision.shouldCompact) {
        compactAttempted = true
        try {
          const compactResult = await compactSession({
            storage: this.storage,
            sessionId: options.sessionId,
            modelId: cleanedModelId,
            trigger: 'auto',
            mapEventsToMessages: mapEventsForProvider,
            initialPrompt: options.prompt,
          })
          absorbCompactSummaryLatencyMetrics(metrics, compactResult.summaryLatencyMs)
          yield compactResult.event
          previousEvents = [...previousEvents, compactResult.event]
          applyContextRefreshState(await refreshRuntimeContextState({
            runtimeOptions: options,
            events: previousEvents,
            modelId: cleanedModelId,
            buildSystemPrompt,
            mapEventsToMessages: mapEventsForProvider,
            tools: toolsList,
            warningPercent: contextWarningPercent,
            compactPercent: contextCompactPercent,
            suppressToolsForIntent: shouldSuppressToolsForIntent,
            memoryProvider: this.memoryProvider,
            sessionInbox: await loadSessionInbox(),
          }))
          autoCompactDecision = contextRefreshState.autoCompactDecision
        } catch (error) {
          yield buildCompactFailureEvent({
            sessionId: options.sessionId,
            trigger: 'auto',
            modelId: cleanedModelId,
            failureCount: autoCompactDecision.failureCount + 1,
            maxFailures: autoCompactDecision.failureLimit,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (contextWindowState.isBlocking && !compactAttempted) {
        compactAttempted = true
        try {
          const compactResult = await compactSession({
            storage: this.storage,
            sessionId: options.sessionId,
            modelId: cleanedModelId,
            trigger: 'reactive',
            mapEventsToMessages: mapEventsForProvider,
            initialPrompt: options.prompt,
          })
          absorbCompactSummaryLatencyMetrics(metrics, compactResult.summaryLatencyMs)
          yield compactResult.event
          previousEvents = [...previousEvents, compactResult.event]
          applyContextRefreshState(await refreshRuntimeContextState({
            runtimeOptions: options,
            events: previousEvents,
            modelId: cleanedModelId,
            buildSystemPrompt,
            mapEventsToMessages: mapEventsForProvider,
            tools: toolsList,
            warningPercent: contextWarningPercent,
            compactPercent: contextCompactPercent,
            suppressToolsForIntent: shouldSuppressToolsForIntent,
            memoryProvider: this.memoryProvider,
            sessionInbox: await loadSessionInbox(),
          }))
        } catch (error) {
          yield buildCompactFailureEvent({
            sessionId: options.sessionId,
            trigger: 'reactive',
            modelId: cleanedModelId,
            failureCount: autoCompactDecision.failureCount + 1,
            maxFailures: autoCompactDecision.failureLimit,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (contextWindowState.isBlocking) {
        for (const event of buildContextBlockingEvents({
          sessionId: options.sessionId,
          modelId: cleanedModelId,
          windowState: contextWindowState,
          thresholdPercent: autoCompactDecision.enabled
            ? autoCompactDecision.thresholdPercent
            : contextCompactPercent,
          cacheAwareCompactPolicy,
        })) yield event
        yield buildRuntimeExecutionMetricsEvent(options, metrics)
        return
      }

      // Parse thinking budget config from environments or options.budget
      const thinkingBudgetEnv =
        process.env.BABEL_O_THINKING_BUDGET || process.env.ANTHROPIC_THINKING_BUDGET
      const thinkingBudget = options.budget !== undefined ? options.budget : (thinkingBudgetEnv ? parseInt(thinkingBudgetEnv, 10) : undefined)

      let loopCount = 0
      const maxLoops = 25
      let finalResponseOnlyMode = false
      let outputRetryCount = 0
      const MAX_OUTPUT_RETRIES = 2
      const MAX_TOKEN_RECOVERIES = 3
      const MAX_SUPPRESSED_TOOL_RETRIES = 1
      let maxTokenRecoveryCount = 0
      let suppressedToolRetryCount = 0
      const replacementState = createReplacementState()
      let providerLoopCompactAttempted = false

      while (loopCount < maxLoops) {
        loopCount++

        if (options.signal?.aborted) {
          throw new Error('Aborted')
        }

        messages = await enforceMessageBudget(messages, replacementState, options.sessionId, options.cwd, {
          contextMaxTokens: cacheAwareCompactPolicy.effectiveContextCeiling ?? assembledContext.budget.maxTokens,
        })

        let suppressToolsForCurrentIntent =
          shouldSuppressToolsForIntent(assembledContext.userIntentGuidance) &&
          suppressedToolRetryCount < MAX_SUPPRESSED_TOOL_RETRIES
        let requestState = buildProviderLoopRequestState({
          loopCount,
          maxLoops,
          readFileCache: this.readFileCache,
          toolCallCount: metrics.toolCallCount,
          systemPrompt: assembledContext.systemPrompt,
          messages,
          currentToolsList: toolsList(),
          contextMaxTokens: assembledContext.budget.maxTokens,
          warningPercent: contextWarningPercent,
          compactPercent: contextCompactPercent,
          suppressToolsForUserIntent: suppressToolsForCurrentIntent,
          cacheAwareCompactPolicy,
          finalResponseOnlyRemainingLoops: FINAL_RESPONSE_ONLY_REMAINING_LOOPS,
        })
        currentToolsList = requestState.currentToolsList
        modelVisibleTools = requestState.modelVisibleTools
        if (requestState.contextWindowState.isBlocking && !providerLoopCompactAttempted) {
          providerLoopCompactAttempted = true
          try {
            const compactResult = await compactSession({
              storage: this.storage,
              sessionId: options.sessionId,
              modelId: cleanedModelId,
              trigger: 'reactive',
              mapEventsToMessages: mapEventsForProvider,
              initialPrompt: options.prompt,
            })
            absorbCompactSummaryLatencyMetrics(metrics, compactResult.summaryLatencyMs)
            yield compactResult.event
            previousEvents = [...previousEvents, compactResult.event]
            applyContextRefreshState(await refreshRuntimeContextState({
              runtimeOptions: options,
              events: previousEvents,
              modelId: cleanedModelId,
              buildSystemPrompt,
              mapEventsToMessages: mapEventsForProvider,
              tools: toolsList,
              warningPercent: contextWarningPercent,
              compactPercent: contextCompactPercent,
              suppressToolsForIntent: shouldSuppressToolsForIntent,
              memoryProvider: this.memoryProvider,
              sessionInbox: await loadSessionInbox(),
            }))
            messages = await enforceMessageBudget(messages, replacementState, options.sessionId, options.cwd, {
              contextMaxTokens: cacheAwareCompactPolicy.effectiveContextCeiling ?? assembledContext.budget.maxTokens,
            })
            suppressToolsForCurrentIntent =
              shouldSuppressToolsForIntent(assembledContext.userIntentGuidance) &&
              suppressedToolRetryCount < MAX_SUPPRESSED_TOOL_RETRIES
            requestState = buildProviderLoopRequestState({
              loopCount,
              maxLoops,
              readFileCache: this.readFileCache,
              toolCallCount: metrics.toolCallCount,
              systemPrompt: assembledContext.systemPrompt,
              messages,
              currentToolsList: toolsList(),
              contextMaxTokens: assembledContext.budget.maxTokens,
              warningPercent: contextWarningPercent,
              compactPercent: contextCompactPercent,
              suppressToolsForUserIntent: suppressToolsForCurrentIntent,
              cacheAwareCompactPolicy,
              finalResponseOnlyRemainingLoops: FINAL_RESPONSE_ONLY_REMAINING_LOOPS,
            })
            currentToolsList = requestState.currentToolsList
            modelVisibleTools = requestState.modelVisibleTools
          } catch (error) {
            yield buildCompactFailureEvent({
              sessionId: options.sessionId,
              trigger: 'reactive',
              modelId: cleanedModelId,
              failureCount: autoCompactDecision.failureCount + 1,
              maxFailures: autoCompactDecision.failureLimit,
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
        if (requestState.contextWindowState.isBlocking) {
          for (const event of buildRuntimeContextBlockingEventsForLoop({
            sessionId: options.sessionId,
            modelId: cleanedModelId,
            windowState: requestState.contextWindowState,
            autoCompactDecision,
            fallbackThresholdPercent: contextCompactPercent,
            cacheAwareCompactPolicy,
          })) yield event
          yield buildRuntimeExecutionMetricsEvent(options, metrics)
          return
        }

        metrics.contextCharsIn += requestState.turnContextCharsIn
        finalResponseOnlyMode = requestState.finalResponseOnlyMode

        const prefixCacheDiagnostics = computeProviderPrefixCacheDiagnostics({
          systemPromptBlocks: assembledContext.systemPromptBlocks,
          executionStateBlock: requestState.executionStateBlock,
          tools: modelVisibleTools,
        })
        absorbPrefixCacheDiagnosticsMetrics(metrics, prefixCacheDiagnostics)

        const queryParams = buildProviderQueryParams({
          modelId: cleanedModelId,
          systemPrompt: assembledContext.systemPrompt,
          systemPromptBlocks: assembledContext.systemPromptBlocks,
          executionStateBlock: requestState.executionStateBlock,
          messages,
          tools: modelVisibleTools,
          maxTokens: options.maxOutputTokens,
          providerId: settings.providerId,
          thinkingBudget,
        })

        const adapterOptions = {
          signal: options.signal,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
        }
        const invocationMetadata: NonNullable<RuntimeHookInput['invocation']> = {
          providerId: settings.providerId,
          modelId: cleanedModelId,
          loopCount,
          maxLoops,
          role: options.role,
          contextTokenEstimate: requestState.contextWindowState.tokenEstimate,
          contextMaxTokens: requestState.contextWindowState.maxTokens,
          percentUsed: requestState.contextWindowState.percentUsed,
          toolCount: currentToolsList.length,
          visibleToolCount: modelVisibleTools.length,
          cachePreservationMode: cacheAwareCompactPolicy.cachePreservationMode,
          finalResponseOnlyMode,
        }

        const preInvocationHooks = await executeRuntimeHooks(
          'PreInvocation',
          { invocation: invocationMetadata },
          {
            sessionId: options.sessionId,
            cwd: options.cwd,
            role: options.role,
            signal: options.signal,
          },
          { config: options.hooks },
        )
        for (const hookEvent of preInvocationHooks.events) yield hookEvent

        const invocationStartMs = performance.now()
        let providerTurn: RuntimeProviderTurn
        try {
          const toolCallTextLeakPhase = finalResponseOnlyMode
            ? 'final_response_only'
            : suppressToolsForCurrentIntent
              ? 'respond_only'
              : modelVisibleTools.length === 0
                ? 'tools_hidden'
                : undefined
          const providerTurnStream = streamProviderTurn({
            stream: adapter.queryStream(queryParams, adapterOptions),
            sessionId: options.sessionId,
            signal: options.signal,
            executionStartMs: metrics.executionStartMs,
            queryStartMs: invocationStartMs,
            ...(toolCallTextLeakPhase && { toolCallTextLeakGuard: { phase: toolCallTextLeakPhase } }),
          })
          let providerTurnResult = await providerTurnStream.next()
          while (!providerTurnResult.done) {
            yield providerTurnResult.value
            providerTurnResult = await providerTurnStream.next()
          }
          providerTurn = providerTurnResult.value
        } catch (error) {
          const providerRecovery = classifyProviderRecovery(error)
          const postInvocationHooks = await executeRuntimeHooks(
            'PostInvocation',
            {
              invocation: {
                ...invocationMetadata,
                durationMs: performance.now() - invocationStartMs,
                success: false,
                errorCode: providerInvocationErrorCode(error, options),
                failureKind: providerRecovery?.kind,
              },
            },
            {
              sessionId: options.sessionId,
              cwd: options.cwd,
              role: options.role,
              signal: options.signal,
            },
            { config: options.hooks },
          )
          for (const hookEvent of postInvocationHooks.events) yield hookEvent
          throw error
        }

        const postInvocationHooks = await executeRuntimeHooks(
          'PostInvocation',
          {
            invocation: {
              ...invocationMetadata,
              durationMs: providerTurn.durationMs,
              success: true,
            },
          },
          {
            sessionId: options.sessionId,
            cwd: options.cwd,
            role: options.role,
            signal: options.signal,
          },
          { config: options.hooks },
        )
        for (const hookEvent of postInvocationHooks.events) yield hookEvent

        absorbProviderTurnMetrics(metrics, providerTurn)
        if (providerTurn.toolCallTextLeakSuppression) {
          metrics.toolCallTextLeakSuppressedCount += 1
          metrics.toolShapedTextPattern = providerTurn.toolCallTextLeakSuppression.pattern
        }
        const providerOutcome = reduceProviderTurnOutcome({
          sessionId: options.sessionId,
          turn: providerTurn,
          finalResponseOnlyMode,
          suppressToolsForUserIntent: suppressToolsForCurrentIntent,
          userIntentGuidance: assembledContext.userIntentGuidance,
          providerId: settings.providerId,
          modelId: cleanedModelId,
          maxTokenRecoveryCount,
          maxTokenRecoveries: MAX_TOKEN_RECOVERIES,
          outputRetryCount,
          maxOutputRetries: MAX_OUTPUT_RETRIES,
          suppressedToolRetryCount,
          maxSuppressedToolRetries: MAX_SUPPRESSED_TOOL_RETRIES,
        })
        if (providerTurn.toolCallTextLeakSuppression && providerOutcome.kind === 'continue') {
          metrics.finalAnswerRetryCount += 1
        }
        maxTokenRecoveryCount = providerOutcome.maxTokenRecoveryCount
        outputRetryCount = providerOutcome.outputRetryCount
        suppressedToolRetryCount = providerOutcome.suppressedToolRetryCount
        for (const event of providerOutcome.eventsBeforeMessages) yield event
        messages.push(...providerOutcome.messages)
        for (const event of providerOutcome.eventsAfterMessages) yield event
        if (providerOutcome.kind === 'continue') continue
        if (providerOutcome.kind === 'terminal') {
          if (providerOutcome.queueSessionMemoryLiteUpdate) {
            queueSessionMemoryLiteUpdate({
              storage: this.storage,
              sessionId: options.sessionId,
              cwd: options.cwd,
              trigger: 'reactive',
              reason: 'pause',
            })
          }
          yield buildRuntimeExecutionMetricsEvent(options, metrics)
          return
        }

        const toolResultsContent = []
        for (const tc of providerOutcome.toolCalls) {
          const toolExecution = executeProviderToolCall({
            toolCall: tc,
            tools: this.tools,
            toolPolicy: this.toolPolicy,
            runtimeOptions: options,
            storage: this.storage,
            metrics,
            readFileCache: this.readFileCache,
          })
          let next = await toolExecution.next()
          while (!next.done) {
            yield next.value
            next = await toolExecution.next()
          }
          if (next.value.kind === 'terminal') {
            return
          }
          toolResultsContent.push(next.value.toolResult)
        }

        messages.push(buildProviderToolResultsMessage(toolResultsContent))
      }

      const maxLoopsMessage = `Execution exceeded maximum tool call iterations (${maxLoops}).`
      yield buildRuntimeErrorEvent({
        sessionId: options.sessionId,
        code: 'MAX_LOOPS_EXCEEDED',
        message: maxLoopsMessage,
      })
      yield buildRuntimeResultEvent(options.sessionId, false, maxLoopsMessage)
      yield buildRuntimeExecutionMetricsEvent(options, metrics)
    } catch (err: any) {
      const isTimeout = options.timeoutSignal?.aborted
      const isCancelled = !isTimeout && (options.signal?.aborted || err.message?.includes('Abort') || err.name === 'AbortError')
      const providerRecovery = classifyProviderRecovery(err)
      const errorCode = isTimeout ? 'REQUEST_TIMEOUT' : isCancelled ? 'REQUEST_CANCELLED' : (err.code || 'PROVIDER_ERROR')
      const errorText = isCancelled
        ? 'Execution cancelled by user.'
        : err instanceof Error ? err.message : String(err)
      yield buildRuntimeErrorEvent({
        sessionId: options.sessionId,
        code: errorCode,
        message: errorText,
        details: providerRecovery,
      })
      yield buildRuntimeResultEvent(options.sessionId, false, errorText)
      yield buildRuntimeExecutionMetricsEvent(options, metrics)
    }
  }
}

export function buildSystemPrompt(
  options: RuntimeExecuteOptions,
  projectMemory = '',
  sessionSummary = '',
  activeSkills = '',
): string {
  const sections = buildSystemPromptSections({
    cwd: options.cwd,
    platform: process.platform,
    projectMemory: projectMemory.trim() || undefined,
    sessionSummary: sessionSummary.trim() || undefined,
    activeSkills: activeSkills.trim() || undefined,
    prompt: options.prompt,
  })
  return sectionsToPromptText(sections)
}

// extractAbsolutePaths is now exported from systemPromptBuilder.ts
// Re-export for backward compatibility
export { extractAbsolutePaths } from './systemPromptBuilder.js'

function providerInvocationErrorCode(error: unknown, options: RuntimeExecuteOptions): string {
  const err = error as { code?: string; message?: string; name?: string }
  const isTimeout = options.timeoutSignal?.aborted
  const isCancelled = !isTimeout && (options.signal?.aborted || err.message?.includes('Abort') || err.name === 'AbortError')
  return isTimeout ? 'REQUEST_TIMEOUT' : isCancelled ? 'REQUEST_CANCELLED' : (err.code || 'PROVIDER_ERROR')
}

function resolveCwdFromPrompt(prompt: string, baseCwd: string): string {
  const paths = extractAbsolutePaths(prompt)
  for (const candidate of paths) {
    const resolved = resolvePromptPath(candidate)
    if (!existsSync(resolved)) {
      const parent = dirname(resolved)
      if (parent !== resolved && existsSync(parent)) {
        return parent
      }
      continue
    }
    try {
      const stat = lstatSync(resolved)
      if (stat.isDirectory()) {
        return resolved
      }
      const parent = dirname(resolved)
      if (parent !== resolved) {
        return parent
      }
    } catch {
      continue
    }
  }
  return baseCwd
}

export function mapEventsToMessages(
  events: NexusEvent[],
  initialPrompt: string,
  options: MapEventsToMessagesOptions = {},
): ModelMessage[] {
  const messages: ModelMessage[] = []

  const firstUserMsg = events.find(e => e.type === 'user_message') as Extract<NexusEvent, { type: 'user_message' }> | undefined
  const initial = firstUserMsg ? firstUserMsg.text : initialPrompt
  messages.push({ role: 'user', content: initial })

  const completedToolIds = new Set<string>()
  const startedToolIds = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool_started') {
      startedToolIds.add(event.toolUseId)
    }
    if (event.type === 'tool_completed') {
      completedToolIds.add(event.toolUseId)
    }
  }

  let pendingToolResultMsg: ModelMessage | null = null
  let pendingToolAssistantMsg: ModelMessage | null = null
  let pendingReasoningContent = ''

  for (const event of events) {
    if (event.type === 'user_message') {
      pendingToolResultMsg = null
      pendingToolAssistantMsg = null
      pendingReasoningContent = ''
      const lastMsg = messages[messages.length - 1]
      if (
        lastMsg?.role === 'user' &&
        typeof lastMsg.content === 'string' &&
        lastMsg.content === event.text
      ) {
        continue
      }
      messages.push({ role: 'user', content: event.text })
    } else if (event.type === 'assistant_delta') {
      pendingToolResultMsg = null
      pendingToolAssistantMsg = null
      let lastMsg = messages[messages.length - 1]
      if (!lastMsg || lastMsg.role !== 'assistant') {
        lastMsg = {
          role: 'assistant',
          content: '',
          ...(options.replayReasoningContent && pendingReasoningContent.trim() && {
            reasoningContent: pendingReasoningContent,
          }),
        }
        pendingReasoningContent = ''
        messages.push(lastMsg)
      }
      if (typeof lastMsg.content === 'string') {
        lastMsg.content += event.text
      } else {
        const lastBlock = lastMsg.content[lastMsg.content.length - 1]
        if (lastBlock && lastBlock.type === 'text') {
          lastBlock.text += event.text
        } else {
          lastMsg.content.push({ type: 'text', text: event.text })
        }
      }
    } else if (event.type === 'thinking_delta') {
      if (!options.replayReasoningContent) {
        // Keep thinking_delta in the event log for UI/history, but do not replay
        // prior hidden reasoning into future provider calls. Some providers treat
        // reasoningContent as live context, which can pollute follow-up turns.
        continue
      }
      const lastMsg = messages[messages.length - 1]
      if (!lastMsg || lastMsg.role !== 'assistant') {
        pendingReasoningContent += event.text
        continue
      }
      lastMsg.reasoningContent = `${lastMsg.reasoningContent ?? ''}${event.text}`
      continue
    } else if (event.type === 'tool_started') {
      let lastMsg: ModelMessage | null | undefined = pendingToolAssistantMsg
      if (!lastMsg) {
        lastMsg = messages[messages.length - 1]
        if (!lastMsg || lastMsg.role !== 'assistant' || !isToolCompatibleAssistantMessage(lastMsg)) {
          lastMsg = {
            role: 'assistant',
            content: [],
            ...(options.replayReasoningContent && pendingReasoningContent.trim() && {
              reasoningContent: pendingReasoningContent,
            }),
          }
          pendingReasoningContent = ''
          messages.push(lastMsg)
        } else if (typeof lastMsg.content === 'string') {
          lastMsg.content = lastMsg.content ? [{ type: 'text', text: lastMsg.content }] : []
        }
        pendingToolAssistantMsg = lastMsg
      }
      ;(lastMsg.content as ContentBlock[]).push({
        type: 'tool_use',
        id: event.toolUseId,
        name: event.name,
        input: event.input,
      })

      // If this tool was started but never completed (e.g. denied or interrupted),
      // we must synthetically complete it with an error result block so future queries don't break.
      if (!completedToolIds.has(event.toolUseId)) {
        let lastUserMsg: ModelMessage | null = pendingToolResultMsg
        if (!lastUserMsg || typeof lastUserMsg.content === 'string') {
          lastUserMsg = { role: 'user', content: [] }
          messages.push(lastUserMsg)
          pendingToolResultMsg = lastUserMsg
        }
        ;(lastUserMsg.content as ContentBlock[]).push({
          type: 'tool_result',
          toolUseId: event.toolUseId,
          content: 'Error: Tool execution was denied or interrupted.',
          isError: true,
        })
      }
    } else if (event.type === 'tool_completed' && startedToolIds.has(event.toolUseId)) {
      let lastMsg: ModelMessage | null = pendingToolResultMsg
      if (!lastMsg || typeof lastMsg.content === 'string') {
        lastMsg = { role: 'user', content: [] }
        messages.push(lastMsg)
        pendingToolResultMsg = lastMsg
      }
      const outputText =
        typeof event.output === 'string'
          ? event.output
          : JSON.stringify(event.output, null, 2)
      ;(lastMsg.content as ContentBlock[]).push({
        type: 'tool_result',
        toolUseId: event.toolUseId,
        content: outputText,
        isError: !event.success,
        toolName: event.name,
      })
    }
  }

  return messages
}

function isToolCompatibleAssistantMessage(message: ModelMessage): boolean {
  if (message.role !== 'assistant' || typeof message.content === 'string') {
    return message.role === 'assistant'
  }
  return message.content.every(block => block.type === 'text' || block.type === 'tool_use')
}
