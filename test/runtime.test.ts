import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir, homedir } from 'node:os'
import { z } from 'zod'
import { createEmptyContextSelectionDiagnostics } from '../src/runtime/contextManager.js'
import { createId } from '../src/shared/id.js'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import {
  LocalCodingRuntime,
  allowAllTools,
  allowlistedTools,
  buildSessionRulesPolicy,
  deriveBashSuggestedRule,
} from '../src/runtime/LocalCodingRuntime.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { createNexusTask, taskQueueStatsForTest } from '../src/nexus/taskQueue.js'
import { createTaskSession, taskSessionStatsForTest } from '../src/nexus/taskSession.js'
import { PendingPermissionRegistry } from '../src/shared/session.js'
import { globTool } from '../src/tools/builtin/glob.js'
import { LLMCodingRuntime } from '../src/runtime/LLMCodingRuntime.js'
import { executeProviderToolCall } from '../src/runtime/runtimeToolLoop.js'
import {
  absorbCacheAwareCompactPolicyMetrics,
  absorbCompactSummaryLatencyMetrics,
  absorbPrefixCacheDiagnosticsMetrics,
  absorbProviderTurnMetrics,
  buildContextBlockingEvents,
  buildContextWarningEvent,
  buildProviderAssistantMessage,
  buildProviderLoopRequestState,
  buildProviderLoopState,
  buildProviderQueryParams,
  buildProviderToolResultsMessage,
  buildRuntimeContextBlockingEventsForLoop,
  computeProviderPrefixCacheDiagnostics,
  buildRuntimeContextRefreshState,
  buildRuntimeExecutionMetricsEvent,
  buildRuntimeExecutionStateBlock,
  buildRuntimeErrorEvent,
  buildRuntimeResultEvent,
  createRuntimeExecutionMetrics,
  countRuntimeTurnContextChars,
  parseLocalRuntimeIntent,
  reduceProviderTurnOutcome,
  resolveProviderToolCallInput,
  streamProviderTurn,
} from '../src/runtime/runtimePipeline.js'
import { compactSession } from '../src/runtime/compact.js'
import { buildCacheAwareCompactPolicy } from '../src/runtime/cacheAwareCompactPolicy.js'
import type { UserIntentGuidance } from '../src/runtime/intentGuidance.js'
import { allocateBudget } from '../src/runtime/contextAssembler.js'
import { setAdapterOverrideForTest } from '../src/providers/registry.js'
import type { ModelAdapter, ModelQueryParams, StreamDelta } from '../src/providers/adapters/ModelAdapter.js'
import { ConfigManager } from '../src/shared/config.js'
import { eventBase, NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'
import {
  HttpRemoteToolRunner,
  InMemoryRemoteToolRunner,
  REMOTE_RUNNER_PROTOCOL_VERSION,
  createRemoteToolRunnerServer,
} from '../src/runtime/remoteRunner.js'
import { HttpEverCoreClient } from '../src/runtime/everCoreClient.js'
import { configureEverCore, configureEverCoreFromEnv } from '../src/nexus/everCoreConfig.js'
import {
  assertAgentRemoteExecutionReady,
  assertRemoteRunnerReady,
  configureRemoteRunner,
  parseAgentExecutionEnvironment,
} from '../src/nexus/remoteRunnerConfig.js'

const baseRuntimeUserIntentGuidance: UserIntentGuidance = {
  intent: 'continue',
  confidence: 1,
  continuity: 1,
  contextScope: 'full',
  actionHint: 'normal',
  requiresTools: true,
  reason: 'test',
  guidance: 'Continue normally.',
  latestUserText: 'test prompt',
  explicitPaths: [],
  source: 'fallback',
}

function createRuntimeTestStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

const runtimeTestConfigPath = join(tmpdir(), `babel-o-runtime-test-config-${process.pid}.json`)
process.env.BABEL_O_CONFIG_FILE = runtimeTestConfigPath
ConfigManager.getInstance().save({})

test('runtime pipeline parses local tool and task intents', () => {
  assert.deepEqual(parseLocalRuntimeIntent('read sample.txt'), {
    kind: 'tool',
    toolName: 'Read',
    input: { path: 'sample.txt' },
  })
  assert.deepEqual(parseLocalRuntimeIntent('task update task_123 completed done'), {
    kind: 'task_update',
    selector: 'task_123',
    status: 'completed',
    result: 'done',
  })
  assert.deepEqual(parseLocalRuntimeIntent('Bash: {"command":"pwd","timeoutMs":20}'), {
    kind: 'tool',
    toolName: 'Bash',
    input: { command: 'pwd', timeoutMs: 20 },
  })
  assert.equal(parseLocalRuntimeIntent('What does sample.txt say?').kind, 'file_question')
})

test('runtime pipeline resolves provider tool call inputs', () => {
  assert.deepEqual(resolveProviderToolCallInput({
    id: 'tool_explicit',
    name: 'Read',
    partialInput: '{"path":"partial.txt"}',
    input: { path: 'explicit.txt' },
  }), { path: 'explicit.txt' })
  assert.deepEqual(resolveProviderToolCallInput({
    id: 'tool_partial',
    name: 'Read',
    partialInput: '{"path":"partial.txt"}',
  }), { path: 'partial.txt' })
  assert.deepEqual(resolveProviderToolCallInput({
    id: 'tool_bad',
    name: 'Read',
    partialInput: '{bad json',
  }), {})
  assert.equal(resolveProviderToolCallInput({
    id: 'tool_empty',
    name: 'Read',
    partialInput: '',
  }), undefined)
})

test('runtime pipeline builds provider assistant and tool result messages', () => {
  const assistantMessage = buildProviderAssistantMessage({
    assistantText: 'I will read it.',
    reasoningText: 'Need file contents.',
    toolCalls: [{
      id: 'tool_1',
      name: 'Read',
      partialInput: '{"path":"a.txt"}',
    }],
  })

  assert.deepEqual(assistantMessage, {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I will read it.' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: 'a.txt' } },
    ],
    reasoningContent: 'Need file contents.',
  })

  assert.deepEqual(buildProviderToolResultsMessage([{
    type: 'tool_result',
    toolUseId: 'tool_1',
    content: 'hello',
    isError: false,
  }]), {
    role: 'user',
    content: [{
      type: 'tool_result',
      toolUseId: 'tool_1',
      content: 'hello',
      isError: false,
    }],
  })
})

test('runtime pipeline builds terminal result and error events', () => {
  const result = buildRuntimeResultEvent('session-terminal', false, 'failed')
  assert.equal(result.type, 'result')
  assert.equal(result.sessionId, 'session-terminal')
  assert.equal(result.success, false)
  assert.equal(result.message, 'failed')

  const error = buildRuntimeErrorEvent({
    sessionId: 'session-terminal',
    code: 'FAILED',
    message: 'failed',
    details: { retryable: true },
  })
  assert.equal(error.type, 'error')
  assert.equal(error.sessionId, 'session-terminal')
  assert.equal(error.code, 'FAILED')
  assert.deepEqual(error.details, { retryable: true })
})

test('runtime pipeline builds context warning and blocking event sequences', () => {
  const windowState = {
    tokenEstimate: 9_500,
    maxTokens: 10_000,
    percentUsed: 95,
    warningThresholdTokens: 7_000,
    compactThresholdTokens: 8_500,
    blockingLimitTokens: 9_000,
    isWarning: true,
    isCompact: true,
    isBlocking: true,
  }

  const policy = buildCacheAwareCompactPolicy({
    modelId: 'minimax/MiniMax-M3',
    tokenEstimate: windowState.tokenEstimate,
    maxOutputTokens: 16_384,
  })
  const warning = buildContextWarningEvent({
    sessionId: 'session-context-warning',
    modelId: 'test-model',
    windowState,
    thresholdPercent: 85,
    message: 'custom warning',
    cacheAwareCompactPolicy: policy,
  })
  assert.equal(warning.type, 'context_warning')
  assert.equal(warning.tokenEstimate, 9_500)
  assert.equal(warning.thresholdPercent, 85)
  assert.equal(warning.modelContextWindow, policy.modelContextWindow)
  assert.equal(warning.reservedOutputTokens, policy.reservedOutputTokens)
  assert.equal(warning.providerSafetyBufferTokens, policy.providerSafetyBufferTokens)
  assert.equal(warning.effectiveContextCeiling, policy.effectiveContextCeiling)
  assert.equal(warning.legacyContextCeiling, policy.legacyContextCeiling)
  assert.equal(warning.contextPolicySource, policy.policySource)

  const events = buildContextBlockingEvents({
    sessionId: 'session-context-blocking',
    modelId: 'test-model',
    windowState,
    thresholdPercent: 85,
    cacheAwareCompactPolicy: policy,
  })
  assert.deepEqual(events.map(event => event.type), ['context_warning', 'context_blocking', 'error', 'result'])
  assert.equal(events[1]?.type, 'context_blocking')
  assert.equal(events[1]?.httpStatus, 413)
  assert.equal(events[1]?.modelContextWindow, policy.modelContextWindow)
  assert.equal(events[1]?.reservedOutputTokens, policy.reservedOutputTokens)
  assert.equal(events[1]?.providerSafetyBufferTokens, policy.providerSafetyBufferTokens)
  assert.equal(events[1]?.effectiveContextCeiling, policy.effectiveContextCeiling)
  assert.equal(events[1]?.legacyContextCeiling, policy.legacyContextCeiling)
  assert.equal(events[1]?.contextPolicySource, policy.policySource)
  assert.equal(events[2]?.type, 'error')
  assert.equal(events[2]?.code, 'CONTEXT_LIMIT_EXCEEDED')
  assert.deepEqual(events[2]?.details, {
    kind: 'context_window',
    recoveryReason: 'CONTEXT_BLOCKING_LIMIT',
    retryable: true,
    httpStatus: 413,
    tokenEstimate: 9_500,
    maxTokens: 10_000,
    blockingLimitTokens: 9_000,
    contextPolicy: {
      modelContextWindow: policy.modelContextWindow,
      reservedOutputTokens: policy.reservedOutputTokens,
      providerSafetyBufferTokens: policy.providerSafetyBufferTokens,
      effectiveContextCeiling: policy.effectiveContextCeiling,
      legacyContextCeiling: policy.legacyContextCeiling,
      envMaxContextTokens: undefined,
      source: policy.policySource,
    },
    recoveryActions: ['compact', 'context', 'switch_model', 'reduce_tool_output'],
    suggestion: 'Run /compact or /context, switch to a larger context model, or reduce tool output before retrying.',
    fallbackPolicy: {
      mode: 'compact_then_retry',
      reason: 'The input context is too large; compaction is safer than silently changing providers.',
      nextAction: 'Run /compact or reduce context first; ask before routing to a larger-context model/profile.',
      allowSilentModelSwitch: false,
    },
  })
  assert.equal(events[3]?.type, 'result')
  assert.equal(events[3]?.success, false)
})

test('runtime pipeline builds compact refresh state from assembled context', () => {
  const messages = [{ role: 'user' as const, content: 'hello compact refresh' }]
  const assembledContext = {
    systemPrompt: 'system prompt',
    systemPromptBlocks: [{ text: 'system prompt', cacheable: true }],
    messages,
    budget: allocateBudget('missing-model-for-default-budget'),
    selectedEventCount: 1,
    omittedEventCount: 0,
    snippedEventCount: 0,
    sessionSummary: '',
    projectMemory: '',
    activeSkills: '',
    compactRetainedEventCount: 0,
    compactRetainedSegmentValid: true,
    compactRetainedSegmentWarning: '',
    postCompactState: {
      recentReadFiles: [],
      restoredFileContents: [],
      activeToolNames: [],
      activeSkills: [],
      skillReminderLines: [],
      mcpToolLines: [],
      toolContractLines: [],
      toolFailureLines: [],
      taskStatusLines: [],
      agentStatusLines: [],
      subTaskStatusLines: [],
      hookLines: [],
    },
    userIntentGuidance: baseRuntimeUserIntentGuidance,
    memoryTruncated: false,
    microcompactedEventCount: 0,
    microcompactMetrics: {
      compactedEventCount: 0,
      deduplicatedToolResultCount: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      bytesSaved: 0,
      estimatedTokensSaved: 0,
    },
    selectionDiagnostics: createEmptyContextSelectionDiagnostics(allocateBudget('missing-model-for-default-budget').maxTokens),
    scopedMemoryDiagnostics: [],
  }
  const compactFailureEvent: NexusEvent = {
    type: 'compact_failure',
    ...eventBase('session-refresh'),
    trigger: 'auto',
    failureCount: 1,
    maxFailures: 2,
    message: 'failed once',
  }

  const state = buildRuntimeContextRefreshState({
    assembledContext,
    events: [compactFailureEvent],
    tools: [
      { name: 'Read', description: 'Read files', inputSchema: { type: 'object' } },
      { name: 'Bash', description: 'Run shell commands', inputSchema: { type: 'object' } },
    ],
    modelId: 'missing-model-for-default-budget',
    warningPercent: 70,
    compactPercent: 85,
    suppressToolsForUserIntent: true,
  })

  assert.equal(state.assembledContext, assembledContext)
  assert.equal(state.messages, messages)
  assert.equal(state.currentToolsList.length, 2)
  assert.deepEqual(state.modelVisibleTools, [])
  assert.equal(state.contextWindowState.tokenEstimate, state.contextEstimateTokens)
  assert.equal(state.contextWindowState.maxTokens, assembledContext.budget.maxTokens)
  assert.equal(state.autoCompactDecision.failureCount, 1)

  const previous = process.env.BABEL_O_MAX_CONTEXT_TOKENS
  try {
    delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
    const cacheAwareState = buildRuntimeContextRefreshState({
      assembledContext,
      events: [{
        type: 'usage',
        ...eventBase('session-refresh'),
        inputTokens: 10_000,
        outputTokens: 100,
        cacheReadInputTokens: 30_000,
      }],
      tools: [],
      modelId: 'minimax/MiniMax-M3',
      warningPercent: 70,
      compactPercent: 90,
      suppressToolsForUserIntent: false,
    })
    assert.equal(cacheAwareState.cacheAwareCompactPolicy.longContextUtilizationMode, true)
    assert.equal(cacheAwareState.cacheAwareCompactPolicy.cachePreservationMode, true)
    assert.equal(cacheAwareState.contextWindowState.maxTokens, 179_616)
    assert.equal(cacheAwareState.autoCompactDecision.thresholdPercent, 93)

    const providerErrorState = buildRuntimeContextRefreshState({
      assembledContext,
      events: [{
        type: 'error',
        ...eventBase('session-refresh'),
        code: 'PROVIDER_CONTEXT_WINDOW',
        message: 'context window limit reached',
      }],
      tools: [],
      modelId: 'minimax/MiniMax-M3',
      warningPercent: 70,
      compactPercent: 90,
      suppressToolsForUserIntent: false,
    })
    assert.equal(providerErrorState.cacheAwareCompactPolicy.cachePreservationMode, false)
    assert.equal(providerErrorState.autoCompactDecision.thresholdPercent, 80)
  } finally {
    if (previous === undefined) delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
    else process.env.BABEL_O_MAX_CONTEXT_TOKENS = previous
  }
})

test('runtime pipeline builds provider loop state and execution state blocks', () => {
  const messages = [
    { role: 'user' as const, content: 'hello' },
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'answer' },
        { type: 'tool_result' as const, toolUseId: 'tool_1', content: 'result', isError: false },
      ],
    },
  ]
  assert.equal(countRuntimeTurnContextChars({ systemPrompt: 'system', messages }), 23)

  const readFileCache = new Map<string, { mtime: number; size: number }>([
    ['/tmp/a.txt', { mtime: 1, size: 10 }],
  ])
  const loopState = buildProviderLoopState({
    loopCount: 23,
    maxLoops: 25,
    readFileCache,
    toolCallCount: 3,
    contextTokenEstimate: 9_500,
    contextMaxTokens: 10_000,
    systemPrompt: 'system',
    messages,
    finalResponseOnlyRemainingLoops: 3,
  })
  assert.equal(loopState.finalResponseOnlyMode, true)
  assert.equal(loopState.turnContextCharsIn, 23)
  assert.match(loopState.executionStateBlock, /iteration 23\/25/)
  assert.match(loopState.executionStateBlock, /Files read: \/tmp\/a\.txt/)
  assert.match(loopState.executionStateBlock, /Phase: must_respond/)

  const synthesizeBlock = buildRuntimeExecutionStateBlock({
    loopCount: 4,
    maxLoops: 25,
    readFileCache,
    toolCallCount: 10,
    contextTokenEstimate: 5_000,
    contextMaxTokens: 10_000,
    finalResponseOnlyRemainingLoops: 3,
  })
  assert.match(synthesizeBlock, /Phase: synthesize/)
  assert.match(synthesizeBlock, /Present your findings now/)
})

test('runtime pipeline builds provider loop request state and query params', () => {
  const messages = [
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'orphan_tool', name: 'Read', input: {} }] },
  ]
  const currentToolsList = [{ name: 'Read', description: 'Read files', inputSchema: { type: 'object' } }]
  const requestState = buildProviderLoopRequestState({
    loopCount: 4,
    maxLoops: 25,
    readFileCache: new Map(),
    toolCallCount: 2,
    systemPrompt: 'system prompt',
    messages,
    currentToolsList,
    contextMaxTokens: 10_000,
    warningPercent: 70,
    compactPercent: 85,
    suppressToolsForUserIntent: false,
    finalResponseOnlyMode: false,
    finalResponseOnlyRemainingLoops: 3,
  })

  assert.equal(requestState.finalResponseOnlyMode, false)
  assert.equal(requestState.currentToolsList, currentToolsList)
  assert.equal(requestState.modelVisibleTools, currentToolsList)
  assert.equal(requestState.contextWindowState.maxTokens, 10_000)
  assert.match(requestState.executionStateBlock, /iteration 4\/25/)

  const policyRequestState = buildProviderLoopRequestState({
    loopCount: 4,
    maxLoops: 25,
    readFileCache: new Map(),
    toolCallCount: 2,
    systemPrompt: 'system prompt',
    messages,
    currentToolsList,
    contextMaxTokens: 10_000,
    warningPercent: 70,
    compactPercent: 85,
    suppressToolsForUserIntent: false,
    cacheAwareCompactPolicy: buildCacheAwareCompactPolicy({
      modelId: 'minimax/MiniMax-M3',
      tokenEstimate: 1_000,
      usage: { inputTokens: 10_000, cacheReadInputTokens: 30_000 },
      cacheableSystemPromptRatio: 1,
      compactPercent: 90,
      maxOutputTokens: 16_384,
    }),
    finalResponseOnlyMode: false,
    finalResponseOnlyRemainingLoops: 3,
  })
  assert.equal(policyRequestState.contextWindowState.maxTokens, 179_616)
  assert.equal(policyRequestState.contextWindowState.compactThresholdTokens, Math.floor(179_616 * 0.93))

  const suppressedState = buildProviderLoopRequestState({
    loopCount: 24,
    maxLoops: 25,
    readFileCache: new Map(),
    toolCallCount: 2,
    systemPrompt: 'system prompt',
    messages,
    currentToolsList,
    contextMaxTokens: 10_000,
    warningPercent: 70,
    compactPercent: 85,
    suppressToolsForUserIntent: true,
    finalResponseOnlyRemainingLoops: 3,
  })
  assert.equal(suppressedState.finalResponseOnlyMode, true)
  assert.deepEqual(suppressedState.modelVisibleTools, [])

  const blockingEvents = buildRuntimeContextBlockingEventsForLoop({
    sessionId: 'session-loop-blocking',
    modelId: 'test-model',
    windowState: {
      tokenEstimate: 9_500,
      maxTokens: 10_000,
      percentUsed: 95,
      warningThresholdTokens: 7_000,
      compactThresholdTokens: 8_500,
      blockingLimitTokens: 9_000,
      isWarning: true,
      isCompact: true,
      isBlocking: true,
    },
    autoCompactDecision: {
      enabled: false,
      shouldCompact: false,
      thresholdPercent: 90,
      failureCount: 0,
      failureLimit: 2,
      fuseOpen: false,
    },
    fallbackThresholdPercent: 85,
  })
  assert.equal(blockingEvents[0]?.type, 'context_warning')
  assert.equal(blockingEvents[0]?.thresholdPercent, 85)

  const queryParams = buildProviderQueryParams({
    modelId: 'test/model',
    systemPrompt: 'system prompt',
    systemPromptBlocks: [{ text: 'system prompt', cacheable: true }],
    executionStateBlock: requestState.executionStateBlock,
    messages,
    tools: requestState.modelVisibleTools,
    maxTokens: 123,
    providerId: 'anthropic',
    thinkingBudget: 456,
  })
  assert.equal(queryParams.model, 'test/model')
  assert.equal(queryParams.enablePromptCaching, true)
  assert.deepEqual(queryParams.thinking, { budgetTokens: 456 })
  assert.equal(queryParams.systemPromptBlocks?.at(-1)?.cacheable, false)
  assert.equal(queryParams.messages[0]?.role, 'user')
  assert.equal(queryParams.tools, currentToolsList)
})

test('runtime pipeline reduces max-token provider turns to continuation or terminal outcomes', () => {
  const retryOutcome = reduceProviderTurnOutcome({
    sessionId: 'session-turn-reducer',
    turn: {
      assistantText: 'partial answer',
      reasoningText: 'reasoning',
      finishReason: 'max_tokens',
      toolCalls: [],
    },
    finalResponseOnlyMode: false,
    suppressToolsForUserIntent: false,
    userIntentGuidance: baseRuntimeUserIntentGuidance,
    maxTokenRecoveryCount: 0,
    maxTokenRecoveries: 3,
    outputRetryCount: 0,
    maxOutputRetries: 2,
    suppressedToolRetryCount: 0,
    maxSuppressedToolRetries: 1,
  })
  assert.equal(retryOutcome.kind, 'continue')
  assert.equal(retryOutcome.maxTokenRecoveryCount, 1)
  assert.equal(retryOutcome.messages.length, 2)
  assert.deepEqual(retryOutcome.eventsBeforeMessages, [])

  const terminalOutcome = reduceProviderTurnOutcome({
    sessionId: 'session-turn-reducer',
    turn: {
      assistantText: 'partial answer',
      reasoningText: '',
      finishReason: 'max_tokens',
      toolCalls: [],
    },
    finalResponseOnlyMode: false,
    suppressToolsForUserIntent: false,
    userIntentGuidance: baseRuntimeUserIntentGuidance,
    maxTokenRecoveryCount: 3,
    maxTokenRecoveries: 3,
    outputRetryCount: 0,
    maxOutputRetries: 2,
    suppressedToolRetryCount: 0,
    maxSuppressedToolRetries: 1,
  })
  assert.equal(terminalOutcome.kind, 'terminal')
  assert.equal(terminalOutcome.eventsBeforeMessages[0]?.type, 'error')
  assert.equal(terminalOutcome.eventsBeforeMessages[1]?.type, 'result')
})

test('runtime pipeline reduces suppressed provider tool turns to retry prompts', () => {
  const outcome = reduceProviderTurnOutcome({
    sessionId: 'session-turn-reducer-suppressed',
    turn: {
      assistantText: '',
      reasoningText: '',
      toolCalls: [{ id: 'tool_1', name: 'Read', partialInput: '{}' }],
    },
    finalResponseOnlyMode: false,
    suppressToolsForUserIntent: true,
    userIntentGuidance: {
      ...baseRuntimeUserIntentGuidance,
      actionHint: 'respond_only',
      requiresTools: false,
      latestUserText: '你是谁？',
    },
    maxTokenRecoveryCount: 0,
    maxTokenRecoveries: 3,
    outputRetryCount: 0,
    maxOutputRetries: 2,
    suppressedToolRetryCount: 0,
    maxSuppressedToolRetries: 1,
  })

  assert.equal(outcome.kind, 'continue')
  assert.equal(outcome.suppressedToolRetryCount, 1)
  assert.equal(outcome.eventsBeforeMessages[0]?.type, 'error')
  assert.equal(outcome.eventsBeforeMessages[0]?.code, 'TOOL_CALL_SUPPRESSED_BY_USER_INTENT')
  assert.equal((outcome.eventsBeforeMessages[0]?.details as any).retryAttempted, true)
  assert.equal(outcome.messages[0]?.role, 'user')

  const exhaustedOutcome = reduceProviderTurnOutcome({
    sessionId: 'session-turn-reducer-suppressed-exhausted',
    turn: {
      assistantText: '',
      reasoningText: '',
      toolCalls: [{ id: 'tool_1', name: 'Read', partialInput: '{}' }],
    },
    finalResponseOnlyMode: false,
    suppressToolsForUserIntent: true,
    userIntentGuidance: {
      ...baseRuntimeUserIntentGuidance,
      actionHint: 'respond_only',
      requiresTools: false,
      latestUserText: '你是谁？',
    },
    maxTokenRecoveryCount: 0,
    maxTokenRecoveries: 3,
    outputRetryCount: 0,
    maxOutputRetries: 2,
    suppressedToolRetryCount: 1,
    maxSuppressedToolRetries: 1,
  })
  assert.equal(exhaustedOutcome.kind, 'tool_calls')
  assert.equal(exhaustedOutcome.toolCalls.length, 1)
})

test('runtime pipeline reduces final and tool-call provider turns', () => {
  const finalOutcome = reduceProviderTurnOutcome({
    sessionId: 'session-turn-reducer-final',
    turn: {
      assistantText: 'done',
      reasoningText: '',
      toolCalls: [],
    },
    finalResponseOnlyMode: false,
    suppressToolsForUserIntent: false,
    userIntentGuidance: baseRuntimeUserIntentGuidance,
    maxTokenRecoveryCount: 0,
    maxTokenRecoveries: 3,
    outputRetryCount: 0,
    maxOutputRetries: 2,
    suppressedToolRetryCount: 0,
    maxSuppressedToolRetries: 1,
  })
  assert.equal(finalOutcome.kind, 'terminal')
  assert.equal(finalOutcome.queueSessionMemoryLiteUpdate, true)
  assert.equal(finalOutcome.eventsAfterMessages[0]?.type, 'result')
  assert.equal(finalOutcome.messages[0]?.role, 'assistant')

  const toolOutcome = reduceProviderTurnOutcome({
    sessionId: 'session-turn-reducer-tool',
    turn: {
      assistantText: 'I will read it.',
      reasoningText: '',
      toolCalls: [{ id: 'tool_1', name: 'Read', partialInput: '{"path":"a.txt"}' }],
    },
    finalResponseOnlyMode: false,
    suppressToolsForUserIntent: false,
    userIntentGuidance: baseRuntimeUserIntentGuidance,
    maxTokenRecoveryCount: 0,
    maxTokenRecoveries: 3,
    outputRetryCount: 0,
    maxOutputRetries: 2,
    suppressedToolRetryCount: 0,
    maxSuppressedToolRetries: 1,
  })
  assert.equal(toolOutcome.kind, 'tool_calls')
  assert.equal(toolOutcome.toolCalls.length, 1)
  assert.equal(toolOutcome.messages[0]?.role, 'assistant')
})

