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
import { allowAllTools, allowlistedTools, type ToolPolicy } from './LocalCodingRuntime.js'
import { buildPerRequestAllowedToolsPolicy } from './perRequestPolicy.js'
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
import { buildTaskScopeDeclaredEvent, deriveTaskScope } from './taskScope.js'
import { queueSessionMemoryLiteUpdate } from './sessionMemoryLite.js'
import {
  buildTraceContext,
  detectTriggers,
  deriveRuleSelfAssessment,
  flushBehaviorTraceQueue,
  isBehaviorTraceEnabled,
  queueBehaviorTraceEntry,
} from './behaviorTrace.js'
import { estimateContextTokens } from './tokenEstimator.js'
import { classifyProviderRecovery } from './providerRecovery.js'
import {
  createReplacementState,
  enforceMessageBudget,
} from './toolResultBudget.js'
import {
  buildUserIntakeGuidanceEvent,
  isPureMemoryCapabilityQuestion,
  shouldSuppressToolsForIntent,
} from './intentGuidance.js'
import {
  absorbCacheAwareCompactPolicyMetrics,
  absorbCompactSummaryLatencyMetrics,
  absorbPrefixCacheDiagnosticsMetrics,
  absorbProviderTurnMetrics,
  buildContextBlockingEvents,
  buildContextMicrocompactEvent,
  buildContextRecoveryAttemptedEvent,
  buildContextGroundingConfirmedEventForToolResult,
  buildPostCompactGroundingEvents,
  buildContextUsageEvent,
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
  isOptionSelectionClarificationText,
  normalizeOptionSelection,
  reduceProviderTurnOutcome,
  refreshRuntimeContextState,
  resolveProviderToolCallInput,
  streamProviderTurn,
  type RuntimeProviderTurn,
} from './runtimePipeline.js'
import { executeProviderToolCall, type ReadFileCacheEntry } from './runtimeToolLoop.js'
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
  private readFileCache = new Map<string, ReadFileCacheEntry>()

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
    // Phase D of docs/nexus/reference/go-tui-permission-policy-governance-plan.md:
    // when the request body carries `allowedTools`, apply a per-turn
    // allowlist-based policy override. The override is scoped to this
    // turn only — the next turn re-evaluates from the (possibly
    // different) body. `policyMode: 'soft-deny'` continues to work
    // orthogonally: allowedTools controls the *policy* (which tools
    // are isAllowed), while policyMode controls whether the
    // *hard-deny* gate fires for tools outside the allowlist.
    let inner: AsyncIterable<NexusEvent>
    if (options.allowedTools && options.allowedTools.length > 0) {
      const overridePolicy = buildPerRequestAllowedToolsPolicy(options.allowedTools)
      inner = this.withToolPolicy(overridePolicy, () => this.runExecuteStreamInner(options))
    } else {
      inner = this.runExecuteStreamInner(options)
    }
    // PR-3 (Track B Phase 1 wire, see docs/nexus/reference/behavior-monitor.md
    // §5/§13): behaviorTrace tap. Best-effort side effect; never blocks or
    // mutates the event stream. Opt-out via BABEL_O_BEHAVIOR_TRACE_ENABLED.
    yield* this.withBehaviorTraceTap(options, inner)
  }

  // PR-3: behaviorTrace tap. Buffers events, runs detectTriggers on each
  // yield, and queues BehaviorTraceEntry writes. Respects INV-4 (no
  // silent injection — pure write-side, no model context mutation),
  // INV-11 (does not touch natural_pause), and test config isolation
  // (cwd comes from options, never from process.env.HOME).
  private async *withBehaviorTraceTap(
    options: RuntimeExecuteOptions,
    source: AsyncIterable<NexusEvent>,
  ): AsyncIterable<NexusEvent> {
    yield* wrapWithBehaviorTraceTap(options, source)
  }

  private async *runExecuteStreamInner(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
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
      const confirmedOptionSelection = isConfirmedOptionSelectionAfterClarification(previousEvents, options.prompt)
      let taskScopeEvent = buildTaskScopeDeclaredEvent({
        sessionId: options.sessionId,
        requestId: options.requestId,
        cwd: options.cwd,
        prompt: options.prompt,
        events: previousEvents,
        allowedPaths: options.allowedPaths,
      })
      yield taskScopeEvent
      previousEvents = [...previousEvents, taskScopeEvent]

      const toolsList = () => [...this.tools.values()]
        .filter(tool => this.toolPolicy.isAllowed(tool) || (
          options.policyMode === 'soft-deny' &&
          (tool.risk === 'write' || tool.risk === 'execute')
        ))
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
      yield buildContextUsageEvent({
        sessionId: options.sessionId,
        requestId: options.requestId,
        modelId: cleanedModelId,
        providerId: settings.providerId,
        windowState: contextWindowState,
        cacheAwareCompactPolicy,
        source: 'initial_refresh',
      })
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
      const contextMicrocompactEvent = (trigger: 'initial_refresh' | 'pre_provider_call' | 'after_compact' | 'after_message_budget') => buildContextMicrocompactEvent({
        sessionId: options.sessionId,
        requestId: options.requestId,
        trigger,
        metrics: assembledContext.microcompactMetrics,
      })
      const refreshAfterProviderContextRecovery = async () => {
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
      }
      const postCompactGroundingEvents = (source: 'post_compact' | 'context_recovery', boundaryId?: string) => {
        this.readFileCache.clear()
        return buildPostCompactGroundingEvents({
          sessionId: options.sessionId,
          requestId: options.requestId,
          source,
          boundaryId,
          gitStatus: assembledContext.gitStatus,
        })
      }
      const initialMicrocompactEvent = contextMicrocompactEvent('initial_refresh')
      if (initialMicrocompactEvent) yield initialMicrocompactEvent
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
          yield compactResult.contextEvent
          const groundingEvents = postCompactGroundingEvents('post_compact', compactResult.contextEvent.boundaryId)
          for (const groundingEvent of groundingEvents) yield groundingEvent
          previousEvents = [...previousEvents, compactResult.event, compactResult.contextEvent, ...groundingEvents]
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
          yield buildContextUsageEvent({
            sessionId: options.sessionId,
            requestId: options.requestId,
            modelId: cleanedModelId,
            providerId: settings.providerId,
            windowState: contextWindowState,
            cacheAwareCompactPolicy,
            source: 'after_compact',
          })
          const afterCompactMicrocompactEvent = contextMicrocompactEvent('after_compact')
          if (afterCompactMicrocompactEvent) yield afterCompactMicrocompactEvent
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
          yield compactResult.contextEvent
          const groundingEvents = postCompactGroundingEvents('post_compact', compactResult.contextEvent.boundaryId)
          for (const groundingEvent of groundingEvents) yield groundingEvent
          previousEvents = [...previousEvents, compactResult.event, compactResult.contextEvent, ...groundingEvents]
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
          yield buildContextUsageEvent({
            sessionId: options.sessionId,
            requestId: options.requestId,
            modelId: cleanedModelId,
            providerId: settings.providerId,
            windowState: contextWindowState,
            cacheAwareCompactPolicy,
            source: 'after_compact',
          })
          const afterCompactMicrocompactEvent = contextMicrocompactEvent('after_compact')
          if (afterCompactMicrocompactEvent) yield afterCompactMicrocompactEvent
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
      const MAX_PROVIDER_CONTEXT_RECOVERIES = 1
      let maxTokenRecoveryCount = 0
      let providerContextRecoveryCount = 0
      let suppressedToolRetryCount = 0
      let memoryCapabilityAnswerRetryCount = 0
      const memoryCapabilityQuestion = isPureMemoryCapabilityQuestion(options.prompt)
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
          !confirmedOptionSelection &&
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
        yield buildContextUsageEvent({
          sessionId: options.sessionId,
          requestId: options.requestId,
          modelId: cleanedModelId,
          providerId: settings.providerId,
          windowState: requestState.contextWindowState,
          cacheAwareCompactPolicy,
          source: 'pre_provider_call',
        })
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
            yield compactResult.contextEvent
            const groundingEvents = postCompactGroundingEvents('post_compact', compactResult.contextEvent.boundaryId)
            for (const groundingEvent of groundingEvents) yield groundingEvent
            previousEvents = [...previousEvents, compactResult.event, compactResult.contextEvent, ...groundingEvents]
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
              !confirmedOptionSelection &&
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
            yield buildContextUsageEvent({
              sessionId: options.sessionId,
              requestId: options.requestId,
              modelId: cleanedModelId,
              providerId: settings.providerId,
              windowState: requestState.contextWindowState,
              cacheAwareCompactPolicy,
              source: 'after_compact',
            })
            const afterCompactMicrocompactEvent = contextMicrocompactEvent('after_compact')
            if (afterCompactMicrocompactEvent) yield afterCompactMicrocompactEvent
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
          { config: options.hooks, hooks: options.runtimeHooks },
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
            ...(memoryCapabilityQuestion && { memoryCapabilityAnswerLeakGuard: true }),
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
            { config: options.hooks, hooks: options.runtimeHooks },
          )
          for (const hookEvent of postInvocationHooks.events) yield hookEvent
          if (providerRecovery?.kind === 'context_window') {
            const providerErrorCode = providerContextRecoveryErrorCode(error, options)
            if (providerContextRecoveryCount < MAX_PROVIDER_CONTEXT_RECOVERIES) {
              providerContextRecoveryCount += 1
              providerLoopCompactAttempted = true
              const attempt = providerContextRecoveryCount
              const preTokens = requestState.contextWindowState.tokenEstimate
              const recoveryEvent = buildContextRecoveryAttemptedEvent({
                sessionId: options.sessionId,
                requestId: options.requestId,
                providerId: settings.providerId,
                modelId: cleanedModelId,
                providerErrorCode,
                strategy: 'semantic_compact_retry',
                attempt,
                maxAttempts: MAX_PROVIDER_CONTEXT_RECOVERIES,
                preTokens,
                retryable: true,
                message: `Provider rejected the prompt as too large; compacting session context and retrying (${attempt}/${MAX_PROVIDER_CONTEXT_RECOVERIES}).`,
              })
              yield recoveryEvent
              previousEvents = [...previousEvents, recoveryEvent]
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
                yield compactResult.contextEvent
                const groundingEvents = postCompactGroundingEvents('context_recovery', compactResult.contextEvent.boundaryId)
                for (const groundingEvent of groundingEvents) yield groundingEvent
                previousEvents = [...previousEvents, compactResult.event, compactResult.contextEvent, ...groundingEvents]
                await refreshAfterProviderContextRecovery()
                autoCompactDecision = contextRefreshState.autoCompactDecision
                messages = await enforceMessageBudget(messages, replacementState, options.sessionId, options.cwd, {
                  contextMaxTokens: cacheAwareCompactPolicy.effectiveContextCeiling ?? assembledContext.budget.maxTokens,
                })
                yield buildContextUsageEvent({
                  sessionId: options.sessionId,
                  requestId: options.requestId,
                  modelId: cleanedModelId,
                  providerId: settings.providerId,
                  windowState: contextWindowState,
                  cacheAwareCompactPolicy,
                  source: 'after_compact',
                })
                const afterCompactMicrocompactEvent = contextMicrocompactEvent('after_compact')
                if (afterCompactMicrocompactEvent) yield afterCompactMicrocompactEvent
                continue
              } catch (compactError) {
                yield buildCompactFailureEvent({
                  sessionId: options.sessionId,
                  trigger: 'reactive',
                  modelId: cleanedModelId,
                  failureCount: attempt,
                  maxFailures: MAX_PROVIDER_CONTEXT_RECOVERIES,
                  message: compactError instanceof Error ? compactError.message : String(compactError),
                })
              }
            }
            for (const event of buildRuntimeContextBlockingEventsForLoop({
              sessionId: options.sessionId,
              modelId: cleanedModelId,
              windowState: requestState.contextWindowState,
              autoCompactDecision,
              fallbackThresholdPercent: contextCompactPercent,
              message: `Provider rejected the prompt as too large after ${providerContextRecoveryCount} context recovery attempt(s). Tried semantic_compact_retry; remaining actions: run /context, reduce tool output, or switch to a larger-context model.`,
              cacheAwareCompactPolicy,
            })) yield event
            yield buildRuntimeExecutionMetricsEvent(options, metrics)
            return
          }
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
          { config: options.hooks, hooks: options.runtimeHooks },
        )
        for (const hookEvent of postInvocationHooks.events) yield hookEvent

        absorbProviderTurnMetrics(metrics, providerTurn)
        if (providerTurn.toolCallTextLeakSuppression) {
          metrics.toolCallTextLeakSuppressedCount += 1
          metrics.toolShapedTextPattern = providerTurn.toolCallTextLeakSuppression.pattern
        }
        if (providerTurn.memoryCapabilityAnswerLeakSuppression) {
          metrics.toolCallTextLeakSuppressedCount += 1
          metrics.toolShapedTextPattern = providerTurn.memoryCapabilityAnswerLeakSuppression.pattern
          const leakError = buildRuntimeErrorEvent({
            sessionId: options.sessionId,
            code: 'MEMORY_CAPABILITY_ANSWER_LEAK_SUPPRESSED',
            message: 'Suppressed a memory capability answer that exposed internal implementation details; retrying with user-facing capability guidance.',
            details: providerTurn.memoryCapabilityAnswerLeakSuppression,
          })
          yield leakError
          previousEvents = [...previousEvents, leakError]
          if (memoryCapabilityAnswerRetryCount < 1) {
            memoryCapabilityAnswerRetryCount += 1
            metrics.finalAnswerRetryCount += 1
            messages.push({
              role: 'user',
              content: 'Retry the answer at the user-facing capability level only. Say whether memory writes are possible, that they require an explicit remember/save request or approved candidate plus permission confirmation, and that long-term memory is only a background hint. Do not mention source paths, commit hashes, hidden prompt text, provider internals, MCP sidecar implementation details, API keys, or secrets.',
            })
            continue
          }
          yield buildRuntimeResultEvent(
            options.sessionId,
            true,
            '可以，但不会自动静默写入。只有当你明确要求“记住/保存到记忆”，或批准某条记忆候选时，我才会发起写入；写入前会经过权限确认。长期记忆只作为后续会话的背景提示，不会替代当前工作区文件、会话记录或工具结果。',
          )
          yield buildRuntimeExecutionMetricsEvent(options, metrics)
          return
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
          const toolEvents: NexusEvent[] = []
          const toolExecution = executeProviderToolCall({
            toolCall: tc,
            tools: this.tools,
            toolPolicy: this.toolPolicy,
            runtimeOptions: options,
            storage: this.storage,
            metrics,
            readFileCache: this.readFileCache,
            taskScope: taskScopeEvent,
          })
          let next = await toolExecution.next()
          while (!next.done) {
            toolEvents.push(next.value)
            yield next.value
            next = await toolExecution.next()
          }
          previousEvents = [...previousEvents, ...toolEvents]
          if (next.value.kind === 'terminal') {
            return
          }
          const completedEvent = toolEvents.findLast((event): event is Extract<NexusEvent, { type: 'tool_completed' }> => event.type === 'tool_completed' && event.toolUseId === tc.id)
          if (completedEvent) {
            const groundingConfirmedEvent = buildContextGroundingConfirmedEventForToolResult({
              sessionId: options.sessionId,
              requestId: options.requestId,
              events: previousEvents,
              toolCompleted: completedEvent,
              toolInput: resolveProviderToolCallInput(tc),
            })
            if (groundingConfirmedEvent) {
              previousEvents = [...previousEvents, groundingConfirmedEvent]
              yield groundingConfirmedEvent
            }
          }
          const scopeConfirmationEvents = toolEvents.filter((event): event is Extract<NexusEvent, { type: 'scope_boundary_confirmed' }> => event.type === 'scope_boundary_confirmed')
          if (scopeConfirmationEvents.length > 0) {
            taskScopeEvent = {
              ...taskScopeEvent,
              ...deriveTaskScope({
                sessionId: options.sessionId,
                requestId: options.requestId,
                cwd: options.cwd,
                prompt: options.prompt,
                events: previousEvents,
                allowedPaths: options.allowedPaths,
              }),
              message: taskScopeEvent.message,
            }
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

function providerContextRecoveryErrorCode(error: unknown, options: RuntimeExecuteOptions): string {
  const maybeMetadata = error as { metadata?: { code?: unknown; type?: unknown } }
  const providerCode = maybeMetadata.metadata?.code ?? maybeMetadata.metadata?.type
  if (typeof providerCode === 'string' && providerCode.trim()) return providerCode
  return providerInvocationErrorCode(error, options)
}

function isConfirmedOptionSelectionAfterClarification(events: NexusEvent[], latestPrompt: string): boolean {
  const optionSelection = normalizeOptionSelection(latestPrompt)
  if (!optionSelection) return false
  let skippedCurrentUserMessage = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'user_message') {
      if (!skippedCurrentUserMessage && normalizeOptionSelection(event.text) === optionSelection) {
        skippedCurrentUserMessage = true
        continue
      }
      return false
    }
    if (
      (event.type === 'assistant_delta' && isOptionSelectionClarificationText(event.text) && event.text.includes(`"${optionSelection}"`)) ||
      (event.type === 'result' && isOptionSelectionClarificationText(event.message) && event.message.includes(`"${optionSelection}"`))
    ) {
      return true
    }
  }
  return false
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
  const seenStartedToolIds = new Set<string>()
  const earlyCompletedByToolId = new Map<string, Extract<NexusEvent, { type: 'tool_completed' }>>()
  const emittedToolResultIds = new Set<string>()

  const appendToolResult = (event: Extract<NexusEvent, { type: 'tool_completed' }>) => {
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
    emittedToolResultIds.add(event.toolUseId)
  }

  const appendRuntimeUserMessage = (content: string) => {
    pendingToolResultMsg = null
    pendingToolAssistantMsg = null
    pendingReasoningContent = ''
    messages.push({ role: 'user', content })
  }

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
    } else if (event.type === 'context_grounding_required') {
      pendingToolResultMsg = null
      pendingToolAssistantMsg = null
      messages.push({ role: 'user', content: `Runtime grounding required: ${event.message} Required for: ${event.requiredFor.join(', ')}. Suggested actions: ${event.suggestedActions.join(', ')}.` })
    } else if (event.type === 'context_grounding_confirmed') {
      pendingToolResultMsg = null
      pendingToolAssistantMsg = null
      messages.push({ role: 'user', content: `Runtime grounding confirmed: ${event.message} Confirmation kind: ${event.confirmationKind}. Confirmed for: ${event.confirmedFor.join(', ')}. Source: ${event.source}.` })
    } else if (event.type === 'workspace_dirty_detected') {
      pendingToolResultMsg = null
      pendingToolAssistantMsg = null
      messages.push({ role: 'user', content: `Runtime workspace dirty guard: ${event.message} Changed files (${event.changedFileCount}): ${event.changedFiles.join(', ')}${event.truncated ? ' (truncated)' : ''}. Suggested actions: ${event.suggestedActions.join(', ')}.` })
    } else if (event.type === 'task_scope_declared') {
      pendingToolResultMsg = null
      pendingToolAssistantMsg = null
      messages.push({ role: 'user', content: `Runtime task scope declared: ${event.message} Primary root: ${event.primaryRoot}. Explicit roots: ${event.explicitRoots.join(', ') || 'none'}. Confirmed external roots: ${event.confirmedExternalRoots.join(', ') || 'none'}. Mode: ${event.mode}.` })
    } else if (event.type === 'scope_boundary_detected') {
      pendingToolResultMsg = null
      pendingToolAssistantMsg = null
      messages.push({ role: 'user', content: `Runtime scope boundary detected before ${event.toolName}: ${event.reason} Action: ${event.action}. Target root: ${event.targetRoot}. Current task root: ${event.taskPrimaryRoot}. Do not use this external evidence unless the user confirms the scope boundary.` })
    } else if (event.type === 'scope_boundary_confirmed') {
      pendingToolResultMsg = null
      pendingToolAssistantMsg = null
      messages.push({ role: 'user', content: `Runtime scope boundary confirmed: ${event.message} Target root: ${event.targetRoot}. Confirmation scope: ${event.confirmationScope}.` })
    } else if (event.type === 'near_timeout_warning') {
      appendRuntimeUserMessage(formatNearTimeoutConvergenceMessage(event))
    } else if (event.type === 'timeout_budget_exceeded') {
      appendRuntimeUserMessage(formatTimeoutBudgetConvergenceMessage(event))
    } else if (event.type === 'timeout_extension_granted') {
      appendRuntimeUserMessage(formatTimeoutExtensionConvergenceMessage(event))
    } else if (event.type === 'tool_started') {
      seenStartedToolIds.add(event.toolUseId)
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

      const completed = earlyCompletedByToolId.get(event.toolUseId)
      if (completed && !emittedToolResultIds.has(event.toolUseId)) {
        appendToolResult(completed)
      } else if (!completedToolIds.has(event.toolUseId)) {
        // If this tool was started but never completed (e.g. denied or interrupted),
        // we must synthetically complete it with an error result block so future queries don't break.
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
        emittedToolResultIds.add(event.toolUseId)
      }
    } else if (
      event.type === 'tool_completed' &&
      startedToolIds.has(event.toolUseId) &&
      !emittedToolResultIds.has(event.toolUseId)
    ) {
      if (seenStartedToolIds.has(event.toolUseId)) {
        appendToolResult(event)
      } else {
        earlyCompletedByToolId.set(event.toolUseId, event)
      }
    }
  }

  return messages
}

