import { z } from 'zod'
import { resolve } from 'node:path'
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
import { buildSystemPromptSections, sectionsToPromptText, extractAbsolutePaths, resolvePromptPath, resolvePromptCwd } from './systemPromptBuilder.js'
import { deriveSessionRootContinuity, buildSessionRootContinuityMessage } from './sessionRootContinuity.js'
import type { NexusStorage } from '../storage/Storage.js'
import { getAdapter } from '../providers/registry.js'
import type {
  ModelMessage,
  ContentBlock,
} from '../providers/adapters/ModelAdapter.js'
import { ConfigManager } from '../shared/config.js'
import { mapEventsToMessages } from './eventsTranslator.js'
import { wrapWithBehaviorTraceTap } from './behaviorTraceTap.js'
import { loadWorkingSetOverride } from './loadWorkingSetOverride.js'
import { applyWorkingSetUpdate } from './applyWorkingSetUpdate.js'
import { emitMemoryRetrieval as emitMemoryRetrievalImpl } from './emitMemoryRetrieval.js'
import { prepareRuntimeStart } from './prepareRuntimeStart.js'
import { buildPostRefreshYieldEvents } from './buildPostRefreshYieldEvents.js'
import { buildContextRefreshClosureSet } from './buildContextRefreshClosureSet.js'
import { executePreLoopCompactSequence } from './executePreLoopCompactSequence.js'
import { executeProviderLoopCompactBlock } from './executeProviderLoopCompactBlock.js'
import { applyProviderOutcome } from './applyProviderOutcome.js'
import { executeToolDispatch } from './executeToolDispatch.js'
import { applyLeakSuppressionEffects } from './applyLeakSuppressionEffects.js'
import { executeProviderRecoveryDecision } from './executeProviderRecoveryDecision.js'
import {
  buildCompactFailureEvent,
  compactSession,
} from './compact.js'
import { buildTaskScopeDeclaredEvent, deriveTaskScope, type TaskScopeDeclaredEvent } from './taskScope.js'
import { queueSessionMemoryLiteUpdate } from './sessionMemoryLite.js'
// `wrapWithBehaviorTraceTap` (and its private `behaviorTraceDetectionKey`
// helper) were extracted to `./behaviorTraceTap.ts` in Phase 3B-6; the
// underlying behaviorTrace primitives it composes (buildTraceContext /
// detectTriggers / deriveRuleSelfAssessment / flushBehaviorTraceQueue /
// isBehaviorTraceEnabled / queueBehaviorTraceEntry) are now imported
// inside that module instead of here.
import { estimateContextTokens } from './tokenEstimator.js'
import { classifyProviderRecovery } from './providerRecovery.js'
// PR-A2: optional broadcaster type for the /v1/context/observe observer.
// Imported as a type-only reference to keep the runtime-side hot path
// paying no cost for the field.
import type { RuntimeContextBroadcaster } from './contextBroadcaster.js'
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
  type RuntimeProviderTurn,
} from './runtimePipeline.js'
import { ContextRefreshStrategy } from './ContextRefreshStrategy.js'
import { ProviderTurnDriver } from './ProviderTurnDriver.js'
import { ToolDispatchPipeline } from './ToolDispatchPipeline.js'
import { type ReadFileCacheEntry } from './runtimeToolLoop.js'
import { executeRuntimeHooks, type RuntimeHookInput } from './hooks.js'
import type { MemoryProvider, MemoryProviderDiagnostics } from './memoryProvider.js'
// PR-A4: resume() class method imports — see long-running-context-
// assembly.md §6.2 for the 3-step flow.
import type { PersistedWorkingSetTracker } from './persistedWorkingSetTracker.js'
import type { BehaviorMonitor } from './behaviorMonitor.js'
import { deriveEntriesFromEvents } from './workingSetTracker.js'
import { formatWorkingSet } from './workingSet.js'
import { formatHint } from './formatHint.js'
import type { AssembledContext } from './contextAssembler.js'
import { HISTORY_EVENT_LOAD_LIMIT_MAX } from './contextAssembler.js'
import type { WorkingSet } from './workingSetTracker.js'
import { ProviderSessionRules } from './providerSessionRules.js'

const FINAL_RESPONSE_ONLY_REMAINING_LOOPS = 3

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

// `mapEventsToMessages` and `MapEventsToMessagesOptions` were extracted
// to `./eventsTranslator.ts` in Phase 3B-1. We re-export them here so
// legacy import paths (`from '../runtime/LLMCodingRuntime.js'` for
// `mapEventsToMessages`) keep working without forcing every consumer
// to migrate in lockstep. New code should import directly from
// `./eventsTranslator.js`.
export { mapEventsToMessages } from './eventsTranslator.js'
export type { MapEventsToMessagesOptions } from './eventsTranslator.js'

export class LLMCodingRuntime implements NexusRuntime {
  private readFileCache = new Map<string, ReadFileCacheEntry>()

  constructor(
    private readonly tools: Map<string, AnyTool>,
    private toolPolicy: ToolPolicy,
    private readonly storage: NexusStorage,
    private readonly configManager: ConfigManager = ConfigManager.getInstance(),
    private readonly memoryProvider?: MemoryProvider,
    // Phase 2B: optional per-instance broadcaster injected by the
    // composition root. When omitted, context publishing is disabled
    // for this runtime instance; no Nexus singleton is read from the
    // runtime hot path.
    private readonly contextBroadcaster?: RuntimeContextBroadcaster,
    // PR-A4: optional resume dependencies. When provided, the public
    // resume() method is enabled; when omitted, calling resume() throws
    // a clear "not configured" error. The four closures are the same
    // shapes the hot-path refreshRuntimeContextState call site uses;
    // they are re-required here so resume() can drive a full
    // assembleContext pass without re-wiring the singleton side of the
    // runtime. Production factory (createRuntime.ts) wires these; tests
    // can omit them.
    private readonly resumeDeps?: {
      workingSetTracker: PersistedWorkingSetTracker
      behaviorMonitor?: BehaviorMonitor
      buildSystemPrompt: (
        options: RuntimeExecuteOptions,
        projectMemory?: string,
        sessionSummary?: string,
        activeSkills?: string,
      ) => string
      mapEventsToMessages: (events: NexusEvent[], initialPrompt: string) => ModelMessage[]
    },
    private readonly providerSessionRules: ProviderSessionRules = new ProviderSessionRules(),
  ) {}