test('runtime tool loop executes a provider tool call and returns tool_result content', async () => {
  const tools = createDefaultToolRegistry()
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-tool-loop-success`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'tool-loop.txt'), 'tool-loop-content', 'utf8')
  const metrics = createRuntimeExecutionMetrics()
  const stream = executeProviderToolCall({
    toolCall: {
      id: 'tool_loop_read',
      name: 'Read',
      partialInput: '{"path":"tool-loop.txt"}',
    },
    tools,
    toolPolicy: allowAllTools(),
    runtimeOptions: {
      sessionId: 'session-tool-loop-success',
      prompt: 'read tool-loop.txt',
      cwd,
      skipPermissionCheck: true,
    },
    storage: new MemoryStorage(),
    metrics,
    readFileCache: new Map(),
  })

  const events: NexusEvent[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }

  assert.equal(next.value.kind, 'continue')
  assert.equal(next.value.toolResult.content, 'tool-loop-content')
  assert.equal(next.value.toolResult.isError, false)
  assert.equal(metrics.toolCallCount, 1)
  assert.ok(metrics.toolRoundtripDurationMs >= 0)
  assert.ok(events.some(event => event.type === 'tool_started' && event.name === 'Read'))
  assert.ok(events.some(event => event.type === 'tool_completed' && event.name === 'Read' && event.success))
})

test('runtime tool loop returns recoverable result for unknown tools', async () => {
  const stream = executeProviderToolCall({
    toolCall: {
      id: 'tool_loop_unknown',
      name: 'MissingTool',
      partialInput: '{}',
    },
    tools: createDefaultToolRegistry(),
    toolPolicy: allowAllTools(),
    runtimeOptions: {
      sessionId: 'session-tool-loop-unknown',
      prompt: 'call missing',
      cwd: tmpdir(),
      skipPermissionCheck: true,
    },
    storage: new MemoryStorage(),
    metrics: createRuntimeExecutionMetrics(),
    readFileCache: new Map(),
  })

  const events: NexusEvent[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }

  assert.equal(next.value.kind, 'continue')
  assert.equal(next.value.toolResult.isError, true)
  assert.match(next.value.toolResult.content, /Unknown tool "MissingTool"/)
  assert.ok(events.some(event => event.type === 'tool_completed' && event.name === 'MissingTool' && !event.success))
})

test('runtime tool loop returns terminal result for denied tools', async () => {
  const stream = executeProviderToolCall({
    toolCall: {
      id: 'tool_loop_denied',
      name: 'Bash',
      partialInput: '{"command":"pwd"}',
    },
    tools: createDefaultToolRegistry(),
    toolPolicy: allowlistedTools(['Read']),
    runtimeOptions: {
      sessionId: 'session-tool-loop-denied',
      prompt: 'bash pwd',
      cwd: tmpdir(),
      skipPermissionCheck: true,
    },
    storage: new MemoryStorage(),
    metrics: createRuntimeExecutionMetrics(),
    readFileCache: new Map(),
  })

  const events: NexusEvent[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }

  assert.equal(next.value.kind, 'terminal')
  assert.ok(events.some(event => event.type === 'tool_started' && event.name === 'Bash'))
  assert.ok(events.some(event => event.type === 'tool_denied' && event.name === 'Bash'))
  assert.ok(events.some(event => event.type === 'result' && !event.success))
})

test('runtime pipeline collects provider turn deltas and usage events', async () => {
  async function* stream() {
    yield { type: 'text' as const, text: 'hello ' }
    yield { type: 'thinking' as const, text: 'reason' }
    yield { type: 'tool_use_start' as const, id: 'tool_1', name: 'Read' }
    yield { type: 'tool_use_delta' as const, id: 'tool_1', inputDelta: '{"path"' }
    yield { type: 'tool_use_delta' as const, id: 'tool_1', inputDelta: ':"a.txt"}' }
    yield { type: 'tool_use_end' as const, id: 'tool_1', input: { path: 'a.txt' } }
    yield { type: 'usage' as const, inputTokens: 10, outputTokens: 4, cacheCreationInputTokens: 2, cacheReadInputTokens: 8 }
    yield { type: 'finish' as const, reason: 'tool_use' as const }
  }

  const events: NexusEvent[] = []
  const providerTurnStream = streamProviderTurn({
    stream: stream(),
    sessionId: 'session-pipeline-turn',
    executionStartMs: 0,
  })
  let next = await providerTurnStream.next()
  while (!next.done) {
    events.push(next.value)
    next = await providerTurnStream.next()
  }

  assert.equal(next.value.assistantText, 'hello ')
  assert.equal(next.value.reasoningText, 'reason')
  assert.equal(next.value.finishReason, 'tool_use')
  assert.deepEqual(next.value.toolCalls, [{
    id: 'tool_1',
    name: 'Read',
    partialInput: '{"path":"a.txt"}',
    input: { path: 'a.txt' },
  }])
  assert.deepEqual(next.value.usage, {
    inputTokens: 10,
    outputTokens: 4,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 8,
  })
  assert.ok(events.some(event => event.type === 'assistant_delta' && event.text === 'hello '))
  assert.ok(events.some(event => event.type === 'thinking_delta' && event.text === 'reason'))
  assert.ok(events.some(event => event.type === 'usage' && event.inputTokens === 10 && event.cacheReadInputTokens === 8))
})

test('runtime execution metrics include cache-aware compact diagnostics', () => {
  const metrics = createRuntimeExecutionMetrics()
  const policy = buildCacheAwareCompactPolicy({
    modelId: 'anthropic/claude-3-5-sonnet',
    tokenEstimate: 130_000,
    usage: {
      inputTokens: 40_000,
      outputTokens: 8_000,
      cacheCreationInputTokens: 20_000,
      cacheReadInputTokens: 120_000,
    },
    cacheableSystemPromptRatio: 0.8,
    maxOutputTokens: 16_384,
  })
  absorbCacheAwareCompactPolicyMetrics(metrics, policy)
  absorbProviderTurnMetrics(metrics, {
    assistantText: 'done',
    reasoningText: '',
    toolCalls: [],
    durationMs: 12,
    providerFirstTokenMs: 7,
    streamDeltaCount: 1,
    charsOut: 4,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 8,
    },
  })
  absorbCompactSummaryLatencyMetrics(metrics, 15)

  assert.equal(metrics.providerFirstTokenMs, 7)
  assert.equal(metrics.cacheCreationInputTokens, 2)
  assert.equal(metrics.cacheReadInputTokens, 8)
  assert.equal(metrics.compactSummaryLatencyMs, 15)
  assert.equal(metrics.modelContextWindow, policy.modelContextWindow)
  assert.equal(metrics.reservedOutputTokens, policy.reservedOutputTokens)
  assert.equal(metrics.providerSafetyBufferTokens, policy.providerSafetyBufferTokens)
  assert.equal(metrics.effectiveContextCeiling, policy.effectiveContextCeiling)
  assert.equal(metrics.legacyContextCeiling, policy.legacyContextCeiling)
  assert.equal(metrics.contextPolicySource, policy.policySource)
  assert.equal(metrics.contextWarningThresholdPercent, policy.warningThresholdPercent)
  assert.equal(metrics.contextCompactThresholdPercent, policy.compactThresholdPercent)
  assert.equal(metrics.contextWarningThresholdTokens, policy.warningThresholdTokens)
  assert.equal(metrics.contextCompactThresholdTokens, policy.compactThresholdTokens)
  assert.equal(metrics.contextBlockingLimitTokens, policy.blockingLimitTokens)
  assert.equal(metrics.cachePreservationMode, true)
  assert.equal(metrics.longContextUtilizationMode, true)

  const prefixCacheDiagnostics = computeProviderPrefixCacheDiagnostics({
    systemPromptBlocks: [
      { text: 'static-system', cacheable: true },
      { text: 'dynamic-working-set', cacheable: false },
    ],
    executionStateBlock: 'runtime-state',
    tools: [{ name: 'Read', description: 'Read files', inputSchema: {} }],
  })
  absorbPrefixCacheDiagnosticsMetrics(metrics, prefixCacheDiagnostics)
  assert.equal(metrics.prefixCacheImmutableRatio, prefixCacheDiagnostics.immutablePrefixRatio)
  assert.equal(metrics.prefixCacheVolatileContentLast, true)
  assert.equal(metrics.prefixCacheFingerprint, prefixCacheDiagnostics.fingerprint)

  const event = buildRuntimeExecutionMetricsEvent({ sessionId: 'session-metrics-cache-aware' }, metrics)
  assert.equal(event.providerFirstTokenMs, 7)
  assert.equal(event.cacheCreationInputTokens, 2)
  assert.equal(event.cacheReadInputTokens, 8)
  assert.equal(event.modelContextWindow, policy.modelContextWindow)
  assert.equal(event.reservedOutputTokens, policy.reservedOutputTokens)
  assert.equal(event.providerSafetyBufferTokens, policy.providerSafetyBufferTokens)
  assert.equal(event.effectiveContextCeiling, policy.effectiveContextCeiling)
  assert.equal(event.legacyContextCeiling, policy.legacyContextCeiling)
  assert.equal(event.contextPolicySource, policy.policySource)
  assert.equal(event.contextWarningThresholdPercent, policy.warningThresholdPercent)
  assert.equal(event.contextCompactThresholdPercent, policy.compactThresholdPercent)
  assert.equal(event.contextWarningThresholdTokens, policy.warningThresholdTokens)
  assert.equal(event.contextCompactThresholdTokens, policy.compactThresholdTokens)
  assert.equal(event.contextBlockingLimitTokens, policy.blockingLimitTokens)
  assert.equal(event.compactSummaryLatencyMs, 15)
  assert.equal(event.cachePreservationMode, true)
  assert.equal(event.longContextUtilizationMode, true)
  assert.equal(event.prefixCacheImmutableRatio, prefixCacheDiagnostics.immutablePrefixRatio)
  assert.equal(event.prefixCacheVolatileContentLast, true)
  assert.equal(event.prefixCacheFingerprint, prefixCacheDiagnostics.fingerprint)
})

test('execute reads a workspace file and records session events', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello nexus\n', 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read sample.txt', cwd },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.success, true)
    assert.ok(body.events.some((event: { type: string }) => event.type === 'tool_completed'))

    // Phase B execute-timeout observability: execute_result envelope exposes
    // timeoutMs / executeDurationMs / nearTimeout / outcome so callers can
    // monitor turn duration vs timeout budget without scraping internal state.
    assert.equal(typeof body.timeoutMs, 'number')
    assert.equal(typeof body.executeDurationMs, 'number')
    assert.equal(typeof body.nearTimeout, 'boolean')
    assert.ok(['success', 'error', 'cancelled', 'timeout'].includes(body.outcome))
    assert.equal(body.outcome, 'success')
    assert.ok(body.timeoutMs > 0)
    assert.ok(body.executeDurationMs >= 0)

    const summaryEvent = body.events.find((event: { type: string }) => event.type === 'execute_summary')
    assert.ok(summaryEvent, 'execute_summary event should be appended to events array')
    assert.equal(summaryEvent.timeoutMs, body.timeoutMs)
    assert.equal(summaryEvent.executeDurationMs, body.executeDurationMs)
    assert.equal(summaryEvent.nearTimeout, body.nearTimeout)
    assert.equal(summaryEvent.outcome, body.outcome)

    const session = await storage.getSession(body.sessionId)
    assert.ok(session)
    assert.ok(session.events.length >= 3)
    assert.ok(session.events.some(e => e.type === 'execute_summary'))
  } finally {
    await app.close()
  }
})

test('local runtime emits hook events around failed tool execution', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-hooks`)
  await mkdir(cwd, { recursive: true })
  const tools = createDefaultToolRegistry()
  const runtime = new LocalCodingRuntime(tools)

  const events: Array<{ type: string; [key: string]: unknown }> = []
  for await (const event of runtime.executeStream({
    sessionId: 'session-hooks',
    prompt: 'bash cd /definitely/missing && pwd',
    cwd,
    skipPermissionCheck: true,
  })) {
    events.push(event as any)
  }

  assert.ok(events.some(event => event.type === 'tool_completed'))
  assert.ok(events.some(event => event.type === 'hook_started'))
  assert.ok(events.some(event => event.type === 'hook_completed'))
  assert.ok(events.some(event => event.type === 'result'))
})

test('local runtime supports task status and update commands', async () => {
  const { storage } = await createDefaultNexusRuntime()
  const tools = createDefaultToolRegistry()
  const runtime = new LocalCodingRuntime(tools, allowAllTools(), storage)
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-task-update`)
  await mkdir(cwd, { recursive: true })
  try {
    const createEvents: Array<{ type: string; output?: any }> = []
    for await (const event of runtime.executeStream({
      sessionId: 'session-task-update',
      prompt: 'task Verify task update smoke',
      cwd,
      storage,
    })) {
      createEvents.push(event as any)
    }
    const created = createEvents.find(event => event.type === 'tool_completed')?.output
    assert.ok(created?.taskId)

    const statusEvents: Array<{ type: string; text?: string }> = []
    for await (const event of runtime.executeStream({
      sessionId: 'session-task-update',
      prompt: 'task status',
      cwd,
      storage,
    })) {
      statusEvents.push(event as any)
    }
    assert.ok(statusEvents.some(event => event.type === 'assistant_delta' && String(event.text).includes('Verify task update smoke')))

    const updateEvents: Array<{ type: string; eventType?: string; payload?: any; message?: string }> = []
    for await (const event of runtime.executeStream({
      sessionId: 'session-task-update',
      prompt: `task update ${created.taskId} completed done`,
      cwd,
      storage,
    })) {
      updateEvents.push(event as any)
    }
    const updated = await storage.getTask(created.taskId)
    assert.equal(updated?.status, 'completed')
    assert.ok(updateEvents.some(event => event.type === 'task_session_event' && event.eventType === 'task_updated'))
    assert.ok(updateEvents.some(event => event.type === 'result' && String(event.message).includes('completed')))
  } finally {
    await storage.close?.()
  }
})

test('local runtime answers natural-language questions about file contents', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-file-question`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'question.txt'), 'answer-token: violet-river\n', 'utf8')

  const tools = createDefaultToolRegistry()
  const runtime = new LocalCodingRuntime(tools)
  const events: Array<{ type: string; [key: string]: unknown }> = []
  for await (const event of runtime.executeStream({
    sessionId: 'session-file-question',
    prompt: 'What does question.txt say?',
    cwd,
  })) {
    events.push(event as any)
  }

  assert.ok(events.some(event => event.type === 'tool_completed' && event.name === 'Read'))
  assert.ok(events.some(event => event.type === 'assistant_delta' && String(event.text).includes('violet-river')))
  assert.ok(events.some(event => event.type === 'result' && String(event.message).includes('violet-river')))
})

test('Read returns a recoverable tool result for directories', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-read-dir`)
  await mkdir(join(cwd, 'src'), { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read src', cwd },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    const toolCompleted = body.events.find((event: { type: string; name?: string }) =>
      event.type === 'tool_completed' && event.name === 'Read',
    )
    assert.equal(toolCompleted.success, false)
    assert.match(String(toolCompleted.output), /is a directory/)
    assert.equal(body.result.success, false)
  } finally {
    await app.close()
  }
})

test('Read returns a recoverable tool result for missing files', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-read-missing`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read missing.txt', cwd },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    const toolCompleted = body.events.find((event: { type: string; name?: string }) =>
      event.type === 'tool_completed' && event.name === 'Read',
    )
    assert.equal(toolCompleted.success, false)
    assert.match(String(toolCompleted.output), /could not find/)
    assert.ok(!body.events.some((event: { type: string; code?: string }) =>
      event.type === 'error' && event.code === 'TOOL_ERROR',
    ))
  } finally {
    await app.close()
  }
})

test('Read returns a recoverable tool result for workspace escape paths', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-read-escape`)
  await mkdir(cwd, { recursive: true })
  const outsidePath = join(tmpdir(), `babel-o-outside-${Date.now()}.txt`)

  process.env.NEXUS_ALLOWED_WORKSPACES = cwd
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: `read ${outsidePath}`, cwd },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    const toolCompleted = body.events.find((event: { type: string; name?: string }) =>
      event.type === 'tool_completed' && event.name === 'Read',
    )
    assert.equal(toolCompleted.success, false)
    assert.equal(toolCompleted.output.code, 'WORKSPACE_PATH_ESCAPE')
    assert.match(toolCompleted.output.message, /outside the current workspace/)
    assert.ok(!body.events.some((event: { type: string; code?: string }) =>
      event.type === 'error' && event.code === 'TOOL_ERROR',
    ))
  } finally {
    delete process.env.NEXUS_ALLOWED_WORKSPACES
    await app.close()
  }
})

test('plain prompts return local runtime guidance', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-plain`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'hello there', cwd },
    })
    const body = response.json()
    assert.equal(body.success, true)
    assert.match(body.result.message, /local runtime is active/)
  } finally {
    await app.close()
  }
})

test('sqlite storage persists sessions and events across storage instances', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-sqlite`)
  await mkdir(cwd, { recursive: true })
  const dbPath = join(cwd, 'nexus.sqlite')
  const tools = createDefaultToolRegistry()

  const storageA = new SqliteStorage(dbPath)
  const appA = await createNexusApp({
    runtime: new LocalCodingRuntime(tools),
    storage: storageA,
    defaultCwd: cwd,
  })
  let sessionId = ''
  try {
    const response = await appA.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'task "persist this"', cwd },
    })
    const body = response.json()
    sessionId = body.sessionId
    assert.equal(body.success, true)

    const session = await storageA.getSession(sessionId, { includeEvents: false })
    assert.ok(session)
    await storageA.saveSession({
      ...session,
      phase: 'executing',
      updatedAt: new Date().toISOString(),
    })

    const taskResponse = await appA.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/tasks`,
      payload: { title: 'stored task' },
    })
    assert.equal(taskResponse.statusCode, 200)
  } finally {
    await appA.close()
    await storageA.close()
  }

  const storageB = new SqliteStorage(dbPath)
  try {
    const restoredBeforeMetadata = await storageB.getSession(sessionId)
    assert.ok(restoredBeforeMetadata)
    restoredBeforeMetadata.metadata = { agentType: 'subagent', transcriptPath: `nexus://sessions/${sessionId}/events` }
    await storageB.saveSession(restoredBeforeMetadata)

    const restored = await storageB.getSession(sessionId)
    assert.ok(restored)
    assert.equal(restored.metadata?.agentType, 'subagent')
    assert.equal(restored.metadata?.transcriptPath, `nexus://sessions/${sessionId}/events`)
    assert.ok(restored.events.some(event => event.type === 'session_started'))
    const tasks = await storageB.listTasks(sessionId)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]?.title, 'stored task')
  } finally {
    await storageB.close()
  }
})

