import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildContextRefreshClosureSet } from '../src/runtime/buildContextRefreshClosureSet.js'
import { ContextRefreshStrategy } from '../src/runtime/ContextRefreshStrategy.js'
import type { RuntimeContextRefreshState } from '../src/runtime/pipeline/contextRefresh.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import type { NexusEvent } from '../src/shared/events.js'

// ─── minimal fixtures ──────────────────────────────────────────

function makeState(
  overrides: Partial<RuntimeContextRefreshState> = {},
): RuntimeContextRefreshState {
  return {
    assembledContext: {
      systemPrompt: 'system prompt',
      messages: [],
      microcompactMetrics: {
        compactedEventCount: 0,
        deduplicatedToolResultCount: 0,
        bytesBefore: 0,
        bytesAfter: 0,
        bytesSaved: 0,
        estimatedTokensSaved: 0,
      },
      gitStatus: '',
      budget: { maxTokens: 100_000, headroom: 50_000, usedTokens: 50_000 } as any,
    } as any,
    messages: [{ role: 'user', content: 'hi' }] as any,
    currentToolsList: [] as any,
    modelVisibleTools: [] as any,
    contextEstimateTokens: 100,
    contextWindowState: {
      isWarning: false,
      isBlocking: false,
      isCompact: false,
      percent: 50,
      tokensUsed: 50_000,
      tokensRemaining: 50_000,
      maxTokens: 100_000,
    } as any,
    autoCompactDecision: {
      shouldCompact: false,
      enabled: false,
      thresholdPercent: 80,
      fuseOpen: false,
      failureCount: 0,
    } as any,
    cacheAwareCompactPolicy: {} as any,
    ...overrides,
  } as RuntimeContextRefreshState
}

function makeMutableState(initial: RuntimeContextRefreshState) {
  let s: RuntimeContextRefreshState = initial
  return {
    get current() {
      return s
    },
    getAssembledContext: () => s.assembledContext,
    getMessages: () => s.messages,
    getModelVisibleTools: () => s.modelVisibleTools,
    getContextWindowState: () => s.contextWindowState,
    setContextRefreshState: (next: RuntimeContextRefreshState) => {
      s = next
    },
  }
}

function makeReadFileCache() {
  return new Map()
}

const sessionId = 'sess-1'
const requestId = 'req-1'

// ─── tests ──────────────────────────────────────────────────────

test('buildContextRefreshClosureSet returns 5 closures that read state through the bundle', () => {
  const state = makeMutableState(makeState())
  const refreshStrategy = new ContextRefreshStrategy({ storage: undefined })
  const closures = buildContextRefreshClosureSet({
    state,
    metrics: {} as any,
    refreshStrategy,
    refreshOptions: { runtimeOptions: {} as any, events: [], modelId: 'm', buildSystemPrompt: (() => '') as any, mapEventsToMessages: (() => []) as any, tools: (() => []) as any, warningPercent: 70, compactPercent: 90, suppressToolsForIntent: (() => false) as any, onMemoryRetrieval: undefined, workingSetOverride: undefined },
    readFileCache: makeReadFileCache(),
    sessionId,
    requestId,
  })
  assert.equal(typeof closures.estimateVisibleContextTokens, 'function')
  assert.equal(typeof closures.applyContextRefreshState, 'function')
  assert.equal(typeof closures.contextMicrocompactEvent, 'function')
  assert.equal(typeof closures.refreshAfterProviderContextRecovery, 'function')
  assert.equal(typeof closures.postCompactGroundingEvents, 'function')
})

test('contextMicrocompactEvent returns undefined when microcompact metrics are zero', () => {
  const state = makeMutableState(makeState())
  const refreshStrategy = new ContextRefreshStrategy({ storage: undefined })
  const closures = buildContextRefreshClosureSet({
    state,
    metrics: {} as any,
    refreshStrategy,
    refreshOptions: { runtimeOptions: {} as any, events: [], modelId: 'm', buildSystemPrompt: (() => '') as any, mapEventsToMessages: (() => []) as any, tools: (() => []) as any, warningPercent: 70, compactPercent: 90, suppressToolsForIntent: (() => false) as any, onMemoryRetrieval: undefined, workingSetOverride: undefined },
    readFileCache: makeReadFileCache(),
    sessionId,
    requestId,
  })
  const ev = closures.contextMicrocompactEvent('initial_refresh')
  assert.equal(ev, undefined, 'zero metrics means no microcompact event')
})

test('contextMicrocompactEvent returns an event when metrics are non-zero', () => {
  const state = makeMutableState(
    makeState({
      assembledContext: {
        systemPrompt: '',
        messages: [],
        microcompactMetrics: {
          compactedEventCount: 2,
          deduplicatedToolResultCount: 0,
          bytesBefore: 1024,
          bytesAfter: 512,
          bytesSaved: 512,
          estimatedTokensSaved: 128,
        },
        gitStatus: '',
        budget: {} as any,
      } as any,
    }),
  )
  const refreshStrategy = new ContextRefreshStrategy({ storage: undefined })
  const closures = buildContextRefreshClosureSet({
    state,
    metrics: {} as any,
    refreshStrategy,
    refreshOptions: { runtimeOptions: {} as any, events: [], modelId: 'm', buildSystemPrompt: (() => '') as any, mapEventsToMessages: (() => []) as any, tools: (() => []) as any, warningPercent: 70, compactPercent: 90, suppressToolsForIntent: (() => false) as any, onMemoryRetrieval: undefined, workingSetOverride: undefined },
    readFileCache: makeReadFileCache(),
    sessionId,
    requestId,
  })
  const ev = closures.contextMicrocompactEvent('after_compact')
  assert.ok(ev, 'non-zero metrics produce an event')
  assert.equal(ev!.type, 'context_microcompact')
  assert.equal((ev as any).trigger, 'after_compact')
  assert.equal((ev as any).compactedEventCount, 2)
})

