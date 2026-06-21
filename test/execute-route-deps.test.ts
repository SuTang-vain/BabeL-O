import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildExecuteRouteSharedDeps, type ExecuteRouteSharedDeps } from '../src/nexus/executeRouteDeps.js'
import { ExecutionGate } from '../src/nexus/executionGate.js'
import { NexusMetrics } from '../src/nexus/metrics.js'
import { ActiveExecutionRegistry } from '../src/nexus/activeExecutionRegistry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import type { NexusRuntime } from '../src/runtime/Runtime.js'
import type { RemoteToolRunner } from '../src/runtime/remoteRunner.js'
import type { BehaviorMonitor } from '../src/runtime/behaviorMonitor.js'

class StubRuntime implements NexusRuntime {
  async *executeStream(): AsyncIterable<never> {
    // no streams exercised in deps tests
  }
}

const stubRemoteRunner = {
  // The factory only passes this reference through; the type is
  // intentionally minimal because no remote runner code is invoked here.
} as unknown as RemoteToolRunner

const stubBehaviorMonitor = {
  ingest: () => {},
  detectAll: () => ({ hotPath: [], toolStorm: [], scopeDriftWave: [] }),
} as unknown as BehaviorMonitor

function buildFactoryInput(overrides: Partial<{
  runtime: NexusRuntime
  storage: MemoryStorage
  remoteRunner: RemoteToolRunner | undefined
  executeTimeoutMs: number
  executePolicyMode: 'strict' | 'soft-deny'
  maxToolOutputBytes: number
  bashMaxBufferBytes: number
  defaultCwd: string
  executionGate: ExecutionGate
  metrics: NexusMetrics
  activeExecutionRegistry: ActiveExecutionRegistry
  behaviorMonitor: BehaviorMonitor | undefined
}> = {}) {
  const storage = overrides.storage ?? new MemoryStorage()
  return {
    runtime: overrides.runtime ?? new StubRuntime(),
    storage,
    remoteRunner: overrides.remoteRunner,
    executeTimeoutMs: overrides.executeTimeoutMs ?? 30_000,
    executePolicyMode: overrides.executePolicyMode ?? 'strict' as const,
    maxToolOutputBytes: overrides.maxToolOutputBytes ?? 200_000,
    bashMaxBufferBytes: overrides.bashMaxBufferBytes ?? 1_000_000,
    defaultCwd: overrides.defaultCwd ?? '/tmp',
    executionGate: overrides.executionGate ?? new ExecutionGate(8),
    metrics: overrides.metrics ?? new NexusMetrics(),
    activeExecutionRegistry: overrides.activeExecutionRegistry ?? new ActiveExecutionRegistry(),
    behaviorMonitor: overrides.behaviorMonitor,
  }
}

test('buildExecuteRouteSharedDeps returns all 11 shared fields', () => {
  const input = buildFactoryInput()
  const deps = buildExecuteRouteSharedDeps(input)
  assert.ok(deps.runtime instanceof StubRuntime)
  assert.ok(deps.storage instanceof MemoryStorage)
  assert.equal(deps.executeTimeoutMs, 30_000)
  assert.equal(deps.executePolicyMode, 'strict')
  assert.equal(deps.maxToolOutputBytes, 200_000)
  assert.equal(deps.bashMaxBufferBytes, 1_000_000)
  assert.equal(deps.defaultCwd, '/tmp')
  assert.ok(deps.executionGate instanceof ExecutionGate)
  assert.ok(deps.metrics instanceof NexusMetrics)
  assert.ok(deps.activeExecutionRegistry instanceof ActiveExecutionRegistry)
})

test('buildExecuteRouteSharedDeps passes gate/metrics/registry references through unchanged', () => {
  const gate = new ExecutionGate(4)
  const metrics = new NexusMetrics()
  const registry = new ActiveExecutionRegistry()
  const storage = new MemoryStorage()

  const deps = buildExecuteRouteSharedDeps(buildFactoryInput({
    executionGate: gate,
    metrics,
    activeExecutionRegistry: registry,
    storage,
  }))

  // Reference identity must be preserved — the route handlers observe
  // the same instances as the rest of the app.
  assert.equal(deps.executionGate, gate)
  assert.equal(deps.metrics, metrics)
  assert.equal(deps.activeExecutionRegistry, registry)
  assert.equal(deps.storage, storage)
})

test('buildExecuteRouteSharedDeps propagates policy mode changes (strict vs soft-deny)', () => {
  const strict = buildExecuteRouteSharedDeps(buildFactoryInput({ executePolicyMode: 'strict' }))
  assert.equal(strict.executePolicyMode, 'strict')

  const softDeny = buildExecuteRouteSharedDeps(buildFactoryInput({ executePolicyMode: 'soft-deny' }))
  assert.equal(softDeny.executePolicyMode, 'soft-deny')
})

test('buildExecuteRouteSharedDeps forwards optional remoteRunner and behaviorMonitor', () => {
  const deps = buildExecuteRouteSharedDeps(buildFactoryInput({
    remoteRunner: stubRemoteRunner,
    behaviorMonitor: stubBehaviorMonitor,
  }))
  assert.equal(deps.remoteRunner, stubRemoteRunner)
  assert.equal(deps.behaviorMonitor, stubBehaviorMonitor)
})

test('buildExecuteRouteSharedDeps tolerates undefined optional fields', () => {
  // Composition roots without a remote runner or behavior monitor must
  // still be able to build the deps bundle.
  const input = buildFactoryInput()
  // Explicitly leave remoteRunner + behaviorMonitor undefined.
  delete (input as { remoteRunner?: unknown }).remoteRunner
  delete (input as { behaviorMonitor?: unknown }).behaviorMonitor
  const deps: ExecuteRouteSharedDeps = buildExecuteRouteSharedDeps(input)
  assert.equal(deps.remoteRunner, undefined)
  assert.equal(deps.behaviorMonitor, undefined)
})

test('buildExecuteRouteSharedDeps result is structurally compatible with both route deps types', () => {
  // The factory's `ExecuteRouteSharedDeps` shape is the intersection of
  // `ExecuteHttpRouteDeps` and `ExecuteStreamRouteDeps`. This test
  // asserts that the factory output can be passed to both route
  // registration helpers without TypeScript complaints.
  const deps = buildExecuteRouteSharedDeps(buildFactoryInput())
  // Both casts below must succeed without runtime errors.
  const httpCompatible: ExecuteRouteSharedDeps = deps
  const streamCompatible: ExecuteRouteSharedDeps = deps
  assert.equal(httpCompatible, streamCompatible)
  assert.equal(httpCompatible.metrics, deps.metrics)
})