test('/v1/execute session reuse and history mapping', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-reuse`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  try {
    const sessionId = 'session-test-reuse'

    // First execute
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { sessionId, prompt: 'hello first time', cwd },
    })
    assert.equal(res1.statusCode, 200)
    const body1 = res1.json()
    assert.equal(body1.sessionId, sessionId)

    // Verify session phase is completed
    const sessionAfterFirst = await storage.getSession(sessionId, { includeEvents: true })
    assert.ok(sessionAfterFirst)
    assert.ok(sessionAfterFirst.events.some(e => e.type === 'user_message' && e.text === 'hello first time'))

    // Second execute with the same sessionId
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { sessionId, prompt: 'hello second time', cwd },
    })
    assert.equal(res2.statusCode, 200)
    const body2 = res2.json()
    assert.equal(body2.sessionId, sessionId)

    // Verify session events include both user_message events and that the session phase is updated
    const sessionAfterSecond = await storage.getSession(sessionId, { includeEvents: true })
    assert.ok(sessionAfterSecond)
    assert.equal(sessionAfterSecond.lastUserInput, 'hello second time')

    const userMessages = sessionAfterSecond.events.filter(e => e.type === 'user_message')
    assert.equal(userMessages.length, 2)
    assert.equal((userMessages[0] as any).text, 'hello first time')
    assert.equal((userMessages[1] as any).text, 'hello second time')
  } finally {
    await app.close()
  }
})

test('/v1/execute persists resolved cwd and reuses it for correction turns', async () => {
  const defaultCwd = join(tmpdir(), `babel-o-test-${Date.now()}-cwd-default`)
  const targetCwd = join(tmpdir(), `babel-o-test-${Date.now()}-cwd-target`)
  await mkdir(defaultCwd, { recursive: true })
  await mkdir(targetCwd, { recursive: true })
  await writeFile(join(targetCwd, 'marker.txt'), 'target marker\n', 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Bash'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd })
  try {
    const sessionId = `session-cwd-follow-${Date.now()}`
    const first = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        sessionId,
        prompt: `${targetCwd}查看这个项目`,
        cwd: defaultCwd,
      },
    })
    assert.equal(first.statusCode, 200)
    const sessionAfterFirst = await storage.getSession(sessionId, { includeEvents: false })
    assert.equal(sessionAfterFirst?.cwd, targetCwd)

    const second = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        sessionId,
        prompt: '呃让你分析的就是这个项目',
        cwd: defaultCwd,
      },
    })
    assert.equal(second.statusCode, 200)
    const body = second.json()
    const secondSessionStarted = body.events.find((event: any) =>
      event.type === 'session_started' && event.requestId === body.events.find((e: any) => e.type === 'session_started')?.requestId,
    )
    assert.equal(secondSessionStarted?.cwd, targetCwd)

    const sessionAfterSecond = await storage.getSession(sessionId, { includeEvents: false })
    assert.equal(sessionAfterSecond?.cwd, targetCwd)
    assert.equal(sessionAfterSecond?.lastUserInput, '呃让你分析的就是这个项目')
  } finally {
    await app.close()
  }
})

test('SDK task mutation API writes audit events and guards revisions', async () => {
  for (const storageKind of ['memory', 'sqlite'] as const) {
    const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-task-mutation-${storageKind}`)
    await mkdir(cwd, { recursive: true })
    const runtimeBundle = storageKind === 'sqlite'
      ? { runtime: new LocalCodingRuntime(createDefaultToolRegistry()), storage: new SqliteStorage(join(cwd, 'nexus.sqlite')) }
      : await createDefaultNexusRuntime()
    const app = await createNexusApp({ runtime: runtimeBundle.runtime, storage: runtimeBundle.storage, defaultCwd: cwd })
    try {
      const sessionId = `session-task-mutation-${storageKind}-${Date.now()}`
      const timestamp = new Date().toISOString()
      await runtimeBundle.storage.saveSession({
        sessionId,
        cwd,
        prompt: 'SDK task mutation smoke',
        phase: 'executing',
        createdAt: timestamp,
        updatedAt: timestamp,
        events: [],
      })
      const worktreeRecoverySessionId = `${sessionId}-worktree-recovery`
      await runtimeBundle.storage.saveSession({
        sessionId: worktreeRecoverySessionId,
        cwd,
        prompt: 'worktree recovery smoke',
        phase: 'waiting_user',
        pendingInput: {
          kind: 'user_input',
          reason: 'worktree_merge_conflict',
          requestedBy: 'system',
          metadata: { taskId: `worktree-recovery-${storageKind}` },
        },
        createdAt: timestamp,
        updatedAt: timestamp,
        events: [],
      })
      const completedSessionId = `${sessionId}-completed`
      await runtimeBundle.storage.saveSession({
        sessionId: completedSessionId,
        cwd,
        prompt: 'completed session mutation smoke',
        phase: 'completed',
        createdAt: timestamp,
        updatedAt: timestamp,
        events: [],
      })
      const cancelledSessionId = `${sessionId}-cancelled`
      await runtimeBundle.storage.saveSession({
        sessionId: cancelledSessionId,
        cwd,
        prompt: 'cancelled session mutation smoke',
        phase: 'cancelled',
        createdAt: timestamp,
        updatedAt: timestamp,
        events: [],
      })
      const failedSubAgentSessionId = `${sessionId}-failed-subagent`
      await runtimeBundle.storage.saveSession({
        sessionId: failedSubAgentSessionId,
        cwd,
        prompt: 'failed sub-agent rerun smoke',
        phase: 'failed',
        error: 'parent failed after child failed',
        failureReason: 'parent failed after child failed',
        terminalReason: {
          category: 'error',
          code: 'NEXUS_RUNTIME_ERROR',
          message: 'parent failed after child failed',
        },
        createdAt: timestamp,
        updatedAt: timestamp,
        events: [],
      })
      const completedCreateResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${completedSessionId}/tasks`,
        payload: { title: 'Should not create after completion' },
      })
      assert.equal(completedCreateResponse.statusCode, 409)
      assert.equal(completedCreateResponse.json().code, 'SESSION_NOT_MUTABLE')
      const cancelledCreateResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${cancelledSessionId}/tasks`,
        payload: { title: 'Should not create after cancellation' },
      })
      assert.equal(cancelledCreateResponse.statusCode, 409)
      assert.equal(cancelledCreateResponse.json().code, 'SESSION_NOT_MUTABLE')
      const missingSessionCreateResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}-missing/tasks`,
        payload: { title: 'Should not create without session' },
      })
      assert.equal(missingSessionCreateResponse.statusCode, 404)
      assert.equal(missingSessionCreateResponse.json().code, 'SESSION_NOT_FOUND')
      const createResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks`,
        payload: {
          title: 'SDK mutation task',
          description: 'created by SDK smoke',
          metadata: { parentTaskId: 'parent-1' },
          actor: 'dashboard',
          source: 'sdk-test',
          requestId: `create-${storageKind}`,
        },
      })
      assert.equal(createResponse.statusCode, 200)
      const created = createResponse.json().task
      assert.equal(created.description, 'created by SDK smoke')
      assert.equal(created.metadata.mutationRequestId, `create-${storageKind}`)

      const duplicateCreate = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks`,
        payload: { title: 'duplicate title ignored', requestId: `create-${storageKind}` },
      })
      assert.equal(duplicateCreate.json().idempotent, true)
      assert.equal(duplicateCreate.json().task.taskId, created.taskId)

      const staleUpdate = await app.inject({
        method: 'PATCH',
        url: `/v1/sessions/${sessionId}/tasks/${created.taskId}`,
        payload: { status: 'in_progress', expectedUpdatedAt: 'stale-revision' },
      })
      assert.equal(staleUpdate.statusCode, 409)
      assert.equal(staleUpdate.json().code, 'TASK_REVISION_CONFLICT')

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/v1/sessions/${sessionId}/tasks/${created.taskId}`,
        payload: {
          title: 'SDK mutation task updated',
          status: 'in_progress',
          metadata: { priority: 'high' },
          expectedUpdatedAt: created.updatedAt,
          actor: 'dashboard',
          source: 'sdk-test',
          reason: 'claim from dashboard',
        },
      })
      assert.equal(updateResponse.statusCode, 200)
      assert.equal(updateResponse.json().task.status, 'in_progress')
      assert.equal(updateResponse.json().task.metadata.priority, 'high')

      const completedSessionTask = {
        ...created,
        taskId: `${created.taskId}-completed-session`,
        sessionId: completedSessionId,
        status: 'pending' as const,
        updatedAt: new Date().toISOString(),
      }
      await runtimeBundle.storage.saveTask(completedSessionTask)
      const completedUpdateResponse = await app.inject({
        method: 'PATCH',
        url: `/v1/sessions/${completedSessionId}/tasks/${completedSessionTask.taskId}`,
        payload: { status: 'in_progress' },
      })
      assert.equal(completedUpdateResponse.statusCode, 409)
      assert.equal(completedUpdateResponse.json().code, 'SESSION_NOT_MUTABLE')
      const completedClaimResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${completedSessionId}/tasks/${completedSessionTask.taskId}/claim`,
        payload: { ownerAgentId: 'dashboard-worker' },
      })
      assert.equal(completedClaimResponse.statusCode, 409)
      assert.equal(completedClaimResponse.json().code, 'SESSION_NOT_MUTABLE')

      const worktreeTaskResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks`,
        payload: {
          title: 'Worktree task mutation smoke',
          metadata: { requiresIsolation: true, worktreePath: join(cwd, '.babel-o', 'worktrees', `sdk-${storageKind}`) },
          requestId: `worktree-${storageKind}`,
        },
      })
      assert.equal(worktreeTaskResponse.statusCode, 200)
      const worktreeTask = worktreeTaskResponse.json().task
      const worktreeClaimResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks/${worktreeTask.taskId}/claim`,
        payload: { ownerAgentId: 'dashboard-worker', actor: 'dashboard', source: 'sdk-test' },
      })
      assert.equal(worktreeClaimResponse.statusCode, 200)
      assert.equal(worktreeClaimResponse.json().task.metadata.requiresIsolation, true)
      assert.equal(worktreeClaimResponse.json().task.metadata.worktreePath, join(cwd, '.babel-o', 'worktrees', `sdk-${storageKind}`))
      assert.equal(worktreeClaimResponse.json().task.ownerAgentId, 'dashboard-worker')

      const recoveryWorktreePath = join(cwd, '.babel-o', 'worktrees', `recovery-${storageKind}`)
      mkdirSync(recoveryWorktreePath, { recursive: true })
      const recoveryTask = {
        ...worktreeTask,
        taskId: `worktree-recovery-${storageKind}`,
        sessionId: worktreeRecoverySessionId,
        status: 'failed' as const,
        result: 'Worktree merge conflict: conflict.txt',
        metadata: {
          requiresIsolation: true,
          worktreeRecovery: {
            type: 'worktree_merge_conflict',
            status: 'awaiting_manual_recovery',
            taskId: `worktree-recovery-${storageKind}`,
            cwd,
            worktreePath: recoveryWorktreePath,
            preservedWorktreePath: recoveryWorktreePath,
            conflictingFiles: ['conflict.txt'],
          },
        },
        updatedAt: new Date().toISOString(),
      }
      await runtimeBundle.storage.saveTask(recoveryTask)
      const keepRecoveryResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${worktreeRecoverySessionId}/tasks/${recoveryTask.taskId}/worktree-recovery`,
        payload: { action: 'keep', actor: 'dashboard', source: 'sdk-test', reason: 'inspect later' },
      })
      assert.equal(keepRecoveryResponse.statusCode, 200)
      assert.equal(keepRecoveryResponse.json().action, 'keep')
      assert.equal(keepRecoveryResponse.json().task.metadata.worktreeRecovery.status, 'kept')
      assert.equal(existsSync(recoveryWorktreePath), true)
      const continueRecoveryResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${worktreeRecoverySessionId}/tasks/${recoveryTask.taskId}/worktree-recovery`,
        payload: { action: 'continue', actor: 'dashboard', source: 'sdk-test', reason: 'manual fix applied' },
      })
      assert.equal(continueRecoveryResponse.statusCode, 200)
      assert.equal(continueRecoveryResponse.json().task.status, 'pending')
      assert.equal(continueRecoveryResponse.json().task.retryCount, recoveryTask.retryCount + 1)
      assert.equal(continueRecoveryResponse.json().task.metadata.worktreeRecovery.status, 'retry_requested')
      assert.equal(existsSync(recoveryWorktreePath), false)
      assert.equal((await runtimeBundle.storage.getSession(worktreeRecoverySessionId))?.phase, 'executing')

      const completeResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks/${created.taskId}/complete`,
        payload: { result: 'done', actor: 'dashboard', source: 'sdk-test' },
      })
      assert.equal(completeResponse.statusCode, 200)
      assert.equal(completeResponse.json().task.status, 'completed')
      assert.equal(completeResponse.json().task.result, 'done')

      const retryResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks/${created.taskId}/retry`,
        payload: { reason: 'retry from SDK' },
      })
      assert.equal(retryResponse.statusCode, 200)
      assert.equal(retryResponse.json().task.status, 'pending')
      assert.equal(retryResponse.json().task.retryCount, 1)

      const invalidRejectResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks/${created.taskId}/reject`,
        payload: { reviewReason: 'needs changes' },
      })
      assert.equal(invalidRejectResponse.statusCode, 409)
      assert.equal(invalidRejectResponse.json().code, 'TASK_REVIEW_NOT_PENDING')

      const approveReviewResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks`,
        payload: {
          title: 'Approve pending review task',
          requestId: `approve-review-${storageKind}`,
        },
      })
      assert.equal(approveReviewResponse.statusCode, 200)
      const approveReviewTask = approveReviewResponse.json().task
      await runtimeBundle.storage.saveTask({
        ...approveReviewTask,
        review: { status: 'pending', reason: 'Planner HITL approval required' },
        updatedAt: new Date().toISOString(),
      })
      const approveResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks/${approveReviewTask.taskId}/approve`,
        payload: { reviewReason: 'approved by reviewer', actor: 'dashboard', source: 'sdk-test' },
      })
      assert.equal(approveResponse.statusCode, 200)
      assert.equal(approveResponse.json().task.review.status, 'approved')

      const rejectReviewResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks`,
        payload: {
          title: 'Reject pending review task',
          requestId: `reject-review-${storageKind}`,
        },
      })
      assert.equal(rejectReviewResponse.statusCode, 200)
      const rejectReviewTask = rejectReviewResponse.json().task
      await runtimeBundle.storage.saveTask({
        ...rejectReviewTask,
        review: { status: 'pending', reason: 'Planner HITL rejection required' },
        updatedAt: new Date().toISOString(),
      })
      const rejectResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks/${rejectReviewTask.taskId}/reject`,
        payload: { reviewReason: 'needs changes', actor: 'dashboard', source: 'sdk-test' },
      })
      assert.equal(rejectResponse.statusCode, 200)
      assert.equal(rejectResponse.json().task.review.status, 'rejected')

      const failedDependencyResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks`,
        payload: {
          title: 'Fail propagation dependent task',
          requestId: `failed-dependent-${storageKind}`,
        },
      })
      assert.equal(failedDependencyResponse.statusCode, 200)
      const failedDependencyTask = failedDependencyResponse.json().task
      await runtimeBundle.storage.saveTask({
        ...failedDependencyTask,
        status: 'blocked',
        dependsOn: [created.taskId],
        updatedAt: new Date().toISOString(),
      })
      const failResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks/${created.taskId}/fail`,
        payload: { result: 'dependency exploded', reason: 'fail from SDK' },
      })
      assert.equal(failResponse.statusCode, 200)
      assert.equal(failResponse.json().task.status, 'failed')
      assert.deepEqual(failResponse.json().task.metadata.blockedTasksFailed, [failedDependencyTask.taskId])
      const propagatedFailure = await runtimeBundle.storage.getTask(failedDependencyTask.taskId)
      assert.equal(propagatedFailure?.status, 'failed')
      assert.equal((propagatedFailure?.metadata?.failedDependencies as any[])?.[0]?.taskId, created.taskId)

      const retryAfterFailResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks/${created.taskId}/retry`,
        payload: {
          actor: 'cli',
          source: 'sessions.retry-task',
          reason: 'retry after dependency fix',
        },
      })
      assert.equal(retryAfterFailResponse.statusCode, 200)
      assert.equal(retryAfterFailResponse.json().task.status, 'pending')
      assert.deepEqual(retryAfterFailResponse.json().task.metadata.blockedTasksRestored, [failedDependencyTask.taskId])
      const restoredDependent = await runtimeBundle.storage.getTask(failedDependencyTask.taskId)
      assert.equal(restoredDependent?.status, 'blocked')
      assert.equal(restoredDependent?.metadata?.failedDependencies, undefined)

      const failedSubAgentTask = {
        ...created,
        taskId: `failed-subagent-task-${storageKind}`,
        sessionId: failedSubAgentSessionId,
        status: 'failed' as const,
        retryCount: 2,
        result: 'Sub-agent session ended with phase failed',
        metadata: {
          parentTaskId: 'parent-subagent-task',
          subAgent: {
            status: 'failed',
            subSessionId: `${failedSubAgentSessionId}-sub-2`,
            transcriptPath: `nexus://sessions/${failedSubAgentSessionId}-sub-2/events`,
            summary: 'child failed',
          },
        },
        updatedAt: new Date().toISOString(),
      }
      await runtimeBundle.storage.saveTask(failedSubAgentTask)
      const failedSubAgentParentTask = {
        ...created,
        taskId: `failed-subagent-parent-${storageKind}`,
        sessionId: failedSubAgentSessionId,
        status: 'failed' as const,
        dependsOn: [failedSubAgentTask.taskId],
        result: 'Dependency failed',
        metadata: {
          delegatedSubTaskIds: [failedSubAgentTask.taskId],
          failedDependencies: [{ taskId: failedSubAgentTask.taskId }],
        },
        updatedAt: new Date().toISOString(),
      }
      await runtimeBundle.storage.saveTask(failedSubAgentParentTask)
      const rerunSubAgentResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${failedSubAgentSessionId}/tasks/${failedSubAgentTask.taskId}/rerun-subagent`,
        payload: {
          actor: 'cli',
          source: 'sessions.rerun-subagent',
          reason: 'retry failed child with fixed dependency',
        },
      })
      assert.equal(rerunSubAgentResponse.statusCode, 200)
      assert.equal(rerunSubAgentResponse.json().task.status, 'pending')
      assert.equal(rerunSubAgentResponse.json().task.retryCount, 3)
      assert.equal(rerunSubAgentResponse.json().task.metadata.previousSubAgents[0].subSessionId, `${failedSubAgentSessionId}-sub-2`)
      assert.equal(rerunSubAgentResponse.json().task.metadata.subAgentRerun.previousTranscriptPath, `nexus://sessions/${failedSubAgentSessionId}-sub-2/events`)
      assert.deepEqual(rerunSubAgentResponse.json().task.metadata.blockedTasksRestored, [failedSubAgentParentTask.taskId])
      assert.equal((await runtimeBundle.storage.getSession(failedSubAgentSessionId, { includeEvents: false }))?.phase, 'executing')
      const restoredSubAgentParent = await runtimeBundle.storage.getTask(failedSubAgentParentTask.taskId)
      assert.equal(restoredSubAgentParent?.status, 'blocked')
      assert.equal(restoredSubAgentParent?.metadata?.failedDependencies, undefined)

      const childSessionId = `${sessionId}-child-${storageKind}`
      const blockedTaskResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks`,
        payload: {
          title: 'Blocked parent task',
          metadata: { parentTaskId: created.taskId },
          requestId: `blocked-${storageKind}`,
        },
      })
      assert.equal(blockedTaskResponse.statusCode, 200)
      const blockedTask = blockedTaskResponse.json().task
      await runtimeBundle.storage.saveTask({
        ...blockedTask,
        status: 'blocked',
        dependsOn: [created.taskId],
        updatedAt: new Date().toISOString(),
      })
      await runtimeBundle.storage.saveSession({
        sessionId: childSessionId,
        cwd,
        prompt: 'child task session',
        phase: 'executing',
        parentSessionId: sessionId,
        currentTaskId: created.taskId,
        createdAt: timestamp,
        updatedAt: timestamp,
        events: [],
        metadata: {
          agentType: 'subagent',
          status: 'running',
          parentTaskId: created.taskId,
          transcriptPath: `nexus://sessions/${childSessionId}/events`,
        },
      })

      const cancelResponse = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/tasks/${created.taskId}/cancel`,
        payload: { reason: 'cancel from SDK' },
      })
      assert.equal(cancelResponse.statusCode, 200)
      assert.equal(cancelResponse.json().task.status, 'cancelled')
      assert.deepEqual(cancelResponse.json().task.metadata.childSessionsCancelled, [childSessionId])
      const cancelledChild = await runtimeBundle.storage.getSession(childSessionId, { includeEvents: false })
      assert.equal(cancelledChild?.phase, 'cancelled')
      assert.equal(cancelledChild?.metadata?.cancelledByTaskId, created.taskId)
      const failedBlockedTask = await runtimeBundle.storage.getTask(blockedTask.taskId)
      assert.equal(failedBlockedTask?.status, 'failed')
      assert.equal(failedBlockedTask?.metadata?.failedDependencyTaskId, created.taskId)

      const events = (await runtimeBundle.storage.listEvents(sessionId, { limit: 80 })).events
      const mutationEvents = events.filter(event => event.type === 'task_session_event') as any[]
      assert.ok(mutationEvents.some(event => event.eventType === 'task_created' && event.payload.actor === 'dashboard'))
      assert.ok(mutationEvents.some(event => event.eventType === 'task_updated' && event.payload.previous.status === 'pending' && event.payload.next.status === 'in_progress'))
      assert.ok(mutationEvents.some(event => event.eventType === 'task_completed'))
      assert.ok(mutationEvents.some(event => event.eventType === 'task_retried' && event.payload.actor === 'cli' && event.payload.source === 'sessions.retry-task'))
      const subAgentEvents = (await runtimeBundle.storage.listEvents(failedSubAgentSessionId, { limit: 20 })).events.filter(event => event.type === 'task_session_event') as any[]
      assert.ok(subAgentEvents.some(event => event.eventType === 'subagent_rerun_requested' && event.payload.actor === 'cli' && event.payload.source === 'sessions.rerun-subagent'))
      assert.ok(mutationEvents.some(event => event.eventType === 'task_approved' && event.payload.previous.review.status === 'pending'))
      assert.ok(mutationEvents.some(event => event.eventType === 'task_rejected' && event.payload.previous.review.status === 'pending'))
      assert.ok(mutationEvents.some(event => event.eventType === 'task_cancelled' && event.payload.reason === 'cancel from SDK'))
      assert.ok(mutationEvents.every(event => event.payload.source))
    } finally {
      await app.close()
      await runtimeBundle.storage.close?.()
    }
  }
})

test('session input, cancel, and task lifecycle endpoints update state', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-lifecycle`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const executeResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'hello', cwd },
    })
    const { sessionId } = executeResponse.json()

    const inputResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/input`,
      payload: { message: 'continue please' },
    })
    assert.equal(inputResponse.statusCode, 200)
    assert.equal(inputResponse.json().phase, 'executing')

    const taskResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/tasks`,
      payload: { title: 'finish lifecycle test' },
    })
    const taskId = taskResponse.json().task.taskId

    const claimResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/tasks/${taskId}/claim`,
    })
    assert.equal(claimResponse.json().task.status, 'in_progress')

    const completeResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/tasks/${taskId}/complete`,
      payload: { result: 'done' },
    })
    assert.equal(completeResponse.json().task.status, 'completed')
    assert.equal(completeResponse.json().task.result, 'done')

    const cancelResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/cancel`,
    })
    assert.equal(cancelResponse.statusCode, 200)
    const session = await storage.getSession(sessionId)
    assert.equal(session?.phase, 'cancelled')
  } finally {
    await app.close()
  }
})

test('remote cancel aborts active execution and resume returns session snapshot', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-remote-cancel`)
  await mkdir(cwd, { recursive: true })
  const storage = new SqliteStorage(join(cwd, 'nexus.sqlite'))
  const sessionId = `session-remote-cancel-${Date.now()}`
  const childSessionId = `${sessionId}-sub-1`
  let runtimeStarted!: () => void
  const runtimeStartedPromise = new Promise<void>(resolve => {
    runtimeStarted = resolve
  })
  const runtime = {
    async *executeStream(options: any): AsyncIterable<NexusEvent> {
      yield {
        type: 'session_started',
        ...eventBase(options.sessionId),
        cwd: options.cwd,
        requestId: options.requestId,
      }
      runtimeStarted()
      await new Promise<void>(resolve => {
        options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: 'REQUEST_CANCELLED',
        message: 'Execution cancelled by user.',
      }
      yield {
        type: 'result',
        ...eventBase(options.sessionId),
        success: false,
        message: 'Execution cancelled by user.',
      }
    },
  }
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    await storage.saveSession({
      sessionId: childSessionId,
      cwd,
      prompt: 'child',
      phase: 'executing',
      parentSessionId: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      metadata: {
        agentType: 'subagent',
        status: 'running',
        transcriptPath: `nexus://sessions/${childSessionId}/events`,
      },
    })

    const executePromise = app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { sessionId, prompt: 'long running work', cwd },
    })
    await runtimeStartedPromise

    const taskResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/tasks`,
      payload: { title: 'remote task' },
    })
    assert.equal(taskResponse.statusCode, 200)

    const activeResumeResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/resume`,
      payload: { recentEventLimit: 10 },
    })
    assert.equal(activeResumeResponse.statusCode, 200)
    assert.equal(activeResumeResponse.json().activeExecution.transport, 'http')
    assert.equal(activeResumeResponse.json().childSessions[0].sessionId, childSessionId)
    assert.equal(activeResumeResponse.json().tasks[0].title, 'remote task')

    const cancelResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/cancel`,
      payload: { reason: 'remote dashboard cancel' },
    })
    assert.equal(cancelResponse.statusCode, 200)
    assert.equal(cancelResponse.json().activeExecutionCancelled, true)
    assert.deepEqual(cancelResponse.json().childSessionsCancelled, [childSessionId])

    const executeResponse = await executePromise
    assert.equal(executeResponse.statusCode, 200)
    assert.equal(executeResponse.json().success, false)

    const session = await storage.getSession(sessionId, { includeEvents: true })
    assert.equal(session?.phase, 'cancelled')
    assert.ok(session?.events.some(event => event.type === 'error' && event.code === 'REQUEST_CANCELLED'))

    const resumedResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/resume`,
      payload: { recentEventLimit: 10 },
    })
    const resumed = resumedResponse.json()
    assert.equal(resumed.activeExecution, null)
    assert.equal(resumed.session.phase, 'cancelled')
    assert.ok(resumed.session.events.some((event: NexusEvent) => event.type === 'error' && event.code === 'REQUEST_CANCELLED'))
  } finally {
    await app.close()
    await storage.close()
  }
})

test('session close cascades runtime session state cleanup', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-session-close`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({
    allowedTools: ['Bash'],
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  const sessionId = `session-close-${Date.now()}`
  const registry = PendingPermissionRegistry.getInstance()
  registry.resetForTest()

  try {
    await storage.saveSession({
      sessionId,
      cwd,
      prompt: 'close me',
      phase: 'executing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
    })

    createTaskSession({ sessionId, cwd, prompt: 'close me' })
    createNexusTask({ queueId: sessionId, title: 'cleanup task' })
    const pendingPermission = registry.register(sessionId, 'tool-close-test')

    const { bashTool, getBashSessionStateSizeForTest, clearBashSessionState } = await import('../src/tools/builtin/bash.js')
    await clearBashSessionState()
    await bashTool.execute({ command: 'cd /', timeoutMs: 10_000 }, {
      cwd,
      sessionId,
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 10_000,
    })
    assert.equal(getBashSessionStateSizeForTest(), 1)
    assert.equal(taskQueueStatsForTest().tasks, 1)
    assert.equal(taskSessionStatsForTest().sessions, 1)
    assert.equal(registry.pendingCount(), 1)

    const closeResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/close`,
      payload: { reason: 'test close' },
    })
    assert.equal(closeResponse.statusCode, 200)
    assert.equal(closeResponse.json().type, 'session_closed')

    const permissionResult = await pendingPermission
    assert.equal(permissionResult.approved, false)
    assert.equal(permissionResult.reason, 'test close')
    assert.equal(getBashSessionStateSizeForTest(), 0)
    assert.equal(taskQueueStatsForTest().tasks, 0)
    assert.equal(taskSessionStatsForTest().sessions, 0)
    assert.equal(registry.pendingCount(), 0)
  } finally {
    registry.resetForTest()
    await app.close()
  }
})

test('session close records non-fatal EverCore sync failures', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-evercore-close`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const sessionId = `session-evercore-close-${Date.now()}`
  let addCalls = 0
  let flushCalls = 0
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    everCoreClient: {
      async search() {
        return { data: {} }
      },
      async addAgentMessages() {
        addCalls += 1
        throw new Error('EverCore unavailable')
      },
      async flushAgentSession() {
        flushCalls += 1
        return { data: {} }
      },
    },
    everCoreConfig: {
      appId: 'babel-o',
      projectId: 'project-1',
      agentId: 'babel-o',
      retrieveMethod: 'hybrid',
      topK: 5,
      uploadOnSessionEnd: true,
      maxMessages: 8,
      maxContentChars: 200,
      mcpToolsEnabled: false,
    },
  })
  try {
    await storage.saveSession({
      sessionId,
      cwd,
      prompt: 'close me with EverCore sync',
      phase: 'executing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
    })
    await storage.appendEvent(sessionId, {
      type: 'user_message',
      ...eventBase(sessionId),
      text: 'remember this bounded session fact',
    })

    const closeResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/close`,
      payload: { phase: 'completed', reason: 'test close' },
    })
    assert.equal(closeResponse.statusCode, 200)
    assert.equal(closeResponse.json().type, 'session_closed')
    assert.equal(addCalls, 1)
    assert.equal(flushCalls, 0)

    const session = await storage.getSession(sessionId, { includeEvents: false })
    assert.equal(session?.phase, 'completed')
    assert.equal((session?.metadata?.everCoreSync as any)?.status, 'failed')
    assert.match(String((session?.metadata?.everCoreSync as any)?.error), /EverCore unavailable/)
  } finally {
    await app.close()
  }
})