function formatNearTimeoutConvergenceMessage(event: Extract<NexusEvent, { type: 'near_timeout_warning' }>): string {
  return [
    `Runtime timeout convergence warning: elapsed ${event.elapsedMs}ms of ${event.timeoutMs}ms (${Math.round(event.thresholdRatio * 100)}% threshold). ${event.message}`,
    'Do not start new exploratory tool calls.',
    'Either answer with verified evidence already collected, or run at most one explicitly bounded final check.',
    'Mark unverified claims as unverified.',
    'If the task needs more exploration, ask the user to continue with a fresh budget.',
    event.partialSummary ? `Partial summary already available: ${event.partialSummary}` : '',
  ].filter(Boolean).join('\n')
}

function formatTimeoutBudgetConvergenceMessage(event: Extract<NexusEvent, { type: 'timeout_budget_exceeded' }>): string {
  return [
    `Runtime soft timeout budget reached: elapsed ${event.elapsedMs}ms of ${event.timeoutMs}ms (policy=${event.policy}). ${event.message}`,
    'This is a recoverable budget signal, not permission for broad discovery.',
    'Do not start new exploratory tool calls.',
    'Either answer with verified evidence already collected, or run at most one explicitly bounded final check.',
    'Mark unverified claims as unverified.',
    'If more exploration is required, ask the user to continue with a fresh budget.',
    event.suggestedActions?.length ? `Suggested actions: ${event.suggestedActions.join(', ')}.` : '',
    event.partialSummary ? `Partial summary already available: ${event.partialSummary}` : '',
  ].filter(Boolean).join('\n')
}

