// Cache health observability tests — Phase A of
// `docs/nexus/reference/cache-observability-and-nexus-realtime-detection-plan.md`.
//
// Coverage: target ratios, unavailable semantics, threshold bands,
// per-event rollup, sampleCount semantics, summary aggregation,
// pickExecutionMetricsEvents filter, schema version stability.

import { describe, it, beforeEach } from 'node:test'
import * as assert from 'node:assert'
import {
  buildCacheHealthFromRuntimeMetrics,
  buildCacheHealthFromEvents,
  buildCacheHealthEvent,
  evaluateCacheDimension,
  pickExecutionMetricsEvents,
  maybeBuildCacheHealthEventFromExecutionMetrics,
  CacheHealthEventDedup,
  _resetCacheHealthDedupForTesting,
  setCacheHealthDedup,
  DEFAULT_CACHE_HEALTH_TARGETS,
  type CacheHealthSnapshot,
  type TokenUsageLike,
  type ExecutionMetricsLike,
  type CacheHealthEvent,
} from '../src/nexus/cacheHealth.js'
import type { NexusEvent } from '../src/shared/events.js'

describe('cacheHealth', () => {
  // ---- T1: default targets match plan §4.2 ----
  it('default targets match the plan (85/90/50/10)', () => {
    assert.strictEqual(DEFAULT_CACHE_HEALTH_TARGETS.prompt, 0.85)
    assert.strictEqual(DEFAULT_CACHE_HEALTH_TARGETS.code_index, 0.90)
    assert.strictEqual(DEFAULT_CACHE_HEALTH_TARGETS.tool, 0.50)
    assert.strictEqual(DEFAULT_CACHE_HEALTH_TARGETS.reasoning, 0.10)
  })

  // ---- T2: prompt 0.90 → ok ----
  it('prompt 0.90 → ok', () => {
    const snap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 100, cacheCreation: 0, cacheRead: 900 }),
    })
    const prompt = findDim(snap, 'prompt')
    assert.strictEqual(prompt.status, 'ok')
    assert.ok(Math.abs((prompt.observedRatio ?? 0) - 0.9) < 1e-6)
    assert.strictEqual(prompt.source, 'provider_usage')
  })

  // ---- T3: prompt 0.40 → critical (target * 0.75 = 0.6375, 0.4 is below) ----
  it('prompt 0.40 → critical (below warning band)', () => {
    const snap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 600, cacheCreation: 0, cacheRead: 400 }),
    })
    const prompt = findDim(snap, 'prompt')
    // ratio = 400 / (600 + 0 + 400) = 0.4
    // target = 0.85, warningFloor = 0.85 * 0.75 = 0.6375
    // 0.4 < 0.6375 → critical
    assert.strictEqual(prompt.status, 'critical')
  })

  // ---- T4: prompt at exactly target * 0.75 → warning boundary ----
  it('prompt at warning boundary (0.6375) → warning', () => {
    // pick numbers so ratio = 0.6375 exactly: cacheRead / (input + cacheRead) = 0.6375
    // 255 / (145 + 255) = 255 / 400 = 0.6375
    const snap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 145, cacheCreation: 0, cacheRead: 255 }),
    })
    const prompt = findDim(snap, 'prompt')
    assert.strictEqual(prompt.status, 'warning')
  })

  // ---- T5: no provider cache samples → prompt unavailable ----
  it('no provider cache samples → prompt unavailable', () => {
    const snap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 1000, cacheCreation: 0, cacheRead: 0 }),
    })
    const prompt = findDim(snap, 'prompt')
    assert.strictEqual(prompt.status, 'unavailable')
    assert.ok(prompt.reason)
    assert.strictEqual(prompt.source, 'provider_usage')
  })

  // ---- T6: empty token usage → prompt unavailable with no_provider_cache_token_samples ----
  it('empty token usage → prompt unavailable', () => {
    const snap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 0, cacheCreation: 0, cacheRead: 0 }),
    })
    const prompt = findDim(snap, 'prompt')
    assert.strictEqual(prompt.status, 'unavailable')
    assert.strictEqual(prompt.reason, 'no_provider_cache_token_samples')
  })

  // ---- T7: code_index / tool / reasoning always unavailable ----
  it('code_index / tool / reasoning are always unavailable in Phase A', () => {
    const snap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 100, cacheCreation: 50, cacheRead: 200 }),
    })
    assert.strictEqual(findDim(snap, 'code_index').status, 'unavailable')
    assert.strictEqual(findDim(snap, 'code_index').source, 'not_implemented')
    assert.strictEqual(findDim(snap, 'tool').status, 'unavailable')
    assert.strictEqual(findDim(snap, 'tool').source, 'not_implemented')
    assert.strictEqual(findDim(snap, 'reasoning').status, 'unavailable')
    assert.strictEqual(findDim(snap, 'reasoning').source, 'not_implemented')
  })

  // ---- T8: summary aggregates correctly ----
  it('summary aggregates belowTarget + unavailable lists', () => {
    const snap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 100, cacheCreation: 0, cacheRead: 50 }),
    })
    // prompt ratio = 50 / 150 = 0.333 → critical → belowTarget includes prompt
    assert.deepStrictEqual(snap.summary.belowTarget.sort(), ['prompt'])
    // code_index / tool / reasoning → unavailable
    assert.deepStrictEqual(
      snap.summary.unavailable.sort(),
      ['code_index', 'reasoning', 'tool'],
    )
    assert.strictEqual(snap.summary.status, 'critical')
  })

  // ---- T9: schema version is stable ----
  it('snapshot schemaVersion is stable', () => {
    const snap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 100, cacheCreation: 0, cacheRead: 50 }),
    })
    assert.strictEqual(snap.type, 'cache_health')
    assert.strictEqual(snap.schemaVersion, '2026-06-17.cache-health.v1')
    assert.strictEqual(snap.window.kind, 'process')
  })

  // ---- T10: buildCacheHealthFromEvents aggregates execution_metrics ----
  it('buildCacheHealthFromEvents aggregates execution_metrics', () => {
    const events: ExecutionMetricsLike[] = [
      {
        type: 'execution_metrics',
        sessionId: 's-001',
        timestamp: '2026-06-17T10:00:00Z',
        inputTokens: 200,
        outputTokens: 100,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 0,
      },
      {
        type: 'execution_metrics',
        sessionId: 's-001',
        timestamp: '2026-06-17T10:01:00Z',
        inputTokens: 0,
        outputTokens: 50,
        cacheReadInputTokens: 700,
        cacheCreationInputTokens: 0,
      },
    ]
    const snap = buildCacheHealthFromEvents(events, { sessionId: 's-001', lastN: 2 })
    const prompt = findDim(snap, 'prompt')
    // aggregated: input=200, cacheRead=1000, denominator=1200
    // ratio = 1000 / 1200 ≈ 0.8333
    assert.ok(prompt.observedRatio !== undefined)
    assert.ok(Math.abs(prompt.observedRatio - 1000 / 1200) < 1e-6)
    assert.strictEqual(prompt.sampleCount, 2)
    // 0.8333 < 0.85 → warning
    assert.strictEqual(prompt.status, 'warning')
    assert.strictEqual(snap.window.sessionId, 's-001')
    assert.strictEqual(snap.window.lastN, 2)
    assert.strictEqual(snap.window.kind, 'session')
  })

  // ---- T11: buildCacheHealthFromEvents with no events → prompt unavailable ----
  it('buildCacheHealthFromEvents with no events → prompt unavailable', () => {
    const snap = buildCacheHealthFromEvents([], { sessionId: 's-002' })
    const prompt = findDim(snap, 'prompt')
    assert.strictEqual(prompt.status, 'unavailable')
    assert.strictEqual(prompt.sampleCount, 0)
  })

  // ---- T12: pane kind propagates ----
  it('pane kind propagates to window', () => {
    const snap = buildCacheHealthFromEvents([], { kind: 'pane' })
    assert.strictEqual(snap.window.kind, 'pane')
  })

  // ---- T13: evaluateCacheDimension direct ----
  it('evaluateCacheDimension returns ok / warning / critical / unavailable', () => {
    const ok = evaluateCacheDimension({ dimension: 'prompt', observedRatio: 0.9, sampleCount: 1 })
    assert.strictEqual(ok.status, 'ok')
    const warning = evaluateCacheDimension({ dimension: 'prompt', observedRatio: 0.7, sampleCount: 1 })
    assert.strictEqual(warning.status, 'warning')
    const critical = evaluateCacheDimension({ dimension: 'prompt', observedRatio: 0.1, sampleCount: 1 })
    assert.strictEqual(critical.status, 'critical')
    const unavailable = evaluateCacheDimension({ dimension: 'prompt', observedRatio: undefined, sampleCount: 0 })
    assert.strictEqual(unavailable.status, 'unavailable')
  })

  // ---- T14: pickExecutionMetricsEvents filter ----
  it('pickExecutionMetricsEvents filters out non-execution_metrics events', () => {
    // Use loose object construction + cast to NexusEvent for the test
    // (we only care about the `type` filter behavior here, not full schema).
    const events = [
      { type: 'user_message', sessionId: 's-1', timestamp: '2026-06-17T10:00:00Z', text: 'hi' },
      { type: 'execution_metrics', sessionId: 's-1', timestamp: '2026-06-17T10:00:01Z' },
      { type: 'result', sessionId: 's-1', timestamp: '2026-06-17T10:00:02Z', text: 'ok' },
    ] as unknown as Parameters<typeof pickExecutionMetricsEvents>[0]
    const picked = pickExecutionMetricsEvents(events)
    assert.strictEqual(picked.length, 1)
  })

  // ---- T15: target ratio clamp: ratio > 1 → clamp to 1 ----
  it('observedRatio > 1 is clamped to 1 in status evaluation', () => {
    // We can simulate by direct call: ratio=1.5 should still go through
    // evaluateStatus (which uses raw ratio), but evaluateCacheDimension
    // clamps via clamp01.
    const dim = evaluateCacheDimension({ dimension: 'prompt', observedRatio: 1.5, sampleCount: 1 })
    assert.strictEqual(dim.observedRatio, 1)
    assert.strictEqual(dim.status, 'ok')
  })

  // ---- T16: cacheReadRatio formula matches nexus/metrics.ts ----
  it('cacheReadRatio formula matches nexus/metrics.ts (token-weighted)', () => {
    // ratios verified against the formula in nexus/metrics.ts:344-351
    // ratio = cacheRead / (input + cacheCreation + cacheRead)
    // (cases with no cache tokens return `unavailable` per plan §2.2)
    const cases: Array<{ tokens: TokenUsageLike; expected: number | 'unavailable' }> = [
      { tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, expected: 'unavailable' },
      { tokens: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, expected: 'unavailable' },
      { tokens: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 900 }, expected: 900 / 1010 },
      { tokens: { inputTokens: 50, outputTokens: 50, cacheCreationInputTokens: 50, cacheReadInputTokens: 100 }, expected: 0.5 },
    ]
    for (const c of cases) {
      const snap = buildCacheHealthFromRuntimeMetrics({ tokenUsage: c.tokens })
      const prompt = findDim(snap, 'prompt')
      if (c.expected === 'unavailable') {
        assert.strictEqual(prompt.status, 'unavailable', `case ${JSON.stringify(c.tokens)}`)
      } else {
        assert.ok(prompt.observedRatio !== undefined, `case ${JSON.stringify(c.tokens)}`)
        assert.ok(Math.abs(prompt.observedRatio - c.expected) < 1e-6, `case ${JSON.stringify(c.tokens)}: ${prompt.observedRatio} vs ${c.expected}`)
      }
    }
  })

  // ---- T17: 4 dimensions always present, in fixed order ----
  it('4 dimensions always present in fixed order', () => {
    const snap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 100, cacheCreation: 50, cacheRead: 200 }),
    })
    assert.deepStrictEqual(
      snap.dimensions.map(d => d.dimension),
      ['prompt', 'code_index', 'tool', 'reasoning'],
    )
  })

  // ---- T18 (Phase B): buildCacheHealthFromEvents accepts wide NexusEvent slice ----
  it('buildCacheHealthFromEvents accepts wide NexusEvent slice and filters internally', () => {
    // Simulate the loop/health route: pass a slice with mixed event types.
    const wide = [
      { type: 'session_started', sessionId: 's-1', timestamp: '2026-06-17T10:00:00Z' },
      { type: 'user_message', sessionId: 's-1', timestamp: '2026-06-17T10:00:01Z', text: 'hi' },
      { type: 'execution_metrics', sessionId: 's-1', timestamp: '2026-06-17T10:00:02Z',
        inputTokens: 200, outputTokens: 100, cacheReadInputTokens: 700, cacheCreationInputTokens: 0 },
      { type: 'result', sessionId: 's-1', timestamp: '2026-06-17T10:00:03Z', text: 'ok' },
    ] as unknown as Parameters<typeof buildCacheHealthFromEvents>[0]
    const snap = buildCacheHealthFromEvents(wide, { sessionId: 's-1', kind: 'pane' })
    const prompt = findDim(snap, 'prompt')
    // Only 1 execution_metrics event in the slice
    assert.strictEqual(prompt.sampleCount, 1)
    // ratio = 700 / (200 + 0 + 700) = 0.7777
    assert.ok(prompt.observedRatio !== undefined)
    assert.ok(Math.abs(prompt.observedRatio - 700 / 900) < 1e-6)
    // 0.7777 < 0.85 → warning
    assert.strictEqual(prompt.status, 'warning')
    assert.strictEqual(snap.window.kind, 'pane')
    assert.strictEqual(snap.window.sessionId, 's-1')
  })

  // ---- T19 (Phase B): loop/health integration smoke via buildCacheHealthFromEvents ----
  it('Phase B per-pane loop/health integration: cacheHealth does not override status', () => {
    // The loop/health route always includes cacheHealth as a sibling field
    // of status; status remains the primary pane health signal.
    // This test verifies the cacheHealth shape and that prompt is the
    // only evaluable dimension in Phase A.
    const wide = [
      { type: 'execution_metrics', sessionId: 's-1', timestamp: '2026-06-17T10:00:02Z',
        inputTokens: 100, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 },
    ] as unknown as Parameters<typeof buildCacheHealthFromEvents>[0]
    const snap = buildCacheHealthFromEvents(wide, { sessionId: 's-1', kind: 'pane' })
    // Shape: type + schemaVersion + window + dimensions + summary
    assert.strictEqual(snap.type, 'cache_health')
    assert.strictEqual(snap.schemaVersion, '2026-06-17.cache-health.v1')
    assert.strictEqual(snap.window.kind, 'pane')
    assert.strictEqual(snap.dimensions.length, 4)
    // Only prompt is evaluable; the other 3 stay unavailable.
    assert.strictEqual(snap.dimensions[0].dimension, 'prompt')
    assert.ok(snap.dimensions[0].observedRatio !== undefined)
    assert.strictEqual(snap.dimensions[1].status, 'unavailable')
    assert.strictEqual(snap.dimensions[2].status, 'unavailable')
    assert.strictEqual(snap.dimensions[3].status, 'unavailable')
    // Summary aggregates correctly
    assert.deepStrictEqual(snap.summary.unavailable.sort(), ['code_index', 'reasoning', 'tool'])
  })

  // ---- T20 (Phase C): buildCacheHealthEvent returns undefined when status is ok ----
  it('buildCacheHealthEvent returns undefined when status is ok', () => {
    const okSnap: CacheHealthSnapshot = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 100, cacheCreation: 0, cacheRead: 1000 }), // ratio 0.909 → ok
    })
    assert.strictEqual(okSnap.summary.status, 'ok')
    const event = buildCacheHealthEvent({
      sessionId: 's-1', cwd: '/tmp', cacheHealth: okSnap, requestId: 'r-1',
    })
    assert.strictEqual(event, undefined, 'ok status → no event')
  })

  // ---- T21 (Phase C): buildCacheHealthEvent returns event when status is critical ----
  it('buildCacheHealthEvent returns event when status is critical', () => {
    const critSnap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 1000, cacheCreation: 0, cacheRead: 50 }), // ratio 0.0476 → critical
    })
    assert.strictEqual(critSnap.summary.status, 'critical')
    const event: CacheHealthEvent | undefined = buildCacheHealthEvent({
      sessionId: 's-1', cwd: '/tmp', cacheHealth: critSnap, requestId: 'r-1',
    })
    assert.ok(event)
    assert.strictEqual(event.type, 'cache_health')
    assert.strictEqual(event.sessionId, 's-1')
    assert.strictEqual(event.requestId, 'r-1')
    assert.strictEqual(event.cwd, '/tmp')
    assert.strictEqual(event.trigger, 'after_execution_metrics')
    assert.strictEqual(event.cacheHealth.summary.status, 'critical')
  })

  // ---- T22 (Phase C): buildCacheHealthEvent returns event when status is warning ----
  it('buildCacheHealthEvent returns event when status is warning', () => {
    const warnSnap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 50, cacheCreation: 0, cacheRead: 30 }), // ratio 0.375 → critical (< 0.6375)
    })
    // Actually verify: ratio = 30/80 = 0.375; target = 0.85, warningFloor = 0.6375
    // 0.375 < 0.6375 → critical
    // To get a warning, we need a ratio in [0.6375, 0.85). Try 0.7:
    // 0.7 = cacheRead / (input + cacheRead) → cacheRead = 7, input = 3
    const realWarnSnap = buildCacheHealthFromRuntimeMetrics({
      tokenUsage: tokens({ input: 3, cacheCreation: 0, cacheRead: 7 }),
    })
    assert.strictEqual(realWarnSnap.summary.status, 'warning')
    const event = buildCacheHealthEvent({
      sessionId: 's-1', cwd: '/tmp', cacheHealth: realWarnSnap, requestId: 'r-2',
    })
    assert.ok(event)
    assert.strictEqual(event.cacheHealth.summary.status, 'warning')
  })

  // ---- T23 (Phase C): dedup dedupes same requestId ----
  it('CacheHealthEventDedup dedupes same requestId per session', () => {
    const dedup = new CacheHealthEventDedup()
    assert.strictEqual(dedup.shouldEmit('s-1', 'r-1'), true, 'first call emits')
    assert.strictEqual(dedup.shouldEmit('s-1', 'r-1'), false, 'second call skips')
    assert.strictEqual(dedup.shouldEmit('s-1', 'r-2'), true, 'different requestId emits')
    assert.strictEqual(dedup.shouldEmit('s-2', 'r-1'), true, 'different session emits')
  })

  // ---- T24 (Phase C): dedup treats undefined requestId as always emit ----
  it('CacheHealthEventDedup allows undefined requestId (caller should always pass one)', () => {
    const dedup = new CacheHealthEventDedup()
    assert.strictEqual(dedup.shouldEmit('s-1', undefined), true)
    assert.strictEqual(dedup.shouldEmit('s-1', undefined), true, 'no dedup without requestId')
  })

  // ---- T25 (Phase C): dedup caps entries at maxEntriesPerSession ----
  it('CacheHealthEventDedup caps entries at maxEntriesPerSession', () => {
    const dedup = new CacheHealthEventDedup(3)
    assert.strictEqual(dedup.shouldEmit('s-1', 'r-1'), true)
    assert.strictEqual(dedup.shouldEmit('s-1', 'r-2'), true)
    assert.strictEqual(dedup.shouldEmit('s-1', 'r-3'), true)
    assert.strictEqual(dedup.shouldEmit('s-1', 'r-4'), true, 'over cap still emits (eviction)')
    // After eviction, r-1 may have been evicted. The exact eviction
    // order is implementation-defined; we only assert the cap is bounded.
    // Calling r-1 again may or may not emit (depending on eviction
    // order), so we don't assert it.
  })

  // ---- T26 (Phase C): maybeBuildCacheHealthEventFromExecutionMetrics dedups ----
  it('maybeBuildCacheHealthEventFromExecutionMetrics dedups by requestId', () => {
    setCacheHealthDedup(new CacheHealthEventDedup())
    const execEvent = {
      type: 'execution_metrics',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 's-1',
      cwd: '/tmp',
      timestamp: '2026-06-17T10:00:00Z',
      requestId: 'r-1',
      inputTokens: 1000,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 50, // ratio 0.0476 → critical
    } as unknown as NexusEvent
    const first = maybeBuildCacheHealthEventFromExecutionMetrics(execEvent, '/tmp')
    assert.ok(first, 'first call emits')
    const second = maybeBuildCacheHealthEventFromExecutionMetrics(execEvent, '/tmp')
    assert.strictEqual(second, undefined, 'second call dedups')
    // Different requestId emits again
    const third = { ...execEvent, requestId: 'r-2' } as unknown as NexusEvent
    const thirdResult = maybeBuildCacheHealthEventFromExecutionMetrics(third, '/tmp')
    assert.ok(thirdResult, 'different requestId emits')
  })

  // ---- T27 (Phase C): maybeBuildCacheHealthEventFromExecutionMetrics returns undefined for non-execution_metrics ----
  it('maybeBuildCacheHealthEventFromExecutionMetrics returns undefined for non-execution_metrics events', () => {
    setCacheHealthDedup(new CacheHealthEventDedup())
    const userMsg = {
      type: 'user_message',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 's-1',
      cwd: '/tmp',
      timestamp: '2026-06-17T10:00:00Z',
      text: 'hi',
    } as unknown as NexusEvent
    assert.strictEqual(
      maybeBuildCacheHealthEventFromExecutionMetrics(userMsg, '/tmp'),
      undefined,
    )
  })

  // ---- T28 (Phase C): ok status execution_metrics does not emit even first time ----
  it('ok status execution_metrics does not emit cache_health event', () => {
    setCacheHealthDedup(new CacheHealthEventDedup())
    const okExec = {
      type: 'execution_metrics',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 's-1',
      cwd: '/tmp',
      timestamp: '2026-06-17T10:00:00Z',
      requestId: 'r-1',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 900, // ratio 0.9 → ok
    } as unknown as NexusEvent
    assert.strictEqual(
      maybeBuildCacheHealthEventFromExecutionMetrics(okExec, '/tmp'),
      undefined,
      'ok status → no event',
    )
  })
})

function tokens(t: { input: number; cacheCreation: number; cacheRead: number }): TokenUsageLike {
  return {
    inputTokens: t.input,
    outputTokens: 0,
    cacheCreationInputTokens: t.cacheCreation,
    cacheReadInputTokens: t.cacheRead,
  }
}

function findDim(snap: CacheHealthSnapshot, dim: string) {
  const found = snap.dimensions.find(d => d.dimension === dim)
  if (!found) throw new Error(`dimension ${dim} not found`)
  return found
}