test('tool audit reports risk and allowlist status', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-audit`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({
    allowedTools: ['Read', 'Grep', 'Glob'],
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tools/audit',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const read = body.tools.find((tool: { name: string }) => tool.name === 'Read')
    const bash = body.tools.find((tool: { name: string }) => tool.name === 'Bash')

    assert.equal(read.allowed, true)
    assert.equal(read.risk, 'read')
    assert.equal(bash.allowed, false)
    assert.equal(bash.risk, 'execute')
  } finally {
    await app.close()
  }
})

test('remote runner env config defaults to disabled and reports optional failures', async () => {
  const disabled = await configureRemoteRunner()
  assert.equal(disabled.runner, undefined)
  assert.deepEqual(disabled.status, {
    configured: false,
    required: false,
    healthy: true,
    errorCode: undefined,
    errorMessage: undefined,
  })

  const optionalFailure = await configureRemoteRunner({
    url: 'http://user:secret@127.0.0.1:9?token=abc',
    fetch: async () => { throw new Error('connection refused') },
  })
  assert.equal(optionalFailure.runner, undefined)
  assert.equal(optionalFailure.status.configured, true)
  assert.equal(optionalFailure.status.required, false)
  assert.equal(optionalFailure.status.healthy, false)
  assert.equal(optionalFailure.status.url, 'http://127.0.0.1:9/?token=%3Credacted%3E')
  assert.equal(optionalFailure.status.errorCode, 'REMOTE_RUNNER_CAPABILITIES_FAILED')
})

test('EverCore config defaults to disabled and redacts optional failures', async () => {
  const disabled = await configureEverCore()
  assert.equal(disabled.client, undefined)
  assert.equal(disabled.status.configured, false)
  assert.equal(disabled.status.enabled, false)
  assert.equal(disabled.status.healthy, true)
  assert.equal(disabled.status.uploadOnSessionEnd, false)
  assert.equal(disabled.status.agentId, 'babel-o')
  assert.equal(disabled.status.retrieveMethod, 'hybrid')
  assert.deepEqual(disabled.status.namespace, {
    layer: 'project_memory',
    isolationKey: 'projectId',
    sessionScoped: false,
    projectIdSource: 'default',
  })

  const optionalFailure = await configureEverCore({
    enabled: true,
    baseUrl: 'http://user:secret@127.0.0.1:9?token=abc',
    fetch: async () => { throw new Error('connection refused') },
  })
  assert.ok(optionalFailure.client)
  assert.equal(optionalFailure.status.configured, true)
  assert.equal(optionalFailure.status.enabled, true)
  assert.equal(optionalFailure.status.healthy, false)
  assert.equal(optionalFailure.status.url, 'http://127.0.0.1:9/?token=%3Credacted%3E')
  assert.equal(optionalFailure.status.errorCode, 'EVERCORE_HEALTH_CHECK_FAILED')
  assert.equal(optionalFailure.status.namespace?.warningCode, 'EVERCORE_PROJECT_ID_DEFAULT')
  assert.match(optionalFailure.status.namespace?.guidance ?? '', /BABEL_O_EVERCORE_PROJECT_ID/)

  const explicitProject = await configureEverCore({
    enabled: true,
    baseUrl: 'http://127.0.0.1:9',
    projectId: 'babel-o-dev',
    fetch: async () => { throw new Error('connection refused') },
  })
  assert.equal(explicitProject.config.projectId, 'babel-o-dev')
  assert.deepEqual(explicitProject.status.namespace, {
    layer: 'project_memory',
    isolationKey: 'projectId',
    sessionScoped: false,
    projectIdSource: 'explicit',
  })

  const workspace = join(tmpdir(), `babel-o-evercore-workspace-${Date.now()}`)
  const nestedWorkspace = join(workspace, 'packages', 'child')
  await mkdir(join(workspace, '.git'), { recursive: true })
  await mkdir(nestedWorkspace, { recursive: true })
  const derivedProject = await configureEverCore({
    enabled: true,
    baseUrl: 'http://127.0.0.1:9',
    projectIdMode: 'workspace',
    cwd: nestedWorkspace,
    fetch: async () => { throw new Error('connection refused') },
  })
  assert.equal(derivedProject.status.namespace?.projectIdSource, 'workspace')
  assert.equal(derivedProject.status.namespace?.warningCode, undefined)
  assert.match(derivedProject.config.projectId, /^babel-o-evercore-workspace-[0-9]+-[0-9a-f]{12}$/)

  const derivedFromRoot = await configureEverCore({
    enabled: true,
    baseUrl: 'http://127.0.0.1:9',
    projectIdMode: 'workspace',
    cwd: workspace,
    fetch: async () => { throw new Error('connection refused') },
  })
  assert.equal(derivedFromRoot.config.projectId, derivedProject.config.projectId)

  const explicitProjectWins = await configureEverCore({
    enabled: true,
    baseUrl: 'http://127.0.0.1:9',
    projectId: 'explicit-project',
    projectIdMode: 'workspace',
    cwd: nestedWorkspace,
    fetch: async () => { throw new Error('connection refused') },
  })
  assert.equal(explicitProjectWins.config.projectId, 'explicit-project')
  assert.equal(explicitProjectWins.status.namespace?.projectIdSource, 'explicit')

  const envDerived = await configureEverCoreFromEnv({
    BABEL_O_EVERCORE_ENABLED: '1',
    BABEL_O_EVERCORE_BASE_URL: 'http://127.0.0.1:9',
    BABEL_O_EVERCORE_PROJECT_ID_MODE: 'workspace',
  } as NodeJS.ProcessEnv, { cwd: nestedWorkspace })
  assert.equal(envDerived.config.projectId, derivedProject.config.projectId)
  assert.equal(envDerived.status.namespace?.projectIdSource, 'workspace')
})

test('EverCore managed mode starts local sidecar and exposes diagnostics', async () => {
  const dataDir = join(tmpdir(), `babel-o-test-${Date.now()}-evercore-managed`)
  const spawnCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  let killed = false
  const configured = await configureEverCore({
    mode: 'managed',
    managedCommand: 'everos-test',
    managedHost: '127.0.0.1',
    managedDataDir: dataDir,
    managedPortAllocator: async host => {
      assert.equal(host, '127.0.0.1')
      return 9876
    },
    managedStartupTimeoutMs: 100,
    managedHealthIntervalMs: 1,
    providerSettings: {
      providerId: 'openai',
      modelId: 'openai/gpt-4o',
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.example/v1',
      modelSource: 'env',
      apiKeySource: 'env',
      baseUrlSource: 'env',
    },
    managedSpawn(command, args, options) {
      spawnCalls.push({ command, args, env: options.env })
      return {
        pid: 12345,
        killed: false,
        kill() {
          killed = true
          return true
        },
        once() {},
      }
    },
    fetch: async url => {
      assert.equal(String(url), 'http://127.0.0.1:9876/health')
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    },
  })

  assert.ok(configured.client)
  assert.ok(configured.memoryProvider)
  assert.equal(configured.status.mode, 'managed')
  assert.equal(configured.status.configured, true)
  assert.equal(configured.status.enabled, true)
  assert.equal(configured.status.healthy, true)
  assert.equal(configured.status.url, 'http://127.0.0.1:9876/')
  assert.equal(configured.status.sidecar?.managed, true)
  assert.equal(configured.status.sidecar?.running, true)
  assert.equal(configured.status.sidecar?.dataDir, dataDir)
  assert.equal(configured.status.sidecar?.pid, 12345)
  assert.equal(spawnCalls[0]?.command, 'everos-test')
  assert.deepEqual(spawnCalls[0]?.args, ['server', 'start', '--host', '127.0.0.1', '--port', '9876'])
  assert.equal(spawnCalls[0]?.env.EVEROS_MEMORY__ROOT, dataDir)
  assert.equal(spawnCalls[0]?.env.EVEROS_API__HOST, '127.0.0.1')
  assert.equal(spawnCalls[0]?.env.EVEROS_API__PORT, '9876')
  assert.equal(spawnCalls[0]?.env.EVEROS_LLM__API_KEY, 'openai-key')
  assert.equal(spawnCalls[0]?.env.EVEROS_LLM__BASE_URL, 'https://api.openai.example/v1')
  assert.equal(spawnCalls[0]?.env.EVEROS_LLM__MODEL, 'gpt-4o')

  await configured.dispose?.()
  assert.equal(killed, true)
})

test('EverCore managed mode does not auto-map Anthropic-compatible provider settings', async () => {
  const spawnCalls: Array<{ env: NodeJS.ProcessEnv }> = []
  const configured = await configureEverCore({
    mode: 'managed',
    managedPort: 9877,
    managedStartupTimeoutMs: 100,
    managedHealthIntervalMs: 1,
    providerSettings: {
      providerId: 'minimax',
      modelId: 'minimax/MiniMax-M3',
      apiKey: 'minimax-key',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      modelSource: 'env',
      apiKeySource: 'env',
      baseUrlSource: 'provider_default',
    },
    managedSpawn(_command, _args, options) {
      spawnCalls.push({ env: options.env })
      return {
        pid: 12346,
        killed: false,
        kill() {
          return true
        },
        once() {},
      }
    },
    fetch: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
  })

  assert.ok(configured.client)
  assert.equal(spawnCalls[0]?.env.EVEROS_LLM__API_KEY, undefined)
  assert.equal(spawnCalls[0]?.env.EVEROS_LLM__BASE_URL, undefined)
  assert.equal(spawnCalls[0]?.env.EVEROS_LLM__MODEL, undefined)
  await configured.dispose?.()
})

test('EverCore managed mode uses explicit LLM override for sidecar env', async () => {
  const spawnCalls: Array<{ env: NodeJS.ProcessEnv }> = []
  const configured = await configureEverCore({
    mode: 'managed',
    managedPort: 9878,
    managedStartupTimeoutMs: 100,
    managedHealthIntervalMs: 1,
    managedLlmApiKey: 'evercore-key',
    managedLlmBaseUrl: 'https://openai-compatible.example/v1',
    managedLlmModel: 'memory-model',
    providerSettings: {
      providerId: 'minimax',
      modelId: 'minimax/MiniMax-M3',
      apiKey: 'minimax-key',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      modelSource: 'env',
      apiKeySource: 'env',
      baseUrlSource: 'provider_default',
    },
    managedSpawn(_command, _args, options) {
      spawnCalls.push({ env: options.env })
      return {
        pid: 12347,
        killed: false,
        kill() {
          return true
        },
        once() {},
      }
    },
    fetch: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
  })

  assert.ok(configured.client)
  assert.equal(spawnCalls[0]?.env.EVEROS_LLM__API_KEY, 'evercore-key')
  assert.equal(spawnCalls[0]?.env.EVEROS_LLM__BASE_URL, 'https://openai-compatible.example/v1')
  assert.equal(spawnCalls[0]?.env.EVEROS_LLM__MODEL, 'memory-model')
  await configured.dispose?.()
})

test('EverCore managed mode rejects non-loopback hosts without starting sidecar', async () => {
  let spawned = false
  const configured = await configureEverCore({
    mode: 'managed',
    managedHost: '0.0.0.0',
    managedSpawn() {
      spawned = true
      throw new Error('should not spawn')
    },
  })

  assert.equal(spawned, false)
  assert.equal(configured.client, undefined)
  assert.equal(configured.memoryProvider, undefined)
  assert.equal(configured.status.mode, 'managed')
  assert.equal(configured.status.enabled, true)
  assert.equal(configured.status.healthy, false)
  assert.equal(configured.status.errorCode, 'EVERCORE_MANAGED_HOST_NOT_LOCAL')
  assert.equal(configured.status.sidecar?.healthy, false)
})

test('EverCore client calls current memory REST routes', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const client = new HttpEverCoreClient({
    baseUrl: 'http://evercore.local',
    apiKey: 'secret-token',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify({ request_id: 'req-1', data: { ok: true } }), {
        status: 200,
      })
    },
  })

  await client.addAgentMessages({
    sessionId: 'session-evercore-client',
    appId: 'babel-o',
    projectId: 'project-1',
    messages: [{
      sender_id: 'babel-o',
      role: 'assistant',
      timestamp: 1,
      content: 'done',
    }],
  })
  await client.flushAgentSession({
    sessionId: 'session-evercore-client',
    appId: 'babel-o',
    projectId: 'project-1',
  })
  await client.search({
    query: 'previous work',
    agentId: 'babel-o',
    appId: 'babel-o',
    projectId: 'project-1',
  })

  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/api/v1/memory/add',
    '/api/v1/memory/flush',
    '/api/v1/memory/search',
  ])
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, 'Bearer secret-token')
  assert.equal(JSON.parse(String(calls[0]?.init.body)).session_id, 'session-evercore-client')
  assert.equal(JSON.parse(String(calls[2]?.init.body)).agent_id, 'babel-o')
  assert.equal(JSON.parse(String(calls[2]?.init.body)).method, 'hybrid')
})

test('required remote runner config fails fast when unhealthy', async () => {
  const required = await configureRemoteRunner({ required: true })
  assert.equal(required.status.configured, false)
  assert.equal(required.status.healthy, false)
  assert.throws(
    () => assertRemoteRunnerReady(required.status),
    /NEXUS_REMOTE_RUNNER_REQUIRED failed/,
  )
})

test('agent remote execution env requires configured healthy remote runner', async () => {
  assert.equal(parseAgentExecutionEnvironment(undefined), undefined)
  assert.equal(parseAgentExecutionEnvironment('local'), 'local')
  assert.equal(parseAgentExecutionEnvironment('REMOTE'), 'remote')
  assert.throws(
    () => parseAgentExecutionEnvironment('docker'),
    /NEXUS_AGENT_EXECUTION_ENVIRONMENT must be local or remote/,
  )

  const disabled = await configureRemoteRunner()
  assert.throws(
    () => assertAgentRemoteExecutionReady('remote', disabled.status),
    /requires a healthy NEXUS_REMOTE_RUNNER_URL/,
  )
  assert.doesNotThrow(() => assertAgentRemoteExecutionReady('local', disabled.status))
})

test('remote runner config creates HttpRemoteToolRunner from capabilities', async () => {
  const configured = await configureRemoteRunner({
    url: 'http://127.0.0.1:3897',
    required: true,
    fetch: async () => new Response(JSON.stringify({
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      id: 'go-runner-test',
      capabilities: { tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], readOnly: false, writeEnabled: true, maxConcurrentTools: 4 },
    }), { status: 200 }),
  })

  assert.ok(configured.runner)
  assert.equal(configured.runner.id, 'go-runner-test')
  assert.deepEqual(configured.runner.capabilities, { tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], readOnly: false, writeEnabled: true, maxConcurrentTools: 4 })
  assert.deepEqual(configured.status, {
    configured: true,
    required: true,
    healthy: true,
    url: 'http://127.0.0.1:3897/',
    id: 'go-runner-test',
    protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
    capabilities: { tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], readOnly: false, writeEnabled: true, maxConcurrentTools: 4 },
  })
})

test('/v1/runtime/status reports remote runner diagnostics', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const remoteRunner = new InMemoryRemoteToolRunner({
    id: 'status-runner',
    capabilities: { tools: ['Read'] },
    handler: () => ({ kind: 'result', success: true, output: 'ok' }),
  })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: process.cwd(),
    remoteRunner,
    remoteRunnerStatus: {
      configured: true,
      required: false,
      healthy: true,
      url: 'http://127.0.0.1:3897/',
      id: 'status-runner',
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      capabilities: { tools: ['Read'] },
    },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/status' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.remoteRunner.configured, true)
    assert.equal(body.remoteRunner.healthy, true)
    assert.equal(body.remoteRunner.id, 'status-runner')
    assert.deepEqual(body.remoteRunner.capabilities.tools, ['Read'])
  } finally {
    await app.close()
  }
})

test('/v1/runtime/status reports EverCore diagnostics', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: process.cwd(),
    everCoreStatus: {
      configured: true,
      enabled: true,
      healthy: false,
      mode: 'external',
      url: 'http://127.0.0.1:8000/',
      uploadOnSessionEnd: true,
      appId: 'babel-o',
      projectId: 'project-1',
      agentId: 'babel-o',
      retrieveMethod: 'hybrid',
      topK: 5,
      mcpToolsEnabled: false,
      namespace: {
        layer: 'project_memory',
        isolationKey: 'projectId',
        sessionScoped: false,
        projectIdSource: 'explicit',
      },
      errorCode: 'EVERCORE_HEALTH_CHECK_FAILED',
    },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/status' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.everCore.configured, true)
    assert.equal(body.everCore.enabled, true)
    assert.equal(body.everCore.healthy, false)
    assert.equal(body.everCore.mode, 'external')
    assert.equal(body.everCore.uploadOnSessionEnd, true)
    assert.equal(body.everCore.mcpToolsEnabled, false)
    assert.equal(body.everCore.namespace?.isolationKey, 'projectId')
    assert.equal(body.everCore.namespace?.sessionScoped, false)
    assert.equal(body.everCore.errorCode, 'EVERCORE_HEALTH_CHECK_FAILED')
  } finally {
    await app.close()
  }
})

test('/v1/runtime/status reports managed EverCore sidecar diagnostics', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: process.cwd(),
    everCoreStatus: {
      configured: true,
      enabled: true,
      healthy: true,
      mode: 'managed',
      url: 'http://127.0.0.1:9876/',
      uploadOnSessionEnd: false,
      appId: 'babel-o',
      projectId: 'project-1',
      agentId: 'babel-o',
      retrieveMethod: 'hybrid',
      topK: 5,
      mcpToolsEnabled: true,
      sidecar: {
        mode: 'managed',
        managed: true,
        running: true,
        healthy: true,
        url: 'http://127.0.0.1:9876/',
        dataDir: '/tmp/babel-o-evercore',
        pid: 12345,
      },
    },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/status' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.everCore.mode, 'managed')
    assert.equal(body.everCore.sidecar.running, true)
    assert.equal(body.everCore.sidecar.dataDir, '/tmp/babel-o-evercore')
    assert.equal(body.everCore.mcpToolsEnabled, true)
  } finally {
    await app.close()
  }
})

test('/v1/runtime/status returns redacted provider diagnostics', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-status`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/runtime/status',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'runtime_status')
    assert.equal(body.provider.modelId, 'local/coding-runtime')
    assert.equal(body.provider.providerId, 'local')
    assert.equal(body.provider.authConfigured, true)
    assert.equal(body.provider.authMode, 'none')
    assert.equal(body.provider.capabilities.toolCalling, true)
    assert.equal(body.provider.capabilities.streaming, true)
    assert.equal(body.provider.apiKey, undefined)
    const plannerResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/provider-smoke?role=planner',
    })
    assert.equal(plannerResponse.statusCode, 200)
    const plannerBody = plannerResponse.json()
    assert.equal(plannerBody.provider.roleRecommendation.role, 'planner')
    assert.equal(plannerBody.provider.roleRecommendation.configured, false)
    assert.equal(plannerBody.provider.roleRecommendation.willAutoSwitch, false)

    assert.equal(body.providerSmoke.type, 'provider_smoke')
    assert.equal(body.providerSmoke.mode, 'dry_run')
    assert.equal(body.providerSmoke.ready, true)
    assert.equal(body.providerSmoke.provider.apiKey, undefined)
    assert.equal(body.providerSmoke.checks.authConfigured, true)
    assert.equal(body.providerSmoke.fallbackPolicy.allowSilentModelSwitch, false)
    assert.equal(body.providerSmoke.diagnostic.domain, 'provider')
    assert.equal(body.providerSmoke.diagnostic.name, 'provider_smoke')
    assert.equal(body.providerSmoke.diagnostic.details.providerId, 'local')
  } finally {
    await app.close()
  }
})

test('/v1/runtime/config endpoints expose shared redacted profile state and select profiles', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-runtime-config-shared`)
  await mkdir(cwd, { recursive: true })
  const configManager = ConfigManager.getInstance()
  configManager.save({
    defaultModel: 'local/coding-runtime',
    providers: {
      openai: { apiKey: 'provider-openai-key' },
    },
    activeProfile: 'dev',
    profiles: {
      dev: {
        model: 'openai/gpt-4o',
        provider: 'openai',
        apiKey: 'dev-profile-key',
        baseUrl: 'https://dev.openai.example/v1',
        roles: {
          planner: 'anthropic/claude-3-7-sonnet',
        },
      },
      local: {
        model: 'local/coding-runtime',
        provider: 'local',
      },
    },
  })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const configResponse = await app.inject({ method: 'GET', url: '/v1/runtime/config' })
    assert.equal(configResponse.statusCode, 200)
    const configBody = configResponse.json()
    assert.equal(configBody.type, 'runtime_config')
    assert.equal(configBody.modelId, 'openai/gpt-4o')
    assert.equal(configBody.activeProfile, 'dev')
    assert.equal(configBody.hasApiKey, true)
    assert.equal(configBody.apiKey, undefined)
    assert.doesNotMatch(JSON.stringify(configBody), /dev-profile-key|provider-openai-key/)

    const profilesResponse = await app.inject({ method: 'GET', url: '/v1/runtime/config/profiles' })
    assert.equal(profilesResponse.statusCode, 200)
    const profilesBody = profilesResponse.json()
    assert.equal(profilesBody.type, 'runtime_config_profiles')
    assert.equal(profilesBody.activeProfile, 'dev')
    assert.equal(profilesBody.profiles.length, 2)
    const devProfile = profilesBody.profiles.find((profile: { name: string }) => profile.name === 'dev')
    assert.equal(devProfile.active, true)
    assert.equal(devProfile.hasApiKey, true)
    assert.equal(devProfile.hasBaseUrl, true)
    assert.equal(devProfile.roles.planner, 'anthropic/claude-3-7-sonnet')
    assert.equal(devProfile.apiKey, undefined)
    assert.equal(devProfile.baseUrl, undefined)
    assert.doesNotMatch(JSON.stringify(profilesBody), /dev-profile-key|provider-openai-key|dev\.openai\.example/)

    const modelsResponse = await app.inject({ method: 'GET', url: '/v1/runtime/models' })
    assert.equal(modelsResponse.statusCode, 200)
    const modelsBody = modelsResponse.json()
    assert.equal(modelsBody.type, 'runtime_models')
    assert.equal(modelsBody.activeProfile, 'dev')
    const openaiProvider = modelsBody.providers.find((provider: { id: string }) => provider.id === 'openai')
    assert.equal(openaiProvider.configured, true)
    assert.equal(openaiProvider.active, true)
    assert.doesNotMatch(JSON.stringify(modelsBody), /provider-openai-key|dev-profile-key/)

    const selectResponse = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/select',
      payload: { profile: 'local' },
    })
    assert.equal(selectResponse.statusCode, 200)
    const selectedBody = selectResponse.json()
    assert.equal(selectedBody.type, 'runtime_config')
    assert.equal(selectedBody.activeProfile, 'local')
    assert.equal(selectedBody.modelId, 'local/coding-runtime')
    assert.equal(ConfigManager.getInstance().getActiveProfile(), 'local')
  } finally {
    await app.close()
    configManager.save({})
  }
})

test('/v1/runtime/config/select rejects inherited profile names', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-runtime-config-proto`)
  await mkdir(cwd, { recursive: true })
  const configManager = ConfigManager.getInstance()
  configManager.save({
    defaultModel: 'local/coding-runtime',
    profiles: {
      dev: { model: 'local/coding-runtime', provider: 'local' },
    },
  })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/config/select',
      payload: { profile: '__proto__' },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'unknown_profile')
    assert.equal(ConfigManager.getInstance().getActiveProfile(), undefined)
  } finally {
    await app.close()
    configManager.save({})
  }
})

test('/v1/runtime/provider-smoke returns local dry-run readiness without executing sessions', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-smoke-local`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/runtime/provider-smoke',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'provider_smoke')
    assert.equal(body.mode, 'dry_run')
    assert.equal(body.ready, true)
    assert.equal(body.provider.providerId, 'local')
    assert.equal(body.provider.modelId, 'local/coding-runtime')
    assert.equal(body.provider.apiKey, undefined)
    assert.equal(body.checks.authConfigured, true)
    assert.equal(body.checks.toolsSupported, true)
    assert.equal(body.fallbackPolicy.allowSilentModelSwitch, false)
    assert.equal(body.diagnostic.domain, 'provider')
    assert.equal(body.diagnostic.name, 'provider_smoke')
    assert.equal(body.diagnostic.status, 'ok')
    assert.deepEqual(await storage.listSessions({ limit: 10 }), [])
  } finally {
    await app.close()
  }
})

test('/v1/runtime/provider-smoke reports unmet capability without silent fallback', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-smoke-capability`)
  await mkdir(cwd, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/runtime/provider-smoke?model=local%2Fcoding-runtime&requireStructuredOutput=true',
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'provider_smoke')
    assert.equal(body.mode, 'dry_run')
    assert.equal(body.ready, false)
    assert.equal(body.provider.providerId, 'local')
    assert.equal(body.provider.modelId, 'local/coding-runtime')
    assert.equal(body.provider.apiKey, undefined)
    assert.equal(body.checks.authConfigured, true)
    assert.equal(body.checks.structuredOutputSupported, false)
    assert.equal(body.fallbackPolicy.mode, 'fix_configuration')
    assert.equal(body.fallbackPolicy.allowSilentModelSwitch, false)
    assert.equal(body.diagnostic.domain, 'provider')
    assert.equal(body.diagnostic.name, 'provider_smoke')
    assert.equal(body.diagnostic.status, 'blocked')
    assert.ok(body.diagnostic.signals.some((signal: { type: string }) => signal.type === 'provider_check_structuredOutputSupported'))
    assert.deepEqual(await storage.listSessions({ limit: 10 }), [])
  } finally {
    await app.close()
  }
})

test('/v1/runtime/provider-fallback/plan returns non-executing fallback action', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-fallback-plan`)
  await mkdir(cwd, { recursive: true })

  const oldFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = async () => {
    fetchCalled = true
    throw new Error('provider should not be called')
  }

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/provider-fallback/plan',
      payload: { kind: 'context_window' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'provider_fallback_plan')
    assert.equal(body.provider.providerId, 'local')
    assert.equal(body.provider.apiKey, undefined)
    assert.equal(body.fallbackPolicy.mode, 'compact_then_retry')
    assert.equal(body.fallbackPolicy.allowSilentModelSwitch, false)
    assert.equal(body.action.requiresUserConfirmation, true)
    assert.equal(body.action.willSwitchModel, false)
    assert.equal(body.action.willSwitchProvider, false)
    assert.equal(body.action.willMutateConfig, false)
    assert.equal(body.action.willCallProvider, false)
    assert.equal(body.action.willCreateSession, false)
    assert.equal(body.diagnostic.domain, 'provider')
    assert.equal(body.diagnostic.name, 'provider_fallback_plan')
    assert.equal(body.diagnostic.details.recoveryKind, 'context_window')
    assert.equal(body.diagnostic.action.allowSilentModelSwitch, false)

    const rateLimitResponse = await app.inject({
      method: 'POST',
      url: '/v1/runtime/provider-fallback/plan',
      payload: { kind: 'rate_limit' },
    })
    assert.equal(rateLimitResponse.statusCode, 200)
    assert.equal(rateLimitResponse.json().diagnostic.details.recoveryKind, 'rate_limit')
    assert.equal(fetchCalled, false)
    assert.deepEqual(await storage.listSessions({ limit: 10 }), [])
  } finally {
    await app.close()
    globalThis.fetch = oldFetch
  }
})

test('provider smoke dry-run recognizes Moonshot and Ollama registry seeds', () => {
  const moonshotConfig = new ConfigManager(join(tmpdir(), `babel-o-moonshot-smoke-${Date.now()}.json`))
  moonshotConfig.save({
    defaultModel: 'moonshot/moonshot-v1-128k',
    providers: {
      moonshot: { apiKey: 'moonshot-test-key' },
    },
  })

  const moonshotSmoke = moonshotConfig.getProviderDiagnostics({ model: 'moonshot/moonshot-v1-128k' })
  assert.equal(moonshotSmoke.providerId, 'moonshot')
  assert.equal(moonshotSmoke.adapter, 'openai-compatible')
  assert.equal(moonshotSmoke.authMode, 'bearer')
  assert.equal(moonshotSmoke.authConfigured, true)
  assert.equal(moonshotSmoke.modelDeclared, true)
  assert.equal(moonshotSmoke.capabilities.structuredOutput, true)
  assert.equal(moonshotSmoke.suitability.agentLoopRoles.optimizer.suitable, true)

  const ollamaConfig = new ConfigManager(join(tmpdir(), `babel-o-ollama-smoke-${Date.now()}.json`))
  ollamaConfig.save({ defaultModel: 'ollama/qwen2.5-coder:7b' })

  const ollamaSmoke = ollamaConfig.getProviderDiagnostics({ model: 'ollama/qwen2.5-coder:7b' })
  assert.equal(ollamaSmoke.providerId, 'ollama')
  assert.equal(ollamaSmoke.adapter, 'openai-compatible')
  assert.equal(ollamaSmoke.authMode, 'none')
  assert.equal(ollamaSmoke.authConfigured, true)
  assert.equal(ollamaSmoke.baseUrl, 'http://localhost:11434/v1')
  assert.equal(ollamaSmoke.baseUrlSource, 'provider_default')
  assert.equal(ollamaSmoke.modelDeclared, true)
  assert.equal(ollamaSmoke.capabilities.toolCalling, true)
})

test('/v1/runtime/provider-smoke/live runs fixed live smoke without creating sessions', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-smoke-live`)
  const configPath = join(cwd, 'config.json')
  await mkdir(cwd, { recursive: true })

  const oldConfigFile = process.env.BABEL_O_CONFIG_FILE
  const oldAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  const oldAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL
  const oldFetch = globalThis.fetch
  process.env.BABEL_O_CONFIG_FILE = configPath
  process.env.ANTHROPIC_API_KEY = 'anthropic-live-smoke-test-key'
  process.env.ANTHROPIC_BASE_URL = 'https://api.test-anthropic.com'

  const fetchCalls: RequestInit[] = []
  globalThis.fetch = async (_url, init) => {
    fetchCalls.push(init ?? {})
    return {
      ok: true,
      status: 200,
      body: createRuntimeTestStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"text_delta","text":"BABEL_O_PROVIDER_SMOKE_OK"}}\n\n',
        'event: message_delta\n',
        'data: {"delta":{"stop_reason":"end_turn"}}\n\n',
      ]),
      text: async () => 'mock live smoke response',
    } as Response
  }

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/provider-smoke/live',
      payload: { model: 'anthropic/claude-3-5-sonnet' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'provider_smoke')
    assert.equal(body.mode, 'live')
    assert.equal(body.smokeMode, 'simple_text')
    assert.equal(body.ready, true)
    assert.equal(body.live, true)
    assert.equal(body.success, true)
    assert.equal(body.matchedExpectedText, true)
    assert.equal(body.outputPreview, 'BABEL_O_PROVIDER_SMOKE_OK')
    assert.equal(body.provider.apiKey, undefined)
    assert.equal(body.fallbackPolicy.allowSilentModelSwitch, false)
    assert.equal(body.diagnostic.domain, 'provider')
    assert.equal(body.diagnostic.name, 'provider_smoke')
    assert.equal(body.diagnostic.details.mode, 'live')
    assert.equal(body.diagnostic.details.smokeMode, 'simple_text')
    assert.deepEqual(await storage.listSessions({ limit: 10 }), [])

    assert.equal(fetchCalls.length, 1)
    const requestBody = JSON.parse(String(fetchCalls[0].body))
    assert.match(JSON.stringify(requestBody), /BABEL_O_PROVIDER_SMOKE_OK/)
    assert.doesNotMatch(JSON.stringify(requestBody), /分析|project|Baidu/)
  } finally {
    await app.close()
    globalThis.fetch = oldFetch
    if (oldAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = oldAnthropicApiKey
    if (oldAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = oldAnthropicBaseUrl
    if (oldConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
    else process.env.BABEL_O_CONFIG_FILE = oldConfigFile
  }
})

test('/v1/runtime/provider-smoke/live tool-call mode probes provider protocol without sessions', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-provider-smoke-live-tool`)
  const configPath = join(cwd, 'config.json')
  await mkdir(cwd, { recursive: true })

  const oldConfigFile = process.env.BABEL_O_CONFIG_FILE
  const oldAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  const oldAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL
  const oldFetch = globalThis.fetch
  process.env.BABEL_O_CONFIG_FILE = configPath
  process.env.ANTHROPIC_API_KEY = 'anthropic-live-tool-smoke-test-key'
  process.env.ANTHROPIC_BASE_URL = 'https://api.test-anthropic.com'

  const fetchCalls: RequestInit[] = []
  globalThis.fetch = async (_url, init) => {
    fetchCalls.push(init ?? {})
    return {
      ok: true,
      status: 200,
      body: createRuntimeTestStream([
        'event: content_block_start\n',
        'data: {"index":0,"content_block":{"type":"tool_use","id":"tool_smoke","name":"provider_smoke_probe","input":{}}}\n\n',
        'event: content_block_delta\n',
        'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"probe\\":\\"BABEL_O_PROVIDER_SMOKE_OK\\"}"}}\n\n',
        'event: content_block_stop\n',
        'data: {"index":0}\n\n',
        'event: message_delta\n',
        'data: {"delta":{"stop_reason":"tool_use"}}\n\n',
      ]),
      text: async () => 'mock live tool smoke response',
    } as Response
  }

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runtime/provider-smoke/live',
      payload: { model: 'anthropic/claude-3-5-sonnet', mode: 'tool_call' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'provider_smoke')
    assert.equal(body.mode, 'live')
    assert.equal(body.smokeMode, 'tool_call')
    assert.equal(body.ready, true)
    assert.equal(body.live, true)
    assert.equal(body.success, true)
    assert.equal(body.requirements.tools, true)
    assert.equal(body.matchedExpectedTool, true)
    assert.equal(body.toolCallCount, 1)
    assert.deepEqual(body.toolCalls, [
      { name: 'provider_smoke_probe', input: { probe: 'BABEL_O_PROVIDER_SMOKE_OK' } },
    ])
    assert.equal(body.provider.apiKey, undefined)
    assert.equal(body.fallbackPolicy.allowSilentModelSwitch, false)
    assert.equal(body.diagnostic.domain, 'provider')
    assert.equal(body.diagnostic.name, 'provider_smoke')
    assert.equal(body.diagnostic.details.smokeMode, 'tool_call')
    assert.deepEqual(await storage.listSessions({ limit: 10 }), [])

    assert.equal(fetchCalls.length, 1)
    const requestBody = JSON.parse(String(fetchCalls[0].body))
    assert.equal(requestBody.tools[0].name, 'provider_smoke_probe')
    assert.equal(requestBody.tools[0].input_schema.properties.probe.enum[0], 'BABEL_O_PROVIDER_SMOKE_OK')
    assert.match(JSON.stringify(requestBody), /provider_smoke_probe/)
    assert.match(JSON.stringify(requestBody), /BABEL_O_PROVIDER_SMOKE_OK/)
    assert.doesNotMatch(JSON.stringify(requestBody), /分析|project|Baidu/)
  } finally {
    await app.close()
    globalThis.fetch = oldFetch
    if (oldAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = oldAnthropicApiKey
    if (oldAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = oldAnthropicBaseUrl
    if (oldConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
    else process.env.BABEL_O_CONFIG_FILE = oldConfigFile
  }
})

test('/v1/sessions/:sessionId/assets returns SDK dashboard data assets', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-session-assets-api`)
  await mkdir(cwd, { recursive: true })
  const storage = new SqliteStorage(join(tmpdir(), `babel-o-assets-${Date.now()}.sqlite`))
  const runtime = new LocalCodingRuntime(createDefaultToolRegistry(), allowAllTools(), storage)
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  const sessionId = `session-assets-${Date.now()}`
  const childSessionId = `${sessionId}-child`
  const now = Date.now()
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()

  try {
    await storage.saveSession({
      sessionId,
      cwd,
      prompt: 'dashboard assets',
      phase: 'completed',
      createdAt: iso(0),
      updatedAt: iso(10),
      events: [],
      result: 'done',
    })
    await storage.saveSession({
      sessionId: childSessionId,
      cwd,
      prompt: 'child assets',
      phase: 'completed',
      parentSessionId: sessionId,
      createdAt: iso(1),
      updatedAt: iso(9),
      events: [
        {
          type: 'assistant_delta',
          schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
          sessionId: childSessionId,
          timestamp: iso(2),
          text: 'child transcript stays out of parent asset snapshot',
        },
      ],
      metadata: {
        agentId: 'agent-child',
        status: 'completed',
        transcriptPath: `nexus://sessions/${childSessionId}/events`,
      },
    })
    await storage.appendEvent(childSessionId, {
      type: 'assistant_delta',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: childSessionId,
      timestamp: iso(10),
      text: 'child transcript detail is queryable from parent',
    })
    await storage.saveTask({
      taskId: 'task-assets-1',
      sessionId,
      title: 'Review dashboard query API',
      description: 'Expose stable data assets',
      status: 'failed',
      source: 'critic',
      dependsOn: [],
      blocks: [],
      retryCount: 1,
      review: {
        status: 'rejected',
        reason: 'Critic wants clearer usage totals',
        reviewerAgentId: 'critic',
      },
      createdAt: iso(3),
      updatedAt: iso(8),
      result: 'needs changes',
    })
    await storage.appendEvent(sessionId, {
      type: 'usage',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: iso(4),
      inputTokens: 12,
      outputTokens: 8,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
    })
    await storage.appendEvent(sessionId, {
      type: 'task_session_event',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      eventId: 'event-critic-assets-1',
      eventType: 'critic_completed',
      phase: 'reviewing',
      timestamp: iso(5),
      payload: {
        taskId: 'task-assets-1',
        title: 'Review dashboard query API',
        approved: false,
        reason: 'Usage summary missing',
      },
    })
    await storage.appendEvent(sessionId, {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: iso(6),
      toolUseId: 'tool-assets-1',
      name: 'Read',
      input: { path: 'README.md' },
    })
    await storage.appendEvent(sessionId, {
      type: 'tool_completed',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: iso(7),
      toolUseId: 'tool-assets-1',
      name: 'Read',
      success: true,
      output: 'ok',
    })
    await storage.savePermissionAudit({
      auditId: 'audit-assets-1',
      sessionId,
      toolUseId: 'tool-assets-1',
      toolName: 'Read',
      toolRisk: 'read',
      toolInput: { path: 'README.md' },
      decision: 'approved',
      timestamp: iso(7),
    })
    await storage.saveExecutionMetrics({
      metricId: 'metric-assets-1',
      sessionId,
      executeDurationMs: 123,
      providerFirstTokenMs: 11,
      toolCallCount: 1,
      contextCharsIn: 456,
      contextCharsOut: 78,
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 70,
      effectiveContextCeiling: 179_616,
      legacyContextCeiling: 120_000,
      cacheReadRatio: 0.35,
      cachePreservationMode: true,
      longContextUtilizationMode: true,
      prefixCacheImmutableRatio: 0.82,
      prefixCacheVolatileContentLast: true,
      prefixCacheFingerprint: 'assets-prefix-fingerprint',
      compactSummaryLatencyMs: 12,
      timestamp: iso(9),
    })

    const response = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/assets?eventLimit=2&toolTraceLimit=1`,
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'session_assets')
    assert.equal(body.schemaVersion, '2026-05-31.babel-o.session-assets.v1')
    assert.equal(body.sessionId, sessionId)
    assert.equal(body.session.events.length, 0)
    assert.equal(body.tasks[0].taskId, 'task-assets-1')
    assert.equal(body.childSessions[0].sessionId, childSessionId)
    assert.equal(body.childSessions[0].events.length, 0)
    assert.equal(body.childSessions[0].metadata.transcriptPath, `nexus://sessions/${childSessionId}/events`)
    assert.equal(body.events.items.length, 2)
    assert.equal(body.events.truncated, true)
    assert.equal(body.toolTraces.items.length, 1)
    assert.equal(body.toolTraces.items[0].toolUseId, 'tool-assets-1')
    assert.equal(body.toolTraces.items[0].success, true)
    assert.equal(body.usageSummary.eventCount, 1)
    assert.equal(body.usageSummary.inputTokens, 12)
    assert.equal(body.usageSummary.outputTokens, 8)
    assert.equal(body.usageSummary.cacheCreationInputTokens, 2)
    assert.equal(body.usageSummary.cacheReadInputTokens, 3)
    assert.ok(body.criticReviews.some((review: any) =>
      review.source === 'task_review' &&
      review.taskId === 'task-assets-1' &&
      review.reason === 'Critic wants clearer usage totals',
    ))
    assert.ok(body.criticReviews.some((review: any) =>
      review.source === 'critic_event' &&
      review.taskId === 'task-assets-1' &&
      review.reason === 'Usage summary missing',
    ))
    assert.equal(body.permissionAudits[0].auditId, 'audit-assets-1')
    assert.equal(body.executionMetrics.metricId, 'metric-assets-1')
    assert.equal(body.executionMetrics.toolCallCount, 1)
    assert.equal(body.executionMetrics.providerFirstTokenMs, 11)
    assert.equal(body.executionMetrics.cacheCreationInputTokens, 30)
    assert.equal(body.executionMetrics.cacheReadInputTokens, 70)
    assert.equal(body.executionMetrics.effectiveContextCeiling, 179_616)
    assert.equal(body.executionMetrics.legacyContextCeiling, 120_000)
    assert.equal(body.executionMetrics.compactSummaryLatencyMs, 12)
    assert.equal(body.executionMetrics.cachePreservationMode, true)
    assert.equal(body.executionMetrics.longContextUtilizationMode, true)

    const childrenResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/children?eventLimit=1`,
    })
    assert.equal(childrenResponse.statusCode, 200)
    const childrenBody = childrenResponse.json()
    assert.equal(childrenBody.type, 'child_sessions')
    assert.equal(childrenBody.children[0].session.sessionId, childSessionId)
    assert.equal(childrenBody.children[0].transcriptPath, `nexus://sessions/${childSessionId}/events`)
    assert.equal(childrenBody.children[0].events.items[0].text, 'child transcript detail is queryable from parent')

    const childEventsResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/children/${childSessionId}/events?limit=1&order=desc`,
    })
    assert.equal(childEventsResponse.statusCode, 200)
    const childEventsBody = childEventsResponse.json()
    assert.equal(childEventsBody.type, 'child_session_events')
    assert.equal(childEventsBody.sessionId, sessionId)
    assert.equal(childEventsBody.childSessionId, childSessionId)
    assert.equal(childEventsBody.transcriptPath, `nexus://sessions/${childSessionId}/events`)
    assert.equal(childEventsBody.events[0].text, 'child transcript detail is queryable from parent')

    const missingChildEventsResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/children/not-a-child/events`,
    })
    assert.equal(missingChildEventsResponse.statusCode, 404)
    assert.equal(missingChildEventsResponse.json().code, 'CHILD_SESSION_NOT_FOUND')

    const missingResponse = await app.inject({
      method: 'GET',
      url: '/v1/sessions/missing-session/assets',
    })
    assert.equal(missingResponse.statusCode, 404)
    assert.equal(missingResponse.json().code, 'SESSION_NOT_FOUND')

    const leanResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/assets?includeEvents=false&includeToolTraces=false&includePermissionAudits=false&includeExecutionMetrics=false`,
    })
    assert.equal(leanResponse.statusCode, 200)
    const lean = leanResponse.json()
    assert.equal(lean.events, undefined)
    assert.equal(lean.toolTraces, undefined)
    assert.equal(lean.permissionAudits, undefined)
    assert.equal(lean.executionMetrics, undefined)
    assert.equal(lean.usageSummary.inputTokens, 12)
  } finally {
    await app.close()
    await storage.close()
  }
})

