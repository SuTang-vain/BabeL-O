import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeProviderLoopCompactBlock } from '../src/runtime/executeProviderLoopCompactBlock.js'
import { ContextRefreshStrategy } from '../src/runtime/ContextRefreshStrategy.js'
import type { NexusEvent } from '../src/shared/events.js'

// ─── fixtures ──────────────────────────────────────────────

function makeStateBundle() {
  let previousEvents: NexusEvent[] = []
  let autoCompactDecision: any = {
    shouldCompact: false, enabled: false, thresholdPercent: 80,
    fuseOpen: false, failureCount: 0, failureLimit: 3,
  }
  let cacheAwareCompactPolicy: any = { effectiveContextCeiling: 100_000 }
  const contextWindowState: any = {
    isWarning: true, isBlocking: true, isCompact: false,
    percent: 95, tokensUsed: 95_000, tokensRemaining: 5_000, maxTokens: 100_000,
  }
  return {
    state: {
      getPreviousEvents: () => previousEvents,
      setPreviousEvents: (next: NexusEvent[]) => { previousEvents = next },
      getAutoCompactDecision: () => autoCompactDecision,
      setAutoCompactDecision: (next: any) => { autoCompactDecision = next },
      getCacheAwareCompactPolicy: () => cacheAwareCompactPolicy,
      setCacheAwareCompactPolicy: (next: any) => { cacheAwareCompactPolicy = next },
      getContextWindowState: () => contextWindowState,
    },
    getPreviousEvents: () => previousEvents,
  }
}

function makeClosures() {
  return {
    applyContextRefreshState: (() => undefined) as any,
    postCompactGroundingEvents: () => [] as NexusEvent[],
    contextMicrocompactEvent: () => undefined as NexusEvent | undefined,
  }
}

function makeInput(overrides: any = {}) {
  const b = makeStateBundle()
  return {
    storage: undefined as any,
    sessionId: 'sess-1',
    requestId: 'req-1',
    modelId: 'model-1',
    providerId: 'provider-1',
    cleanedModelId: 'model-1',
    isContextWindowBlocking: true,
    alreadyAttempted: false,
    refreshStrategy: new ContextRefreshStrategy({ storage: undefined }),
    refreshOptions: {
      runtimeOptions: {} as any,
      events: [],
      modelId: 'm',
      buildSystemPrompt: (() => '') as any,
      mapEventsToMessages: (() => []) as any,
      tools: (() => []) as any,
      warningPercent: 70,
      compactPercent: 90,
      suppressToolsForIntent: (() => false) as any,
      onMemoryRetrieval: undefined,
      workingSetOverride: undefined,
    },
    state: b.state,
    closures: makeClosures(),
    metrics: {} as any,
    toolsList: () => [] as any,
    mapEventsForProvider: (() => []) as any,
    shouldSuppressToolsForIntent: () => false,
    onMemoryRetrieval: (() => undefined) as any,
    workingSetOverride: undefined,
    initialPrompt: 'p',
    ...overrides,
  }
}

// ─── tests ──────────────────────────────────────────────────

test('executeProviderLoopCompactBlock is a no-op when isContextWindowBlocking is false', async () => {
  const input = makeInput({ isContextWindowBlocking: false })
  const result = await executeProviderLoopCompactBlock(input)
  assert.equal(result.events.length, 0)
  assert.equal(result.compactAttempted, false, 'no compact attempted when not blocking')
})

test('executeProviderLoopCompactBlock is a no-op when alreadyAttempted is true', async () => {
  const input = makeInput({ alreadyAttempted: true })
  const result = await executeProviderLoopCompactBlock(input)
  assert.equal(result.events.length, 0)
  assert.equal(result.compactAttempted, true, 'compactAttempted echoes the alreadyAttempted flag')
})

test('executeProviderLoopCompactBlock yields a compact_failure event when compactSession throws', async () => {
  const input = makeInput()
  // compactSession needs a real session in storage; without
  // it, compactSession throws → the helper yields a
  // compact_failure event.
  const result = await executeProviderLoopCompactBlock(input)
  assert.ok(result.events.some((e) => e.type === 'compact_failure'))
  const failure = result.events.find((e) => e.type === 'compact_failure') as any
  assert.equal(failure.trigger, 'reactive')
  assert.equal(failure.failureCount, 1)
  assert.equal(failure.maxFailures, 3)
  assert.equal(result.compactAttempted, true)
})

test('executeProviderLoopCompactBlock returns events array (not generator) and exposes compactAttempted', async () => {
  const input = makeInput()
  const result = await executeProviderLoopCompactBlock(input)
  assert.ok(Array.isArray(result.events))
  // The helper must update the state's previousEvents list
  // even when the compact throws — the throw path is
  // structured so a failure does not roll back the
  // partial update.
  assert.equal(typeof result.compactAttempted, 'boolean')
})

test('executeProviderLoopCompactBlock tolerates requestId being undefined', async () => {
  const input = makeInput({ requestId: undefined })
  const result = await executeProviderLoopCompactBlock(input)
  assert.ok(result.events.some((e) => e.type === 'compact_failure'))
})

test('executeProviderLoopCompactBlock short-circuits when alreadyAttempted even if isBlocking', async () => {
  const input = makeInput({
    isContextWindowBlocking: true,
    alreadyAttempted: true,
  })
  const result = await executeProviderLoopCompactBlock(input)
  assert.equal(result.events.length, 0, 'no events when alreadyAttempted short-circuits')
  assert.equal(result.compactAttempted, true)
})
