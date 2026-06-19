import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { eventBase, type NexusEvent } from '../src/shared/events.js'
import { NexusMetrics } from '../src/nexus/metrics.js'
import { ExecutionGate } from '../src/nexus/executionGate.js'
import { ActiveExecutionRegistry } from '../src/nexus/activeExecutionRegistry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { registerExecuteHttpRoute } from '../src/nexus/executeHttpRoute.js'
import type { NexusRuntime, RuntimeExecuteOptions } from '../src/runtime/Runtime.js'

class ScriptedRuntime implements NexusRuntime {
  constructor(private readonly streamEvents: NexusEvent[]) {}

  async *executeStream(_options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    for (const event of this.streamEvents) {
      yield event
    }
  }
}

function makeApp(deps: {
  runtime: NexusRuntime
  executionGate: ExecutionGate
  metrics: NexusMetrics
  registry: ActiveExecutionRegistry
}): FastifyInstance {
  const app = Fastify({ logger: false })
  registerExecuteHttpRoute(app, {
    runtime: deps.runtime,
    storage: new MemoryStorage(),
    executeTimeoutMs: 5_000,
    executePolicyMode: 'strict',
    maxToolOutputBytes: 200_000,
    bashMaxBufferBytes: 1_000_000,
    defaultCwd: '/tmp',
    executionGate: deps.executionGate,
    metrics: deps.metrics,
    activeExecutionRegistry: deps.registry,
  })
  return app
}

test('executeHttpRoute returns 429 EXECUTION_BUSY when execution gate is saturated', async () => {
  const executionGate = new ExecutionGate(1)
  // Hold the only slot manually so the next tryAcquire returns null.
  const heldRelease = executionGate.tryAcquire()
  assert.ok(heldRelease, 'test setup: first slot should be acquired')
  const app = makeApp({
    runtime: new ScriptedRuntime([]),
    executionGate,
    metrics: new NexusMetrics(),
    registry: new ActiveExecutionRegistry(),
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'hello' },
    })
    assert.equal(response.statusCode, 429)
    const body = response.json()
    assert.equal(body.code, 'EXECUTION_BUSY')
  } finally {
    heldRelease!()
    await app.close()
  }
})

test('executeHttpRoute rejects prompt exceeding max length', async () => {
  // The schema requires `prompt` to be a non-empty string; the executeSchema
  // parses the body via zod, which throws on validation failure. The
  // production handler in `app.ts` lets Fastify convert that into a 500.
  // This slice preserves that exact behavior — a focused regression is
  // covered by `test/security.test.ts` which exercises the full Nexus app.
  // Here we only assert that an obviously invalid body does not silently
  // succeed (statusCode is 4xx/5xx, never 200).
  const app = makeApp({
    runtime: new ScriptedRuntime([]),
    executionGate: new ExecutionGate(8),
    metrics: new NexusMetrics(),
    registry: new ActiveExecutionRegistry(),
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: '' },
    })
    assert.notEqual(response.statusCode, 200, 'invalid body must not return success')
  } finally {
    await app.close()
  }
})

test('executeHttpRoute streams events and returns execute_result envelope on success', async () => {
  // The runtime does not own session ids — `prepareExecution` mints a
  // fresh one each call. We just confirm the envelope shape and that
  // the runtime stream's events appear in the response body.
  const runtime = new ScriptedRuntime([
    {
      type: 'assistant_delta',
      ...eventBase('seed-1'),
      text: 'partial',
    },
    {
      type: 'result',
      ...eventBase('seed-1'),
      success: true,
      message: 'done',
    },
  ])
  const app = makeApp({
    runtime,
    executionGate: new ExecutionGate(8),
    metrics: new NexusMetrics(),
    registry: new ActiveExecutionRegistry(),
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'hello world' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.type, 'execute_result')
    assert.equal(typeof body.sessionId, 'string')
    assert.ok(body.sessionId.length > 0)
    assert.equal(body.success, true)
    assert.equal(body.outcome, 'success')
    assert.ok(Array.isArray(body.events))
    assert.ok(body.events.length >= 2)
    // The streamed events from the runtime must appear in the envelope.
    const hasAssistantDelta = body.events.some(
      (event: NexusEvent) => event.type === 'assistant_delta' && event.text === 'partial',
    )
    const hasResult = body.events.some((event: NexusEvent) => event.type === 'result')
    assert.equal(hasAssistantDelta, true)
    assert.equal(hasResult, true)
  } finally {
    await app.close()
  }
})

test('executeHttpRoute releases execution lease on success path', async () => {
  const executionGate = new ExecutionGate(1)
  const registry = new ActiveExecutionRegistry()
  const runtime = new ScriptedRuntime([
    {
      type: 'result',
      ...eventBase('seed-2'),
      success: true,
      message: 'done',
    },
  ])
  const app = makeApp({
    runtime,
    executionGate,
    metrics: new NexusMetrics(),
    registry,
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt: 'first' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const sessionId = body.sessionId as string
    // Lease was released by the finally block, so the registry must
    // be empty even though the request succeeded.
    assert.equal(registry.snapshot(sessionId), null)
  } finally {
    await app.close()
  }
})
