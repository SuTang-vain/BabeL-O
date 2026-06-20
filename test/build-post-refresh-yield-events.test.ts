import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPostRefreshYieldEvents } from '../src/runtime/buildPostRefreshYieldEvents.js'
import type { AssembledContext } from '../src/runtime/contextAssembler.js'
import type { ContextWindowState } from '../src/runtime/tokenEstimator.js'
import type { AutoCompactDecision } from '../src/runtime/compact.js'
import type { CacheAwareCompactPolicy } from '../src/runtime/cacheAwareCompactPolicy.js'
import type { NexusEvent } from '../src/shared/events.js'

// ─── minimal fixtures ───────────────────────────────────────────

function makeContextWindowState(
  overrides: Partial<ContextWindowState> = {},
): ContextWindowState {
  return {
    isWarning: false,
    isBlocking: false,
    isCompact: false,
    percent: 50,
    tokensUsed: 50_000,
    tokensRemaining: 50_000,
    maxTokens: 100_000,
    ...overrides,
  } as ContextWindowState
}

function makeAutoCompactDecision(
  overrides: Partial<AutoCompactDecision> = {},
): AutoCompactDecision {
  return {
    shouldCompact: false,
    enabled: false,
    thresholdPercent: 80,
    fuseOpen: false,
    failureCount: 0,
    ...overrides,
  } as AutoCompactDecision
}

function makeCacheAwarePolicy(): CacheAwareCompactPolicy {
  return {} as CacheAwareCompactPolicy
}

function makeAssembledContext(microcompactMetrics: {
  compactedEventCount: number
  bytesSaved: number
  deduplicatedToolResultCount?: number
  bytesBefore?: number
  bytesAfter?: number
  estimatedTokensSaved?: number
} = { compactedEventCount: 0, bytesSaved: 0 }): AssembledContext {
  return {
    systemPrompt: '',
    messages: [],
    microcompactMetrics: {
      compactedEventCount: microcompactMetrics.compactedEventCount,
      deduplicatedToolResultCount: microcompactMetrics.deduplicatedToolResultCount ?? 0,
      bytesBefore: microcompactMetrics.bytesBefore ?? 0,
      bytesAfter: microcompactMetrics.bytesAfter ?? 0,
      bytesSaved: microcompactMetrics.bytesSaved,
      estimatedTokensSaved: microcompactMetrics.estimatedTokensSaved ?? 0,
    },
  } as unknown as AssembledContext
}

const baseInput = {
  sessionId: 'sess-1',
  requestId: 'req-1',
  modelId: 'model-1',
  contextWarningPercent: 80,
  contextCompactPercent: 90,
}

// ─── tests ──────────────────────────────────────────────────────

test('buildPostRefreshYieldEvents returns an empty list when no microcompact happened and no warning / fuse', () => {
  const result = buildPostRefreshYieldEvents({
    ...baseInput,
    assembledContext: makeAssembledContext({ compactedEventCount: 0, bytesSaved: 0 }),
    contextWindowState: makeContextWindowState({ isWarning: false }),
    autoCompactDecision: makeAutoCompactDecision({ fuseOpen: false }),
    cacheAwareCompactPolicy: makeCacheAwarePolicy(),
  })
  assert.equal(result.length, 0, 'no events when no microcompact, no warning, no fuse')
})

test('buildPostRefreshYieldEvents yields context_microcompact when microcompact metrics are non-zero', () => {
  const result = buildPostRefreshYieldEvents({
    ...baseInput,
    assembledContext: makeAssembledContext({
      compactedEventCount: 3,
      bytesSaved: 1024,
      bytesBefore: 4096,
      bytesAfter: 3072,
      estimatedTokensSaved: 256,
    }),
    contextWindowState: makeContextWindowState({ isWarning: false }),
    autoCompactDecision: makeAutoCompactDecision({ fuseOpen: false }),
    cacheAwareCompactPolicy: makeCacheAwarePolicy(),
  })
  assert.equal(result.length, 1)
  assert.equal(result[0].type, 'context_microcompact')
  const m = result[0] as Extract<NexusEvent, { type: 'context_microcompact' }>
  assert.equal(m.compactedEventCount, 3)
  assert.equal(m.bytesSaved, 1024)
  assert.equal(m.estimatedTokensSaved, 256)
  assert.equal(m.trigger, 'initial_refresh')
})

test('buildPostRefreshYieldEvents yields context_warning when isWarning is true', () => {
  const result = buildPostRefreshYieldEvents({
    ...baseInput,
    assembledContext: makeAssembledContext({ compactedEventCount: 0, bytesSaved: 0 }),
    contextWindowState: makeContextWindowState({ isWarning: true, isCompact: false }),
    autoCompactDecision: makeAutoCompactDecision({ fuseOpen: false, enabled: false }),
    cacheAwareCompactPolicy: makeCacheAwarePolicy(),
  })
  // microcompact metrics are 0 → skipped; isWarning → warning yielded.
  assert.equal(result.length, 1)
  assert.equal(result[0].type, 'context_warning')
  const w = result[0] as Extract<NexusEvent, { type: 'context_warning' }>
  assert.match(w.message, /approaching the compact threshold/)
  assert.equal(w.thresholdPercent, 90, 'uses contextCompactPercent fallback when auto-compact is disabled')
})