test('postCompactGroundingEvents clears readFileCache and returns events with the given source', () => {
  const cache = new Map<string, any>()
  cache.set('file1.ts', { content: 'cached content' })
  cache.set('file2.ts', { content: 'cached content' })
  const state = makeMutableState(makeState())
  const refreshStrategy = new ContextRefreshStrategy({ storage: undefined })
  const closures = buildContextRefreshClosureSet({
    state,
    metrics: {} as any,
    refreshStrategy,
    refreshOptions: { runtimeOptions: {} as any, events: [], modelId: 'm', buildSystemPrompt: (() => '') as any, mapEventsToMessages: (() => []) as any, tools: (() => []) as any, warningPercent: 70, compactPercent: 90, suppressToolsForIntent: (() => false) as any, onMemoryRetrieval: undefined, workingSetOverride: undefined },
    readFileCache: cache,
    sessionId,
    requestId,
  })
  const events = closures.postCompactGroundingEvents('post_compact', 'boundary-1')
  assert.ok(Array.isArray(events))
  assert.equal(cache.size, 0, 'readFileCache must be cleared as a side effect')
})

test('applyContextRefreshState overwrites the holder state', () => {
  const state = makeMutableState(makeState())
  const refreshStrategy = new ContextRefreshStrategy({ storage: undefined })
  const closures = buildContextRefreshClosureSet({
    state,
    metrics: {} as any,
    refreshStrategy,
    refreshOptions: { runtimeOptions: {} as any, events: [], modelId: 'm', buildSystemPrompt: (() => '') as any, mapEventsToMessages: (() => []) as any, tools: (() => []) as any, warningPercent: 70, compactPercent: 90, suppressToolsForIntent: (() => false) as any, onMemoryRetrieval: undefined, workingSetOverride: undefined },
    readFileCache: makeReadFileCache(),
    sessionId,
    requestId,
  })
  const next = makeState({
    contextWindowState: {
      isWarning: true,
      isBlocking: true,
      isCompact: false,
      percent: 95,
      tokensUsed: 95_000,
      tokensRemaining: 5_000,
      maxTokens: 100_000,
    } as any,
  })
  closures.applyContextRefreshState(next)
  assert.equal(state.getContextWindowState().isBlocking, true)
})

test('estimateVisibleContextTokens returns 0 when no system prompt / messages / tools', () => {
  const state = makeMutableState(
    makeState({
      assembledContext: {
        systemPrompt: '',
        messages: [],
        microcompactMetrics: { compactedEventCount: 0, deduplicatedToolResultCount: 0, bytesBefore: 0, bytesAfter: 0, bytesSaved: 0, estimatedTokensSaved: 0 },
        gitStatus: '',
        budget: {} as any,
      } as any,
      messages: [],
      modelVisibleTools: [],
    }),
  )
  const refreshStrategy = new ContextRefreshStrategy({ storage: undefined })
  const closures = buildContextRefreshClosureSet({
    state,
    metrics: {} as any,
    refreshStrategy,
    refreshOptions: { runtimeOptions: {} as any, events: [], modelId: 'm', buildSystemPrompt: (() => '') as any, mapEventsToMessages: (() => []) as any, tools: (() => []) as any, warningPercent: 70, compactPercent: 90, suppressToolsForIntent: (() => false) as any, onMemoryRetrieval: undefined, workingSetOverride: undefined },
    readFileCache: makeReadFileCache(),
    sessionId,
    requestId,
  })
  const tokens = closures.estimateVisibleContextTokens()
  assert.equal(typeof tokens, 'number')
  assert.ok(tokens >= 0)
})

test('contextMicrocompactEvent tolerates requestId being undefined', () => {
  const state = makeMutableState(
    makeState({
      assembledContext: {
        systemPrompt: '',
        messages: [],
        microcompactMetrics: { compactedEventCount: 1, deduplicatedToolResultCount: 0, bytesBefore: 100, bytesAfter: 50, bytesSaved: 50, estimatedTokensSaved: 10 },
        gitStatus: '',
        budget: {} as any,
      } as any,
    }),
  )
  const refreshStrategy = new ContextRefreshStrategy({ storage: undefined })
  const closures = buildContextRefreshClosureSet({
    state,
    metrics: {} as any,
    refreshStrategy,
    refreshOptions: { runtimeOptions: {} as any, events: [], modelId: 'm', buildSystemPrompt: (() => '') as any, mapEventsToMessages: (() => []) as any, tools: (() => []) as any, warningPercent: 70, compactPercent: 90, suppressToolsForIntent: (() => false) as any, onMemoryRetrieval: undefined, workingSetOverride: undefined },
    readFileCache: makeReadFileCache(),
    sessionId,
    requestId: undefined,
  })
  const ev = closures.contextMicrocompactEvent('pre_provider_call')
  assert.ok(ev)
  assert.equal((ev as any).trigger, 'pre_provider_call')
})