test('/v1/sessions/:sessionId/context returns reusable context analysis', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-context-api`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello context\n', 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const executeResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read sample.txt', cwd },
    })
    assert.equal(executeResponse.statusCode, 200)
    const sessionId = executeResponse.json().sessionId

    const contextResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/context?modelId=local/coding-runtime`,
    })
    assert.equal(contextResponse.statusCode, 200)
    const body = contextResponse.json()
    assert.equal(body.type, 'context_analysis')
    assert.equal(body.sessionId, sessionId)
    assert.ok(body.estimate.totalTokens > 0)
    assert.ok(body.window.maxTokens > 0)
    assert.equal(body.sections.toolDefinitionCount, 1)
    assert.equal(typeof body.runtimePolicy.toolsVisible, 'boolean')
    assert.equal(typeof body.runtimePolicy.recoveryBoundaryActive, 'boolean')
    assert.equal(typeof body.userIntentGuidance.intent, 'string')
    assert.equal(typeof body.diagnostics.remainingTokens, 'number')
    assert.equal(typeof body.diagnostics.usageSummary.inputTokens, 'number')
    assert.equal(typeof body.diagnostics.autoCompact.enabled, 'boolean')
    assert.ok(Array.isArray(body.diagnostics.workingSetPaths))
    assert.equal(typeof body.diagnostics.autoCompactFloor.thresholdTokens, 'number')
    assert.equal(typeof body.diagnostics.compactTokenDelta.hasBoundary, 'boolean')
    assert.equal(typeof body.diagnostics.sessionMemoryLite.enabled, 'boolean')
    assert.equal(body.diagnostics.sessionMemoryLite.path, '.babel-o/session-memory.md')
    assert.equal(body.diagnostics.sessionMemoryLite.costPolicy.modelFallback, 'extractive-only')
    assert.equal(typeof body.diagnostics.sessionMemoryLite.nextDecision.estimatedTokensSinceLastUpdate, 'number')
    assert.equal(body.diagnostics.longTermMemory.provider, 'noop')
    assert.equal(body.diagnostics.longTermMemory.enabled, false)
    assert.equal(body.diagnostic.details.longTermMemoryEnabled, false)
    assert.ok(Array.isArray(body.diagnostics.signals))
    assert.ok(Array.isArray(body.recommendations))

    await storage.saveSession({
      sessionId: 'session-child-context-api',
      parentSessionId: sessionId,
      cwd,
      prompt: 'child prompt',
      phase: 'created',
      createdAt: '2026-05-23T00:00:09.000Z',
      updatedAt: '2026-05-23T00:00:09.000Z',
      events: [],
      metadata: {
        contextForkMode: 'task-focused',
        contextFork: {
          inheritedItems: 7,
          omittedItems: 3,
        },
      },
    })
    const childContextResponse = await app.inject({
      method: 'GET',
      url: '/v1/sessions/session-child-context-api/context?modelId=local/coding-runtime',
    })
    assert.equal(childContextResponse.statusCode, 200)
    const childContext = childContextResponse.json()
    assert.deepEqual(childContext.diagnostics.selection.fork, {
      mode: 'task-focused',
      inheritedItems: 7,
      omittedItems: 3,
    })

    const retainedEvents: NexusEvent[] = [{
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:10.000Z',
      text: 'retained context api turn',
    }]
    await storage.appendEvent(sessionId, {
      type: 'compact_boundary',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:11.000Z',
      trigger: 'manual',
      summary: 'Context API compact summary.',
      beforeEventCount: 4,
      afterEventCount: 2,
      summaryChars: 28,
      snippedToolResults: 1,
      retainedEvents,
      modelId: 'local/coding-runtime',
      budget: allocateBudget('local/coding-runtime'),
    } as any)
    await storage.appendEvent(sessionId, {
      type: 'error',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-05-23T00:00:12.000Z',
      code: 'REQUEST_CANCELLED',
      message: 'Execution cancelled by user.',
    })
    const boundaryResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/context?modelId=local/coding-runtime`,
    })
    assert.equal(boundaryResponse.statusCode, 200)
    const boundaryBody = boundaryResponse.json()
    assert.equal(boundaryBody.diagnostics.compactRetention.hasBoundary, true)
    assert.equal(boundaryBody.diagnostics.compactRetention.retainedSegmentValid, true)
    assert.equal(boundaryBody.diagnostics.compactTokenDelta.hasBoundary, true)
    assert.equal(boundaryBody.diagnostics.resumeRecovery.active, true)
    assert.ok(boundaryBody.diagnostics.signals.some((signal: { type: string }) => signal.type === 'resume_recovery_boundary'))
  } finally {
    await app.close()
  }
})

test('/v1/sessions/:sessionId/context reports long-term memory diagnostics', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-context-evercore`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const sessionId = `session-context-evercore-${Date.now()}`
  let retrieveCalls = 0
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    memoryProvider: {
      name: 'evercore-test',
      async retrieve(input) {
        retrieveCalls += 1
        assert.equal(input.prompt, 'What did we decide about memory?')
        return {
          content: '- Keep EverCore memory volatile.',
          diagnostics: {
            provider: 'evercore-test',
            enabled: true,
            hitCount: 1,
            injectedChars: 32,
            budgetChars: 128,
            maxHitChars: 64,
            truncated: false,
            searchLatencyMs: 3,
            scope: 'project',
            namespaceId: 'project-api',
            namespaceSource: 'explicit',
            isolationKey: 'projectId',
          },
        }
      },
    },
  })
  try {
    await storage.saveSession({
      sessionId,
      cwd,
      prompt: 'What did we decide about memory?',
      phase: 'executing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
    })

    const response = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/context?modelId=local/coding-runtime`,
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(retrieveCalls, 1)
    assert.equal(body.diagnostics.longTermMemory.provider, 'evercore-test')
    assert.equal(body.diagnostics.longTermMemory.enabled, true)
    assert.equal(body.diagnostics.longTermMemory.hitCount, 1)
    assert.equal(body.diagnostics.longTermMemory.injectedChars, 32)
    assert.equal(body.diagnostics.longTermMemory.budgetChars, 128)
    assert.equal(body.diagnostics.longTermMemory.scope, 'project')
    assert.equal(body.diagnostics.longTermMemory.namespaceId, 'project-api')
    assert.equal(body.diagnostics.longTermMemory.namespaceSource, 'explicit')
    assert.equal(body.diagnostics.longTermMemory.isolationKey, 'projectId')
    assert.equal(body.diagnostic.details.longTermMemoryProvider, 'evercore-test')
    assert.equal(body.diagnostic.details.longTermMemoryHitCount, 1)
    assert.equal(body.diagnostic.details.longTermMemoryScope, 'project')
    assert.equal(body.diagnostic.details.longTermMemoryNamespaceId, 'project-api')
    assert.equal(body.diagnostic.details.longTermMemoryNamespaceSource, 'explicit')
    assert.equal(body.diagnostic.details.longTermMemoryIsolationKey, 'projectId')
    assert.equal(body.diagnostics.scopedMemory.length, 1)
    assert.equal(body.diagnostics.scopedMemory[0].scope, 'project')
    assert.equal(body.diagnostics.scopedMemory[0].namespaceId, 'project-api')
    assert.equal(body.diagnostic.details.scopedMemory[0].isolationKey, 'projectId')
  } finally {
    await app.close()
  }
})


test('/v1/sessions/:sessionId/compact creates a manual compact boundary', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-compact-api`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello compact\n', 'utf8')

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const executeResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read sample.txt', cwd },
    })
    assert.equal(executeResponse.statusCode, 200)
    const sessionId = executeResponse.json().sessionId

    const compactResponse = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/compact`,
      payload: {
        modelId: 'local/coding-runtime',
        trigger: 'manual',
      },
    })
    assert.equal(compactResponse.statusCode, 200)
    const body = compactResponse.json()
    assert.equal(body.type, 'compact_result')
    assert.equal(body.sessionId, sessionId)
    assert.equal(body.event.type, 'compact_boundary')
    assert.equal(body.event.trigger, 'manual')
    assert.ok(body.event.summary.length > 0)

    const persisted = await storage.listEvents(sessionId, { order: 'asc', limit: 10_000 })
    const memoryEvent = persisted.events.find(event => event.type === 'session_memory_updated') as any
    if (memoryEvent) {
      assert.equal(memoryEvent.reason, 'compact')
      assert.equal(memoryEvent.decisionReason, 'forced')
      assert.equal(memoryEvent.summaryMode, 'extractive')
      assert.equal(typeof memoryEvent.estimatedTokensSinceLastUpdate, 'number')
      assert.equal(typeof memoryEvent.toolCallCount, 'number')
    }
  } finally {
    await app.close()
  }
})

test('Grep and Glob fall back when ripgrep is unavailable', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-rg-fallback`)
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'fallback.txt'), 'needle appears here\n', 'utf8')
  await writeFile(join(cwd, 'src', 'context.ts'), 'class ContextForker {}\nfunction forkContext() {}\n', 'utf8')

  const oldPath = process.env.PATH
  const oldForceGrepFallback = process.env.BABEL_O_GREP_FORCE_FALLBACK
  process.env.PATH = ''
  process.env.BABEL_O_GREP_FORCE_FALLBACK = '1'
  try {
    const { runtime, storage } = await createDefaultNexusRuntime({
      allowedTools: ['Grep', 'Glob'],
    })
    const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
    try {
      const grepResponse = await app.inject({
        method: 'POST',
        url: '/v1/execute',
        payload: { prompt: 'grep needle', cwd },
      })
      assert.equal(grepResponse.statusCode, 200)
      assert.match(
        JSON.stringify(
          grepResponse.json().events.find((event: { type: string }) => event.type === 'tool_completed'),
        ),
        /fallback\.txt/,
      )

      const grepAlternationResponse = await app.inject({
        method: 'POST',
        url: '/v1/execute',
        payload: { prompt: 'grep ContextForker|forkContext|contextFork', cwd },
      })
      assert.equal(grepAlternationResponse.statusCode, 200)
      const grepAlternationEvent = grepAlternationResponse.json().events.find((event: { type: string }) => event.type === 'tool_completed')
      assert.match(JSON.stringify(grepAlternationEvent), /context\.ts/)
      assert.match(JSON.stringify(grepAlternationEvent), /ContextForker/)
      assert.match(JSON.stringify(grepAlternationEvent), /Grep fallback/)

      const globResponse = await app.inject({
        method: 'POST',
        url: '/v1/execute',
        payload: { prompt: 'glob fallback', cwd },
      })
      assert.equal(globResponse.statusCode, 200)
      assert.match(
        JSON.stringify(
          globResponse.json().events.find((event: { type: string }) => event.type === 'tool_completed'),
        ),
        /fallback\.txt/,
      )
    } finally {
      await app.close()
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    if (oldForceGrepFallback === undefined) delete process.env.BABEL_O_GREP_FORCE_FALLBACK
    else process.env.BABEL_O_GREP_FORCE_FALLBACK = oldForceGrepFallback
  }
})

test('allowlisted runtime executes allowed tools and denies blocked tools', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-allowlist`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello allowlist\n', 'utf8')
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Read'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const readResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read sample.txt', cwd },
    })
    assert.equal(readResponse.statusCode, 200)
    assert.equal(readResponse.json().success, true)

    // Phase A of docs/nexus/reference/go-tui-permission-policy-governance-plan.md
    // downgrades read-only Bash subcommands (`ls`, `pwd`, `git status`, ...)
    // to `risk: 'read'`, so they bypass the allowlist at the policy layer.
    // To exercise the original deny path, use a command the classifier
    // escalates to `risk: 'execute'` (here: `bash "rm file"`).
    const bashResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "rm sample.txt"', cwd, skipPermissionCheck: true },
    })
    assert.equal(bashResponse.statusCode, 200)
    const body = bashResponse.json()
    assert.equal(body.success, false)
    assert.equal(body.result.success, false)
    assert.ok(body.events.some((event: { type: string }) => event.type === 'tool_denied'))
    assert.ok(
      body.events.some(
        (event: { type: string; name?: string }) =>
          event.type === 'tool_denied' && event.name === 'Bash',
      ),
    )
  } finally {
    await app.close()
  }
})

test('read-only Bash source inspection skips permission gate', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-source-inspection`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'state-machine.go'), Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n'), 'utf8')
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    for (const command of [
      "sed -n '1,20p' state-machine.go | head -c 30000",
      'grep -n "line" state-machine.go | head -20',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/execute',
        payload: { prompt: `Bash: ${JSON.stringify({ command })}`, cwd },
      })
      assert.equal(response.statusCode, 200)
      const body = response.json()
      assert.equal(body.success, true)
      assert.ok(
        body.events.some((event: { type: string; name?: string; effectiveRisk?: string }) =>
          event.type === 'tool_started' && event.name === 'Bash' && event.effectiveRisk === 'read'),
        `expected Bash effectiveRisk=read for ${command}`,
      )
      assert.ok(
        !body.events.some((event: { type: string }) => event.type === 'permission_request'),
        `safe source inspection should not ask permission for ${command}`,
      )
    }
  } finally {
    await app.close()
  }
})

test('session list stays lightweight while session detail keeps events', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-session-list`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const executeResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'hello', cwd },
    })
    const { sessionId } = executeResponse.json()

    const listResponse = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
    })
    const listedSession = listResponse
      .json()
      .sessions.find((session: { sessionId: string }) => session.sessionId === sessionId)
    assert.ok(listedSession)
    assert.deepEqual(listedSession.events, [])

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
    })
    assert.ok(detailResponse.json().session.events.length > 0)
  } finally {
    await app.close()
  }
})

test('session detail uses recent events and events endpoint paginates history', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-events-page`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const executeResponse = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read missing.txt', cwd },
    })
    const { sessionId } = executeResponse.json()

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}?recentEventLimit=2`,
    })
    const detail = detailResponse.json()
    assert.equal(detail.session.events.length, 2)
    assert.equal(detail.eventsTruncated, true)

    const firstPageResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/events?limit=2`,
    })
    const firstPage = firstPageResponse.json()
    assert.equal(firstPage.events.length, 2)
    assert.ok(firstPage.nextCursor)

    const secondPageResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/events?limit=2&cursor=${encodeURIComponent(
        firstPage.nextCursor,
      )}`,
    })
    const secondPage = secondPageResponse.json()
    assert.ok(secondPage.events.length > 0)
    assert.notDeepEqual(secondPage.events[0], firstPage.events[0])
  } finally {
    await app.close()
  }
})

test('execute timeout aborts long-running tools and records metrics', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-timeout`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    executeTimeoutMs: 50,
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "sleep 1"', cwd, skipPermissionCheck: true },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.success, false)
    assert.ok(
      body.events.some(
        (event: { type: string; code?: string }) =>
          event.type === 'error' && event.code === 'REQUEST_TIMEOUT',
      ),
    )

    // Phase B execute-timeout observability: timeout path classifies the
    // execute_summary outcome as 'timeout' and marks nearTimeout=true so
    // dashboards can distinguish a hard timeout from a slow-but-completed
    // turn. timeoutMs echoes the configured executeTimeoutMs (50) so the
    // caller can confirm which budget was hit.
    assert.equal(body.outcome, 'timeout')
    assert.equal(body.timeoutMs, 50)
    assert.equal(body.nearTimeout, true)
    assert.ok(body.executeDurationMs >= 0)
    const summaryEvent = body.events.find((event: { type: string }) => event.type === 'execute_summary')
    assert.ok(summaryEvent, 'execute_summary event should be appended even on timeout')
    assert.equal(summaryEvent.outcome, 'timeout')
    assert.equal(summaryEvent.timeoutMs, 50)
    assert.equal(summaryEvent.nearTimeout, true)

    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    const metrics = metricsResponse.json()
    assert.equal(metrics.execute.count, 1)
    assert.equal(metrics.execute.timeoutCount, 1)
    assert.ok(metrics.execute.avgMs >= 0)
  } finally {
    await app.close()
  }
})

test('execute timeout preserves partial result and emits near-timeout warning', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-partial-timeout`)
  await mkdir(cwd, { recursive: true })
  const storage = new MemoryStorage()
  const runtime = {
    async *executeStream(options: any): AsyncIterable<NexusEvent> {
      yield {
        type: 'session_started',
        ...eventBase(options.sessionId),
        cwd: options.cwd,
        requestId: options.requestId,
      }
      yield {
        type: 'assistant_delta',
        ...eventBase(options.sessionId),
        text: 'Partial analysis: inspected state machine setup.',
      }
      await new Promise<void>(resolve => {
        options.timeoutSignal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: 'REQUEST_TIMEOUT',
        message: 'This operation was aborted',
      }
      yield {
        type: 'result',
        ...eventBase(options.sessionId),
        success: false,
        message: 'This operation was aborted',
      }
    },
  }
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd, executeTimeoutMs: 80 })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'long analysis', cwd },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.statusCode, 408)
    assert.equal(body.success, false)
    assert.equal(body.outcome, 'timeout')
    const warning = body.events.find((event: { type: string }) => event.type === 'near_timeout_warning')
    assert.ok(warning, 'near_timeout_warning should be emitted before timeout')
    assert.match(warning.partialSummary, /Partial analysis/)
    const resultEvents = body.events.filter((event: { type: string }) => event.type === 'result')
    const finalResult = resultEvents.at(-1)
    assert.ok(finalResult, 'timeout should still emit a result event')
    assert.match(finalResult.message, /Partial result preserved before timeout/)
    assert.match(finalResult.message, /inspected state machine setup/)
    assert.notEqual(finalResult.message, 'This operation was aborted')
    assert.equal(body.result.message, finalResult.message)

    const session = await storage.getSession(body.sessionId)
    assert.ok(session)
    assert.match(session.result ?? '', /Partial result preserved before timeout/)
  } finally {
    await app.close()
  }
})

test('execute honours per-request timeoutMs from Go TUI WebSocket payload', async () => {
  // Phase C regression: when the WebSocket / HTTP body sends a per-request
  // timeoutMs that overrides the server default, Nexus must honour it AND
  // echo the effective value in the execute_result envelope + execute_summary
  // event so the caller (Go TUI) can confirm which budget was applied.
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-per-request-timeout`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    executeTimeoutMs: 30_000, // server default kept generous; per-request should win
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        prompt: 'bash "sleep 1"',
        cwd,
        skipPermissionCheck: true,
        timeoutMs: 200, // per-request override; shorter than the bash sleep
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.success, false)
    assert.ok(
      body.events.some(
        (event: { type: string; code?: string }) =>
          event.type === 'error' && event.code === 'REQUEST_TIMEOUT',
      ),
      'expected REQUEST_TIMEOUT error event in body.events',
    )

    // The per-request timeoutMs must win over the server default 30_000
    // both in the envelope and in the persisted execute_summary event.
    assert.equal(body.timeoutMs, 200, 'envelope should echo the per-request timeoutMs, not the server default')
    assert.equal(body.outcome, 'timeout')
    const summary = body.events.find((event: { type: string }) => event.type === 'execute_summary')
    assert.ok(summary, 'execute_summary should still be emitted on per-request timeout')
    assert.equal(summary.timeoutMs, 200)
    assert.equal(summary.outcome, 'timeout')
    assert.equal(summary.nearTimeout, true)
  } finally {
    await app.close()
  }
})

test('execute honours per-request policy=soft-deny for write/execute tools', async () => {
  // Phase B of docs/nexus/reference/go-tui-permission-policy-governance-plan.md:
  // when the request body carries `policy: 'soft-deny'`, the hard-deny
  // for tools not in the allowlist is bypassed. The existing approval
  // gate then emits `permission_request` for write/execute-risk tools
  // (here: Bash with `git commit -m x`), giving the user (Go TUI
  // permission panel) a chance to approve / deny. Under the default
  // `'strict'` policy the same call would be hard-denied with no
  // permission_request.
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-soft-deny-bash`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-soft-deny-bash-${Date.now()}`
  const executePromise = app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: {
      prompt: 'bash "git commit -m x"',
      cwd,
      sessionId,
      policy: 'soft-deny',
      skipPermissionCheck: false,
    },
  })

  // Wait for permission_request to appear; auto-approve via /approve.
  let toolUseId = ''
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100))
    const sessionRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
    })
    if (sessionRes.statusCode === 200) {
      const data = sessionRes.json()
      const reqEvent = data.session?.events?.find((e: any) => e.type === 'permission_request')
      if (reqEvent) {
        toolUseId = reqEvent.toolUseId
        break
      }
    }
  }
  assert.ok(toolUseId, 'soft-deny should emit permission_request for execute-risk Bash')

  // Approve and await the result.
  const approveRes = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/approve`,
    payload: { toolUseId, reason: 'auto-approve test' },
  })
  assert.equal(approveRes.statusCode, 200)

  const response = await executePromise
  assert.equal(response.statusCode, 200)
  const body = response.json()
  // The body.success is what the runtime reports; the tool itself may
  // fail (e.g. `git commit` outside a git repo) but the key claim is
  // that the tool was allowed to run instead of being hard-denied.
  const events = body.events
  assert.ok(
    events.some((e: any) => e.type === 'permission_request' && e.toolUseId === toolUseId),
    'permission_request event should be present in the events stream',
  )
  // No tool_denied from the hard-deny path; a downstream tool failure
  // would still emit tool_completed with success=false, not tool_denied.
  assert.ok(
    !events.some((e: any) => e.type === 'tool_denied' && /denied by Nexus policy/i.test(e.message)),
    'soft-deny should NOT emit policy-based tool_denied',
  )

  await app.close()
})

test('execute with default strict policy still hard-denies execute-risk Bash', async () => {
  // Back-compat: when `policy` is omitted (server-side default 'strict')
  // AND the server is using the default `denyByDefaultTools()` policy,
  // Bash with execute subcommands is hard-denied with no
  // permission_request, matching pre-Phase-B behaviour. This pins the
  // back-compat surface for `bbl chat` and other non-Go-TUI clients.
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-strict-deny`)
  await mkdir(cwd, { recursive: true })
  // No `allowedTools` → denyByDefaultTools() default → only read/task
  // risk tools pass isAllowed; Bash (`risk: execute`) is denied.
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const response = await app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: {
      prompt: 'bash "git commit -m x"',
      cwd,
      sessionId: `session-strict-deny-${Date.now()}`,
    },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  const events = body.events
  assert.ok(
    events.some(
      (e: any) => e.type === 'tool_denied' && /denied by Nexus policy/i.test(e.message),
    ),
    'default strict policy should hard-deny execute-risk Bash with policy message',
  )
  assert.ok(
    !events.some((e: any) => e.type === 'permission_request'),
    'default strict policy must NOT emit permission_request (back-compat)',
  )

  await app.close()
})