test('buildPostRefreshYieldEvents uses autoCompactDecision.thresholdPercent when auto-compact is enabled', () => {
  const result = buildPostRefreshYieldEvents({
    ...baseInput,
    assembledContext: makeAssembledContext({ compactedEventCount: 0, bytesSaved: 0 }),
    contextWindowState: makeContextWindowState({ isWarning: true, isCompact: false }),
    autoCompactDecision: makeAutoCompactDecision({ fuseOpen: false, enabled: true, thresholdPercent: 75 }),
    cacheAwareCompactPolicy: makeCacheAwarePolicy(),
  })
  assert.equal(result.length, 1)
  const w = result[0] as Extract<NexusEvent, { type: 'context_warning' }>
  assert.equal(w.thresholdPercent, 75, 'uses auto-compact threshold when enabled')
})

test('buildPostRefreshYieldEvents uses the isCompact message when isCompact is true', () => {
  const result = buildPostRefreshYieldEvents({
    ...baseInput,
    assembledContext: makeAssembledContext({ compactedEventCount: 0, bytesSaved: 0 }),
    contextWindowState: makeContextWindowState({ isWarning: true, isCompact: true }),
    autoCompactDecision: makeAutoCompactDecision({ fuseOpen: false, enabled: false }),
    cacheAwareCompactPolicy: makeCacheAwarePolicy(),
  })
  assert.equal(result.length, 1)
  const w = result[0] as Extract<NexusEvent, { type: 'context_warning' }>
  assert.match(w.message, /passed the compact threshold/)
})

test('buildPostRefreshYieldEvents uses the fuse-open message when fuseOpen is true', () => {
  const result = buildPostRefreshYieldEvents({
    ...baseInput,
    assembledContext: makeAssembledContext({ compactedEventCount: 0, bytesSaved: 0 }),
    contextWindowState: makeContextWindowState({ isWarning: false }),
    autoCompactDecision: makeAutoCompactDecision({ fuseOpen: true, failureCount: 3, enabled: false }),
    cacheAwareCompactPolicy: makeCacheAwarePolicy(),
  })
  assert.equal(result.length, 1)
  const w = result[0] as Extract<NexusEvent, { type: 'context_warning' }>
  assert.match(w.message, /Auto compact is paused after 3 consecutive failures/)
})

test('buildPostRefreshYieldEvents returns [microcompact, warning] when both fire', () => {
  const result = buildPostRefreshYieldEvents({
    ...baseInput,
    assembledContext: makeAssembledContext({
      compactedEventCount: 5,
      bytesSaved: 2048,
      bytesBefore: 8192,
      bytesAfter: 6144,
      estimatedTokensSaved: 512,
    }),
    contextWindowState: makeContextWindowState({ isWarning: true, isCompact: false }),
    autoCompactDecision: makeAutoCompactDecision({ fuseOpen: false, enabled: false }),
    cacheAwareCompactPolicy: makeCacheAwarePolicy(),
  })
  assert.equal(result.length, 2)
  assert.equal(result[0].type, 'context_microcompact')
  assert.equal(result[1].type, 'context_warning')
})

test('buildPostRefreshYieldEvents returns [warning, microcompact NOT] when fuseOpen + isWarning both fire (warning alone)', () => {
  // The factory is "if isWarning || fuseOpen" — only one
  // warning event, not two. The fuse-open message wins
  // when fuseOpen is set.
  const result = buildPostRefreshYieldEvents({
    ...baseInput,
    assembledContext: makeAssembledContext({ compactedEventCount: 0, bytesSaved: 0 }),
    contextWindowState: makeContextWindowState({ isWarning: true, isCompact: false }),
    autoCompactDecision: makeAutoCompactDecision({ fuseOpen: true, failureCount: 2 }),
    cacheAwareCompactPolicy: makeCacheAwarePolicy(),
  })
  assert.equal(result.length, 1)
  const w = result[0] as Extract<NexusEvent, { type: 'context_warning' }>
  assert.match(w.message, /Auto compact is paused after 2 consecutive failures/)
})

test('buildPostRefreshYieldEvents tolerates requestId being undefined', () => {
  // options.requestId is string | undefined at the call site.
  // The factory must not require it.
  const result = buildPostRefreshYieldEvents({
    ...baseInput,
    requestId: undefined,
    assembledContext: makeAssembledContext({ compactedEventCount: 0, bytesSaved: 0 }),
    contextWindowState: makeContextWindowState({ isWarning: false }),
    autoCompactDecision: makeAutoCompactDecision({ fuseOpen: false }),
    cacheAwareCompactPolicy: makeCacheAwarePolicy(),
  })
  assert.equal(result.length, 0)
})

test('buildPostRefreshYieldEvents tolerates zero bytesSaved with non-zero compactedEventCount (skip per builder contract)', () => {
  // buildContextMicrocompactEvent returns undefined when
  // bytesSaved <= 0 even if compactedEventCount > 0 —
  // the factory must respect that and skip the microcompact
  // event.
  const result = buildPostRefreshYieldEvents({
    ...baseInput,
    assembledContext: makeAssembledContext({ compactedEventCount: 5, bytesSaved: 0 }),
    contextWindowState: makeContextWindowState({ isWarning: false }),
    autoCompactDecision: makeAutoCompactDecision({ fuseOpen: false }),
    cacheAwareCompactPolicy: makeCacheAwarePolicy(),
  })
  assert.equal(result.length, 0, 'microcompact event builder returns undefined when bytesSaved <= 0')
})
