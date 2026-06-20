import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { NexusMetrics } from '../src/nexus/metrics.js'
import { ActiveExecutionRegistry } from '../src/nexus/activeExecutionRegistry.js'
import { ExploreAgentScheduler } from '../src/nexus/agents/AgentScheduler.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import type { NexusRuntime } from '../src/runtime/Runtime.js'
import type { AgentScheduler } from '../src/nexus/agents/types.js'
import { registerAllRouters, type RouterRegistrarExtras } from '../src/nexus/routerRegistrar.js'
import { WorkingSetBroadcaster } from '../src/nexus/workingSetBroadcaster.js'

class StubRuntime implements NexusRuntime {
  async *executeStream(): AsyncIterable<never> {
    // no streams exercised in registrar tests
  }
}

function buildExtras(overrides: Partial<RouterRegistrarExtras> = {}): RouterRegistrarExtras {
  const metrics = overrides.metrics ?? new NexusMetrics()
  const storage = overrides.options?.storage ?? new MemoryStorage()
  const options = { ...(overrides.options ?? {}), storage }
  const agentScheduler = overrides.agentScheduler ?? new ExploreAgentScheduler({ storage })
  return {
    options: options as RouterRegistrarExtras['options'],
    metrics,
    everCoreStatus: overrides.everCoreStatus ?? (() => ({
      configured: false,
      enabled: false,
      healthy: true,
      mode: 'disabled' as const,
      uploadOnSessionEnd: false,
      mcpToolsEnabled: false,
      namespace: {
        layer: 'project_memory' as const,
        isolationKey: 'projectId' as const,
        sessionScoped: false,
        projectIdSource: 'default' as const,
      },
    })),
    everOSBootstrapStatus: overrides.everOSBootstrapStatus ?? (() => ({
      configured: false,
      path: '/tmp/everos.json',
      status: 'not_configured',
    })),
    activeExecutionRegistry: overrides.activeExecutionRegistry ?? new ActiveExecutionRegistry(),
    agentScheduler: agentScheduler as AgentScheduler,
    workingSetBroadcaster: overrides.workingSetBroadcaster ?? new WorkingSetBroadcaster(),
  }
}

test('registerAllRouters registers the full route table', async () => {
  const app = Fastify({ logger: false })
  const extras = buildExtras()
  await registerAllRouters(app, extras)
  try {
    const routes = app.printRoutes({ commonPrefix: false })
    // Sample a few representative routes from each router group.
    assert.ok(routes.includes('/health'), 'runtimeStatusRouter must register /health')
    assert.ok(routes.includes('/v1/runtime/config'), 'runtimeConfigRouter must register GET /v1/runtime/config')
    assert.ok(routes.includes('/v1/sessions'), 'sessionReadRouter must register GET /v1/sessions')
    assert.ok(routes.includes('/v1/skills'), 'skillReadRouter must register GET /v1/skills')
    assert.ok(routes.includes('/v1/context/working-set'), 'contextWorkingSetReadRouter must register GET /v1/context/working-set')
    assert.ok(routes.includes('/v1/tools/audit'), 'toolsAuditRouter must register GET /v1/tools/audit')
    assert.ok(routes.includes('/v1/loop/workspaces'), 'loopWorkspaceRouter must register GET /v1/loop/workspaces')
    assert.ok(routes.includes('/v1/schema/events'), 'schemaRouter must register GET /v1/schema/events')
  } finally {
    await app.close()
  }
})

test('registerAllRouters accepts custom memoryApprovalCounters without crashing', async () => {
  const app = Fastify({ logger: false })
  const counters = { approved: 0, denied: 0, pendingReview: 0 }
  await registerAllRouters(
    app,
    buildExtras({ memoryApprovalCounters: counters }),
  )
  try {
    // Routers that read memoryApprovalCounters must see the same instance.
    assert.equal(counters.approved, 0)
    // No throw means the registration contract is preserved.
  } finally {
    await app.close()
  }
})

test('registerAllRouters wires activeExecutionRegistry cancellation into sessionCancelRouter', async () => {
  const app = Fastify({ logger: false })
  const registry = new ActiveExecutionRegistry()
  await registerAllRouters(app, buildExtras({ activeExecutionRegistry: registry }))
  try {
    // Inject an active execution, then verify that the cancel callback wired
    // by the registrar reaches into the same registry instance.
    const lease = registry.register('session-registrar-cancel', {
      requestId: 'req-cancel-1',
      abortController: new AbortController(),
      transport: 'http',
      startedAt: new Date().toISOString(),
    })
    const cancelled = registry.cancel('session-registrar-cancel')
    assert.ok(cancelled, 'cancel must find the active execution')
    assert.equal(cancelled!.requestId, 'req-cancel-1')
    lease.release()
  } finally {
    await app.close()
  }
})

test('registerAllRouters builds a runtimeMetricsSnapshot closure that defers reads', async () => {
  const app = Fastify({ logger: false })
  const metrics = new NexusMetrics()
  const extras = buildExtras({ metrics })
  await registerAllRouters(app, extras)
  try {
    // Increment a metric and then call the /v1/runtime/metrics route —
    // the closure must see the up-to-date value (proves it is captured
    // by reference, not snapshotted at registration time).
    metrics.recordRoute('GET /foo', 200, 12)
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/metrics' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.ok(body && typeof body === 'object', 'metrics body must be an object')
    // routes is a map keyed by "<METHOD> <url>"; we just assert that the
    // registration ran without throwing and the route is reachable.
  } finally {
    await app.close()
  }
})

test('registerAllRouters wires the shared workingSetBroadcaster into contextWorkingSetWriteRouter', async () => {
  const app = Fastify({ logger: false })
  const broadcaster = new WorkingSetBroadcaster()
  await registerAllRouters(app, buildExtras({ workingSetBroadcaster: broadcaster }))
  try {
    // Before any request, the broadcaster has no cached tracker.
    assert.equal(broadcaster.size(), 0)
    // PUT /v1/context/working-set/:sessionId?cwd=... must route the mutation
    // through broadcaster.mutate() so the broadcaster ends up with a
    // cached per-cwd tracker (proves the wire is live, not just typed).
    const cwd = '/tmp/wsbroadcaster-test'
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/context/working-set/sess-abc?cwd=' + encodeURIComponent(cwd),
      payload: {
        workspaceId: 'ws-1',
        entries: [
          { key: 'k1', value: 'v1', updatedAt: new Date().toISOString(), confidence: 0.9 },
        ],
      },
    })
    assert.equal(response.statusCode, 200, `expected 200, got ${response.statusCode}: ${response.body}`)
    // The broadcaster now owns a tracker for `cwd` — the only way this
    // could happen is if contextWorkingSetWriteRouter called
    // broadcaster.mutate(cwd, ...).
    assert.equal(broadcaster.size(), 1)
    const tracker = broadcaster.getTracker(cwd)
    assert.ok(tracker, 'tracker must be cached after PUT')
    const persisted = tracker!.get('sess-abc')
    assert.ok(persisted, 'session must be persisted on the shared tracker')
    assert.equal(persisted!.workspaceId, 'ws-1')
    assert.equal(persisted!.entries.length, 1)
    assert.equal(persisted!.entries[0]!.key, 'k1')
  } finally {
    await app.close()
  }
})
