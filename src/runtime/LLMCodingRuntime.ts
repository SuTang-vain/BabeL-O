import { z } from 'zod'
import { performance } from 'node:perf_hooks'
import { existsSync, lstatSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { errorMessage, ProviderError } from '../shared/errors.js'
import { eventBase, type NexusEvent } from '../shared/events.js'
import { createId, nowIso } from '../shared/id.js'
import { logger } from '../shared/logger.js'
import type { AnyTool } from '../tools/Tool.js'
import type {
  NexusRuntime,
  RuntimeExecuteOptions,
  RuntimeToolAuditEntry,
} from './Runtime.js'
import type { ToolPolicy } from './LocalCodingRuntime.js'
import { checkOptimizerSafety } from './safetyCheck.js'
import { PendingPermissionRegistry } from '../shared/session.js'
import { classifyAction } from './classifier.js'
import { buildSystemPromptSections, sectionsToPromptText, extractAbsolutePaths, resolvePromptPath } from './systemPromptBuilder.js'
import { normalizeMessages } from './messageNormalizer.js'
import type { NexusStorage } from '../storage/Storage.js'
import { getAdapter } from '../providers/registry.js'
import type {
  ModelMessage,
  ModelQueryParams,
  ContentBlock,
} from '../providers/adapters/ModelAdapter.js'
import { ConfigManager } from '../shared/config.js'
import { assembleContext } from './contextAssembler.js'
import {
  buildCompactFailureEvent,
  compactSession,
  getAutoCompactDecision,
} from './compact.js'
import {
  estimateContextTokens,
  getContextWindowState,
  type ContextWindowState,
} from './tokenEstimator.js'
import {
  executeRuntimeHooks,
  firstHookDenyReason,
  firstHookPermissionDecision,
  lastHookUpdatedInput,
  mergeHookRetryHints,
} from './hooks.js'
import { buildProviderFallbackPolicy, classifyProviderRecovery } from './providerRecovery.js'
import {
  createReplacementState,
  replaceLargeToolResult,
  enforceMessageBudget,
} from './toolResultBudget.js'
import {
  buildUserIntakeGuidanceEvent,
  shouldSuppressToolsForIntent,
} from './intentGuidance.js'

const FINAL_RESPONSE_ONLY_REMAINING_LOOPS = 3

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
  ) {}

  listTools(): RuntimeToolAuditEntry[] {
    return [...this.tools.values()]
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        allowed: this.toolPolicy.isAllowed(tool),
        inputSchema: tool.modelInputSchema ?? z.toJSONSchema(tool.inputSchema),
        source: tool.source ?? { type: 'builtin' as const },
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  withToolPolicy<T>(toolPolicy: ToolPolicy, fn: () => T): T {
    const previousPolicy = this.toolPolicy
    this.toolPolicy = toolPolicy
    try {
      return fn()
    } finally {
      this.toolPolicy = previousPolicy
    }
  }

  async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    const resolvedCwd = resolveCwdFromPrompt(options.prompt, options.cwd)
    if (resolvedCwd !== options.cwd) {
      options.cwd = resolvedCwd
    }

    yield {
      type: 'session_started',
      ...eventBase(options.sessionId),
      cwd: options.cwd,
      requestId: options.requestId,
      model: options.model,
      budget: options.budget,
    }

    const executionStartMs = performance.now()
    let providerFirstTokenMs: number | undefined = undefined
    let totalProviderRequestDurationMs = 0
    let streamDeltaCount = 0
    let toolCallCount = 0
    let totalToolDurationMs = 0
    let contextCharsIn = 0
    let contextCharsOut = 0

    try {
      // 1. Resolve connection and credential settings
      const settings = this.configManager.resolveSettings({
        model: options.model,
      })

      // 2. Load previous session events from storage (if any)
      let previousEvents: NexusEvent[] = []
      if (this.storage) {
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

      let assembledContext = await assembleContext({
        runtimeOptions: options,
        events: previousEvents,
        modelId: cleanedModelId,
        buildSystemPrompt,
        mapEventsToMessages: mapEventsForProvider,
      })
      let messages = assembledContext.messages
      const toolsList = () => [...this.tools.values()]
        .filter(tool => this.toolPolicy.isAllowed(tool))
        .map(tool => ({
          name: tool.name,
          description: tool.prompt ? tool.prompt() : tool.description,
          inputSchema: tool.modelInputSchema ?? z.toJSONSchema(tool.inputSchema),
        }))
      let currentToolsList = toolsList()
      let modelVisibleTools = shouldSuppressToolsForIntent(assembledContext.userIntentGuidance) ? [] : currentToolsList
      let contextEstimateTokens = estimateContextTokens({
        systemPrompt: assembledContext.systemPrompt,
        messages,
        tools: modelVisibleTools,
      }).totalTokens
      const contextWarningPercent = 70
      const contextCompactPercent = 85
      let contextWindowState = getContextWindowState({
        tokenEstimate: contextEstimateTokens,
        maxTokens: assembledContext.budget.maxTokens,
        warningPercent: contextWarningPercent,
        compactPercent: contextCompactPercent,
      })
      let autoCompactDecision = getAutoCompactDecision({
        events: previousEvents,
        tokenEstimate: contextEstimateTokens,
        maxTokens: assembledContext.budget.maxTokens,
      })
      if (contextWindowState.isWarning || autoCompactDecision.fuseOpen) {
        const compactPercent = autoCompactDecision.enabled
          ? autoCompactDecision.thresholdPercent
          : contextCompactPercent
        yield createContextWarningEvent({
          sessionId: options.sessionId,
          modelId: cleanedModelId,
          windowState: contextWindowState,
          thresholdPercent: compactPercent,
          message: autoCompactDecision.fuseOpen
            ? `Auto compact is paused after ${autoCompactDecision.failureCount} consecutive failures. Run /compact manually or inspect compact_failure events.`
            : contextWindowState.isCompact
              ? `Context has passed the compact threshold (${compactPercent}%). Auto-compact will trigger on this turn.`
              : `Context is approaching the compact threshold (${contextWarningPercent}%→${compactPercent}%). Consider /compact soon.`,
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
          yield compactResult.event
          previousEvents = [...previousEvents, compactResult.event]
          assembledContext = await assembleContext({
            runtimeOptions: options,
            events: previousEvents,
            modelId: cleanedModelId,
            buildSystemPrompt,
            mapEventsToMessages: mapEventsForProvider,
          })
          messages = assembledContext.messages
          currentToolsList = toolsList()
          modelVisibleTools = shouldSuppressToolsForIntent(assembledContext.userIntentGuidance) ? [] : currentToolsList
          contextEstimateTokens = estimateContextTokens({
            systemPrompt: assembledContext.systemPrompt,
            messages,
            tools: modelVisibleTools,
          }).totalTokens
          contextWindowState = getContextWindowState({
            tokenEstimate: contextEstimateTokens,
            maxTokens: assembledContext.budget.maxTokens,
            warningPercent: contextWarningPercent,
            compactPercent: contextCompactPercent,
          })
          autoCompactDecision = getAutoCompactDecision({
            events: previousEvents,
            tokenEstimate: contextEstimateTokens,
            maxTokens: assembledContext.budget.maxTokens,
          })
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
          yield compactResult.event
          previousEvents = [...previousEvents, compactResult.event]
          assembledContext = await assembleContext({
            runtimeOptions: options,
            events: previousEvents,
            modelId: cleanedModelId,
            buildSystemPrompt,
            mapEventsToMessages: mapEventsForProvider,
          })
          messages = assembledContext.messages
          currentToolsList = toolsList()
          modelVisibleTools = shouldSuppressToolsForIntent(assembledContext.userIntentGuidance) ? [] : currentToolsList
          contextEstimateTokens = estimateContextTokens({
            systemPrompt: assembledContext.systemPrompt,
            messages,
            tools: modelVisibleTools,
          }).totalTokens
          contextWindowState = getContextWindowState({
            tokenEstimate: contextEstimateTokens,
            maxTokens: assembledContext.budget.maxTokens,
            warningPercent: contextWarningPercent,
            compactPercent: contextCompactPercent,
          })
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
        const message = `Context estimate ${contextWindowState.tokenEstimate}/${contextWindowState.maxTokens} tokens exceeds the blocking limit (${contextWindowState.blockingLimitTokens}). Run /compact or /context before continuing.`
        yield createContextWarningEvent({
          sessionId: options.sessionId,
          modelId: cleanedModelId,
          windowState: contextWindowState,
          thresholdPercent: autoCompactDecision.enabled
            ? autoCompactDecision.thresholdPercent
            : contextCompactPercent,
          message,
        })
        yield {
          type: 'error',
          ...eventBase(options.sessionId),
          code: 'CONTEXT_LIMIT_EXCEEDED',
          message,
        }
        yield {
          type: 'result',
          ...eventBase(options.sessionId),
          success: false,
          message,
        }
        yield {
          type: 'execution_metrics',
          ...eventBase(options.sessionId),
          requestId: options.requestId,
          executeDurationMs: performance.now() - executionStartMs,
          providerFirstTokenMs,
          providerRequestDurationMs: totalProviderRequestDurationMs,
          streamDeltaCount,
          toolCallCount,
          toolRoundtripDurationMs: totalToolDurationMs,
          contextCharsIn,
          contextCharsOut,
        }
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
      let maxTokenRecoveryCount = 0
      const replacementState = createReplacementState()

      while (loopCount < maxLoops) {
        loopCount++

        if (options.signal?.aborted) {
          throw new Error('Aborted')
        }

        messages = await enforceMessageBudget(messages, replacementState, options.sessionId, options.cwd)

        currentToolsList = toolsList()
        finalResponseOnlyMode = maxLoops - loopCount <= FINAL_RESPONSE_ONLY_REMAINING_LOOPS
        modelVisibleTools = finalResponseOnlyMode || shouldSuppressToolsForIntent(assembledContext.userIntentGuidance) ? [] : currentToolsList
        const turnContextWindowState = getContextWindowState({
          tokenEstimate: estimateContextTokens({
            systemPrompt: assembledContext.systemPrompt,
            messages,
            tools: modelVisibleTools,
          }).totalTokens,
          maxTokens: assembledContext.budget.maxTokens,
          warningPercent: contextWarningPercent,
          compactPercent: contextCompactPercent,
        })
        if (turnContextWindowState.isBlocking) {
          const message = `Context estimate ${turnContextWindowState.tokenEstimate}/${turnContextWindowState.maxTokens} tokens exceeds the blocking limit (${turnContextWindowState.blockingLimitTokens}). Run /compact or /context before continuing.`
          yield createContextWarningEvent({
            sessionId: options.sessionId,
            modelId: cleanedModelId,
            windowState: turnContextWindowState,
            thresholdPercent: autoCompactDecision.enabled
              ? autoCompactDecision.thresholdPercent
              : contextCompactPercent,
            message,
          })
          yield {
            type: 'error',
            ...eventBase(options.sessionId),
            code: 'CONTEXT_LIMIT_EXCEEDED',
            message,
          }
          yield {
            type: 'result',
            ...eventBase(options.sessionId),
            success: false,
            message,
          }
          yield {
            type: 'execution_metrics',
            ...eventBase(options.sessionId),
            requestId: options.requestId,
            executeDurationMs: performance.now() - executionStartMs,
            providerFirstTokenMs,
            providerRequestDurationMs: totalProviderRequestDurationMs,
            streamDeltaCount,
            toolCallCount,
            toolRoundtripDurationMs: totalToolDurationMs,
            contextCharsIn,
            contextCharsOut,
          }
          return
        }

        let turnCharsIn = assembledContext.systemPrompt.length
        for (const msg of messages) {
          if (typeof msg.content === 'string') {
            turnCharsIn += msg.content.length
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text') {
                turnCharsIn += block.text.length
              } else if (block.type === 'tool_result') {
                turnCharsIn += block.content.length
              }
            }
          }
        }
        contextCharsIn += turnCharsIn

        const executionStateBlock = buildExecutionState({
          loopCount,
          maxLoops,
          readFileCache: this.readFileCache,
          toolCallCount,
          contextTokenEstimate: turnContextWindowState.tokenEstimate,
          contextMaxTokens: turnContextWindowState.maxTokens,
          finalResponseOnlyMode,
        })

        const queryParams: ModelQueryParams = {
          model: cleanedModelId,
          systemPrompt: assembledContext.systemPrompt,
          systemPromptBlocks: [
            ...(assembledContext.systemPromptBlocks ?? []),
            { text: executionStateBlock, cacheable: false },
          ],
          messages: normalizeMessages(messages),
          tools: modelVisibleTools,
          enablePromptCaching: settings.providerId === 'anthropic',
          ...(thinkingBudget &&
            thinkingBudget > 0 && {
              thinking: { budgetTokens: thinkingBudget },
            }),
        }

        const adapterOptions = {
          signal: options.signal,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
        }

        let currentAssistantText = ''
        let currentReasoningText = ''
        let currentFinishReason: string | undefined
        const currentToolCalls: {
          id: string
          name: string
          partialInput: string
          input?: unknown
        }[] = []

        const queryStartMs = performance.now()
        let turnFirstTokenMs: number | undefined = undefined

        // Stream LLM response
        const stream = adapter.queryStream(queryParams, adapterOptions)
        for await (const delta of stream) {
          if (options.signal?.aborted) {
            throw new Error('Aborted')
          }

          if (delta.type === 'text') {
            if (turnFirstTokenMs === undefined) {
              turnFirstTokenMs = performance.now() - queryStartMs
              if (providerFirstTokenMs === undefined) {
                providerFirstTokenMs = performance.now() - executionStartMs
              }
            }
            streamDeltaCount += 1
            contextCharsOut += delta.text.length
            currentAssistantText += delta.text
            yield {
              type: 'assistant_delta',
              ...eventBase(options.sessionId),
              text: delta.text,
            }
          } else if (delta.type === 'thinking') {
            if (turnFirstTokenMs === undefined) {
              turnFirstTokenMs = performance.now() - queryStartMs
              if (providerFirstTokenMs === undefined) {
                providerFirstTokenMs = performance.now() - executionStartMs
              }
            }
            streamDeltaCount += 1
            contextCharsOut += delta.text.length
            currentReasoningText += delta.text
            yield {
              type: 'thinking_delta',
              ...eventBase(options.sessionId),
              text: delta.text,
            }
          } else if (delta.type === 'tool_use_start') {
            if (turnFirstTokenMs === undefined) {
              turnFirstTokenMs = performance.now() - queryStartMs
              if (providerFirstTokenMs === undefined) {
                providerFirstTokenMs = performance.now() - executionStartMs
              }
            }
            currentToolCalls.push({
              id: delta.id,
              name: delta.name,
              partialInput: '',
            })
          } else if (delta.type === 'tool_use_delta') {
            const toolCall = currentToolCalls.find(tc => tc.id === delta.id)
            if (toolCall) {
              toolCall.partialInput += delta.inputDelta
            }
          } else if (delta.type === 'tool_use_end') {
            const toolCall = currentToolCalls.find(tc => tc.id === delta.id)
            if (toolCall) {
              toolCall.input = delta.input
            }
          } else if (delta.type === 'usage') {
            yield {
              type: 'usage',
              ...eventBase(options.sessionId),
              inputTokens: delta.inputTokens,
              outputTokens: delta.outputTokens,
              cacheCreationInputTokens: delta.cacheCreationInputTokens,
              cacheReadInputTokens: delta.cacheReadInputTokens,
            }
          } else if (delta.type === 'finish') {
            currentFinishReason = delta.reason
          }
        }

        const turnDurationMs = performance.now() - queryStartMs
        totalProviderRequestDurationMs += turnDurationMs

        // Max output tokens recovery
        if (currentFinishReason === 'max_tokens' && currentToolCalls.length === 0) {
          if (maxTokenRecoveryCount < MAX_TOKEN_RECOVERIES) {
            maxTokenRecoveryCount++
            messages.push({
              role: 'assistant',
              content: currentAssistantText,
              ...(currentReasoningText.trim() && { reasoningContent: currentReasoningText }),
            })
            messages.push({
              role: 'user',
              content: 'Your previous response was cut off because it hit the maximum output token limit. Please continue exactly from where you left off — do not repeat what you already said.',
            })
            continue
          }
          const message = `Provider repeatedly stopped because it hit the maximum output token limit after ${MAX_TOKEN_RECOVERIES} recovery attempts.`
          yield {
            type: 'error',
            ...eventBase(options.sessionId),
            code: 'MAX_OUTPUT_TOKENS_EXCEEDED',
            message,
            details: {
              kind: 'max_output_tokens',
              recoveryReason: 'ESCALATED_MAX_TOKENS',
              retryable: true,
              suggestion: 'Retry with a smaller requested output, ask for a shorter summary, or route this task to a model with a larger output budget.',
              fallbackPolicy: buildProviderFallbackPolicy('max_output_tokens'),
            },
          }
          yield {
            type: 'result',
            ...eventBase(options.sessionId),
            success: false,
            message,
          }
          yield {
            type: 'execution_metrics',
            ...eventBase(options.sessionId),
            requestId: options.requestId,
            executeDurationMs: performance.now() - executionStartMs,
            providerFirstTokenMs,
            providerRequestDurationMs: totalProviderRequestDurationMs,
            streamDeltaCount,
            toolCallCount,
            toolRoundtripDurationMs: totalToolDurationMs,
            contextCharsIn,
            contextCharsOut,
          }
          return
        }

        if (finalResponseOnlyMode && currentToolCalls.length > 0) {
          const attemptedTools = currentToolCalls.map(toolCall => toolCall.name).join(', ')
          const message = `Runtime entered final-response-only mode after repeated tool calls and ignored additional requested tools: ${attemptedTools}.`
          yield {
            type: 'error',
            ...eventBase(options.sessionId),
            code: 'TOOL_LOOP_FINAL_RESPONSE_ONLY',
            message,
          }
          messages.push({
            role: 'user',
            content: `${message}\nProvide the best final answer now using the information already available. Do not call tools.`,
          })
          continue
        }

        if (shouldSuppressToolsForIntent(assembledContext.userIntentGuidance) && currentToolCalls.length > 0) {
          const attemptedTools = currentToolCalls.map(toolCall => toolCall.name).join(', ')
          const message = `Runtime suppressed provider tool calls for respond-only user intent: ${attemptedTools}.`
          yield {
            type: 'error',
            ...eventBase(options.sessionId),
            code: 'TOOL_CALL_SUPPRESSED_BY_USER_INTENT',
            message,
            details: {
              intent: assembledContext.userIntentGuidance.intent,
              actionHint: assembledContext.userIntentGuidance.actionHint,
              requiresTools: assembledContext.userIntentGuidance.requiresTools,
              latestUserText: assembledContext.userIntentGuidance.latestUserText,
              attemptedTools: currentToolCalls.map(toolCall => toolCall.name),
            },
          }
          messages.push({
            role: 'user',
            content: `${message}\nAnswer the latest user message directly using existing context. Do not call tools.`,
          })
          continue
        }

        // Record assistant's turn in messages array
        const assistantContent: ContentBlock[] = []
        if (currentAssistantText) {
          assistantContent.push({ type: 'text', text: currentAssistantText })
        }
        for (const tc of currentToolCalls) {
          let resolvedInput = tc.input
          if (resolvedInput === undefined && tc.partialInput) {
            try {
              resolvedInput = JSON.parse(tc.partialInput)
            } catch {
              resolvedInput = {}
            }
          }
          assistantContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: resolvedInput,
          })
        }

        messages.push({
          role: 'assistant',
          content: assistantContent.length > 0 ? assistantContent : currentAssistantText,
          ...(currentReasoningText.trim() && { reasoningContent: currentReasoningText }),
        })

        // If no tool call was issued, we yield the final result and terminate loop
        if (currentToolCalls.length === 0) {
          if (currentAssistantText.trim().length === 0) {
            if (outputRetryCount < MAX_OUTPUT_RETRIES) {
              outputRetryCount++
              messages.push({
                role: 'user',
                content: 'Your previous response was cut off or empty. Please continue from where you left off.',
              })
              continue
            }
            yield {
              type: 'error',
              ...eventBase(options.sessionId),
              code: 'EMPTY_PROVIDER_RESPONSE',
              message: 'Provider returned an empty assistant response with no tool calls.',
            }
            yield {
              type: 'result',
              ...eventBase(options.sessionId),
              success: false,
              message: 'Provider returned an empty assistant response with no tool calls.',
            }
            yield {
              type: 'execution_metrics',
              ...eventBase(options.sessionId),
              requestId: options.requestId,
              executeDurationMs: performance.now() - executionStartMs,
              providerFirstTokenMs,
              providerRequestDurationMs: totalProviderRequestDurationMs,
              streamDeltaCount,
              toolCallCount,
              toolRoundtripDurationMs: totalToolDurationMs,
              contextCharsIn,
              contextCharsOut,
            }
            return
          }
          yield {
            type: 'result',
            ...eventBase(options.sessionId),
            success: true,
            message: currentAssistantText,
          }
          yield {
            type: 'execution_metrics',
            ...eventBase(options.sessionId),
            requestId: options.requestId,
            executeDurationMs: performance.now() - executionStartMs,
            providerFirstTokenMs,
            providerRequestDurationMs: totalProviderRequestDurationMs,
            streamDeltaCount,
            toolCallCount,
            toolRoundtripDurationMs: totalToolDurationMs,
            contextCharsIn,
            contextCharsOut,
          }
          return
        }

        // Execute requested tools
        const toolResultsContent: ContentBlock[] = []
        for (const tc of currentToolCalls) {
          let resolvedInput = tc.input
          if (resolvedInput === undefined && tc.partialInput) {
            try {
              resolvedInput = JSON.parse(tc.partialInput)
            } catch {
              resolvedInput = {}
            }
          }

          if (resolvedInput && typeof resolvedInput === 'object' && '_parseError' in (resolvedInput as Record<string, unknown>)) {
            const rawPreview = (resolvedInput as Record<string, unknown>)._rawInput as string || '(empty)'
            const errorMsg = `Failed to parse tool input for ${tc.name}. The model output was not valid JSON. Raw input preview: ${rawPreview}`
            toolResultsContent.push({
              type: 'tool_result',
              toolUseId: tc.id,
              content: errorMsg,
              isError: true,
            })
            yield {
              type: 'tool_completed',
              ...eventBase(options.sessionId),
              toolUseId: tc.id,
              name: tc.name,
              success: false,
              output: { code: 'PARSE_ERROR', message: 'Invalid JSON from model', rawPreview },
            }
            continue
          }

          const tool = this.tools.get(tc.name)
          if (!tool) {
            const availableTools = [...this.tools.keys()].join(', ')
            const errorMsg = `Unknown tool "${tc.name}". Available tools: ${availableTools}. Check the tool name and try again.`
            toolResultsContent.push({
              type: 'tool_result',
              toolUseId: tc.id,
              content: errorMsg,
              isError: true,
            })
            yield {
              type: 'tool_completed',
              ...eventBase(options.sessionId),
              toolUseId: tc.id,
              name: tc.name,
              success: false,
              output: { code: 'TOOL_NOT_FOUND', message: errorMsg },
            }
            continue
          }

          yield {
            type: 'tool_started',
            ...eventBase(options.sessionId),
            toolUseId: tc.id,
            name: tc.name,
            input: resolvedInput,
          }

          if (!this.toolPolicy.isAllowed(tool)) {
            const message = `Tool denied by Nexus policy: ${tool.name}`
            yield {
              type: 'tool_denied',
              ...eventBase(options.sessionId),
              name: tool.name,
              risk: tool.risk,
              message,
            }
            yield {
              type: 'result',
              ...eventBase(options.sessionId),
              success: false,
              message,
            }
            return
          }

          const preToolHooks = await executeRuntimeHooks(
            'PreToolUse',
            {
              toolUseId: tc.id,
              toolName: tool.name,
              toolRisk: tool.risk,
              toolInput: resolvedInput,
            },
            {
              sessionId: options.sessionId,
              cwd: options.cwd,
              role: options.role,
              signal: options.signal,
            },
          )
          for (const hookEvent of preToolHooks.events) yield hookEvent
          const hookDenyReason = firstHookDenyReason(preToolHooks)
          if (hookDenyReason) {
            yield {
              type: 'tool_denied',
              ...eventBase(options.sessionId),
              name: tool.name,
              risk: tool.risk,
              message: hookDenyReason,
            }
            yield {
              type: 'result',
              ...eventBase(options.sessionId),
              success: false,
              message: hookDenyReason,
            }
            return
          }
          const hookUpdatedInput = lastHookUpdatedInput(preToolHooks)
          if (hookUpdatedInput !== undefined) {
            resolvedInput = hookUpdatedInput
          }

          const parsed = tool.inputSchema.safeParse(resolvedInput)
          if (!parsed.success) {
            let message = [
              `Invalid input for tool ${tool.name}.`,
              z.prettifyError(parsed.error),
              `Return a corrected ${tool.name} tool call with all required fields.`,
            ].join('\n')
            const failureHooks = await executeRuntimeHooks(
              'PostToolUseFailure',
              {
                toolUseId: tc.id,
                toolName: tool.name,
                toolRisk: tool.risk,
                toolInput: resolvedInput,
                success: false,
                output: {
                  code: 'INVALID_TOOL_INPUT',
                  message,
                  input: resolvedInput,
                },
                errorCode: 'INVALID_TOOL_INPUT',
                errorMessage: message,
              },
              {
                sessionId: options.sessionId,
                cwd: options.cwd,
                role: options.role,
                signal: options.signal,
              },
            )
            for (const hookEvent of failureHooks.events) yield hookEvent
            message = mergeHookRetryHints(message, failureHooks)
            yield {
              type: 'tool_completed',
              ...eventBase(options.sessionId),
              toolUseId: tc.id,
              name: tool.name,
              success: false,
              output: {
                code: 'INVALID_TOOL_INPUT',
                message,
                input: resolvedInput,
              },
            }
            toolResultsContent.push({
              type: 'tool_result',
              toolUseId: tc.id,
              content: message,
              isError: true,
            })
            continue
          }

          const safetyCheck = checkOptimizerSafety(tool.name, parsed.data, options.role)
          if (!safetyCheck.allowed) {
            const message = safetyCheck.reason!
            yield {
              type: 'tool_denied',
              ...eventBase(options.sessionId),
              name: tool.name,
              risk: tool.risk,
              message,
            }
            yield {
              type: 'result',
              ...eventBase(options.sessionId),
              success: false,
              message,
            }
            return
          }

          // Check if the tool requires authorization.
          if ((tool.risk === 'write' || tool.risk === 'execute') && !options.skipPermissionCheck) {
            const { autoApprove, reason } = classifyAction(tool.name, parsed.data, { cwd: options.cwd })
            let approved = autoApprove
            let decisionReason = `Auto-approved: ${reason}`

            if (autoApprove) {
              await this.storage.savePermissionAudit({
                auditId: createId('audit'),
                sessionId: options.sessionId,
                toolUseId: tc.id,
                toolName: tool.name,
                toolRisk: tool.risk,
                toolInput: parsed.data,
                decision: 'approved',
                reason: decisionReason,
                timestamp: nowIso(),
              })
            } else {
              yield {
                type: 'permission_request',
                ...eventBase(options.sessionId),
                toolUseId: tc.id,
                name: tool.name,
                input: parsed.data,
                risk: tool.risk,
                message: `Tool ${tool.name} requires user permission to run. Reason: ${reason}`,
              }

              const permissionHooks = await executeRuntimeHooks(
                'PermissionRequest',
                {
                  toolUseId: tc.id,
                  toolName: tool.name,
                  toolRisk: tool.risk,
                  toolInput: parsed.data,
                },
                {
                  sessionId: options.sessionId,
                  cwd: options.cwd,
                  role: options.role,
                  signal: options.signal,
                },
              )
              for (const hookEvent of permissionHooks.events) yield hookEvent

              const hookDecision = firstHookPermissionDecision(permissionHooks)
              const decision = hookDecision ?? await PendingPermissionRegistry.getInstance().register(
                options.sessionId,
                tc.id
              )

              approved = decision.approved
              decisionReason = decision.reason ?? 'User review'

              await this.storage.savePermissionAudit({
                auditId: createId('audit'),
                sessionId: options.sessionId,
                toolUseId: tc.id,
                toolName: tool.name,
                toolRisk: tool.risk,
                toolInput: parsed.data,
                decision: approved ? 'approved' : 'denied',
                reason: decisionReason,
                timestamp: nowIso(),
              })

              yield {
                type: 'permission_response',
                ...eventBase(options.sessionId),
                toolUseId: tc.id,
                approved,
                reason: decisionReason,
              }
            }

            if (!approved) {
              const denyMessage = decisionReason || `Tool execution denied by user: ${tool.name}`
              yield {
                type: 'tool_denied',
                ...eventBase(options.sessionId),
                name: tool.name,
                risk: tool.risk,
                message: denyMessage,
              }
              yield {
                type: 'result',
                ...eventBase(options.sessionId),
                success: false,
                message: denyMessage,
              }
              return
            }
          }

          toolCallCount += 1
          const toolStartMs = performance.now()

          if (tool.name === 'Read' && parsed.data && typeof parsed.data === 'object' && 'path' in parsed.data) {
            const readPath = resolve(options.cwd, String((parsed.data as { path: string }).path))
            const cached = this.readFileCache.get(readPath)
            if (cached) {
              try {
                const stat = lstatSync(readPath)
                if (stat.mtimeMs === cached.mtime) {
                  totalToolDurationMs += performance.now() - toolStartMs
                  const stubMsg = 'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'
                  yield { type: 'tool_completed', ...eventBase(options.sessionId), toolUseId: tc.id, name: tool.name, success: true, output: stubMsg }
                  toolResultsContent.push({ type: 'tool_result', toolUseId: tc.id, content: stubMsg, isError: false })
                  continue
                }
              } catch {}
            }
          }

          const result = await executeToolSafely(tool, parsed.data, options, { timeout: TOOL_EXECUTION_TIMEOUT_MS })
          totalToolDurationMs += performance.now() - toolStartMs

          if (tool.name === 'Read' && result.kind === 'result' && result.success && parsed.data && typeof parsed.data === 'object' && 'path' in parsed.data) {
            const readPath = resolve(options.cwd, String((parsed.data as { path: string }).path))
            try {
              const stat = lstatSync(readPath)
              this.readFileCache.set(readPath, { mtime: stat.mtimeMs, size: stat.size })
            } catch {}
          }
          if (result.kind === 'error') {
            yield {
              type: 'error',
              ...eventBase(options.sessionId),
              code: result.code,
              message: result.message,
              details: result.details,
            }
            return
          }

          yield {
            type: 'tool_completed',
            ...eventBase(options.sessionId),
            toolUseId: tc.id,
            name: tool.name,
            success: result.success,
            output: result.output,
            truncated: result.truncated,
            originalBytes: result.originalBytes,
          }

          const postHookName = result.success ? 'PostToolUse' : 'PostToolUseFailure'
          const postToolHooks = await executeRuntimeHooks(
            postHookName,
            {
              toolUseId: tc.id,
              toolName: tool.name,
              toolRisk: tool.risk,
              toolInput: parsed.data,
              success: result.success,
              output: result.output,
              errorCode: result.success ? undefined : 'TOOL_RESULT_FAILED',
              errorMessage: result.success ? undefined : `${tool.name} returned success=false.`,
            },
            {
              sessionId: options.sessionId,
              cwd: options.cwd,
              role: options.role,
              signal: options.signal,
            },
          )
          for (const hookEvent of postToolHooks.events) yield hookEvent

          const blockContent =
            typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output, null, 2)
          const contentWithHints = result.success
            ? blockContent
            : mergeHookRetryHints(blockContent, postToolHooks)
          const finalContent = await replaceLargeToolResult({
            content: contentWithHints,
            toolUseId: tc.id,
            toolName: tool.name,
            sessionId: options.sessionId,
            cwd: options.cwd,
          })
          toolResultsContent.push({
            type: 'tool_result',
            toolUseId: tc.id,
            content: finalContent,
            isError: !result.success,
          })
        }

        // Record tool results as a single user message
        messages.push({
          role: 'user',
          content: toolResultsContent,
        })
      }

      const maxLoopsMessage = `Execution exceeded maximum tool call iterations (${maxLoops}).`
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: 'MAX_LOOPS_EXCEEDED',
        message: maxLoopsMessage,
      }
      yield {
        type: 'result',
        ...eventBase(options.sessionId),
        success: false,
        message: maxLoopsMessage,
      }
      yield {
        type: 'execution_metrics',
        ...eventBase(options.sessionId),
        requestId: options.requestId,
        executeDurationMs: performance.now() - executionStartMs,
        providerFirstTokenMs,
        providerRequestDurationMs: totalProviderRequestDurationMs,
        streamDeltaCount,
        toolCallCount,
        toolRoundtripDurationMs: totalToolDurationMs,
        contextCharsIn,
        contextCharsOut,
      }
    } catch (err: any) {
      const isTimeout = options.timeoutSignal?.aborted
      const isCancelled = !isTimeout && (options.signal?.aborted || err.message?.includes('Abort') || err.name === 'AbortError')
      const providerRecovery = classifyProviderRecovery(err)
      const errorCode = isTimeout ? 'REQUEST_TIMEOUT' : isCancelled ? 'REQUEST_CANCELLED' : (err.code || 'PROVIDER_ERROR')
      const errorText = isCancelled
        ? 'Execution cancelled by user.'
        : err instanceof Error ? err.message : String(err)
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: errorCode,
        message: errorText,
        details: providerRecovery,
      }
      yield {
        type: 'result',
        ...eventBase(options.sessionId),
        success: false,
        message: errorText,
      }
      yield {
        type: 'execution_metrics',
        ...eventBase(options.sessionId),
        requestId: options.requestId,
        executeDurationMs: performance.now() - executionStartMs,
        providerFirstTokenMs,
        providerRequestDurationMs: totalProviderRequestDurationMs,
        streamDeltaCount,
        toolCallCount,
        toolRoundtripDurationMs: totalToolDurationMs,
        contextCharsIn,
        contextCharsOut,
      }
    }
  }
}

