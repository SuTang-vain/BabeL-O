import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runExecutionStreamLoop } from '../src/nexus/executionStreamLoop.js'
import { eventBase, type NexusEvent } from '../src/shared/events.js'
import type { NexusStorage } from '../src/storage/Storage.js'
import type { NexusRuntime, RuntimeExecuteOptions } from '../src/runtime/Runtime.js'
import { NexusMetrics } from '../src/nexus/metrics.js'
import type { ExecuteTimeoutDecision, WatchdogState } from '../src/nexus/executionPreparation.js'

class LoopStorage {
  readonly appended: Array<{ sessionId: string; event: NexusEvent }> = []

  async appendEvent(sessionId: string, event: NexusEvent): Promise<void> {
    this.appended.push({ sessionId, event })
  }
}

class StaticRuntime implements NexusRuntime {
  constructor(private readonly streamEvents: NexusEvent[]) {}

  async *executeStream(_options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    for (const event of this.streamEvents) {
      yield event
    }
  }
}

const timeoutDecision: ExecuteTimeoutDecision = {
  policy: 'fatal',
  softTimeoutMs: 1000,
  watchdogTimeoutMs: 1000,
  softTimeoutExtensionMs: 0,
  maxSoftTimeoutExtensions: 0,
}

const watchdog: WatchdogState = {
  fired: false,
}

test('runExecutionStreamLoop persists events, appends near-timeout warning, and tracks terminal result', async () => {
  const sessionId = 'session-loop-http'
  const storage = new LoopStorage()
  const events: NexusEvent[] = []
  const runtime = new StaticRuntime([
    {
      type: 'assistant_delta',
      ...eventBase(sessionId),
      text: 'partial answer',
    },
    {
      type: 'result',
      ...eventBase(sessionId),
      success: true,
      message: 'done',
    },
  ])

  const result = await runExecutionStreamLoop({
    runtime,
    runtimeOptions: {
      sessionId,
      prompt: 'hello',
      cwd: '/workspace',
    },
    events,
    sessionId,
    cwd: '/workspace',
    requestId: 'req-loop-http',
    storage: storage as unknown as NexusStorage,
    metrics: new NexusMetrics(),
    timeoutDecision,
    watchdog,
    timeoutMs: 100,
    startedAtMs: 0,
    now: () => 90,
  })

  assert.deepEqual(result, { success: true, timedOut: false })
  assert.deepEqual(
    events.map(event => event.type),
    ['assistant_delta', 'near_timeout_warning', 'result'],
  )
  assert.deepEqual(
    storage.appended.map(entry => entry.event.type),
    ['assistant_delta', 'near_timeout_warning', 'result'],
  )
})

test('runExecutionStreamLoop lets WebSocket forwarding stop the loop before timeout checkpoint', async () => {
  const sessionId = 'session-loop-ws-closed'
  const storage = new LoopStorage()
  const events: NexusEvent[] = []
  const forwarded: NexusEvent[] = []
  const runtime = new StaticRuntime([
    {
      type: 'assistant_delta',
      ...eventBase(sessionId),
      text: 'first',
    },
    {
      type: 'result',
      ...eventBase(sessionId),
      success: true,
      message: 'should not be reached',
    },
  ])

  const result = await runExecutionStreamLoop({
    runtime,
    runtimeOptions: {
      sessionId,
      prompt: 'hello',
      cwd: '/workspace',
    },
    events,
    sessionId,
    cwd: '/workspace',
    requestId: 'req-loop-ws',
    storage: storage as unknown as NexusStorage,
    metrics: new NexusMetrics(),
    timeoutDecision,
    watchdog,
    timeoutMs: 100,
    startedAtMs: 0,
    now: () => 90,
    forwardProcessedEvent(processed) {
      forwarded.push(processed.event)
      return { event: processed.event, closed: true }
    },
  })

  assert.deepEqual(result, { success: false, timedOut: false })
  assert.deepEqual(
    events.map(event => event.type),
    ['assistant_delta'],
  )
  assert.deepEqual(
    storage.appended.map(entry => entry.event.type),
    ['assistant_delta'],
  )
  assert.deepEqual(
    forwarded.map(event => event.type),
    ['assistant_delta'],
  )
})