function formatTimeoutExtensionConvergenceMessage(event: Extract<NexusEvent, { type: 'timeout_extension_granted' }>): string {
  return [
    `Runtime soft timeout extension granted: extension ${event.extensionCount}/${event.maxExtensions}, +${event.additionalMs}ms, total soft budget ${event.totalSoftBudgetMs}ms.`,
    'Use this extension to wrap up.',
    'Do not start broad discovery. Run at most one explicitly bounded final check, then answer.',
    'Separate verified evidence from unverified claims.',
    `Reason: ${event.reason}. ${event.message}`,
  ].join('\n')
}

function isToolCompatibleAssistantMessage(message: ModelMessage): boolean {
  if (message.role !== 'assistant' || typeof message.content === 'string') {
    return message.role === 'assistant'
  }
  return message.content.every(block => block.type === 'text' || block.type === 'tool_use')
}

// ─── PR-3: behaviorTrace tap (top-level exportable function) ──────────────
//
// Lives outside the LLMCodingRuntime class so it can be unit-tested without
// instantiating a full runtime (and a real provider mock). Kept as a
// top-level export to preserve orthogonality with behaviorTrace.ts
// (see [[feedback-tool-boundary-granularity]]).
//
// Invariants:
//   - INV-4: pure write-side; never mutates the inner event stream
//   - INV-11: never touches natural_pause
//   - test-config-isolation: cwd comes from RuntimeExecuteOptions, never
//     from process.env.HOME
export async function* wrapWithBehaviorTraceTap(
  options: RuntimeExecuteOptions,
  source: AsyncIterable<NexusEvent>,
): AsyncIterable<NexusEvent> {
  if (!isBehaviorTraceEnabled()) {
    yield* source
    return
  }
  const buffer: NexusEvent[] = []
  let taskScopeGlob: string | undefined
  let lastTaskScopeEventAt = -1
  for await (const event of source) {
    buffer.push(event)
    if (event.type === 'task_scope_declared') {
      const e = event as Extract<NexusEvent, { type: 'task_scope_declared' }>
      const root = e.primaryRoot
      if (typeof root === 'string' && root.length > 0) {
        taskScopeGlob = root.endsWith('/**') ? root : `${root.replace(/\/+$/, '')}/**`
        lastTaskScopeEventAt = buffer.length - 1
      }
    }
    try {
      // Only consider events that have been seen (suppress drift detection
      // on the task_scope_declared event itself, which is the first event
      // that establishes the scope).
      const eventsForDetect = lastTaskScopeEventAt >= 0
        ? buffer.slice(lastTaskScopeEventAt)
        : buffer
      const detected = detectTriggers({
        events: eventsForDetect,
        cwd: options.cwd,
        sessionId: options.sessionId,
        taskScope: taskScopeGlob,
      })
      for (const det of detected) {
        const ctx = buildTraceContext({ events: buffer })
        const sa = deriveRuleSelfAssessment(det.trigger, det.anomaly, { retryCount: ctx.retryCount })
        queueBehaviorTraceEntry({
          cwd: options.cwd,
          sessionId: options.sessionId,
          trigger: det.trigger,
          triggerConfidence: det.confidence,
          anomaly: det.anomaly,
          context: ctx,
          selfAssessment: sa,
        })
      }
    } catch (error) {
      logger.debug('behaviorTrace tap detection failed', error)
    }
    yield event
  }
  // Best-effort flush. Do not block event stream teardown.
  void flushBehaviorTraceQueue().catch((error) => {
    logger.debug('behaviorTrace flush failed', error)
  })
}