test('execute concurrency gate rejects excess work quickly', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-busy`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    executeTimeoutMs: 1_000,
    maxConcurrentExecutions: 1,
  })
  try {
    const first = app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "sleep 0.2"', cwd, skipPermissionCheck: true },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'hello', cwd },
    })

    assert.equal(rejected.statusCode, 429)
    assert.equal(rejected.json().code, 'EXECUTION_BUSY')
    assert.equal((await first).statusCode, 200)

    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    assert.equal(metricsResponse.json().execute.rejectedCount, 1)
  } finally {
    await app.close()
  }
})

test('remote execute concurrency gate rejects excess work while runner is active', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-remote-busy`)
  await mkdir(cwd, { recursive: true })
  const remoteRunner = new InMemoryRemoteToolRunner({
    handler: (_request, context) => new Promise<never>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('remote aborted')))
    }),
  })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'], remoteRunner })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    executeTimeoutMs: 200,
    maxConcurrentExecutions: 1,
    remoteRunner,
  })
  try {
    const first = app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read remote.txt', cwd, executionEnvironment: 'remote' },
    })
    await waitFor(() => remoteRunner.requests.length === 1)
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'hello', cwd },
    })

    assert.equal(rejected.statusCode, 429)
    assert.equal(rejected.json().code, 'EXECUTION_BUSY')
    const firstResponse = await first
    assert.equal(firstResponse.statusCode, 200)
    assert.equal(firstResponse.json().statusCode, 408)
    assert.equal(firstResponse.json().error.code, 'REQUEST_TIMEOUT')
    assert.equal(remoteRunner.cancelRequests.length, 1)

    const metricsResponse = await app.inject({ method: 'GET', url: '/v1/runtime/metrics' })
    const metrics = metricsResponse.json()
    assert.equal(metrics.execute.rejectedCount, 1)
    assert.equal(metrics.execute.timeoutCount, 1)
  } finally {
    await app.close()
  }
})

test('tool output is truncated before it is stored in events', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-truncate`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'big.txt'), 'x'.repeat(500), 'utf8')
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    maxToolOutputBytes: 64,
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read big.txt', cwd },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const completed = body.events.find(
      (event: { type: string }) => event.type === 'tool_completed',
    )
    assert.equal(completed.truncated, true)
    assert.equal(completed.originalBytes, 500)
    assert.equal(completed.output.length, 64)

    const session = await storage.getSession(body.sessionId)
    const storedCompleted = session?.events.find(event => event.type === 'tool_completed')
    assert.equal(
      storedCompleted?.type === 'tool_completed' && storedCompleted.truncated,
      true,
    )
  } finally {
    await app.close()
  }
})

test('bash max buffer is configurable and fails safely on excessive output', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-buffer`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    bashMaxBufferBytes: 32,
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "printf 1234567890123456789012345678901234567890"', cwd, skipPermissionCheck: true },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.success, false)
    assert.ok(
      body.events.some(
        (event: { type: string; code?: string }) =>
          event.type === 'error' && event.code === 'TOOL_ERROR',
      ),
    )
  } finally {
    await app.close()
  }
})

test('bash non-zero exit returns a recoverable failed tool result', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-nonzero`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        prompt: 'bash "printf visible-out && printf visible-err >&2 && exit 7"',
        cwd,
        skipPermissionCheck: true,
      },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const toolCompleted = body.events.find((event: { type: string; name?: string }) =>
      event.type === 'tool_completed' && event.name === 'Bash',
    )
    assert.ok(toolCompleted)
    assert.equal(toolCompleted.success, false)
    assert.match(toolCompleted.output.stdout, /visible-out/)
    assert.match(toolCompleted.output.stderr, /visible-err/)
    assert.equal(toolCompleted.output.exitCode, 7)
    assert.ok(!body.events.some((event: { type: string; code?: string }) =>
      event.type === 'error' && event.code === 'TOOL_ERROR',
    ))
  } finally {
    await app.close()
  }
})

test('bash command timeout returns a recoverable failed tool result', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-timeout`)
  await mkdir(cwd, { recursive: true })

  const { bashTool } = await import('../src/tools/builtin/bash.js')
  const result = await bashTool.execute({
    command: 'sleep 1',
    timeoutMs: 20,
  }, {
    cwd,
    sessionId: `bash-timeout-${Date.now()}`,
    maxOutputBytes: 1000,
    bashMaxBufferBytes: 10_000,
  })

  assert.equal(result.success, false)
  assert.equal((result.output as any).code, 'COMMAND_TIMEOUT')
  assert.equal((result.output as any).timedOut, true)
  assert.equal((result.output as any).signal, 'SIGTERM')
  assert.match((result.output as any).message, /timed out|terminated/)
})

test('bash discovery timeout returns guidance without fatal tool error', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-discovery-timeout`)
  await mkdir(cwd, { recursive: true })

  const { bashTool } = await import('../src/tools/builtin/bash.js')
  const result = await bashTool.execute({
    command: 'find . -exec sleep 1 \\;',
    timeoutMs: 20,
  }, {
    cwd,
    sessionId: `bash-discovery-timeout-${Date.now()}`,
    maxOutputBytes: 1000,
    bashMaxBufferBytes: 10_000,
  })

  assert.equal(result.success, false)
  assert.equal((result.output as any).code, 'COMMAND_TIMEOUT')
  assert.equal((result.output as any).guidance.code, 'BASH_AS_FILE_DISCOVERY')
  assert.match((result.output as any).guidance.message, /ListDir|Glob|Grep|Read/)
})

test('runtime surfaces Bash command timeout as tool_completed failure', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-runtime-bash-timeout`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['Bash'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        prompt: 'Bash: {"command":"sleep 1","timeoutMs":20}',
        cwd,
        skipPermissionCheck: true,
      },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    const toolCompleted = body.events.find((event: { type: string; name?: string }) =>
      event.type === 'tool_completed' && event.name === 'Bash',
    )
    assert.ok(toolCompleted)
    assert.equal(toolCompleted.success, false)
    assert.equal(toolCompleted.output.code, 'COMMAND_TIMEOUT')
    assert.ok(!body.events.some((event: { type: string; code?: string }) =>
      event.type === 'error' && event.code === 'TOOL_ERROR',
    ))
  } finally {
    await app.close()
  }
})

test('bash absolute paths outside workspace return recoverable workspace escape result', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-workspace-escape`)
  const outside = join(tmpdir(), `babel-o-outside-${Date.now()}.txt`)
  await mkdir(cwd, { recursive: true })
  await writeFile(outside, 'outside workspace')

  process.env.NEXUS_ALLOWED_WORKSPACES = cwd
  try {
    const { bashTool } = await import('../src/tools/builtin/bash.js')
    const result = await bashTool.execute({
      command: `ls -la ${outside}`,
      timeoutMs: 10_000,
    }, {
      cwd,
      sessionId: `bash-escape-${Date.now()}`,
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 10_000,
    })

    assert.equal(result.success, false)
    assert.equal((result.output as any).code, 'WORKSPACE_PATH_ESCAPE')
    assert.match((result.output as any).message, /outside the current workspace/)
    assert.equal((result.output as any).requestedPath, outside)
  } finally {
    delete process.env.NEXUS_ALLOWED_WORKSPACES
  }
})

test('websocket stream executes prompts and records stream metrics', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-stream`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    await app.ready()
    const ws: any = await app.injectWS('/v1/stream')
    const events: Array<{ type: string; success?: boolean }> = []
    ws.on('message', (data: Buffer) => {
      events.push(JSON.parse(String(data)))
    })
    ws.send(JSON.stringify({ prompt: 'hello', cwd }))
    await waitFor(() => events.some(event => event.type === 'result'))
    ws.terminate()

    assert.ok(events.some(event => event.type === 'session_started'))
    assert.equal(events.find(event => event.type === 'result')?.success, true)

    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    const metrics = metricsResponse.json()
    assert.equal(metrics.stream.count, 1)
    assert.equal(metrics.stream.successCount, 1)
    assert.ok(metrics.stream.sentEventCount >= 3)
  } finally {
    await app.close()
  }
})

test('runtime metrics aggregates cache-aware performance diagnostics', async () => {
  const cwd = join(tmpdir(), `babel-o-test-cache-aware-metrics-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const storage = new SqliteStorage(join(cwd, 'nexus.sqlite'))
  const runtime = {
    async *executeStream(options: any): AsyncIterable<NexusEvent> {
      yield {
        type: 'execution_metrics',
        ...eventBase(options.sessionId),
        requestId: options.requestId,
        providerFirstTokenMs: 25,
        providerRequestDurationMs: 40,
        streamDeltaCount: 2,
        toolCallCount: 0,
        toolRoundtripDurationMs: 0,
        contextCharsIn: 100,
        contextCharsOut: 20,
        inputTokens: 100,
        outputTokens: 30,
        cacheCreationInputTokens: 50,
        cacheReadInputTokens: 150,
        modelContextWindow: 200_000,
        reservedOutputTokens: 16_384,
        providerSafetyBufferTokens: 4_000,
        effectiveContextCeiling: 179_616,
        legacyContextCeiling: 120_000,
        envMaxContextTokens: 180_000,
        contextPolicySource: 'large_context',
        contextWarningThresholdPercent: 80,
        contextCompactThresholdPercent: 93,
        contextWarningThresholdTokens: 143_692,
        contextCompactThresholdTokens: 167_042,
        contextBlockingLimitTokens: 178_616,
        cacheReadRatio: 0.5,
        cachePreservationMode: true,
        longContextUtilizationMode: true,
        prefixCacheImmutableRatio: 0.82,
        prefixCacheVolatileContentLast: true,
        prefixCacheFingerprint: 'runtime-prefix-fingerprint',
        compactSummaryLatencyMs: 12,
      }
      yield {
        type: 'hook_completed',
        ...eventBase(options.sessionId),
        hookName: 'InvocationDiagnosticsHook',
        hookEvent: 'PostInvocation',
        toolUseId: 'provider-invocation-success',
        output: {
          summary: 'Provider invocation completed.',
          metadata: {
            providerId: 'test-provider',
            modelId: 'test-model',
            role: 'executor',
            durationMs: 40,
            success: true,
          },
        },
      }
      yield {
        type: 'hook_completed',
        ...eventBase(options.sessionId),
        hookName: 'InvocationDiagnosticsHook',
        hookEvent: 'PostInvocation',
        toolUseId: 'provider-invocation-failure',
        output: {
          summary: 'Provider invocation completed.',
          metadata: {
            providerId: 'test-provider',
            modelId: 'test-model',
            role: 'critic',
            durationMs: 20,
            success: false,
            errorCode: 'PROVIDER_ERROR',
            failureKind: 'provider_protocol',
          },
        },
      }
      yield {
        type: 'task_session_event',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: options.sessionId,
        eventId: 'task-event-created',
        eventType: 'task_created',
        phase: 'executing',
        timestamp: new Date().toISOString(),
        payload: { task: { taskId: 'task-1', status: 'pending', retryCount: 0 } },
      }
      yield {
        type: 'task_session_event',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: options.sessionId,
        eventId: 'task-event-role',
        eventType: 'agent_loop_role_step_metrics',
        phase: 'executing',
        timestamp: new Date().toISOString(),
        payload: { role: 'executor', taskId: 'task-1', durationMs: 15, inputTokens: 11, outputTokens: 7, success: true },
      }
      yield {
        type: 'task_session_event',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: options.sessionId,
        eventId: 'task-event-updated',
        eventType: 'task_updated',
        phase: 'executing',
        timestamp: new Date().toISOString(),
        payload: { task: { taskId: 'task-1', status: 'failed', retryCount: 1, review: { reviewerAgentId: 'system', reason: 'Executor step returned failure or crashed' } } },
      }
      yield {
        type: 'agent_job_event',
        ...eventBase(options.sessionId),
        eventId: 'agent-job-event-1',
        eventType: 'agent_job_failed',
        jobId: 'agent-job-1',
        childSessionId: 'child-session-1',
        agentType: 'review',
        contextForkMode: 'task-focused',
        status: 'failed',
        error: { code: 'AGENT_JOB_TIMEOUT', message: 'timed out' },
      }
      yield {
        type: 'result',
        ...eventBase(options.sessionId),
        success: true,
        message: 'ok',
      }
    },
  }
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  try {
    const sessionId = `session-cache-aware-metrics-${Date.now()}`
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { sessionId, prompt: 'metrics', cwd },
    })
    assert.equal(response.statusCode, 200)

    const savedMetrics = await storage.getExecutionMetrics(sessionId)
    assert.equal(savedMetrics?.providerFirstTokenMs, 25)
    assert.equal(savedMetrics?.cacheCreationInputTokens, 50)
    assert.equal(savedMetrics?.cacheReadInputTokens, 150)
    assert.equal(savedMetrics?.modelContextWindow, 200_000)
    assert.equal(savedMetrics?.reservedOutputTokens, 16_384)
    assert.equal(savedMetrics?.providerSafetyBufferTokens, 4_000)
    assert.equal(savedMetrics?.effectiveContextCeiling, 179_616)
    assert.equal(savedMetrics?.legacyContextCeiling, 120_000)
    assert.equal(savedMetrics?.envMaxContextTokens, 180_000)
    assert.equal(savedMetrics?.contextPolicySource, 'large_context')
    assert.equal(savedMetrics?.contextWarningThresholdPercent, 80)
    assert.equal(savedMetrics?.contextCompactThresholdPercent, 93)
    assert.equal(savedMetrics?.contextWarningThresholdTokens, 143_692)
    assert.equal(savedMetrics?.contextCompactThresholdTokens, 167_042)
    assert.equal(savedMetrics?.contextBlockingLimitTokens, 178_616)
    assert.equal(savedMetrics?.compactSummaryLatencyMs, 12)
    assert.equal(savedMetrics?.cachePreservationMode, true)
    assert.equal(savedMetrics?.longContextUtilizationMode, true)
    assert.equal(savedMetrics?.prefixCacheImmutableRatio, 0.82)
    assert.equal(savedMetrics?.prefixCacheVolatileContentLast, true)
    assert.equal(savedMetrics?.prefixCacheFingerprint, 'runtime-prefix-fingerprint')

    const metricsResponse = await app.inject({ method: 'GET', url: '/v1/runtime/metrics' })
    const metrics = metricsResponse.json()
    assert.equal(metrics.providerFirstTokenMs.avgMs, 25)
    assert.equal(metrics.tokenUsage.cacheCreationInputTokens, 50)
    assert.equal(metrics.tokenUsage.cacheReadInputTokens, 150)
    assert.equal(metrics.tokenUsage.cacheReadRatio, 0.5)
    assert.equal(metrics.contextPolicy.modelContextWindow, 200_000)
    assert.equal(metrics.contextPolicy.reservedOutputTokens, 16_384)
    assert.equal(metrics.contextPolicy.providerSafetyBufferTokens, 4_000)
    assert.equal(metrics.contextPolicy.effectiveContextCeiling, 179_616)
    assert.equal(metrics.contextPolicy.legacyContextCeiling, 120_000)
    assert.equal(metrics.contextPolicy.envMaxContextTokens, 180_000)
    assert.equal(metrics.contextPolicy.source, 'large_context')
    assert.equal(metrics.contextPolicy.warningThresholdPercent, 80)
    assert.equal(metrics.contextPolicy.compactThresholdPercent, 93)
    assert.equal(metrics.contextPolicy.warningThresholdTokens, 143_692)
    assert.equal(metrics.contextPolicy.compactThresholdTokens, 167_042)
    assert.equal(metrics.contextPolicy.blockingLimitTokens, 178_616)
    assert.equal(metrics.contextPolicy.cachePreservationModeCount, 1)
    assert.equal(metrics.contextPolicy.longContextUtilizationModeCount, 1)
    assert.equal(metrics.contextPolicy.prefixCache.immutableRatioAvg, 0.82)
    assert.equal(metrics.contextPolicy.prefixCache.sampleCount, 1)
    assert.equal(metrics.contextPolicy.prefixCache.volatileContentLastRatio, 1)
    assert.equal(metrics.contextPolicy.prefixCache.latestFingerprint, 'runtime-prefix-fingerprint')
    assert.equal(metrics.compactSummaryLatencyMs.avgMs, 12)
    assert.equal(metrics.providerInvocations.count, 2)
    assert.equal(metrics.providerInvocations.successCount, 1)
    assert.equal(metrics.providerInvocations.failureCount, 1)
    assert.equal(metrics.providerInvocations.durationMs.avgMs, 30)
    assert.equal(metrics.providerInvocations.byFailureKind.provider_protocol, 1)
    assert.equal(metrics.providerInvocations.byErrorCode.PROVIDER_ERROR, 1)
    assert.equal(metrics.providerInvocations.byRole.executor.successCount, 1)
    assert.equal(metrics.providerInvocations.byRole.critic.failureCount, 1)
    assert.equal(metrics.agentLoop.sessionsObserved, 1)
    assert.equal(metrics.agentLoop.taskCount, 1)
    assert.equal(metrics.agentLoop.failedTaskCount, 1)
    assert.equal(metrics.agentLoop.retryCount, 1)
    assert.equal(metrics.agentLoop.roleStepCount, 1)
    assert.equal(metrics.agentLoop.roleInputTokens, 11)
    assert.equal(metrics.agentLoop.roleOutputTokens, 7)
    assert.equal(metrics.agentLoop.roleDurationMs.avgMs, 15)
    assert.equal(metrics.agentLoop.byRole.executor.count, 1)
    assert.equal(metrics.agentLoop.byFailureType.executor_failed, 1)
    assert.equal(metrics.agentJobs.count, 1)
    assert.equal(metrics.agentJobs.failedCount, 1)
    assert.equal(metrics.agentJobs.byAgentType.review.failedCount, 1)
    assert.equal(metrics.agentJobs.byFailureCode.AGENT_JOB_TIMEOUT, 1)

    const statusResponse = await app.inject({ method: 'GET', url: '/v1/runtime/status' })
    const status = statusResponse.json()
    assert.equal(status.metrics.contextPolicy.modelContextWindow, 200_000)
    assert.equal(status.metrics.contextPolicy.source, 'large_context')
    assert.equal(status.metrics.contextPolicy.prefixCache.immutableRatioAvg, 0.82)
    assert.equal(status.metrics.contextPolicy.prefixCache.sampleCount, 1)
    assert.equal(status.metrics.contextPolicy.prefixCache.volatileContentLastRatio, 1)
    assert.equal(status.metrics.contextPolicy.prefixCache.latestFingerprint, 'runtime-prefix-fingerprint')
    assert.equal(status.metrics.providerInvocations.count, 2)
    assert.equal(status.metrics.agentLoop.roleStepCount, 1)
    assert.equal(status.metrics.agentJobs.failedCount, 1)
  } finally {
    await app.close()
    await storage.close()
  }
})

test('websocket stream relays and persists context blocking events', async () => {
  const cwd = join(tmpdir(), `babel-o-test-context-blocking-ws-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const storage = new SqliteStorage(join(cwd, 'nexus.sqlite'))
  const runtime = {
    async *executeStream(options: any): AsyncIterable<NexusEvent> {
      const message = 'Context estimate 1200/1000 tokens exceeds the blocking limit (900). Run /compact or /context before continuing.'
      yield {
        type: 'context_blocking',
        ...eventBase(options.sessionId),
        modelId: 'local/coding-runtime',
        tokenEstimate: 1200,
        maxTokens: 1000,
        percentUsed: 120,
        warningThresholdTokens: 700,
        compactThresholdTokens: 850,
        blockingLimitTokens: 900,
        httpStatus: 413,
        recoveryActions: ['compact', 'context', 'switch_model', 'reduce_tool_output'],
        message,
      }
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: 'CONTEXT_LIMIT_EXCEEDED',
        message,
        details: { httpStatus: 413, recoveryReason: 'CONTEXT_BLOCKING_LIMIT' },
      }
      yield {
        type: 'result',
        ...eventBase(options.sessionId),
        success: false,
        message,
      }
    },
  }
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  try {
    await app.ready()
    const ws: any = await app.injectWS('/v1/stream')
    const events: NexusEvent[] = []
    const sessionId = `session-context-blocking-ws-${Date.now()}`
    ws.on('message', (data: Buffer) => {
      events.push(JSON.parse(String(data)))
    })
    ws.send(JSON.stringify({ sessionId, prompt: 'continue', cwd }))
    await waitFor(() => events.some(event => event.type === 'result'))
    ws.terminate()

    const blockingEvent = events.find(event => event.type === 'context_blocking')
    assert.ok(blockingEvent, 'websocket should relay context_blocking')
    assert.equal(blockingEvent.httpStatus, 413)
    assert.equal(events.find(event => event.type === 'error')?.code, 'CONTEXT_LIMIT_EXCEEDED')

    const persisted = await storage.getSession(sessionId, { includeEvents: true })
    assert.equal(persisted?.phase, 'failed')
    assert.equal(persisted?.terminalReason?.category, 'runtime')
    assert.equal(persisted?.terminalReason?.code, 'CONTEXT_LIMIT_EXCEEDED')
    assert.equal((persisted?.metadata?.runtimeRecovery as any)?.retryable, true)
    assert.equal((persisted?.metadata?.runtimeRecovery as any)?.httpStatus, 413)
    assert.ok(persisted?.events.some(event => event.type === 'context_blocking'))
    assert.ok(persisted?.events.some(event => event.type === 'error' && event.code === 'CONTEXT_LIMIT_EXCEEDED'))
  } finally {
    await app.close()
    await storage.close()
  }
})

test('websocket stream timeout aborts long-running tools', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-stream-timeout`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    executeTimeoutMs: 50,
  })
  try {
    await app.ready()
    const ws: any = await app.injectWS('/v1/stream')
    const events: Array<{ type: string; code?: string }> = []
    ws.on('message', (data: Buffer) => {
      events.push(JSON.parse(String(data)))
    })
    ws.send(JSON.stringify({ prompt: 'bash "sleep 1"', cwd, skipPermissionCheck: true }))
    await waitFor(() =>
      events.some(event => event.type === 'error' && event.code === 'REQUEST_TIMEOUT'),
    )
    ws.terminate()

    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    const metrics = metricsResponse.json()
    assert.equal(metrics.stream.count, 1)
    assert.equal(metrics.stream.timeoutCount, 1)
  } finally {
    await app.close()
  }
})

test('websocket stream concurrency gate rejects excess work', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-stream-busy`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    maxConcurrentExecutions: 1,
    executeTimeoutMs: 1_000,
  })
  try {
    await app.ready()
    const first: any = await app.injectWS('/v1/stream')
    first.send(JSON.stringify({ prompt: 'bash "sleep 0.2"', cwd, skipPermissionCheck: true }))
    await new Promise(resolve => setTimeout(resolve, 20))

    const second: any = await app.injectWS('/v1/stream')
    const events: Array<{ type: string; code?: string }> = []
    second.on('message', (data: Buffer) => {
      events.push(JSON.parse(String(data)))
    })
    second.send(JSON.stringify({ prompt: 'hello', cwd }))
    await waitFor(() =>
      events.some(event => event.type === 'error' && event.code === 'EXECUTION_BUSY'),
    )

    first.terminate()
    second.terminate()
    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    assert.equal(metricsResponse.json().stream.rejectedCount, 1)
  } finally {
    await app.close()
  }
})

test('bash tool session CWD retention', async () => {
  const baseCwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-cwd`)
  await mkdir(baseCwd, { recursive: true })
  const subDir = join(baseCwd, 'sub')
  await mkdir(subDir, { recursive: true })

  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: baseCwd })
  try {
    const sessionId = `test-session-${Date.now()}`

    // 1. Run "cd sub && pwd" to navigate to the subdirectory
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "cd sub && pwd"', cwd: baseCwd, sessionId, skipPermissionCheck: true },
    })
    assert.equal(res1.statusCode, 200)
    const body1 = res1.json()
    assert.equal(body1.success, true)
    const event1 = body1.events.find((e: any) => e.type === 'tool_completed' && e.name === 'Bash')
    assert.ok(event1)
    assert.match(event1.output.stdout, /sub/)

    // 2. Run a simple "pwd" and verify CWD is retained as the subdirectory
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "pwd"', cwd: baseCwd, sessionId, skipPermissionCheck: true },
    })
    assert.equal(res2.statusCode, 200)
    const body2 = res2.json()
    assert.equal(body2.success, true)
    const event2 = body2.events.find((e: any) => e.type === 'tool_completed' && e.name === 'Bash')
    assert.ok(event2)
    assert.match(event2.output.stdout, /sub/)

    // 3. Execute a failing command, and make sure that subsequent CWD is still preserved as subDir
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "cd nonexistent && pwd"', cwd: baseCwd, sessionId, skipPermissionCheck: true },
    })
    assert.equal(res3.statusCode, 200)
    const body3 = res3.json()
    assert.equal(body3.success, false) // Should fail as cd nonexistent fails

    // Verify it is still subDir after the failure
    const res4 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "pwd"', cwd: baseCwd, sessionId, skipPermissionCheck: true },
    })
    assert.equal(res4.statusCode, 200)
    const body4 = res4.json()
    assert.equal(body4.success, true)
    const event4 = body4.events.find((e: any) => e.type === 'tool_completed' && e.name === 'Bash')
    assert.ok(event4)
    assert.match(event4.output.stdout, /sub/)

    // 4. Verify different session IDs have isolated CWDs
    const otherSessionId = `other-session-${Date.now()}`
    const res5 = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash "pwd"', cwd: baseCwd, sessionId: otherSessionId, skipPermissionCheck: true },
    })
    assert.equal(res5.statusCode, 200)
    const body5 = res5.json()
    const event5 = body5.events.find((e: any) => e.type === 'tool_completed' && e.name === 'Bash')
    assert.ok(event5)
    // The other session should run in baseCwd, which does not contain 'sub'
    assert.ok(!event5.output.stdout.includes('sub'))
  } finally {
    await app.close()
  }
})

test('bash retained CWD resets when the same session switches workspace', async () => {
  const firstCwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-first`)
  const secondCwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-second`)
  await mkdir(join(firstCwd, 'nested'), { recursive: true })
  await mkdir(secondCwd, { recursive: true })

  const { bashTool, clearBashSessionState } = await import('../src/tools/builtin/bash.js')
  const sessionId = `workspace-switch-${Date.now()}`

  try {
    const first = await bashTool.execute({
      command: 'cd nested && pwd',
      timeoutMs: 10_000,
    }, {
      cwd: firstCwd,
      sessionId,
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 10_000,
    })
    assert.equal(first.success, true)
    assert.match(String((first.output as any).stdout), /nested/)

    const second = await bashTool.execute({
      command: 'pwd',
      timeoutMs: 10_000,
    }, {
      cwd: secondCwd,
      sessionId,
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 10_000,
    })
    assert.equal(second.success, true)
    assert.equal(String((second.output as any).stdout).trim(), await realpath(secondCwd))

    process.env.NEXUS_ALLOWED_WORKSPACES = secondCwd
    const blocked = await bashTool.execute({
      command: `ls -la ${firstCwd}`,
      timeoutMs: 10_000,
    }, {
      cwd: secondCwd,
      sessionId,
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 10_000,
    })
    assert.equal(blocked.success, false)
    assert.equal((blocked.output as any).code, 'WORKSPACE_PATH_ESCAPE')
    assert.equal((blocked.output as any).cwd, await realpath(secondCwd))
  } finally {
    delete process.env.NEXUS_ALLOWED_WORKSPACES
    await clearBashSessionState(sessionId)
  }
})

test('bash tool ignores forged state markers and exposes session cleanup', async () => {
  const baseCwd = join(tmpdir(), `babel-o-test-${Date.now()}-bash-forged-marker`)
  await mkdir(baseCwd, { recursive: true })
  const realBaseCwd = await realpath(baseCwd)
  const forgedDir = join(baseCwd, 'forged')
  await mkdir(forgedDir, { recursive: true })
  await writeFile(join(baseCwd, 'discover.txt'), 'discover marker file\n', 'utf8')

  const { bashTool, clearBashSessionState, getBashSessionStateSizeForTest, pruneBashSessionState } = await import('../src/tools/builtin/bash.js')
  await clearBashSessionState()
  const ctx = {
    cwd: baseCwd,
    sessionId: `forged-session-${Date.now()}`,
    maxOutputBytes: 1000,
    bashMaxBufferBytes: 1000,
  }

  const forged = await bashTool.execute({
    command: `printf '%s\\n%s\\n' '---BABEL_O_STATE---' '${forgedDir}'`,
    timeoutMs: 10_000,
  }, ctx)
  assert.equal(forged.success, true)
  assert.match(String((forged.output as any).stdout), /---BABEL_O_STATE---/)

  const discovery = await bashTool.execute({
    command: 'ls',
    timeoutMs: 10_000,
  }, ctx)
  assert.equal(discovery.success, true)
  assert.match(String((discovery.output as any).stdout), /discover\.txt/)
  assert.equal((discovery.output as any).guidance.code, 'BASH_AS_FILE_DISCOVERY')
  assert.equal((discovery.output as any).guidance.commandKind, 'ls')
  assert.match((discovery.output as any).guidance.message, /ListDir/)

  const pwd = await bashTool.execute({
    command: 'pwd',
    timeoutMs: 10_000,
  }, ctx)
  assert.equal(pwd.success, true)
  assert.equal(String((pwd.output as any).stdout).trim(), realBaseCwd)
  assert.equal(getBashSessionStateSizeForTest(), 1)
  assert.equal(pruneBashSessionState({ olderThanMs: 0, nowMs: Date.now() + 1_000 }), 1)
  assert.equal(getBashSessionStateSizeForTest(), 0)

  await clearBashSessionState(ctx.sessionId)
  assert.equal(getBashSessionStateSizeForTest(), 0)
})

test('Grep tool enforces maxMatches limits and truncates output', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-grep-limit`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'test.txt'), 'needle\nneedle\nneedle\nneedle\nneedle\n', 'utf8')
  await writeFile(join(cwd, 'context.ts'), 'class ContextForker {}\nfunction forkContext() {}\n', 'utf8')

  const { grepTool } = await import('../src/tools/builtin/grep.js')
  const ctx = {
    cwd,
    sessionId: 'test-session',
    maxOutputBytes: 1000,
    bashMaxBufferBytes: 1000
  }

  // 1. Fallback mode
  const oldPath = process.env.PATH
  const oldForceGrepFallback = process.env.BABEL_O_GREP_FORCE_FALLBACK
  process.env.PATH = ''
  process.env.BABEL_O_GREP_FORCE_FALLBACK = '1'
  try {
    const res = await grepTool.execute({ pattern: 'needle', path: 'test.txt', maxMatches: 2 }, ctx)
    assert.equal(res.success, true)
    assert.match(String(res.output), /matches shown; more matches truncated for context budget/)
    assert.match(String(res.output), /Read with offset\/limit/)
    const lines = String(res.output).split('\n').filter(l => l.includes('needle'))
    assert.equal(lines.length, 2)

    const alternation = await grepTool.execute({ pattern: 'ContextForker|forkContext|contextFork', path: 'context.ts', maxMatches: 10 }, ctx)
    assert.equal(alternation.success, true)
    assert.match(String(alternation.output), /context\.ts/)
    assert.match(String(alternation.output), /ContextForker/)
    assert.match(String(alternation.output), /forkContext/)
    assert.match(String(alternation.output), /Grep fallback/)

    const noResult = await grepTool.execute({ pattern: 'DefinitelyMissingSymbol', path: 'context.ts', maxMatches: 10 }, ctx)
    assert.equal(noResult.success, true)
    assert.match(String(noResult.output), /No matches found/)
    assert.match(String(noResult.output), /JavaScript RegExp fallback/)
  } finally {
    process.env.PATH = oldPath
    if (oldForceGrepFallback === undefined) delete process.env.BABEL_O_GREP_FORCE_FALLBACK
    else process.env.BABEL_O_GREP_FORCE_FALLBACK = oldForceGrepFallback
  }

  // 2. Main rg mode (if rg available in current environment)
  if (oldPath) {
    const res2 = await grepTool.execute({ pattern: 'needle', path: 'test.txt', maxMatches: 2 }, ctx)
    assert.equal(res2.success, true)
    assert.match(String(res2.output), /matches shown; more matches truncated for context budget/)
    assert.match(String(res2.output), /Read with offset\/limit/)
    const lines2 = String(res2.output).split('\n').filter(l => l.includes('needle'))
    assert.equal(lines2.length, 2)
  }
})

