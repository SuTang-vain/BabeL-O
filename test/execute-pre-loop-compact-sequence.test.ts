import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executePreLoopCompactSequence } from '../src/runtime/executePreLoopCompactSequence.js'
import { ContextRefreshStrategy } from '../src/runtime/ContextRefreshStrategy.js'
import type { RuntimeContextRefreshState } from '../src/runtime/pipeline/contextRefresh.js'
import type { NexusEvent } from '../src/shared/events.js'

// ─── fixtures ────────────────────────────────────────────────

function makeStateBundle() {
  let previousEvents: NexusEvent[] = []
  let contextWindowState: any = {
    isWarning: false, isBlocking: false, isCompact: false,
    percent: 50, tokensUsed: 50_000, tokensRemaining: 50_000, maxTokens: 100_000,
  }
  let autoCompactDecision: any = {
    shouldCompact: false, enabled: false, thresholdPercent: 80,
    fuseOpen: false, failureCount: 0, failureLimit: 3,
  }
  let cacheAwareCompactPolicy: any = { effectiveContextCeiling: 100_000 }
  return {
    state: {
      getContextWindowState: () => contextWindowState,
      getPreviousEvents: () => previousEvents,
      setPreviousEvents: (next: NexusEvent[]) => { previousEvents = next },
      getAutoCompactDecision: () => autoCompactDecision,
      setAutoCompactDecision: (next: any) => { autoCompactDecision = next },
      getCacheAwareCompactPolicy: () => cacheAwareCompactPolicy,
      setCacheAwareCompactPolicy: (next: any) => { cacheAwareCompactPolicy = next },
    },
    setContextWindowState: (s: any) => { contextWindowState = s },
    setAutoCompactDecision: (d: any) => { autoCompactDecision = d },
    setCacheAwareCompactPolicy: (p: any) => { cacheAwareCompactPolicy = p },
    getPreviousEvents: () => previousEvents,
    getAutoCompactDecision: () => autoCompactDecision,
  }
}

function makeClosures() {
  return {
    applyContextRefreshState: (next: RuntimeContextRefreshState) => { /* noop for test */ },
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
    autoCompactShouldCompact: false,
    isContextWindowBlocking: false,
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
    readFileCache: new Map<string, any>(),
    toolsList: () => [] as any,
    mapEventsForProvider: (() => []) as any,
    shouldSuppressToolsForIntent: () => false,
    onMemoryRetrieval: (() => undefined) as any,
    userIntentGuidance: undefined,
    workingSetOverride: undefined,
    buildRuntimeExecutionMetricsEvent: () => ({ type: 'runtime_execution_metrics', sessionId: 's' } as any),
    compactAttempted: false,
    ...overrides,
  }
}

async function collectEvents(input: any): Promise<{ events: NexusEvent[]; result: any }> {
  const events: NexusEvent[] = []
  const iter = executePreLoopCompactSequence(input)
  let result: any
  while (true) {
    const next = await iter.next()
    if (next.done) {
      result = next.value
      break
    }
    events.push(next.value)
  }
  return { events, result }
}

// ─── tests ──────────────────────────────────────────────────

test('executePreLoopCompactSequence is a no-op when neither shouldCompact nor isBlocking is true', async () => {
  const input = makeInput()
  const { events, result } = await collectEvents(input)
  assert.equal(events.length, 0)
  assert.equal(result.compactAttempted, false)
  assert.equal(result.blocking, false)
})

test('executePreLoopCompactSequence runs the auto block when shouldCompact=true (compactSession throws → compact_failure event)', async () => {
  const input = makeInput({ autoCompactShouldCompact: true })
  // compactSession needs a real session in storage; without
  // it, compactSession throws → the helper yields a
  // compact_failure event with `trigger: 'auto'`.
  const { events, result } = await collectEvents(input)
  assert.ok(events.some((e) => e.type === 'compact_failure'))
  const failure = events.find((e) => e.type === 'compact_failure') as any
  assert.equal(failure.trigger, 'auto')
  assert.equal(failure.failureCount, 1)
  assert.equal(failure.maxFailures, 3)
  assert.equal(result.compactAttempted, true, 'compactAttempted must be true after auto compact attempted')
  assert.equal(result.blocking, false)
})

test('executePreLoopCompactSequence skips reactive block when auto compact already ran', async () => {
  const input = makeInput({
    autoCompactShouldCompact: true,
    isContextWindowBlocking: true,
    // initial compactAttempted: false; the auto block sets
    // it to true and the reactive block must skip.
    compactAttempted: false,
  })
  const { events, result } = await collectEvents(input)
  // Both blocks throw (no storage) but the reactive
  // block must NOT run because the auto block sets
  // compactAttempted=true.
  const failures = events.filter((e) => e.type === 'compact_failure')
  assert.equal(failures.length, 1, 'only auto failure should be yielded; reactive skipped')
  assert.equal((failures[0] as any).trigger, 'auto')
  assert.equal(result.compactAttempted, true)
  assert.equal(result.blocking, true, 'blocking emit still runs after the auto compact failure')
})

test('executePreLoopCompactSequence runs reactive block when auto did not run but isBlocking=true', async () => {
  const input = makeInput({
    autoCompactShouldCompact: false,
    isContextWindowBlocking: true,
  })
  const { events, result } = await collectEvents(input)
  const failures = events.filter((e) => e.type === 'compact_failure')
  assert.equal(failures.length, 1, 'only reactive failure should be yielded')
  assert.equal((failures[0] as any).trigger, 'reactive')
  assert.equal(result.compactAttempted, true)
  assert.equal(result.blocking, true)
})

test('executePreLoopCompactSequence blocking emit only runs when isBlocking=true', async () => {
  const input = makeInput({ isContextWindowBlocking: true, autoCompactShouldCompact: false })
  const { events, result } = await collectEvents(input)
  // Reactive block + blocking emit both run.
  assert.ok(events.some((e) => e.type === 'compact_failure'), 'reactive failure yielded')
  assert.ok(events.some((e) => e.type === 'runtime_execution_metrics'), 'blocking emit yields runtime_execution_metrics')
  assert.equal(result.blocking, true)
})

test('executePreLoopCompactSequence does not run blocking emit when isBlocking=false', async () => {
  const input = makeInput({ isContextWindowBlocking: false })
  const { events, result } = await collectEvents(input)
  assert.equal(events.length, 0, 'no events when neither block fires')
  assert.equal(result.blocking, false)
})

test('executePreLoopCompactSequence tolerates requestId being undefined', async () => {
  const input = makeInput({
    autoCompactShouldCompact: true,
    requestId: undefined,
  })
  const { events } = await collectEvents(input)
  assert.ok(events.some((e) => e.type === 'compact_failure'))
  // compact_failure event has sessionId + modelId but
  // requestId is optional. The test passes if no type
  // error fires.
})

test('executePreLoopCompactSequence returns compactAttempted=false when both shouldCompact=false and isBlocking=false', async () => {
  const input = makeInput()
  const { result } = await collectEvents(input)
  assert.equal(result.compactAttempted, false)
  assert.equal(result.blocking, false)
})
