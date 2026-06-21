import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyLeakSuppressionEffects } from '../src/runtime/applyLeakSuppressionEffects.js'
import type { NexusEvent } from '../src/shared/events.js'
import type { ModelMessage } from '../src/providers/adapters/ModelAdapter.js'

// ─── fixtures ──────────────────────────────────────────────

function makeMetrics() {
  return {
    toolCallCount: 0,
    toolCallTextLeakSuppressedCount: 0,
    toolShapedTextPattern: '' as string | null,
    finalAnswerRetryCount: 0,
    contextCharsIn: 0,
    executionStartMs: 0,
  } as any
}

function makeTurn(overrides: any = {}) {
  return {
    sessionId: 'sess-1',
    durationMs: 100,
    providerFirstTokenMs: undefined,
    streamDeltaCount: 0,
    charsOut: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    ...overrides,
  }
}

function makeInput(turnOverrides: any = {}, inputOverrides: any = {}) {
  return {
    providerTurn: makeTurn(turnOverrides),
    metrics: makeMetrics(),
    sessionId: 'sess-1',
    options: { sessionId: 'sess-1' } as any,
    previousEvents: [] as NexusEvent[],
    messages: [] as ModelMessage[],
    memoryCapabilityAnswerRetryCount: 0,
    maxMemoryCapabilityAnswerRetries: 1,
    ...inputOverrides,
  }
}

// ─── tests ──────────────────────────────────────────────────

test('applyLeakSuppressionEffects returns kind=none when no leak is present', async () => {
  const result = await applyLeakSuppressionEffects(makeInput())
  assert.equal(result.kind, 'none')
  assert.equal(result.events.length, 0)
  assert.equal(result.previousEvents.length, 0)
  assert.equal(result.messages.length, 0)
  assert.equal(result.memoryCapabilityAnswerRetryCount, 0)
})

test('applyLeakSuppressionEffects records toolCallTextLeakSuppression metrics but does not emit events', async () => {
  const result = await applyLeakSuppressionEffects(makeInput({
    toolCallTextLeakSuppression: { pattern: 'tool-call-text-leak' },
  }))
  assert.equal(result.kind, 'none')
  assert.equal(result.events.length, 0)
  assert.equal(result.metrics.toolCallTextLeakSuppressedCount, 1)
  assert.equal(result.metrics.toolShapedTextPattern, 'tool-call-text-leak')
})

test('applyLeakSuppressionEffects returns kind=retry on first memoryCapabilityAnswerLeakSuppression', async () => {
  const result = await applyLeakSuppressionEffects(makeInput({
    memoryCapabilityAnswerLeakSuppression: { pattern: 'memcap-leak' },
  }))
  assert.equal(result.kind, 'retry')
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].type, 'error')
  const err = result.events[0] as any
  assert.equal(err.code, 'MEMORY_CAPABILITY_ANSWER_LEAK_SUPPRESSED')
  // The previousEvents accumulator must include the
  // new leak error event.
  assert.equal(result.previousEvents.length, 1)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].role, 'user')
  // The retry counter must have been incremented.
  assert.equal(result.memoryCapabilityAnswerRetryCount, 1)
  assert.equal(result.metrics.finalAnswerRetryCount, 1)
  assert.equal(result.metrics.toolCallTextLeakSuppressedCount, 1)
  assert.equal(result.metrics.toolShapedTextPattern, 'memcap-leak')
})

test('applyLeakSuppressionEffects returns kind=terminal when retry cap is reached', async () => {
  const result = await applyLeakSuppressionEffects(
    makeInput({
      memoryCapabilityAnswerLeakSuppression: { pattern: 'memcap-leak' },
    }, {
      memoryCapabilityAnswerRetryCount: 1, // already at cap
    }),
  )
  assert.equal(result.kind, 'terminal')
  // The terminal path emits 3 events:
  // 1. leak error
  // 2. runtime_result (final answer)
  // 3. runtime_execution_metrics
  assert.equal(result.events.length, 3)
  assert.equal(result.events[0].type, 'error')
  assert.equal(result.events[1].type, 'result')
  assert.equal(result.events[2].type, 'execution_metrics')
  // No retry message is appended on the terminal path.
  assert.equal(result.messages.length, 0)
  // The previousEvents accumulator must include the
  // leak error event but not the result / metrics
  // events (those are yield-only, not persisted).
  assert.equal(result.previousEvents.length, 1)
  assert.equal(result.memoryCapabilityAnswerRetryCount, 1, 'counter is not advanced past the cap')
})

test('applyLeakSuppressionEffects appends to the input previousEvents list', async () => {
  const existingEvent = { type: 'thinking_delta', text: 'hmm' } as unknown as NexusEvent
  const result = await applyLeakSuppressionEffects(makeInput(
    { memoryCapabilityAnswerLeakSuppression: { pattern: 'p' } },
    { previousEvents: [existingEvent] },
  ))
  assert.equal(result.kind, 'retry')
  assert.equal(result.previousEvents.length, 2)
  assert.equal(result.previousEvents[0], existingEvent)
  assert.equal((result.previousEvents[1] as any).type, 'error')
})

test('applyLeakSuppressionEffects records both tool + memory leaks in metrics', async () => {
  // When BOTH leak suppressions are set, the helper
  // records both. The memory leak wins for the
  // events / messages path (the memory branch is
  // checked second).
  const result = await applyLeakSuppressionEffects(makeInput({
    toolCallTextLeakSuppression: { pattern: 'tool' },
    memoryCapabilityAnswerLeakSuppression: { pattern: 'mem' },
  }))
  assert.equal(result.kind, 'retry')
  // The metrics counter is incremented twice (once
  // for the tool leak, once for the memory leak).
  assert.equal(result.metrics.toolCallTextLeakSuppressedCount, 2)
  // The toolShapedTextPattern is the LAST pattern set
  // (memory wins).
  assert.equal(result.metrics.toolShapedTextPattern, 'mem')
})

test('applyLeakSuppressionEffects propagates metrics mutations back to the caller', async () => {
  const metrics = makeMetrics()
  const result = await applyLeakSuppressionEffects(
    makeInput(
      { toolCallTextLeakSuppression: { pattern: 'p' } },
      { metrics },
    ),
  )
  // The metrics object the caller passed in must
  // reflect the helper's mutations (the helper
  // mutates metrics in place + returns the same
  // object).
  assert.equal(metrics, result.metrics)
  assert.equal(metrics.toolCallTextLeakSuppressedCount, 1)
})