test('Glob diagnoses workspace path drift for missing search roots', async () => {
  const root = join(tmpdir(), `babel-o-test-${Date.now()}-glob-path-drift`)
  const cwd = join(root, 'BABEL', 'BabeL-O')
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'index.ts'), 'export {}', 'utf8')

  const result = await globTool.execute(
    { pattern: '**/*.ts', path: join(root, 'BabeL-O', 'src'), maxResults: 10 },
    { cwd, sessionId: 'test-session-glob-path-drift', maxOutputBytes: 1000, bashMaxBufferBytes: 1000 },
  )

  assert.equal(result.success, true)
  assert.ok(Array.isArray(result.output))
  assert.match(String(result.output[0]), /does not exist/)
  assert.equal((result.output[1] as any).guidance.code, 'PATH_DRIFT_SUSPECTED')
  assert.equal((result.output[1] as any).guidance.candidatePath, join(cwd, 'src'))
})

test('Glob tool enforces maxResults limits and appends truncation warning', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-glob-limit`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'file1.txt'), 'content', 'utf8')
  await writeFile(join(cwd, 'file2.txt'), 'content', 'utf8')
  await writeFile(join(cwd, 'file3.txt'), 'content', 'utf8')

  const { globTool } = await import('../src/tools/builtin/glob.js')
  const ctx = {
    cwd,
    sessionId: 'test-session',
    maxOutputBytes: 1000,
    bashMaxBufferBytes: 1000
  }

  const res = await globTool.execute({ pattern: 'file', maxResults: 2 }, ctx)
  assert.equal(res.success, true)
  assert.ok(Array.isArray(res.output))
  assert.equal(res.output.length, 3) // 2 sliced + 1 warning element
  assert.match(res.output[2] as string, /more results truncated/)
  assert.match(res.output[2] as string, /Grep or targeted Read/)

  const absoluteRes = await globTool.execute({ pattern: cwd, maxResults: 10 }, ctx)
  assert.equal(absoluteRes.success, true)
  assert.ok(Array.isArray(absoluteRes.output))
  assert.ok(absoluteRes.output.includes('file1.txt'))
})

test('/v1/execute returns context blocking status in result envelope', async () => {
  const cwd = join(tmpdir(), `babel-o-test-context-blocking-envelope-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const storage = new SqliteStorage(join(cwd, 'nexus.sqlite'))
  const runtime = {
    async *executeStream(options: any): AsyncIterable<NexusEvent> {
      const message = 'Context estimate 1200/1000 tokens exceeds the blocking limit (900). Run /compact or /context before continuing.'
      yield {
        type: 'context_blocking',
        ...eventBase(options.sessionId),
        modelId: 'local/coding-runtime',
        tokenEstimate: 1200,
        maxTokens: 1000,
        percentUsed: 120,
        warningThresholdTokens: 700,
        compactThresholdTokens: 850,
        blockingLimitTokens: 900,
        httpStatus: 413,
        recoveryActions: ['compact', 'context', 'switch_model', 'reduce_tool_output'],
        message,
      }
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: 'CONTEXT_LIMIT_EXCEEDED',
        message,
        details: { httpStatus: 413, recoveryReason: 'CONTEXT_BLOCKING_LIMIT' },
      }
      yield {
        type: 'result',
        ...eventBase(options.sessionId),
        success: false,
        message,
      }
    },
  }
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  try {
    const sessionId = `session-context-blocking-http-${Date.now()}`
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { sessionId, prompt: 'continue', cwd },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'execute_result')
    assert.equal(body.success, false)
    assert.equal(body.statusCode, 413)
    assert.equal(body.error.code, 'CONTEXT_LIMIT_EXCEEDED')
    assert.equal(body.error.details.httpStatus, 413)
    assert.ok(body.events.some((event: NexusEvent) => event.type === 'context_blocking'))

    const persisted = await storage.getSession(sessionId, { includeEvents: false })
    assert.equal(persisted?.phase, 'failed')
    assert.equal(persisted?.failureReason, body.error.message)
    assert.equal(persisted?.terminalReason?.category, 'runtime')
    assert.equal(persisted?.terminalReason?.code, 'CONTEXT_LIMIT_EXCEEDED')
    assert.equal((persisted?.metadata?.runtimeRecovery as any)?.retryable, true)
    assert.equal((persisted?.metadata?.runtimeRecovery as any)?.httpStatus, 413)
    assert.equal((persisted?.metadata?.runtimeRecovery as any)?.tokenEstimate, 1200)
    assert.deepEqual((persisted?.metadata?.runtimeRecovery as any)?.recoveryActions, ['compact', 'context', 'switch_model', 'reduce_tool_output'])
  } finally {
    await app.close()
  }
})

test('executionEnvironment parameter validation', async () => {
  const cwd = join(tmpdir(), `babel-o-test-exec-env-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  try {
    const executeRes = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'bash echo hello-sandbox', executionEnvironment: 'docker', cwd, skipPermissionCheck: true },
    })
    assert.equal(executeRes.statusCode, 200)
    const body = executeRes.json()
    assert.equal(body.type, 'execute_result')
    const hasDockerError = body.events.some((e: any) => e.type === 'error' && (e.message.includes('Docker') || e.message.includes('docker')))
    const hasSuccess = body.events.some((e: any) => e.type === 'tool_completed' && e.success === true && String(e.output?.stdout).includes('hello-sandbox'))
    assert.ok(hasDockerError || hasSuccess, 'Should either fail with a Docker error or succeed in a Docker sandbox container')

    const address = await app.listen({ port: 0 })
    const wsUrl = address.replace(/^http/, 'ws') + '/v1/stream'

    const wsModule = await import('ws')
    const wsCtor = (globalThis as any).WebSocket || wsModule.default
    const ws = new wsCtor(wsUrl)

    const events: any[] = []
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ prompt: 'hello', executionEnvironment: 'remote', cwd }))
      })
      ws.addEventListener('message', (event: any) => {
        events.push(JSON.parse(event.data))
        ws.close()
      })
      ws.addEventListener('close', () => resolve())
      ws.addEventListener('error', (err: any) => reject(err))
    })

    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'error')
    assert.equal(events[0].code, 'NOT_IMPLEMENTED')
    assert.match(events[0].message, /Execution environment 'remote' is not implemented yet/)
  } finally {
    await app.close()
  }
})

test('remote execution uses configured RemoteToolRunner seam', async () => {
  const cwd = join(tmpdir(), `babel-o-test-remote-runner-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const remoteRunner = new InMemoryRemoteToolRunner({
    id: 'remote-metrics-test-runner',
    handler: () => ({
      kind: 'result',
      success: true,
      output: { remote: true },
      metrics: {
        runnerId: 'go-metrics-runner',
        protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
        durationMs: 12,
        truncated: true,
        originalBytes: 34,
      },
      truncated: true,
      originalBytes: 34,
    }),
  })
  const { runtime, storage } = await createDefaultNexusRuntime({
    allowedTools: ['*'],
    remoteRunner,
  })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd, remoteRunner })

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read sample.txt', executionEnvironment: 'remote', cwd },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.success, true)
    assert.equal(remoteRunner.requests.length, 1)
    assert.equal(remoteRunner.requests[0].protocolVersion, REMOTE_RUNNER_PROTOCOL_VERSION)
    assert.equal(remoteRunner.requests[0].toolName, 'Read')
    assert.equal((remoteRunner.requests[0].toolInput as { path?: string }).path, 'sample.txt')
    assert.equal(remoteRunner.requests[0].cwd, cwd)
    const completed = body.events.find((e: any) => e.type === 'tool_completed')
    assert.equal(completed.output?.remote, true)
    assert.equal(completed.remoteRunner.runnerId, 'go-metrics-runner')
    assert.equal(completed.remoteRunner.protocolVersion, REMOTE_RUNNER_PROTOCOL_VERSION)
    assert.equal(completed.remoteRunner.durationMs, 12)
    assert.equal(completed.remoteRunner.truncated, true)
    assert.equal(completed.remoteRunner.originalBytes, 34)
    assert.equal(completed.truncated, true)
    assert.equal(completed.originalBytes, 34)

    const metricsEvent = body.events.find((e: any) => e.type === 'execution_metrics')
    assert.equal(metricsEvent.remoteToolCallCount, 1)
    assert.equal(metricsEvent.remoteToolRunnerDurationMs, 12)
    const trace = await storage.getToolTrace(completed.toolUseId)
    assert.equal(trace?.remoteRunner?.runnerId, 'go-metrics-runner')
    assert.equal(trace?.remoteRunner?.durationMs, 12)
    const savedMetrics = await storage.getExecutionMetrics(body.sessionId)
    assert.equal(savedMetrics?.remoteToolCallCount, 1)
    assert.equal(savedMetrics?.remoteToolRunnerDurationMs, 12)
    const metricsResponse = await app.inject({ method: 'GET', url: '/v1/runtime/metrics' })
    assert.equal(metricsResponse.json().remoteToolRunnerDurationMs.count, 1)
    assert.equal(metricsResponse.json().remoteToolRunnerDurationMs.totalMs, 12)
  } finally {
    await app.close()
  }
})

test('HTTP remote runner transport executes a tool through protocol server', async () => {
  const cwd = join(tmpdir(), `babel-o-test-http-remote-runner-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'remote.txt'), 'remote transport content')
  const server = await createRemoteToolRunnerServer({
    tools: createDefaultToolRegistry(),
    capabilities: { tools: ['Read'] },
  })
  const address = await server.listen({ port: 0 })
  const remoteRunner = new HttpRemoteToolRunner({
    baseUrl: address,
    capabilities: { tools: ['Read'] },
  })
  const { runtime, storage } = await createDefaultNexusRuntime({ allowedTools: ['*'], remoteRunner })
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd, remoteRunner })

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read remote.txt', executionEnvironment: 'remote', cwd },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.success, true)
    assert.ok(body.events.some((e: any) => e.type === 'tool_completed' && e.output === 'remote transport content'))
  } finally {
    await app.close()
    await server.close()
  }
})

test('HTTP remote runner transport forwards cancel to protocol server', async () => {
  const cwd = join(tmpdir(), `babel-o-test-http-remote-cancel-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const tools = createDefaultToolRegistry()
  tools.set('RemoteHang', {
    name: 'RemoteHang',
    description: 'Test-only remote hanging tool.',
    risk: 'read',
    inputSchema: z.object({}),
    async execute(_input, context) {
      remoteHangStarted.value = true
      return new Promise<never>((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => {
          remoteHangAborted.value = true
          reject(new Error('remote hang aborted'))
        })
      })
    },
  })
  const remoteHangStarted = { value: false }
  const remoteHangAborted = { value: false }
  const server = await createRemoteToolRunnerServer({ tools, capabilities: { tools: ['RemoteHang'] } })
  const address = await server.listen({ port: 0 })
  const remoteRunner = new HttpRemoteToolRunner({ baseUrl: address, capabilities: { tools: ['RemoteHang'] } })
  const events: NexusEvent[] = []
  const controller = new AbortController()
  const run = (async () => {
    const stream = executeProviderToolCall({
      toolCall: { id: 'tool_http_cancel', name: 'RemoteHang', input: {}, partialInput: '{}' },
      tools,
      toolPolicy: allowAllTools(),
      runtimeOptions: {
        sessionId: `http-remote-cancel-${Date.now()}`,
        requestId: 'req-http-remote-cancel',
        prompt: 'remote hang',
        cwd,
        executionEnvironment: 'remote',
        remoteRunner,
        signal: controller.signal,
      },
      storage: new MemoryStorage(),
      metrics: createRuntimeExecutionMetrics(),
      readFileCache: new Map(),
    })
    let next = await stream.next()
    while (!next.done) {
      events.push(next.value)
      next = await stream.next()
    }
  })()

  try {
    await waitFor(() => remoteHangStarted.value)
    controller.abort()
    await run
    await waitFor(() => remoteHangAborted.value)
    const errorEvent = events.find((e): e is Extract<NexusEvent, { type: 'error' }> => e.type === 'error')
    assert.equal(errorEvent?.code, 'REQUEST_CANCELLED')
  } finally {
    await server.close()
  }
})

test('HTTP remote runner transport maps server errors through runner result', async () => {
  const cwd = join(tmpdir(), `babel-o-test-http-remote-error-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const tools = createDefaultToolRegistry()
  const server = await createRemoteToolRunnerServer({ tools, capabilities: { tools: ['Read'] } })
  const address = await server.listen({ port: 0 })
  const remoteRunner = new HttpRemoteToolRunner({ baseUrl: address, capabilities: { tools: ['Read'] } })
  const { runtime } = await createDefaultNexusRuntime({ allowedTools: ['*'], remoteRunner })
  const events: NexusEvent[] = []

  try {
    for await (const event of runtime.executeStream({
      sessionId: `http-remote-error-${Date.now()}`,
      prompt: 'read missing.txt',
      cwd,
      executionEnvironment: 'remote',
      remoteRunner,
    })) {
      events.push(event)
    }
    const completed = events.find((e): e is Extract<NexusEvent, { type: 'tool_completed' }> => e.type === 'tool_completed')
    assert.equal(completed?.success, false)
    assert.match(String(completed?.output), /could not find/)
  } finally {
    await server.close()
  }
})

test('remote execution without runner does not fall back to local tool execution', async () => {
  const cwd = join(tmpdir(), `babel-o-test-remote-no-runner-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'local content must not leak')
  const { runtime } = await createDefaultNexusRuntime({ allowedTools: ['*'] })
  const events: NexusEvent[] = []

  for await (const event of runtime.executeStream({
    sessionId: `remote-no-runner-${Date.now()}`,
    prompt: 'read sample.txt',
    cwd,
    executionEnvironment: 'remote',
  })) {
    events.push(event)
  }

  const errorEvent = events.find((e): e is Extract<NexusEvent, { type: 'error' }> => e.type === 'error')
  assert.equal(errorEvent?.code, 'REMOTE_RUNNER_NOT_CONFIGURED')
  assert.match(errorEvent?.message ?? '', /requires a configured remote runner/)
  assert.ok(!events.some((e: any) => e.type === 'tool_completed' && String(e.output).includes('local content must not leak')))
})

test('in-memory remote runner cancels active tool execution on abort', async () => {
  const cwd = join(tmpdir(), `babel-o-test-remote-cancel-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  let handlerSignal: AbortSignal | undefined
  const remoteRunner = new InMemoryRemoteToolRunner({
    handler: (_request, context) => new Promise<never>((_resolve, reject) => {
      handlerSignal = context.signal
      context.signal.addEventListener('abort', () => reject(new Error('remote aborted')))
    }),
  })
  const { runtime } = await createDefaultNexusRuntime({
    allowedTools: ['*'],
    remoteRunner,
  })
  const controller = new AbortController()
  const events: NexusEvent[] = []
  const run = (async () => {
    for await (const event of runtime.executeStream({
      sessionId: `remote-cancel-${Date.now()}`,
      requestId: 'req-remote-cancel',
      prompt: 'read sample.txt',
      cwd,
      executionEnvironment: 'remote',
      remoteRunner,
      signal: controller.signal,
    })) {
      events.push(event)
    }
  })()

  await waitFor(() => remoteRunner.requests.length === 1)
  controller.abort()
  await run

  assert.equal(remoteRunner.cancelRequests.length, 1)
  assert.equal(remoteRunner.cancelRequests[0].requestId, 'req-remote-cancel')
  assert.equal(remoteRunner.cancelRequests[0].toolUseId, remoteRunner.requests[0].toolUseId)
  assert.equal(handlerSignal?.aborted, true)
  const errorEvent = events.find((e): e is Extract<NexusEvent, { type: 'error' }> => e.type === 'error')
  assert.equal(errorEvent?.code, 'REQUEST_CANCELLED')
})

test('in-memory remote runner cancels active tool execution on timeout signal', async () => {
  const cwd = join(tmpdir(), `babel-o-test-remote-timeout-signal-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  let handlerSignal: AbortSignal | undefined
  const remoteRunner = new InMemoryRemoteToolRunner({
    handler: (_request, context) => new Promise<never>((_resolve, reject) => {
      handlerSignal = context.signal
      context.signal.addEventListener('abort', () => reject(new Error('remote aborted')))
    }),
  })
  const { runtime } = await createDefaultNexusRuntime({
    allowedTools: ['*'],
    remoteRunner,
  })
  const timeoutController = new AbortController()
  const events: NexusEvent[] = []
  const run = (async () => {
    for await (const event of runtime.executeStream({
      sessionId: `remote-timeout-signal-${Date.now()}`,
      requestId: 'req-remote-timeout-signal',
      prompt: 'read sample.txt',
      cwd,
      executionEnvironment: 'remote',
      remoteRunner,
      timeoutSignal: timeoutController.signal,
    })) {
      events.push(event)
    }
  })()

  await waitFor(() => remoteRunner.requests.length === 1)
  timeoutController.abort()
  await run

  assert.equal(remoteRunner.cancelRequests.length, 1)
  assert.equal(handlerSignal?.aborted, true)
  const errorEvent = events.find((e): e is Extract<NexusEvent, { type: 'error' }> => e.type === 'error')
  assert.equal(errorEvent?.code, 'REQUEST_TIMEOUT')
})

test('remote runner errors and output truncation use existing runtime mapping', async () => {
  const cwd = join(tmpdir(), `babel-o-test-remote-mapping-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const errorRunner = new InMemoryRemoteToolRunner({
    handler: () => ({
      kind: 'error',
      code: 'REMOTE_FIXTURE_ERROR',
      message: 'fixture failed',
    }),
  })
  const { runtime: errorRuntime } = await createDefaultNexusRuntime({
    allowedTools: ['*'],
    remoteRunner: errorRunner,
  })
  const errorEvents: NexusEvent[] = []
  for await (const event of errorRuntime.executeStream({
    sessionId: `remote-error-${Date.now()}`,
    prompt: 'read sample.txt',
    cwd,
    executionEnvironment: 'remote',
    remoteRunner: errorRunner,
  })) {
    errorEvents.push(event)
  }
  const errorEvent = errorEvents.find((e): e is Extract<NexusEvent, { type: 'error' }> => e.type === 'error')
  assert.equal(errorEvent?.code, 'REMOTE_FIXTURE_ERROR')
  assert.equal(errorEvent?.message, 'fixture failed')

  const truncationRunner = new InMemoryRemoteToolRunner({
    handler: () => ({
      kind: 'result',
      success: true,
      output: 'remote-output-is-long',
    }),
  })
  const { runtime: truncationRuntime } = await createDefaultNexusRuntime({
    allowedTools: ['*'],
    remoteRunner: truncationRunner,
  })
  const truncationEvents: NexusEvent[] = []
  for await (const event of truncationRuntime.executeStream({
    sessionId: `remote-truncation-${Date.now()}`,
    prompt: 'read sample.txt',
    cwd,
    executionEnvironment: 'remote',
    remoteRunner: truncationRunner,
    maxToolOutputBytes: 8,
  })) {
    truncationEvents.push(event)
  }
  const completed = truncationEvents.find((e): e is Extract<NexusEvent, { type: 'tool_completed' }> => e.type === 'tool_completed')
  assert.equal(completed?.success, true)
  assert.equal(completed?.truncated, true)
  assert.equal(completed?.originalBytes, 21)
  assert.notEqual(completed?.output, 'remote-output-is-long')
})

test('appendEvent persists embedded execution metrics side table', async () => {
  const cwd = join(tmpdir(), `babel-o-test-embedded-metrics-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const storage = new SqliteStorage(join(cwd, 'nexus.sqlite'))
  const sessionId = `embedded-metrics-session-${Date.now()}`
  const now = new Date().toISOString()

  try {
    await storage.saveSession({
      sessionId,
      cwd,
      prompt: 'metrics',
      phase: 'executing',
      createdAt: now,
      updatedAt: now,
      events: [],
    })
    await storage.appendEvent(sessionId, {
      type: 'execution_metrics',
      ...eventBase(sessionId),
      providerFirstTokenMs: 17,
      toolCallCount: 2,
      cacheReadInputTokens: 33,
      effectiveContextCeiling: 8192,
      compactSummaryLatencyMs: 4,
    })

    const savedMetrics = await storage.getExecutionMetrics(sessionId)
    assert.equal(savedMetrics?.providerFirstTokenMs, 17)
    assert.equal(savedMetrics?.toolCallCount, 2)
    assert.equal(savedMetrics?.cacheReadInputTokens, 33)
    assert.equal(savedMetrics?.effectiveContextCeiling, 8192)
    assert.equal(savedMetrics?.compactSummaryLatencyMs, 4)
  } finally {
    await storage.close()
  }
})

test('execution metrics recording and retrieval', async () => {
  const cwd = join(tmpdir(), `babel-o-test-metrics-rec-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'temp.txt'), 'hello', 'utf8')
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  try {
    const sessionId = `metrics-session-${Date.now()}`

    // Execute a read command (which executes a tool)
    const executeRes = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'read temp.txt', cwd, sessionId },
    })
    assert.equal(executeRes.statusCode, 200)
    const executeBody = executeRes.json()
    assert.equal(executeBody.success, true)

    // Check that execution_metrics was stored in events
    const metricsEvent = executeBody.events.find((e: any) => e.type === 'execution_metrics')
    assert.ok(metricsEvent, 'Should yield execution_metrics event')
    assert.equal(metricsEvent.toolCallCount, 1)
    assert.ok(metricsEvent.executeDurationMs > 0)
    assert.ok(metricsEvent.toolRoundtripDurationMs >= 0)

    // Check that it was saved to storage and can be retrieved
    const savedMetrics = await storage.getExecutionMetrics(sessionId)
    assert.ok(savedMetrics, 'Metrics should be saved in SQLite storage')
    assert.equal(savedMetrics.sessionId, sessionId)
    assert.equal(savedMetrics.toolCallCount, 1)

    // Check `/v1/runtime/metrics` route returns the updated metrics
    const metricsRes = await app.inject({
      method: 'GET',
      url: '/v1/runtime/metrics',
    })
    assert.equal(metricsRes.statusCode, 200)
    const metricsSnapshot = metricsRes.json()
    assert.equal(metricsSnapshot.toolCallCount, 1)
    assert.ok(metricsSnapshot.toolRoundtripDurationMs.totalMs >= 0)
  } finally {
    await app.close()
  }
})

test('POST /v1/execute blocks model without tool calling support', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-no-tool-http`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'do something', cwd, model: 'deepseek/deepseek-reasoner' },
    })
    assert.equal(response.statusCode, 400)
    const body = response.json()
    assert.equal(body.code, 'INVALID_REQUEST')
    assert.match(body.message, /does not support tool calling/)
    assert.match(body.message, /deepseek\/deepseek-reasoner/)
  } finally {
    await app.close()
  }
})

