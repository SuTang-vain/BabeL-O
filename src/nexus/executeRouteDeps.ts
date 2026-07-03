/**
 * Phase 4A+ slice — `executeRouteDeps.ts`
 *
 * Extracts the shared `executeHttpDeps` and `executeStreamDeps`
 * construction from `src/nexus/app.ts` into a focused factory. Both
 * `/v1/execute` (HTTP) and `/v1/stream` (WebSocket) routes consume the
 * exact same 11 fields (the 9 `runtime` / `storage` / `executionGate`
 * etc. fields are identical), so the composition root previously
 * duplicated the literal twice.
 *
 * Goals:
 * - One small reviewable file that documents the canonical execute
 *   route dependency shape.
 * - Preserve exact field values: the returned object is what each
 *   route handler module reads from.
 * - Eliminate the duplicated 11-field literal from `app.ts` (~26 lines
 *   of repeated construction).
 *
 * Non-goals:
 * - Do not introduce field aliases or merge the optional
 *   `remoteRunner` / `behaviorMonitor` fields — pass them through
 *   verbatim so the route modules' own type signatures stay stable.
 * - Do not move the per-request state (cwd, sessionId, abortController)
 *   into this factory; those are computed inside the route handler.
 */

import type { NexusRuntime } from '../runtime/Runtime.js'
import type { RemoteToolRunner } from '../runtime/remoteRunner.js'
import type { BehaviorMonitor } from '../runtime/behaviorMonitor.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { ExecutionGate } from './executionGate.js'
import type { NexusMetrics } from './metrics.js'
import type { ActiveExecutionRegistry } from './activeExecutionRegistry.js'
import type { ShutdownSignal } from './daemonLifecycle.js'

/**
 * The 11 shared dependency fields consumed by both
 * `executeHttpRoute.ts` and `executeStreamRoute.ts`. Anything else the
 * route handlers need (per-request state, parsed body) is computed
 * inside the handler.
 *
 * This type is intentionally the intersection of `ExecuteHttpRouteDeps`
 * and `ExecuteStreamRouteDeps` — keeping it as a separate alias lets
 * the route modules evolve independently without breaking the factory.
 */
export type ExecuteRouteSharedDeps = {
  runtime: NexusRuntime
  storage: NexusStorage
  remoteRunner?: RemoteToolRunner
  executeTimeoutMs: number
  executePolicyMode: 'strict' | 'soft-deny'
  maxToolOutputBytes: number
  bashMaxBufferBytes: number
  defaultCwd: string
  executionGate: ExecutionGate
  metrics: NexusMetrics
  activeExecutionRegistry: ActiveExecutionRegistry
  behaviorMonitor?: BehaviorMonitor
  /**
   * Daemon graceful-shutdown flag (Phase 1 of the daemon shutdown plan).
   * When `isShuttingDown` is true, the execute routes reject new leases
   * with `503 SHUTTING_DOWN` before calling `executionGate.tryAcquire`.
   * Optional for back-compat with embedded runners that do not wire
   * signal handlers.
   */
  shutdownSignal?: ShutdownSignal
}

/**
 * Build the canonical execute route dependency bundle consumed by both
 * the HTTP `/v1/execute` route and the WebSocket `/v1/stream` route.
 *
 * The factory takes already-resolved values (no `??` defaults — those
 * live in `createNexusApp`) so the route modules can rely on the
 * shape being fully populated. References are passed through without
 * cloning: the route handlers observe the same `metrics` and
 * `executionGate` instances that the rest of the app does.
 */
export function buildExecuteRouteSharedDeps(input: {
  runtime: NexusRuntime
  storage: NexusStorage
  remoteRunner?: RemoteToolRunner
  executeTimeoutMs: number
  executePolicyMode: 'strict' | 'soft-deny'
  maxToolOutputBytes: number
  bashMaxBufferBytes: number
  defaultCwd: string
  executionGate: ExecutionGate
  metrics: NexusMetrics
  activeExecutionRegistry: ActiveExecutionRegistry
  behaviorMonitor?: BehaviorMonitor
  shutdownSignal?: ShutdownSignal
}): ExecuteRouteSharedDeps {
  return {
    runtime: input.runtime,
    storage: input.storage,
    remoteRunner: input.remoteRunner,
    executeTimeoutMs: input.executeTimeoutMs,
    executePolicyMode: input.executePolicyMode,
    maxToolOutputBytes: input.maxToolOutputBytes,
    bashMaxBufferBytes: input.bashMaxBufferBytes,
    defaultCwd: input.defaultCwd,
    executionGate: input.executionGate,
    metrics: input.metrics,
    activeExecutionRegistry: input.activeExecutionRegistry,
    behaviorMonitor: input.behaviorMonitor,
    shutdownSignal: input.shutdownSignal,
  }
}