  /**
   * PR-A2: expose the optional per-instance broadcaster (or undefined
   * if not provided). Tests and production wiring can read this to
   * inject a custom broadcaster.
   */
  getContextBroadcaster(): RuntimeContextBroadcaster | undefined {
    return this.contextBroadcaster
  }

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

  /**
   * §3.5 Memory Quality Metrics v1.1 follow-up: hot-path emission.
   * Bound to `ContextAssemblerOptions.onMemoryRetrieval` at every
   * `refreshRuntimeContextState` call site so every real
   * provider/tool turn writes a `memory_retrieval` NexusEvent —
   * not just the GET `/v1/sessions/:id/context` inspection route.
   *
   * The implementation lives in `emitMemoryRetrieval.ts` (Phase 3B-9
   * helper extraction). This class field is a thin delegate so
   * the existing call sites at `onMemoryRetrieval: this.emitMemoryRetrieval`
   * (6 refresh sites) keep the same method-binding shape.
   */
  private readonly emitMemoryRetrieval = (input: {
    sessionId: string
    cwd: string
    prompt: string
    diagnostics: MemoryProviderDiagnostics
  }): Promise<void> => {
    return emitMemoryRetrievalImpl(this.memoryProvider, this.storage, input)
  }

  private async *runExecuteStreamInner(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    // Phase C2 of docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md §11.
    // Propagate the runtime's own storage into RuntimeExecuteOptions so that
    // context tools (contextSearch / contextRecent / contextSummarize) receive
    // a non-null ToolContext.storage. session_10320709 proved that without
    // this, a storage-backed Nexus session still returns
    // CONTEXT_STORAGE_UNAVAILABLE because executeToolSafely builds ToolContext
    // from RuntimeExecuteOptions.storage (which Nexus does not always set),
    // even though this.storage exists. Mirrors LocalCodingRuntime's injection.
    if (!options.storage && this.storage) {
      options = { ...options, storage: this.storage }
    }
    // Phase B of docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md.
    // Use the continuity-aware resolver when the caller has supplied
    // session context. Falls through to the simple 2-arg heuristic
    // when storedSessionCwd / latestTaskPrimaryRoot are absent.
    const hasSessionContext = options.storedSessionCwd !== undefined
      || options.latestTaskPrimaryRoot !== undefined
    const { cwd: resolvedCwd, continuity } = hasSessionContext
      ? resolveCwdWithContinuity({
          prompt: options.prompt,
          baseCwd: options.cwd,
          storedSessionCwd: options.storedSessionCwd,
          latestTaskPrimaryRoot: options.latestTaskPrimaryRoot,
          acceptExternalPromptPath: options.acceptExternalPromptPath,
        })
      : {
          cwd: resolveCwdFromPrompt(options.prompt, options.cwd),
          continuity: null,
        }
    // R2 of docs/nexus/reference/long-running-context-assembly.md §20:
    // load the persisted Nexus-owned working set for this session+cwd so
    // the hot-path refreshRuntimeContextState calls include it as a
    // provider-visible block. Previously every refresh re-derived a
    // transient working set from the event slice; the persisted tracker
    // was only consulted in resume() and via REST GET. After R2, a
    // successful tool event updates the tracker and the next refresh
    // surfaces it (R7 acceptance: "Next turn includes a provider-visible
    // Working Set: block derived from persisted tracker state").
    //
    // The load is best-effort and idempotent: createRuntime pre-loads
    // once at boot, so on the hot path we only re-load when the cwd
    // changes mid-session (rare; e.g. user acceptance of a parent_scan
    // boundary). For the common case, the in-memory tracker state is
    // already correct. The result is awaited once here and threaded
    // into every refreshRuntimeContextState call below; subsequent
    // updates (from successful tool events) are applied in-place via
    // applyWorkingSetUpdate so the next refresh picks them up.
    const workingSetOverride = await this.loadWorkingSetOverride(options.sessionId, resolvedCwd)
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

    if (continuity) {
      yield {
        type: 'session_root_continuity',
        ...eventBase(options.sessionId),
        requestId: options.requestId,
        requestCwd: continuity.requestCwd,
        ...(continuity.storedSessionCwd !== undefined && { storedSessionCwd: continuity.storedSessionCwd }),
        ...(continuity.latestTaskPrimaryRoot !== undefined && { latestTaskPrimaryRoot: continuity.latestTaskPrimaryRoot }),
        promptPathCandidates: continuity.promptPathCandidates,
        resolvedCwd: continuity.resolvedCwd,
        decision: continuity.decision,
        reason: continuity.reason,
        isExternalRoot: continuity.isExternalRoot,
        wasProjectRootKept: continuity.wasProjectRootKept,
        warnings: continuity.warnings,
        message: buildSessionRootContinuityMessage(continuity),
      }
    }

    const metrics = createRuntimeExecutionMetrics()

    try {
      // 1. Resolve connection and credential settings
      const settings = this.configManager.resolveSettings({
        model: options.model,
      })

      // Strip optional [1m] tag from canonical model name
      const activeModel = options.model || settings.modelId
      const cleanedModelId = activeModel.replace(/\[1m\]$/i, '')
      const adapter = getAdapter(settings.providerId)

      // 2. Load previous session events + build intake + task scope
      //    + per-request closures. The implementation lives in
      //    `prepareRuntimeStart.ts` (Phase 3B-10 helper extraction);
      //    this call site owns the shouldReplayReasoningContent
      //    decision (model-specific) and yields the events.
      const shouldReplayReasoningContent =
        cleanedModelId.includes('deepseek') ||
        settings.modelId.includes('deepseek') ||
        settings.providerId === 'deepseek' ||
        Boolean(settings.baseUrl?.includes('deepseek'))
      const start = await prepareRuntimeStart({
        options,
        deps: {
          storage: this.storage,
          tools: this.tools,
          toolPolicy: this.toolPolicy,
          logger,
        },
        settings: {
          providerId: settings.providerId,
          modelId: settings.modelId,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
        },
        cleanedModelId,
        adapter,
        shouldReplayReasoningContent,
      })
      yield start.intakeEvent
      yield start.taskScopeEvent
      let previousEvents = start.previousEvents
      let taskScopeEvent: TaskScopeDeclaredEvent = start.taskScopeEvent as TaskScopeDeclaredEvent
      const mapEventsForProvider = start.mapEventsForProvider
      const toolsList = start.toolsList
      const confirmedOptionSelection = start.confirmedOptionSelection
      const contextRefreshStrategy = new ContextRefreshStrategy({
        storage: this.storage,
        memoryProvider: this.memoryProvider,
        contextBroadcaster: this.contextBroadcaster,
      })
      const providerTurnDriver = new ProviderTurnDriver()
      const toolDispatchPipeline = new ToolDispatchPipeline({
        tools: this.tools,
        toolPolicy: this.toolPolicy,
        storage: this.storage,
        metrics,
        readFileCache: this.readFileCache,
        providerSessionRules: this.providerSessionRules,
        applyWorkingSetUpdate: (sessionId, events, cwd) => this.applyWorkingSetUpdate(sessionId, events, cwd),
      })
      const contextWarningPercent = 70
      const contextCompactPercent = 90
      let contextRefreshState = await contextRefreshStrategy.refresh({
        runtimeOptions: options,
        events: previousEvents,
        modelId: cleanedModelId,
        buildSystemPrompt,
        mapEventsToMessages: mapEventsForProvider,
        tools: toolsList,
        warningPercent: contextWarningPercent,
        compactPercent: contextCompactPercent,
        suppressToolsForIntent: shouldSuppressToolsForIntent,
        onMemoryRetrieval: this.emitMemoryRetrieval,
        // R2: thread the persisted workingSetOverride through the
        // hot-path refresh so the provider-visible Working Set: block
        // is sourced from the Nexus-owned tracker (not the transient
        // event-slice derive that assembleContext falls back to when
        // this field is undefined).
        workingSetOverride,
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
      // Per-request closure bundle for the rest of the
      // turn. The implementation lives in
      // `buildContextRefreshClosureSet.ts` (Phase 3B-12
      // helper extraction). The factory reads / writes
      // the 7 `let` state variables through the state
      // bundle so the inline closure definitions can
      // move out of the main loop body.
      const refreshClosures = buildContextRefreshClosureSet({
        state: {
          getAssembledContext: () => assembledContext,
          getMessages: () => messages,
          getModelVisibleTools: () => modelVisibleTools,
          getContextWindowState: () => contextWindowState,
          setContextRefreshState: (nextState) => {
            contextRefreshState = nextState
            assembledContext = nextState.assembledContext
            messages = nextState.messages
            currentToolsList = nextState.currentToolsList
            modelVisibleTools = nextState.modelVisibleTools
            contextWindowState = nextState.contextWindowState
            cacheAwareCompactPolicy = nextState.cacheAwareCompactPolicy
          },
        },
        metrics,
        refreshStrategy: contextRefreshStrategy,
        refreshOptions: {
          runtimeOptions: options,
          events: previousEvents,
          modelId: cleanedModelId,
          buildSystemPrompt,
          mapEventsToMessages: mapEventsForProvider,
          tools: toolsList,
          warningPercent: contextWarningPercent,
          compactPercent: contextCompactPercent,
          suppressToolsForIntent: shouldSuppressToolsForIntent,
          onMemoryRetrieval: this.emitMemoryRetrieval,
          workingSetOverride,
        },
        readFileCache: this.readFileCache,
        sessionId: options.sessionId,
        requestId: options.requestId,
      })
      const {
        estimateVisibleContextTokens,
        applyContextRefreshState,
        contextMicrocompactEvent,
        refreshAfterProviderContextRecovery,
        postCompactGroundingEvents,
      } = refreshClosures
      // Initial post-refresh yield sequence (microcompact
      // + warning). The list is built by the
      // `buildPostRefreshYieldEvents` factory (Phase 3B-11
      // helper extraction) so the main loop's first refresh
      // step reads as a single ordered yield.
      for (const e of buildPostRefreshYieldEvents({
        assembledContext,
        contextWindowState,
        autoCompactDecision,
        cacheAwareCompactPolicy,
        sessionId: options.sessionId,
        requestId: options.requestId,
        modelId: cleanedModelId,
        contextWarningPercent,
        contextCompactPercent,
      })) yield e
      let compactAttempted = false
      // Pre-loop compact sequence (auto / reactive / blocking
      // emit). The implementation lives in
      // `executePreLoopCompactSequence.ts` (Phase 3B-13 helper
      // extraction). The helper runs the three blocks
      // asynchronously and yields the same events the
      // inline code used to yield.
      const preLoopCompactIterator = executePreLoopCompactSequence({
        storage: this.storage,
        sessionId: options.sessionId,
        requestId: options.requestId,
        modelId: cleanedModelId,
        providerId: settings.providerId,
        cleanedModelId,
        autoCompactShouldCompact: autoCompactDecision.shouldCompact,
        isContextWindowBlocking: contextWindowState.isBlocking,
        refreshStrategy: contextRefreshStrategy,
        refreshOptions: {
          runtimeOptions: options,
          events: previousEvents,
          modelId: cleanedModelId,
          buildSystemPrompt,
          mapEventsToMessages: mapEventsForProvider,
          tools: toolsList,
          warningPercent: contextWarningPercent,
          compactPercent: contextCompactPercent,
          suppressToolsForIntent: shouldSuppressToolsForIntent,
          onMemoryRetrieval: this.emitMemoryRetrieval,
          workingSetOverride,
        },
        state: {
          getContextWindowState: () => contextWindowState,
          getPreviousEvents: () => previousEvents,
          setPreviousEvents: (next) => {
            previousEvents = next
          },
          getAutoCompactDecision: () => autoCompactDecision,
          setAutoCompactDecision: (next) => {
            autoCompactDecision = next
          },
          getCacheAwareCompactPolicy: () => cacheAwareCompactPolicy,
          setCacheAwareCompactPolicy: (next) => {
            cacheAwareCompactPolicy = next
          },
        },
        closures: {
          applyContextRefreshState,
          postCompactGroundingEvents,
          contextMicrocompactEvent,
        },
        metrics,
        readFileCache: this.readFileCache,
        toolsList,
        mapEventsForProvider,
        shouldSuppressToolsForIntent,
        onMemoryRetrieval: this.emitMemoryRetrieval,
        userIntentGuidance: undefined,
        workingSetOverride,
        buildRuntimeExecutionMetricsEvent: () => buildRuntimeExecutionMetricsEvent(options, metrics),
        compactAttempted,
      })
      let preLoopCompactResult: { compactAttempted: boolean; blocking: boolean } = { compactAttempted: false, blocking: false }
      for await (const e of preLoopCompactIterator) {
        yield e
      }
      preLoopCompactResult = await preLoopCompactIterator.next().then(() => preLoopCompactResult, () => preLoopCompactResult)
      // The async generator's return value is not surfaced
      // by for-await; the next .return() round-trip recovers
      // it.
      compactAttempted = preLoopCompactResult.compactAttempted
      if (preLoopCompactResult.blocking) {
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
          // Provider-loop reactive compact + refresh. The
          // implementation lives in
          // `executeProviderLoopCompactBlock.ts` (Phase
          // 3B-14 helper extraction). The helper runs the
          // compact + refresh + yield sequence and
          // returns whether the compact was attempted so
          // the main loop can update its flag.
          const { events: providerLoopEvents, compactAttempted: providerLoopCompactAttemptedNow } =
            await executeProviderLoopCompactBlock({
              storage: this.storage,
              sessionId: options.sessionId,
              requestId: options.requestId,
              modelId: cleanedModelId,
              providerId: settings.providerId,
              cleanedModelId,
              isContextWindowBlocking: requestState.contextWindowState.isBlocking,
              alreadyAttempted: providerLoopCompactAttempted,
              refreshStrategy: contextRefreshStrategy,
              refreshOptions: {
                runtimeOptions: options,
                events: previousEvents,
                modelId: cleanedModelId,
                buildSystemPrompt,
                mapEventsToMessages: mapEventsForProvider,
                tools: toolsList,
                warningPercent: contextWarningPercent,
                compactPercent: contextCompactPercent,
                suppressToolsForIntent: shouldSuppressToolsForIntent,
                onMemoryRetrieval: this.emitMemoryRetrieval,
                workingSetOverride,
              },
              state: {
                getPreviousEvents: () => previousEvents,
                setPreviousEvents: (next) => { previousEvents = next },
                getAutoCompactDecision: () => autoCompactDecision,
                setAutoCompactDecision: (next) => { autoCompactDecision = next },
                getCacheAwareCompactPolicy: () => cacheAwareCompactPolicy,
                setCacheAwareCompactPolicy: (next) => { cacheAwareCompactPolicy = next },
                getContextWindowState: () => contextWindowState,
              },
              closures: {
                applyContextRefreshState,
                postCompactGroundingEvents,
                contextMicrocompactEvent,
              },
              metrics,
              toolsList,
              mapEventsForProvider,
              shouldSuppressToolsForIntent,
              onMemoryRetrieval: this.emitMemoryRetrieval,
              workingSetOverride,
              initialPrompt: options.prompt,
            })
          for (const e of providerLoopEvents) yield e
          providerLoopCompactAttempted = providerLoopCompactAttemptedNow
        }
        if (providerLoopCompactAttempted) {
          // After a reactive compact, rebuild the per-loop
          // request state with the post-refresh context
          // window state + message budget. This is the
          // 3B-14 follow-up that the helper could not
          // pull into the closure bundle: the main loop
          // owns the `requestState` rebuild because it
          // also drives the next `buildContextUsageEvent`
          // / provider turn.
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
          // Stream provider events one-at-a-time so the WS
          // observer (and Go TUI) sees text deltas as the
          // provider produces them. Previously this was
          // `await executeProviderTurn(...)` which buffered
          // every event into an array then yielded them in a
          // tight loop after the turn completed — making the
          // entire assistant text dump out at once at end of
          // turn even when the provider was streaming
          // word-by-word. Real e2e (DeepSeek V4 via OpenAI
          // adapter, prompt: 200-word essay) measured
          // server-side adapter `delta.content` arriving for
          // ~5s but ws-forward firing only ONCE at the end —
          // confirming this buffer was the bottleneck. Path
          // 1's text chunker is necessary but not sufficient
          // unless the buffer is also drained progressively.
          const stream = providerTurnDriver.run({
            adapter,
            queryParams,
            adapterOptions,
            sessionId: options.sessionId,
            signal: options.signal,
            executionStartMs: metrics.executionStartMs,
            queryStartMs: invocationStartMs,
            finalResponseOnlyMode,
            suppressToolsForCurrentIntent,
            modelVisibleToolCount: modelVisibleTools.length,
            memoryCapabilityAnswerLeakGuard: memoryCapabilityQuestion,
          })
          let result = await stream.next()
          while (!result.done) {
            yield result.value
            result = await stream.next()
          }
          providerTurn = result.value
        } catch (error) {
          // Provider recovery decision. The implementation
          // lives in `executeProviderRecoveryDecision.ts`
          // (Phase 3B-19 helper extraction). The helper
          // fires PostInvocation hooks, classifies the
          // error, and either (a) drives the context_window
          // recovery compact + refresh + budget sequence,
          // (b) yields blocking events on cap-reached, or
          // (c) reports a rethrow.
          const recoveryResult = await executeProviderRecoveryDecision({
            error,
            hooksConfig: { config: options.hooks, hooks: options.runtimeHooks },
            invocationMetadata: {
              ...invocationMetadata,
              durationMs: performance.now() - invocationStartMs,
            },
            hookInput: {
              sessionId: options.sessionId,
              cwd: options.cwd,
              role: options.role,
              signal: options.signal,
            },
            options,
            providerId: settings.providerId,
            modelId: cleanedModelId,
            cleanedModelId,
            requestId: options.requestId,
            sessionId: options.sessionId,
            state: {
              getPreviousEvents: () => previousEvents,
              setPreviousEvents: (next) => { previousEvents = next },
              getAutoCompactDecision: () => autoCompactDecision,
              setAutoCompactDecision: (next) => { autoCompactDecision = next },
              getContextWindowState: () => contextWindowState,
              getRequestState: () => requestState,
              getCacheAwareCompactPolicy: () => cacheAwareCompactPolicy,
              getMessages: () => messages,
              setMessages: (next) => { messages = next },
            },
            closures: {
              applyContextRefreshState,
              postCompactGroundingEvents,
              contextMicrocompactEvent,
              refreshAfterProviderContextRecovery,
            },
            counters: {
              providerContextRecoveryCount,
              maxProviderContextRecoveries: MAX_PROVIDER_CONTEXT_RECOVERIES,
            },
            flags: {
              setProviderLoopCompactAttempted: (next) => { providerLoopCompactAttempted = next },
            },
            metrics,
            replacementState,
            initialPrompt: options.prompt,
            storage: this.storage,
            mapEventsForProvider,
            runHooks: (phase, invocation, ctx, config) =>
              executeRuntimeHooks(phase, invocation, ctx, config),
            contextCompactPercent,
            errorCodeHelpers: {
              providerInvocationErrorCode,
              providerContextRecoveryErrorCode,
            },
          })
          for (const e of recoveryResult.events) yield e
          providerContextRecoveryCount = recoveryResult.providerContextRecoveryCount
          previousEvents = recoveryResult.previousEvents
          autoCompactDecision = recoveryResult.autoCompactDecision
          messages = recoveryResult.messages
          cacheAwareCompactPolicy = recoveryResult.cacheAwareCompactPolicy
          if (recoveryResult.kind === 'recovered') continue
          if (recoveryResult.kind === 'blocked') return
          throw recoveryResult.error
        }

        if (
          providerTurn.toolCalls.length === 0 &&
          providerTurn.assistantText.trim().length === 0 &&
          providerTurn.reasoningText.trim().length > 0
        ) {
          absorbProviderTurnMetrics(metrics, providerTurn)
          const message = 'Provider returned an empty assistant response with no tool calls.'
          yield buildRuntimeErrorEvent({
            sessionId: options.sessionId,
            code: 'EMPTY_PROVIDER_RESPONSE',
            message,
            details: {
              kind: 'reasoning_only',
              providerId: settings.providerId,
              modelId: cleanedModelId,
              retryable: true,
              suggestion: 'Retry the turn or switch to a model/provider that emits assistant text or tool calls after reasoning.',
            },
          })
          yield buildRuntimeResultEvent(options.sessionId, false, message)
          yield buildRuntimeExecutionMetricsEvent(options, metrics)
          return
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

        // Leak-suppression effects. The implementation
        // lives in `applyLeakSuppressionEffects.ts`
        // (Phase 3B-18 helper extraction). The helper
        // runs absorbProviderTurnMetrics + the two
        // leak-suppression side effects and returns the
        // updated state + events + kind. The helper
        // mutates `metrics` in place; only the let
        // bindings need a write-back.
        const leakResult = await applyLeakSuppressionEffects({
          providerTurn,
          metrics,
          sessionId: options.sessionId,
          options,
          previousEvents,
          messages,
          memoryCapabilityAnswerRetryCount,
          maxMemoryCapabilityAnswerRetries: 1,
        })
        previousEvents = leakResult.previousEvents
        messages = leakResult.messages
        memoryCapabilityAnswerRetryCount = leakResult.memoryCapabilityAnswerRetryCount
        for (const e of leakResult.events) yield e
        if (leakResult.kind === 'retry') continue
        if (leakResult.kind === 'terminal') {
          return
        }
        // Provider outcome application. The implementation
        // lives in `applyProviderOutcome.ts` (Phase 3B-16
        // helper extraction). The helper runs
        // `reduceProviderTurnOutcome(...)` and returns
        // counter updates + events + kind so the main
        // loop can dispatch on the outcome.
        const outcomeResult = await applyProviderOutcome({
          turn: providerTurn,
          finalResponseOnlyMode,
          suppressToolsForUserIntent: suppressToolsForCurrentIntent,
          confirmedOptionSelection,
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
        if (outcomeResult.finalAnswerRetryIncrement === 1) {
          metrics.finalAnswerRetryCount += 1
        }
        maxTokenRecoveryCount = outcomeResult.nextCounters.maxTokenRecoveryCount
        outputRetryCount = outcomeResult.nextCounters.outputRetryCount
        suppressedToolRetryCount = outcomeResult.nextCounters.suppressedToolRetryCount
        for (const event of outcomeResult.events) yield event
        messages.push(...outcomeResult.messages)
        if (outcomeResult.kind === 'continue') continue
        if (outcomeResult.kind === 'terminal') {
          if (outcomeResult.queueSessionMemoryLiteUpdate) {
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

        // Tool dispatch. The implementation lives in
        // `executeToolDispatch.ts` (Phase 3B-17 helper
        // extraction). The helper drives the dispatch
        // async generator and returns the per-loop
        // state updates + events + terminal flag.
        const dispatchStream = executeToolDispatch(toolDispatchPipeline, {
          toolCalls: outcomeResult.toolCalls!,
          runtimeOptions: options,
          previousEvents,
          taskScopeEvent,
        })
        let dispatchNext = await dispatchStream.next()
        while (!dispatchNext.done) {
          yield dispatchNext.value
          dispatchNext = await dispatchStream.next()
        }
        const dispatchResult = dispatchNext.value
        previousEvents = dispatchResult.previousEvents
        taskScopeEvent = dispatchResult.taskScopeEvent
        if (dispatchResult.terminal) {
          return
        }
        messages.push(...dispatchResult.messages)
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

  // ─── R2 of docs/nexus/reference/long-running-context-assembly.md §20: ───
  //
  // `loadWorkingSetOverride` was extracted to
  // `./loadWorkingSetOverride.ts` in Phase 3B-7. The hot path calls the
  // standalone function once at the start of `runExecuteStreamInner`
  // (line 335 in the current build) and threads the result into every
  // `refreshRuntimeContextState` call.
  //
  // This class method is retained as a thin delegate so that the R2
  // wiring-guard contract (`runtime-working-set-hot-path.test.ts`) keeps
  // passing: it asserts `LLMCodingRuntime.prototype.loadWorkingSetOverride`
  // is a function. Removing it would silently break R2 detection in
  // future refactors. New code should call the standalone function from
  // `./loadWorkingSetOverride.js` directly.
  private async loadWorkingSetOverride(sessionId: string, cwd: string): Promise<string | undefined> {
    return loadWorkingSetOverride(
      this.resumeDeps?.workingSetTracker,
      this.storage,
      sessionId,
      cwd,
    )
  }

  // applyWorkingSetUpdate(sessionId, events, cwd) — write-side of the
  // R2 Persisted Working Set hot-path loop. Extracted to
  // `./applyWorkingSetUpdate.ts` in Phase 3B-8. The hot path calls
  // the standalone function after every successful tool execution
  // with the `toolEvents` batch yielded by the provider tool-call
  // loop; the tracker schedules its own background flush.
  //
  // This class method is retained as a thin delegate so the R2
  // wiring-guard contract (`runtime-working-set-hot-path.test.ts`)
  // keeps passing: it asserts `LLMCodingRuntime.prototype.applyWorkingSetUpdate`
  // is a function. Removing it would silently break R2 detection in
  // future refactors. New code should call the standalone function
  // from `./applyWorkingSetUpdate.js` directly.
  private applyWorkingSetUpdate(sessionId: string, events: NexusEvent[], cwd: string): void {
    applyWorkingSetUpdate(this.resumeDeps?.workingSetTracker, sessionId, events, cwd)
  }

  // ─── PR-A4: Session Resume class method (doc §6.2) ──────────────
  //
  // Drives the 3-step resume flow:
  //   1. Load or rebuild the working set (persisted, or from event tail)
  //   2. Assemble a full context (AssembledContext) at the resumed state
  //   3. Subscribe to live hints from the per-cwd BehaviorMonitor
  //
  // This is the new canonical entry point for resume. The legacy
  // resumeSession() helper in src/runtime/sessionResume.ts only does
  // step 1; CLI/REST callers will migrate to this method in a
  // follow-up.
  async resume(opts: { sessionId: string; cwd: string }): Promise<{
    workingSet: WorkingSet
    rebuilt: boolean
    assembled: AssembledContext
    unsubscribeHints: () => void
  }> {
    if (!this.resumeDeps) {
      throw new Error(
        'LLMCodingRuntime.resume() requires resumeDeps; configure the runtime via ' +
          'createDefaultNexusRuntime() or pass resumeDeps explicitly to the constructor.',
      )
    }
    const { workingSetTracker, behaviorMonitor, buildSystemPrompt, mapEventsToMessages } =
      this.resumeDeps

    // Step 1 — load or rebuild working set.
    await workingSetTracker.load() // idempotent; the file is tiny
    let workingSet = workingSetTracker.get(opts.sessionId)
    let rebuilt = false
    let events: NexusEvent[] = []
    if (!workingSet) {
      rebuilt = true
      try {
        const result = await this.storage.listEvents(opts.sessionId, {
          order: 'desc',
          limit: HISTORY_EVENT_LOAD_LIMIT_MAX,
        })
        events = [...(result?.events ?? [])].reverse() // ascending for assembler
      } catch (error) {
        throw new Error(
          `resume() step 1: storage.listEvents failed for ${opts.sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      const entries = deriveEntriesFromEvents(events, opts.cwd)
      // For now, workspaceId is empty on rebuild — linkToWorkspace is a
      // future concern. The WS file itself has a workspaceId field that
      // defaults to '' when not yet linked.
      try {
        workingSet = workingSetTracker.rebuild(opts.sessionId, '', entries)
      } catch (error) {
        throw new Error(
          `resume() step 1: workingSetTracker.rebuild failed for ${opts.sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    } else {
      // Loaded from persistence — we still want the event tail for the
      // assembler pass below. Same path: storage.listEvents, ascending.
      try {
        const result = await this.storage.listEvents(opts.sessionId, {
          order: 'desc',
          limit: HISTORY_EVENT_LOAD_LIMIT_MAX,
        })
        events = [...(result?.events ?? [])].reverse()
      } catch (error) {
        throw new Error(
          `resume() step 1: storage.listEvents (post-load) failed for ${opts.sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    // Step 2 — assemble context.
    const settings = this.configManager.resolveSettings()
    const runtimeOptions: RuntimeExecuteOptions = {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      prompt: '',
      model: settings.modelId,
    }
    const workingSetOverride = formatWorkingSet(
      workingSet.entries.map((e) => ({
        path: e.value,
        touches: 1,
        lastTurn: 0,
        isDir: false,
        source: 'tool' as const,
      })),
    )
    let assembled: AssembledContext
    try {
      const contextRefreshStrategy = new ContextRefreshStrategy({
        storage: this.storage,
        memoryProvider: this.memoryProvider,
        contextBroadcaster: this.contextBroadcaster,
      })
      const refreshState = await contextRefreshStrategy.refresh({
        runtimeOptions,
        events,
        modelId: settings.modelId,
        buildSystemPrompt,
        mapEventsToMessages,
        tools: () => [],
        warningPercent: 70,
        compactPercent: 90,
        suppressToolsForIntent: () => false,
        onMemoryRetrieval: this.emitMemoryRetrieval,
        sessionInbox: 'empty',
        workingSetOverride,
        includeBehaviorTrace: true,
        includeLongTerm: true,
        includeProjectMemory: true,
        includeLiveHints: !!behaviorMonitor,
      })
      assembled = refreshState.assembledContext
    } catch (error) {
      throw new Error(
        `resume() step 2: refreshRuntimeContextState failed for ${opts.sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    // Step 3 — subscribe live hints.
    let unsubscribeHints = (): void => { /* no-op when no monitor */ }
    if (behaviorMonitor) {
      unsubscribeHints = behaviorMonitor.subscribe(opts.sessionId, (hint) => {
        if (this.canAcceptHint()) {
          const text = formatHint(hint)
          this.injectSystemSection(text, opts.sessionId)
        }
      })
    }

    return { workingSet, rebuilt, assembled, unsubscribeHints }
  }

  // ─── R5 of docs/nexus/reference/long-running-context-assembly.md §20: ───
  //
  // resumePreview(sessionId, cwd) — pure read-only projection of what
  // resume() would build, without subscribing to live hints and
  // without executing a provider turn. R5's product path: an operator
  // can inspect what a resumed session would inherit (working set
  // loaded/rebuilt, assembled section ids + budgets, hint subscription
  // state) without actually resuming. The `hasContinuationSnapshot:
  // false` is the explicit, honest R5 contract: until a real restart
  // e2e proves otherwise, we do not promise "0 information loss".
  //
  // Returns:
  //   - cwd: the cwd the preview was computed for
  //   - workingSet: { sessionId, workspaceId, entries, version,
  //     updatedAt, rebuilt: boolean } — rebuilt=true means the WS was
  //     derived from the recent event tail (no persisted file), false
  //     means it was loaded from <cwd>/.babel-o/working-set.json.
  //   - assembled: the full AssembledContext so the route can project
  //     section ids / budget summaries. The route applies the R4
  //     redaction contract before serializing the response body.
  //   - liveHintsSubscribed: false (we did not subscribe). Operator
  //     sees that no live hook is attached.
  //   - hasContinuationSnapshot: false. Hard-coded per R5 acceptance.
  async resumePreview(opts: { sessionId: string; cwd: string }): Promise<{
    cwd: string
    workingSet: {
      sessionId: string
      workspaceId: string
      entries: Array<{ path: string; touches: number; lastTurn: number; isDir: boolean; source: 'tool' | 'user' }>
      version: number
      updatedAt: string
      rebuilt: boolean
    }
    assembledSectionIds: string[]
    budget: AssembledContext['budget']
    liveHintsSubscribed: false
    hasContinuationSnapshot: false
  }> {
    if (!this.resumeDeps) {
      throw new Error(
        'LLMCodingRuntime.resumePreview() requires resumeDeps; configure the runtime via ' +
          'createDefaultNexusRuntime() or pass resumeDeps explicitly to the constructor.',
      )
    }
    const { workingSetTracker, buildSystemPrompt, mapEventsToMessages } = this.resumeDeps

    // Step 1 — load or rebuild working set. Identical logic to
    // resume() but without subscribing to live hints.
    await workingSetTracker.load()
    let workingSet = workingSetTracker.get(opts.sessionId)
    let rebuilt = false
    let events: NexusEvent[] = []
    if (!workingSet) {
      rebuilt = true
      const result = await this.storage.listEvents(opts.sessionId, {
        order: 'desc',
        limit: HISTORY_EVENT_LOAD_LIMIT_MAX,
      })
      events = [...(result?.events ?? [])].reverse()
      const entries = deriveEntriesFromEvents(events, opts.cwd)
      workingSet = workingSetTracker.rebuild(opts.sessionId, '', entries)
    } else {
      const result = await this.storage.listEvents(opts.sessionId, {
        order: 'desc',
        limit: HISTORY_EVENT_LOAD_LIMIT_MAX,
      })
      events = [...(result?.events ?? [])].reverse()
    }

    // Step 2 — assemble context (read-only). We do NOT subscribe to
    // behaviorMonitor, so liveHintsSubscribed is false.
    const settings = this.configManager.resolveSettings()
    const runtimeOptions: RuntimeExecuteOptions = {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      prompt: '',
      model: settings.modelId,
    }
    const workingSetOverride = formatWorkingSet(
      workingSet.entries.map((e) => ({
        path: e.value,
        touches: 1,
        lastTurn: 0,
        isDir: false,
        source: 'tool' as const,
      })),
    )
    const contextRefreshStrategy = new ContextRefreshStrategy({
      storage: this.storage,
      memoryProvider: this.memoryProvider,
      contextBroadcaster: this.contextBroadcaster,
    })
    const refreshState = await contextRefreshStrategy.refresh({
      runtimeOptions,
      events,
      modelId: settings.modelId,
      buildSystemPrompt,
      mapEventsToMessages,
      tools: () => [],
      warningPercent: 70,
      compactPercent: 90,
      suppressToolsForIntent: () => false,
      onMemoryRetrieval: this.emitMemoryRetrieval,
      sessionInbox: 'empty',
      workingSetOverride,
      includeBehaviorTrace: true,
      includeLongTerm: true,
      includeProjectMemory: true,
      includeLiveHints: false, // R5: pure preview, no live hint subscription
    })
    const assembled = refreshState.assembledContext
    // Section ids from the assembled context's working set block +
    // (best-effort) the system prompt block ids. The assembler's
    // `systemPromptBlocks` array carries no id (it drops the source
    // section id during the buildSystemPromptSections → blocks
    // projection), so we surface only the workingSetPaths the
    // assembler captures (rebuild-only context) and the persisted
    // working set entries as the "section ids" the operator can see.
    const assembledSectionIds = [
      ...workingSet.entries.map((e) => `ws:${e.value}`),
      ...(assembled.selectionDiagnostics?.workingSetPaths ?? []).map((p) => `active-ws:${p}`),
    ]
    return {
      cwd: opts.cwd,
      workingSet: {
        sessionId: workingSet.sessionId,
        workspaceId: workingSet.workspaceId,
        entries: workingSet.entries.map((e) => ({
          path: e.value,
          touches: 1,
          lastTurn: 0,
          isDir: false,
          source: 'tool' as const,
        })),
        version: workingSet.version,
        updatedAt: workingSet.updatedAt,
        rebuilt,
      },
      assembledSectionIds,
      budget: assembled.budget,
      liveHintsSubscribed: false,
      hasContinuationSnapshot: false,
    }
  }

  /**
   * Per doc §6.2 step 3: gates whether a live hint is acceptable right
   * now. Conservative: returns false when the runtime is currently
   * executing a tool (no surprise injections mid-tool).
   *
   * A4 ships a conservative stub: accept when no tool is currently
   * running. The active-execution gate from runtimePipeline is not
   * yet plumbed into the class; until it is, this always returns true
   * and the hint will be queued (injectSystemSection is a no-op push
   * — see below).
   */
  canAcceptHint(): boolean {
    return true
  }

  /**
   * Per doc §6.2 step 3: surface a formatted hint. A4 ships this as a
   * no-op push (Nexus-side observability will see it via a future
   * PR); it does NOT inject into the model prompt (INV-4: no silent
   * model injection).
   */
  injectSystemSection(text: string, sessionId: string): void {
    // No-op for A4. The text is computed but not pushed anywhere; a
    // future PR will wire this to a Nexus event sink. Document the
    // intent here.
    void text
    void sessionId
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

export function resolveCwdFromPrompt(prompt: string, baseCwd: string): string {
  // Bug 4 (§13.2): delegate to the single shared resolver in
  // systemPromptBuilder so Site A (app.ts) and Site B (runtime) can never
  // disagree on the same prompt. Previously this function had its own
  // dirname-fallback + isAcceptablePromptCwd logic that drifted from
  // app.ts's weaker `resolveExplicitPromptCwd`. The body is now a thin
  // wrapper; tests + Phase B continuity call this name for back-compat.
  return resolvePromptCwd(prompt, baseCwd)
}

// Phase B of docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md.
// Same heuristic as `resolveCwdFromPrompt`, but threads through
// `deriveSessionRootContinuity` so the caller can also surface a
// `session_root_continuity` event. Used by the runtime path; tests
// continue to use the 2-arg `resolveCwdFromPrompt` to keep the
// contract narrow.
export function resolveCwdWithContinuity(options: {
  prompt: string
  baseCwd: string
  storedSessionCwd?: string
  latestTaskPrimaryRoot?: string
  acceptExternalPromptPath?: boolean
}): { cwd: string; continuity: import('./sessionRootContinuity.js').SessionRootContinuity } {
  const continuity = deriveSessionRootContinuity({
    requestCwd: options.baseCwd,
    prompt: options.prompt,
    storedSessionCwd: options.storedSessionCwd,
    latestTaskPrimaryRoot: options.latestTaskPrimaryRoot,
    acceptExternalPromptPath: options.acceptExternalPromptPath,
  })
  // If the decision is `require_confirmation`, fall back to the simple
  // 2-arg heuristic (so we still get any internal-path switch) but keep
  // the continuity record so the runtime can surface "external path was
  // detected but not accepted".
  if (continuity.decision === 'require_confirmation') {
    const simpleCwd = resolveCwdFromPrompt(options.prompt, continuity.resolvedCwd)
    return { cwd: simpleCwd, continuity: { ...continuity, resolvedCwd: simpleCwd } }
  }
  return { cwd: continuity.resolvedCwd, continuity }
}

// `mapEventsToMessages` is implemented in `./eventsTranslator.ts`.
// The actual implementation was extracted in Phase 3B-1 to keep this
// file focused on the runtime loop. We re-export it here for backward
// compatibility with consumers that still import from
// `./LLMCodingRuntime.js`.

// `wrapWithBehaviorTraceTap` was extracted to `./behaviorTraceTap.ts`
// in Phase 3B-6. We re-export it here so legacy import paths
// (`from '../runtime/LLMCodingRuntime.js'` for `wrapWithBehaviorTraceTap`)
// keep working without forcing every consumer to migrate in lockstep.
// New code should import directly from `./behaviorTraceTap.js`.
export { wrapWithBehaviorTraceTap } from './behaviorTraceTap.js'