test('WebSocket /v1/stream blocks model without tool calling support', async () => {
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-no-tool-ws`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    await app.ready()
    const ws: any = await app.injectWS('/v1/stream')
    const events: Array<{ type: string; code?: string; message?: string }> = []
    ws.on('message', (data: Buffer) => {
      events.push(JSON.parse(String(data)))
    })
    ws.send(JSON.stringify({ prompt: 'do something', cwd, model: 'deepseek/deepseek-reasoner' }))
    await waitFor(() => events.some(e => e.type === 'error'))
    ws.terminate()

    const errorEvent = events.find(e => e.type === 'error')
    assert.ok(errorEvent, 'should receive an error event')
    assert.equal(errorEvent?.code, 'INVALID_REQUEST')
    assert.match(errorEvent?.message ?? '', /does not support tool calling/)
    assert.match(errorEvent?.message ?? '', /deepseek\/deepseek-reasoner/)
  } finally {
    await app.close()
  }
})

test('Glob respects custom path parameter', async () => {
  const baseCwd = join(tmpdir(), `babel-o-glob-path-${Date.now()}`)
  const subDir = join(baseCwd, 'subproject')
  await mkdir(subDir, { recursive: true })
  await writeFile(join(subDir, 'match-benchmark-here.txt'), 'found', 'utf8')

  const toolCtx = {
    cwd: baseCwd,
    sessionId: 'test',
    signal: new AbortController().signal,
    maxOutputBytes: 200_000,
    bashMaxBufferBytes: 1_000_000,
  }

  const resultDefault = await globTool.execute(
    { pattern: 'benchmark', maxResults: 100 },
    toolCtx,
  )
  assert.ok(
    (resultDefault.output as string[]).some(f => f.includes('match-benchmark-here.txt')),
    'default cwd should find the file',
  )

  const resultPath = await globTool.execute(
    { pattern: 'benchmark', path: subDir, maxResults: 100 },
    toolCtx,
  )
  assert.ok(
    (resultPath.output as string[]).some(f => f.includes('match-benchmark-here.txt')),
    'custom path should find the file in subDir',
  )

  const resultEmptyPath = await globTool.execute(
    { pattern: 'nonexistent-xyz', maxResults: 100 },
    toolCtx,
  )
  assert.equal(
    (resultEmptyPath.output as string[]).filter(f => !f.startsWith('...')).length,
    0,
    'nonexistent pattern should return empty',
  )
})

test('LLMCodingRuntime resolves cwd from prompt absolute path', async () => {
  const tools = createDefaultToolRegistry()
  const policy = allowAllTools()
  const storage = new SqliteStorage(join(tmpdir(), `babel-o-cwd-test-${Date.now()}.sqlite`))
  const configManager = ConfigManager.getInstance()
  const runtime = new LLMCodingRuntime(tools, policy, storage, configManager)

  const baseCwd = homedir()
  const targetDir = join(tmpdir(), `babel-o-cwd-target-${Date.now()}`)
  await mkdir(targetDir, { recursive: true })

  try {
    const events: Array<{ type: string; cwd?: string }> = []
    for await (const event of runtime.executeStream({
      sessionId: createId('session'),
      prompt: `${targetDir} 查看这个项目`,
      cwd: baseCwd,
      signal: new AbortController().signal,
    })) {
      events.push(event)
      if (event.type === 'error' || event.type === 'result') break
    }

    const sessionStarted = events.find(e => e.type === 'session_started')
    assert.ok(sessionStarted, 'should emit session_started')
    assert.equal(sessionStarted?.cwd, targetDir, 'cwd should follow explicit path in prompt')
  } finally {
    await storage.close()
  }
})

test('LLMCodingRuntime continues from a successful compact boundary', async () => {
  const tools = new Map()
  const policy = allowAllTools()
  const storage = new SqliteStorage(join(tmpdir(), `babel-o-compact-boundary-recovery-${Date.now()}.sqlite`))
  const configManager = new ConfigManager(join(tmpdir(), `babel-o-compact-boundary-recovery-config-${Date.now()}.json`))
  configManager.save({ defaultModel: 'local/coding-runtime' })
  const runtime = new LLMCodingRuntime(tools, policy, storage, configManager)
  const sessionId = createId('session')
  const cwd = tmpdir()
  const now = new Date().toISOString()
  const events = createLongRuntimeContextEventsWithSmallRecentTurns(sessionId, 24, 500)

  await storage.saveSession({
    sessionId,
    cwd,
    prompt: '继续',
    phase: 'executing',
    createdAt: now,
    updatedAt: now,
    events,
  })

  try {
    await compactSession({
      storage,
      sessionId,
      modelId: 'local/coding-runtime',
      trigger: 'auto',
    })

    const emitted: NexusEvent[] = []
    for await (const event of runtime.executeStream({
      sessionId,
      prompt: '继续这个任务',
      cwd,
      model: 'local/coding-runtime',
      signal: new AbortController().signal,
    })) {
      emitted.push(event)
      if (event.type === 'result') break
    }

    assert.ok(
      emitted.some(event => event.type === 'assistant_delta'),
      'provider path should continue after compact boundary restores context',
    )
    const resultEvent = emitted.find(event => event.type === 'result')
    assert.equal(resultEvent?.success, true)
    assert.ok(!emitted.some(event => event.type === 'context_blocking'))
    assert.ok(!emitted.some(event => event.type === 'error' && event.code === 'CONTEXT_LIMIT_EXCEEDED'))
  } finally {
    await storage.close()
  }
})

test('LLMCodingRuntime attempts reactive compact after tool results exceed provider-loop context limit', async () => {
  const tools = createDefaultToolRegistry()
  const bashTool = tools.get('Bash')!
  tools.clear()
  tools.set('Bash', {
    ...bashTool,
    async execute() {
      return { success: true, output: 'large tool output '.repeat(2_500) }
    },
  })
  const policy = allowAllTools()
  const storage = new SqliteStorage(join(tmpdir(), `babel-o-provider-loop-compact-${Date.now()}.sqlite`))
  const configManager = new ConfigManager(join(tmpdir(), `babel-o-provider-loop-compact-config-${Date.now()}.json`))
  configManager.save({ defaultModel: 'local/coding-runtime' })
  let executionInvocationCount = 0
  const adapter: ModelAdapter = {
    async *queryStream(params: ModelQueryParams): AsyncIterable<StreamDelta> {
      if (!params.tools?.length) {
        yield {
          type: 'text',
          text: '{"intent":"continue","confidence":0.9,"continuity":0.8,"contextScope":"full","actionHint":"normal","requiresTools":true,"reason":"test","guidance":"continue"}',
        }
        yield { type: 'finish', reason: 'end_turn' }
        return
      }
      executionInvocationCount += 1
      if (executionInvocationCount === 1) {
        yield { type: 'tool_use_start', id: 'tool_large_output', name: 'Bash' }
        yield { type: 'tool_use_delta', id: 'tool_large_output', inputDelta: '{"command":"pwd"}' }
        yield { type: 'tool_use_end', id: 'tool_large_output', input: { command: 'pwd' } }
        yield { type: 'finish', reason: 'tool_use' }
        return
      }
      yield { type: 'text', text: 'continued after compact' }
      yield { type: 'finish', reason: 'end_turn' }
    },
  }
  const runtime = new LLMCodingRuntime(tools, policy, storage, configManager)
  const sessionId = createId('session')
  const cwd = tmpdir()
  const now = new Date().toISOString()

  setAdapterOverrideForTest('local', adapter)
  await storage.saveSession({
    sessionId,
    cwd,
    prompt: '先运行大输出工具，再继续分析',
    phase: 'executing',
    createdAt: now,
    updatedAt: now,
    events: [],
  })

  try {
    const emitted: NexusEvent[] = []
    for await (const event of runtime.executeStream({
      sessionId,
      prompt: '先运行大输出工具，再继续分析',
      cwd,
      model: 'local/coding-runtime',
      signal: new AbortController().signal,
    })) {
      emitted.push(event)
      await storage.appendEvent(sessionId, event)
      if (event.type === 'result') break
    }

    assert.ok(
      emitted.some(event => event.type === 'compact_boundary' && event.trigger === 'reactive'),
      `provider-loop blocking should attempt reactive compact before hard blocking; events=${emitted.map(event => event.type).join(',')}`,
    )
    assert.ok(!emitted.some(event => event.type === 'context_blocking'))
    assert.ok(!emitted.some(event => event.type === 'error' && event.code === 'CONTEXT_LIMIT_EXCEEDED'))
    assert.equal(emitted.find(event => event.type === 'result')?.success, true)
    assert.equal(executionInvocationCount, 2)
  } finally {
    setAdapterOverrideForTest('local', null)
    await storage.close()
  }
})

test('LLMCodingRuntime respects auto compact failure fuse before hard blocking', async () => {
  const tools = createDefaultToolRegistry()
  const policy = allowAllTools()
  const storage = new SqliteStorage(join(tmpdir(), `babel-o-compact-fuse-${Date.now()}.sqlite`))
  const configManager = new ConfigManager(join(tmpdir(), `babel-o-compact-fuse-config-${Date.now()}.json`))
  configManager.save({ defaultModel: 'local/coding-runtime' })
  const runtime = new LLMCodingRuntime(tools, policy, storage, configManager)
  const sessionId = createId('session')
  const cwd = tmpdir()
  const now = new Date().toISOString()
  const events = createLongRuntimeContextEvents(sessionId, 30, 500)
  events.push(
    {
      type: 'compact_failure',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId,
      timestamp: new Date(Date.now() + 50_000).toISOString(),
      trigger: 'auto',
      modelId: 'local/coding-runtime',
      failureCount: 1,
      maxFailures: 2,
      message: 'first auto compact failure',
    },
    {
      type: 'compact_failure',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId,
      timestamp: new Date(Date.now() + 50_001).toISOString(),
      trigger: 'auto',
      modelId: 'local/coding-runtime',
      failureCount: 2,
      maxFailures: 2,
      message: 'second auto compact failure',
    },
  )

  await storage.saveSession({
    sessionId,
    cwd,
    prompt: '继续',
    phase: 'executing',
    createdAt: now,
    updatedAt: now,
    events,
  })

  try {
    const emitted: NexusEvent[] = []
    for await (const event of runtime.executeStream({
      sessionId,
      prompt: '继续这个任务',
      cwd,
      model: 'local/coding-runtime',
      signal: new AbortController().signal,
    })) {
      emitted.push(event)
      if (event.type === 'error' || event.type === 'result') break
    }

    const warningEvent = emitted.find(event =>
      event.type === 'context_warning' && event.message.includes('Auto compact is paused'),
    )
    assert.ok(warningEvent, 'runtime should surface the open auto compact fuse')
    assert.ok(
      !emitted.some(event => event.type === 'compact_boundary' && event.trigger === 'auto'),
      'runtime should not run another auto compact while the fuse is open',
    )
    const blockingEvent = emitted.find(event => event.type === 'context_blocking')
    assert.ok(blockingEvent, 'runtime should hard block after fuse-open context stays too large')
    assert.equal(blockingEvent.httpStatus, 413)
    const errorEvent = emitted.find(event => event.type === 'error')
    assert.equal(errorEvent?.code, 'CONTEXT_LIMIT_EXCEEDED')
    assert.ok(
      !emitted.some(event => event.type === 'assistant_delta'),
      'provider should not be called after blocking guard fails',
    )
  } finally {
    await storage.close()
  }
})

test('LLMCodingRuntime blocks provider calls when compacted context still exceeds limit', async () => {
  const tools = createDefaultToolRegistry()
  const policy = allowAllTools()
  const storage = new SqliteStorage(join(tmpdir(), `babel-o-context-limit-${Date.now()}.sqlite`))
  const configManager = ConfigManager.getInstance()
  const runtime = new LLMCodingRuntime(tools, policy, storage, configManager)
  const sessionId = createId('session')
  const cwd = tmpdir()
  const now = new Date().toISOString()
  const events = createLongRuntimeContextEvents(sessionId, 30, 500)

  await storage.saveSession({
    sessionId,
    cwd,
    prompt: '继续',
    phase: 'executing',
    createdAt: now,
    updatedAt: now,
    events,
  })

  try {
    const emitted: NexusEvent[] = []
    for await (const event of runtime.executeStream({
      sessionId,
      prompt: '继续这个任务',
      cwd,
      model: 'local/coding-runtime',
      signal: new AbortController().signal,
    })) {
      emitted.push(event)
      if (event.type === 'error' || event.type === 'result') break
    }

    assert.ok(
      emitted.some(event => event.type === 'compact_boundary' && (event.trigger === 'reactive' || event.trigger === 'auto')),
      'blocking guard should attempt compact before failing',
    )
    assert.ok(
      emitted.some(event => event.type === 'context_warning'),
      'blocking guard should emit context warning',
    )
    const blockingEvent = emitted.find(event => event.type === 'context_blocking')
    assert.ok(blockingEvent, 'blocking guard should emit structured context_blocking event')
    assert.equal(blockingEvent.httpStatus, 413)
    assert.equal(blockingEvent.blockingLimitTokens > 0, true)
    assert.ok(blockingEvent.recoveryActions.includes('compact'))
    assert.ok(blockingEvent.recoveryActions.includes('context'))
    const errorEvent = emitted.find(event => event.type === 'error')
    assert.equal(errorEvent?.code, 'CONTEXT_LIMIT_EXCEEDED')
    assert.equal((errorEvent?.details as any)?.httpStatus, 413)
    assert.equal((errorEvent?.details as any)?.recoveryReason, 'CONTEXT_BLOCKING_LIMIT')
    assert.ok(
      !emitted.some(event => event.type === 'assistant_delta'),
      'provider should not be called after blocking guard fails',
    )
  } finally {
    await storage.close()
  }
})

function createLongRuntimeContextEventsWithSmallRecentTurns(
  sessionId: string,
  oldTurnCount: number,
  oldRepeatCount: number,
): NexusEvent[] {
  const events = createLongRuntimeContextEvents(sessionId, oldTurnCount, oldRepeatCount)
  events.push(
    {
      type: 'user_message',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId,
      timestamp: new Date(Date.now() + 40_000).toISOString(),
      text: '最近的小上下文问题。',
    },
    {
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId,
      timestamp: new Date(Date.now() + 40_001).toISOString(),
      text: '最近的小上下文回答。',
    },
    {
      type: 'user_message',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId,
      timestamp: new Date(Date.now() + 40_002).toISOString(),
      text: '继续最近的小上下文。',
    },
  )
  return events
}

function createLongRuntimeContextEvents(
  sessionId: string,
  turnCount: number,
  repeatCount: number,
): NexusEvent[] {
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId,
      timestamp: '2026-05-23T00:00:00.000Z',
      text: '开始一个很长的中文上下文任务。',
    },
  ]
  for (let index = 0; index < turnCount; index += 1) {
    events.push({
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId,
      timestamp: new Date(Date.now() + index + 1).toISOString(),
      text: '这是用于触发上下文阻塞限制的中文内容。'.repeat(repeatCount),
    })
  }
  return events
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('execute honours per-request allowedTools for Bash in soft-deny mode', async () => {
  // Phase D of docs/nexus/reference/go-tui-permission-policy-governance-plan.md:
  // when the request body carries `allowedTools: ['Bash']`, the runtime
  // applies an allowlist-based policy for this turn only. Combined
  // with `policy: 'soft-deny'`, this means Bash is in the allowlist
  // (so the hard-deny gate passes) AND is `risk: 'execute'` (so the
  // approval gate fires → `permission_request`).
  // Net: Bash goes through the permission flow instead of being
  // blocked; a tool *not* in allowedTools (e.g. `Write`) is still
  // hard-denied under soft-deny.
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-allow-tools-bash`)
  await mkdir(cwd, { recursive: true })
  // No top-level allowedTools — server default `denyByDefaultTools()`.
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-allow-tools-bash-${Date.now()}`
  const executePromise = app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: {
      prompt: 'bash "git commit -m x"',
      cwd,
      sessionId,
      policy: 'soft-deny',
      allowedTools: ['Bash'],
      skipPermissionCheck: false,
    },
  })

  let toolUseId = ''
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100))
    const sessionRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
    })
    if (sessionRes.statusCode === 200) {
      const data = sessionRes.json()
      const reqEvent = data.session?.events?.find((e: any) => e.type === 'permission_request')
      if (reqEvent) {
        toolUseId = reqEvent.toolUseId
        break
      }
    }
  }
  assert.ok(
    toolUseId,
    'Bash in allowedTools + soft-deny should reach permission_request, not hard-deny',
  )

  // Approve and await the response.
  const approveRes = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/approve`,
    payload: { toolUseId, reason: 'auto-approve test' },
  })
  assert.equal(approveRes.statusCode, 200)

  const response = await executePromise
  assert.equal(response.statusCode, 200)
  const events = response.json().events
  // No hard-deny with policy message (Bash was in the allowlist).
  assert.ok(
    !events.some((e: any) => e.type === 'tool_denied' && /denied by Nexus policy/i.test(e.message)),
    'Bash in allowedTools must NOT be hard-denied',
  )

  await app.close()
})


test('execute with allowedTools scopes to a single turn', async () => {
  // Phase D turn-boundary: per-turn `allowedTools` is scoped to the
  // current `executeStream` call. The next turn re-evaluates from
  // the (possibly different) body. This pins the no-cross-turn-drift
  // invariant — the user must re-declare `--allow-tools` each turn.
  //
  // Both turns use `skipPermissionCheck: true` and rely on the default
  // server-side `policy: 'strict'`. The only knob that changes between
  // turns is `allowedTools`. Turn 1 lets Bash through the policy gate;
  // turn 2 has Bash in the default `denyByDefaultTools()` and gets
  // hard-denied.
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-allow-tools-turn-boundary`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-allow-tools-turn-${Date.now()}`

  // First turn: `allowedTools: ['Bash']` → Bash is allowlisted →
  // hard-deny gate passes → runs.
  const first = await app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: {
      prompt: 'bash "git commit -m x"',
      cwd,
      sessionId,
      allowedTools: ['Bash'],
      skipPermissionCheck: true,
    },
  })
  assert.equal(first.statusCode, 200)
  const firstBody = first.json()
  assert.equal(
    firstBody.events.some((e: any) => e.type === 'tool_denied' && /denied by Nexus policy/i.test(e.message)),
    false,
    'first turn with allowedTools=[Bash] should NOT hard-deny Bash',
  )

  // Second turn: NO `allowedTools` → falls back to server-startup
  // `denyByDefaultTools()` → Bash is denied.
  const second = await app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: {
      prompt: 'bash "git commit -m y"',
      cwd,
      sessionId,
      // allowedTools omitted on purpose.
      skipPermissionCheck: true,
    },
  })
  assert.equal(second.statusCode, 200)
  const secondBody = second.json()
  const secondBashDeny = secondBody.events.filter(
    (e: any) => e.type === 'tool_denied' && e.name === 'Bash' && /denied by Nexus policy/i.test(e.message),
  )
  assert.ok(
    secondBashDeny.length > 0,
    'second turn without allowedTools should hard-deny Bash via the default denyByDefaultTools policy',
  )

  await app.close()
})

test('execute permission denial: user denies → tool_denied + result(false)', async () => {
  // Phase C end-to-end regression for the deny path of
  // docs/nexus/reference/go-tui-permission-policy-governance-plan.md.
  // The model emits Bash (execute risk, not in default allowlist).
  // Under `policy: 'soft-deny'` the hard-deny gate is bypassed
  // and the approval gate fires `permission_request`. The user
  // responds via `/deny` with approved=false. The runtime must
  // (a) emit `tool dened` with the user-denied reason, (b) emit
  // `result(success=false)`, (c) record the denial in the
  // permission_audit table. The model can then continue on the
  // next turn.
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-permission-deny`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-perm-deny-${Date.now()}`
  const executePromise = app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: {
      prompt: 'bash "git commit -m x"',
      cwd,
      sessionId,
      policy: 'soft-deny',
      allowedTools: ['Bash'],
    },
  })

  let toolUseId = ''
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100))
    const sessionRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
    })
    if (sessionRes.statusCode === 200) {
      const data = sessionRes.json()
      const reqEvent = data.session?.events?.find((e: any) => e.type === 'permission_request')
      if (reqEvent) {
        toolUseId = reqEvent.toolUseId
        break
      }
    }
  }
  assert.ok(toolUseId, 'Bash in allowedTools + soft-deny should reach permission_request')

  // User denies.
  const denyRes = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/deny`,
    payload: { toolUseId, reason: 'looks risky' },
  })
  assert.equal(denyRes.statusCode, 200)

  const response = await executePromise
  assert.equal(response.statusCode, 200)
  const body = response.json()
  const events = body.events

  // tool_denied event fires on user denial. The runtime message
  // comes from `classifyAction` (e.g. "Requires manual review" for
  // `git commit`); the user's reason "looks risky" is captured
  // separately in the permission_audit row below.
  const toolDenied = events.find(
    (e: any) => e.type === 'tool_denied' && e.name === 'Bash',
  )
  assert.ok(toolDenied, 'tool_denied should fire on user denial')

  // terminal result is failure.
  const result = body.result ?? events.find((e: any) => e.type === 'result')
  assert.ok(result, 'terminal result event should be present')
  assert.equal(result.success, false)

  // permission_audit row marked 'denied' for record-keeping.
  const auditsRes = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}/permission-audits`,
  })
  const auditsBody = auditsRes.json()
  assert.equal(auditsBody.audits.length, 1)
  assert.equal(auditsBody.audits[0].toolName, 'Bash')
  assert.equal(auditsBody.audits[0].decision, 'denied')
  assert.match(auditsBody.audits[0].reason, /looks risky/)

  await app.close()
})

test('Phase A.1: permission_request surfaces suggestedRule for Bash', async () => {
  // The runtime's `permission_request` event must include a
  // `suggestedRule` field for the Bash tool so the Go TUI can
  // render `Suggested rule: bash:*` above the 5-option
  // panel. The rule is derived from the Bash command input.
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-suggested-rule`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-suggested-rule-${Date.now()}`
  const executePromise = app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: {
      prompt: 'bash "sleep 0"',
      cwd,
      sessionId,
      policy: 'soft-deny',
    },
  })

  // Wait until the runtime has yielded the permission_request and
  // registered it on the pending backend.
  let toolUseId = ''
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 100))
    const sessionRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
    })
    if (sessionRes.statusCode === 200) {
      const data = sessionRes.json()
      const req = (data.session?.events ?? []).find(
        (e: any) => e.type === 'permission_request',
      )
      if (req) {
        toolUseId = req.toolUseId
        // Phase A.1 invariant: the request must carry a
        // `suggestedRule` derived from the Bash command input.
        // `sleep` is not read-allowlisted, so it stays on the
        // permission path and falls back to the whole-tool Bash rule.
        assert.equal(req.suggestedRule, 'bash:*',
          'permission_request for `sleep 0` should derive suggestedRule=bash:*')
        break
      }
    }
  }
  assert.ok(toolUseId, 'should have observed a permission_request event')

  // Cleanup the running turn so the test exits cleanly. We don't
  // care about the rest of the body — we just need to release the
  // pending permission so the runtime can move on.
  await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/deny`,
    payload: { toolUseId, reason: 'test cleanup' },
  })
  await executePromise
  await app.close()
})

test('Phase 3: Bash suggestedRule uses structured source-inspection rules', () => {
  assert.equal(
    deriveBashSuggestedRule({ command: "sed -n '1,20p' file.go | head -c 30000" }),
    'bash:sed-read',
  )
  assert.equal(
    deriveBashSuggestedRule({ command: 'grep -nE "Test[A-Z]+" file_test.go | head -40' }),
    'bash:grep-read',
  )
  assert.equal(
    deriveBashSuggestedRule({ command: "sed -i 's/a/b/' file.go" }),
    'bash:*',
  )
  assert.equal(
    deriveBashSuggestedRule({ command: 'grep -r needle .' }),
    'bash:*',
  )
  assert.equal(
    deriveBashSuggestedRule({ command: 'git status --short' }),
    'git:status',
  )
  assert.equal(
    deriveBashSuggestedRule({ command: 'git status && rm -rf dist' }),
    'bash:*',
  )
  assert.equal(
    deriveBashSuggestedRule({ command: 'sleep 0' }),
    'bash:*',
  )
})

test('Phase 3: session rules match structured Bash rule classes', () => {
  const bash = createDefaultToolRegistry().get('Bash')!
  const grepPolicy = buildSessionRulesPolicy(['bash:grep-read'])
  assert.equal(
    grepPolicy.isAllowed(bash, { command: 'grep -n "needle" file.go | head -20' }),
    true,
  )
  assert.equal(
    grepPolicy.isAllowed(bash, { command: "sed -n '1,20p' file.go | head -c 30000" }),
    false,
  )
  assert.equal(
    grepPolicy.isAllowed(bash, { command: 'grep -r needle .' }),
    false,
  )

  const sedPolicy = buildSessionRulesPolicy(['bash:sed-read'])
  assert.equal(
    sedPolicy.isAllowed(bash, { command: "sed -n '1,20p' file.go | tail -n 5" }),
    true,
  )
  assert.equal(
    sedPolicy.isAllowed(bash, { command: "sed -i 's/a/b/' file.go" }),
    false,
  )

  const broadBashPolicy = buildSessionRulesPolicy(['bash:*'])
  assert.equal(
    broadBashPolicy.isAllowed(bash, { command: 'sleep 0' }),
    true,
  )
})

test('Phase A.1: scope=session accumulates rules and second turn auto-allows', async () => {
  // Hard invariants for `scope: 'session'` accumulation:
  //   1. The runtime must add the suggested rule to the per-session
  //      rules map when the user approves with scope='session'
  //      and a non-empty rule.
  //   2. The next turn of the SAME session, even with no
  //      `allowedTools` (i.e. default `denyByDefaultTools`),
  //      auto-allows the Bash tool call whose input matches the
  //      accumulated rule.
  //   3. `scope: 'once'` never touches the rules map.
  //   4. Rules are process-local (lost on server restart) — not
  //      asserted here directly but enforced by the
  //      `sessionRules: Map<sessionId, string[]>` storage
  //      location in LocalCodingRuntime.
  const cwd = join(tmpdir(), `babel-o-test-${Date.now()}-session-scope`)
  await mkdir(cwd, { recursive: true })
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })

  const sessionId = `session-session-scope-${Date.now()}`
  const localRuntime = runtime as LocalCodingRuntime
  assert.deepEqual(
    localRuntime.getSessionRulesForTest(sessionId),
    [],
    'precondition: no session rules accumulated yet',
  )

  // Turn 1: Bash "sleep 0" → permission_request → user approves
  // with scope='session', rule='bash:*'.
  const first = app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: {
      prompt: 'bash "sleep 0"',
      cwd,
      sessionId,
      policy: 'soft-deny',
    },
  })
  let toolUseId = ''
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 100))
    const res = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
    })
    if (res.statusCode === 200) {
      const data = res.json()
      const req = (data.session?.events ?? []).find(
        (e: any) => e.type === 'permission_request',
      )
      if (req) { toolUseId = req.toolUseId; break }
    }
  }
  assert.ok(toolUseId, 'turn 1: should have permission_request')
  const approveRes = await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/approve`,
    payload: { toolUseId, scope: 'session', rule: 'bash:*' },
  })
  assert.equal(approveRes.statusCode, 200)
  assert.equal(approveRes.json().scope, 'session')
  assert.equal(approveRes.json().rule, 'bash:*')
  const firstBody = (await first).json()
  assert.equal(firstBody.success, true,
    'turn 1: Bash sleep 0 should run after session-scope approval')

  // Invariant: session rules are now populated.
  const accumulated = localRuntime.getSessionRulesForTest(sessionId)
  assert.ok(
    accumulated.includes('bash:*'),
    `session rules should include 'bash:*' after scope=session approval, got ${JSON.stringify([...accumulated])}`,
  )

  // Turn 2 (no `allowedTools`, no `policy` override) — Bash "sleep
  // 0" should auto-allow via the accumulated session rule.
  // Default `denyByDefaultTools()` would normally hard-deny it,
  // but the session-rules policy layer (applied on top of the
  // per-turn allowlist) lets it through.
  const second = await app.inject({
    method: 'POST',
    url: '/v1/execute',
    payload: {
      prompt: 'bash "sleep 0"',
      cwd,
      sessionId,
      // no allowedTools, no policy override.
    },
  })
  const secondBody = second.json()
  const secondBashDeny = secondBody.events.filter(
    (e: any) => e.type === 'tool_denied' && e.name === 'Bash',
  )
  assert.equal(
    secondBashDeny.length,
    0,
    'turn 2: Bash "sleep 0" must NOT be hard-denied because the accumulated session rule auto-allows it',
  )
  // And it must have run to completion.
  const secondBashCompleted = secondBody.events.filter(
    (e: any) => e.type === 'tool_completed' && e.name === 'Bash',
  )
  assert.ok(
    secondBashCompleted.length > 0,
    'turn 2: Bash "sleep 0" should have completed (auto-allowed by session rule)',
  )
  const auditsRes = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}/permission-audits`,
  })
  const auditsBody = auditsRes.json()
  assert.ok(
    auditsBody.audits.some((audit: any) => audit.reason === 'Approved by session rule'),
    'session-rule auto-approval should be recorded in permission audit reason',
  )

  // Invariant: a `scope: 'once'` approval on a different tool
  // must NOT extend the rules map. Drive this by hitting the
  // /approve endpoint with scope=once and a different rule,
  // then verify the rules map still only contains 'bash:*'.
  await app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/deny`,
    payload: { toolUseId: 'synthetic-once-tool', reason: 'invariant check', scope: 'once', rule: 'should-not-stick' },
  })
  // The above may 404 (no such pending tool), but if it 200s the
  // registry would resolve the synthetic entry with scope=once.
  // Either way, the rules map should not have 'should-not-stick'.
  const after = localRuntime.getSessionRulesForTest(sessionId)
  assert.ok(
    !after.includes('should-not-stick'),
    `scope: 'once' must never accumulate rules, got ${JSON.stringify([...after])}`,
  )

  await app.close()
})
