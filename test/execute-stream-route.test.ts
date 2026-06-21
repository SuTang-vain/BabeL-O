import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { eventBase, type NexusEvent } from '../src/shared/events.js'
import { NexusMetrics } from '../src/nexus/metrics.js'
import { ExecutionGate } from '../src/nexus/executionGate.js'
import { ActiveExecutionRegistry } from '../src/nexus/activeExecutionRegistry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { registerExecuteStreamRoute } from '../src/nexus/executeStreamRoute.js'
import type { NexusRuntime, RuntimeExecuteOptions } from '../src/runtime/Runtime.js'

class ScriptedRuntime implements NexusRuntime {
  constructor(private readonly streamEvents: NexusEvent[]) {}

  async *executeStream(_options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    for (const event of this.streamEvents) {
      yield event
    }
  }
}

function attachRoute(deps: {
  runtime: NexusRuntime
  executionGate: ExecutionGate
  metrics: NexusMetrics
  registry: ActiveExecutionRegistry
}) {
  const app = Fastify({ logger: false })
  registerExecuteStreamRoute(app, {
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

test('executeStreamRoute registers the GET /v1/stream websocket upgrade route', async () => {
  const app = attachRoute({
    runtime: new ScriptedRuntime([]),
    executionGate: new ExecutionGate(8),
    metrics: new NexusMetrics(),
    registry: new ActiveExecutionRegistry(),
  })
  await app.register(websocket)
  try {
    const routes = app.printRoutes({ commonPrefix: false })
    assert.ok(routes.includes('/v1/stream'), `expected /v1/stream in routes, got: ${routes}`)
  } finally {
    await app.close()
  }
})

test('executeStreamRoute integrates with the websocket plugin without crashing', async () => {
  // This slice must register without throwing once the websocket plugin is loaded.
  // The handler body is exercised by integration tests in test/runtime.test.ts and
  // test/security.test.ts which drive a real WebSocket client; here we only assert
  // the registration contract.
  const app = attachRoute({
    runtime: new ScriptedRuntime([
      { type: 'result', ...eventBase('seed-1'), success: true, message: 'done' },
    ]),
    executionGate: new ExecutionGate(1),
    metrics: new NexusMetrics(),
    registry: new ActiveExecutionRegistry(),
  })
  await app.register(websocket)
  try {
    // After websocket plugin registration, the app's underlying server
    // should accept upgrade requests — verify by calling ready().
    await app.ready()
    assert.ok(app.server !== undefined)
  } finally {
    await app.close()
  }
})