function createContextWarningEvent(options: {
  sessionId: string
  modelId: string
  windowState: ContextWindowState
  thresholdPercent: number
  message: string
}): Extract<NexusEvent, { type: 'context_warning' }> {
  return {
    type: 'context_warning',
    ...eventBase(options.sessionId),
    modelId: options.modelId,
    tokenEstimate: options.windowState.tokenEstimate,
    maxTokens: options.windowState.maxTokens,
    percentUsed: options.windowState.percentUsed,
    thresholdPercent: options.thresholdPercent,
    message: options.message,
  }
}

import {
  executeToolSafely,
  TOOL_EXECUTION_TIMEOUT_MS,
} from './toolExecutor.js'

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

function buildExecutionState(state: {
  loopCount: number
  maxLoops: number
  readFileCache: Map<string, { mtime: number; size: number }>
  toolCallCount: number
  contextTokenEstimate: number
  contextMaxTokens: number
  finalResponseOnlyMode?: boolean
}): string {
  const filesRead = [...state.readFileCache.keys()]
  const remaining = state.maxLoops - state.loopCount
  const pctUsed = state.contextMaxTokens > 0 ? Math.round(state.contextTokenEstimate / state.contextMaxTokens * 100) : 0
  let phase = 'gathering'
  if (state.finalResponseOnlyMode || remaining <= FINAL_RESPONSE_ONLY_REMAINING_LOOPS) phase = 'must_respond'
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
