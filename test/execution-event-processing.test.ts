import assert from 'node:assert/strict'
import { test } from 'node:test'
import { processRuntimeExecutionEvent } from '../src/nexus/executionEventProcessing.js'
import { NexusMetrics } from '../src/nexus/metrics.js'
import { eventBase, type NexusEvent } from '../src/shared/events.js'
import type { NexusStorage } from '../src/storage/Storage.js'

class RecordingStorage {
  readonly appended: Array<{ sessionId: string; event: NexusEvent }> = []

  async appendEvent(sessionId: string, event: NexusEvent): Promise<void> {
    this.appended.push({ sessionId, event })
  }
}

test('processRuntimeExecutionEvent decorates watchdog timeout before persisting and ingesting', async () => {
  const sessionId = 'session-execution-event-processing-watchdog'
  const storage = new RecordingStorage()
  const events: NexusEvent[] = [
    {
      type: 'timeout_budget_exceeded',
      ...eventBase(sessionId),
      requestId: 'req-watchdog',
      elapsedMs: 100,
      timeoutMs: 100,
      policy: 'soft',
      message: 'soft timeout budget exhausted',
    },
  ]
  const ingested: NexusEvent[] = []
  const inputEvent: NexusEvent = {
    type: 'error',
    ...eventBase(sessionId),
    code: 'REQUEST_TIMEOUT',
    message: 'timed out',
  }

  const result = await processRuntimeExecutionEvent({
    event: inputEvent,
    events,
    sessionId,
    cwd: '/tmp/babel-o-event-processing',
    storage: storage as unknown as NexusStorage,
    metrics: new NexusMetrics(),
    timeoutDecision: {
      policy: 'soft',
      softTimeoutMs: 100,
      watchdogTimeoutMs: 300,
      maxSoftTimeoutExtensions: 1,
      softTimeoutExtensionMs: 100,
    },
    watchdog: { fired: true },
    behaviorMonitor: { ingest: event => ingested.push(event) },
  })

  assert.equal(result.event.type, 'error')
  assert.equal(result.cacheHealthEvent, undefined)
  assert.equal(storage.appended.length, 1)
  assert.equal(events.at(-1), result.event)
  assert.equal(storage.appended[0]?.event, result.event)
  assert.equal(ingested[0], result.event)
  assert.deepEqual((result.event as Extract<NexusEvent, { type: 'error' }>).details, {
    kind: 'watchdog',
    policy: 'soft',
    softTimeoutMs: 100,
    watchdogTimeoutMs: 300,
    maxSoftTimeoutExtensions: 1,
    softCycleEvents: 1,
    retryable: false,
  })
})

test('processRuntimeExecutionEvent persists derived cache health after execution metrics', async () => {
  const sessionId = 'session-execution-event-processing-cache'
  const requestId = `req-cache-${Date.now()}`
  const storage = new RecordingStorage()
  const events: NexusEvent[] = []
  const inputEvent: NexusEvent = {
    type: 'execution_metrics',
    ...eventBase(sessionId),
    requestId,
    inputTokens: 100,
    outputTokens: 10,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 0,
  }

  const result = await processRuntimeExecutionEvent({
    event: inputEvent,
    events,
    sessionId,
    cwd: '/tmp/babel-o-event-processing',
    storage: storage as unknown as NexusStorage,
    metrics: new NexusMetrics(),
    timeoutDecision: {
      policy: 'fatal',
      softTimeoutMs: 30_000,
      watchdogTimeoutMs: 30_000,
      maxSoftTimeoutExtensions: 0,
      softTimeoutExtensionMs: 30_000,
    },
    watchdog: { fired: false },
  })

  assert.equal(result.event, inputEvent)
  assert.equal(result.cacheHealthEvent?.type, 'cache_health')
  assert.deepEqual(
    storage.appended.map(entry => entry.event.type),
    ['execution_metrics', 'cache_health'],
  )
  assert.deepEqual(
    events.map(event => event.type),
    ['execution_metrics', 'cache_health'],
  )
})
