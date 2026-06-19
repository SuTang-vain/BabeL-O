import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import type { NexusRuntime } from '../runtime/Runtime.js'
import type { EverCoreClient } from '../runtime/everCoreClient.js'
import type { RemoteToolRunner } from '../runtime/remoteRunner.js'
import type { EverCoreRuntimeConfig, EverCoreStatus } from './everCoreConfig.js'
import type { MemoryProvider } from '../runtime/memoryProvider.js'
import type { RemoteRunnerStatus } from './remoteRunnerConfig.js'
import type { NexusStorage } from '../storage/Storage.js'
import { ExecutionGate } from './executionGate.js'
import { NexusMetrics } from './metrics.js'
import { ActiveExecutionRegistry } from './activeExecutionRegistry.js'
import { buildRuntimeMetricsSnapshot } from './runtimeMetricsSnapshot.js'
import { ExploreAgentScheduler } from './agents/AgentScheduler.js'
import { registerExecuteHttpRoute, type ExecuteHttpRouteDeps } from './executeHttpRoute.js'
import { registerExecuteStreamRoute, type ExecuteStreamRouteDeps } from './executeStreamRoute.js'
import { registerAllRouters } from './routerRegistrar.js'
import type { AgentScheduler } from './agents/types.js'
import { buildEverCoreStatus, buildEverOSBootstrapStatus } from './bootstrapStatus.js'
import { registerCoreMiddleware } from './middleware.js'
import { buildExecuteRouteSharedDeps } from './executeRouteDeps.js'

export {
  parseSinceFromQuery,
  runBehaviorTraceGet,
  runContextHistory,
  type ContextHistoryParams,
} from './routers/contextHistoryRouter.js'
export {
  runContextAssemble,
  type ContextAssembleParams,
  type ContextAssembleScope,
} from './routers/contextAssembleRouter.js'
export {
  runWorkingSetGet,
  runWorkingSetList,
  runWorkspaceWorkingSetGet,
  type WorkingSetSession,
  type WorkspaceAggregatedEntry,
  type WorkspaceEntryContributor,
} from './routers/contextWorkingSetReadRouter.js'
export { runWorkingSetPut } from './routers/contextWorkingSetWriteRouter.js'
export { isLocalHost, validateSecurityConfig } from '../shared/security.js'

declare module 'fastify' {
  interface FastifyRequest {
    performanceStartMs: number
  }
}

export type CreateNexusAppOptions = {
  runtime: NexusRuntime
  storage: NexusStorage
  defaultCwd: string
  /**
   * PR-27: Optional shared WorkingSetBroadcaster. When provided, the
   * /v1/working-set/observe WebSocket and any future REST handlers that
   * opt in will share a per-cwd PersistedWorkingSetTracker instance, so
   * mutations flow into the same event bus that subscribers are listening
   * on. If not provided, a default per-app broadcaster is created.
   */
  workingSetBroadcaster?: import('./workingSetBroadcaster.js').WorkingSetBroadcaster
  /**
   * Optional ContextBroadcaster instance for /v1/context/observe.
   * Composition roots that need live runtime fan-out should pass the
   * same instance to createDefaultNexusRuntime({ contextBroadcaster }).
   * When omitted, the route uses the legacy default instance.
   */
  contextBroadcaster?: import('./contextBroadcaster.js').ContextBroadcaster
  /**
   * Optional BehaviorMonitor for cross-session event ingestion.
   * When provided, every Nexus event yielded during execution is
   * fed to behaviorMonitor.ingest() so that the 3 cross-session
   * detectors (hot-path, tool-storm, scope-drift-wave) receive
   * real event data. Without this, detectAll() always returns
   * empty results. The monitor is created per-cwd inside
   * createDefaultNexusRuntime(); server.ts passes it through.
   */
  behaviorMonitor?: import('../runtime/behaviorMonitor.js').BehaviorMonitor
  executeTimeoutMs?: number
  /**
   * Server-side default for the per-request `policy` body field. When a
   * request body omits `policy`, this value is used. Defaults to
   * `'strict'` to preserve existing HTTP API behavior. Go TUI overrides
   * per-request to `'soft-deny'`.
   */
  executePolicyMode?: 'strict' | 'soft-deny'
  maxConcurrentExecutions?: number
  maxToolOutputBytes?: number
  bashMaxBufferBytes?: number
  apiKey?: string
  remoteRunner?: RemoteToolRunner
  remoteRunnerStatus?: RemoteRunnerStatus
  everCoreClient?: EverCoreClient
  everCoreConfig?: EverCoreRuntimeConfig
  everCoreStatus?: EverCoreStatus
  memoryProvider?: MemoryProvider
  agentScheduler?: AgentScheduler
  agentExecutionEnvironment?: 'local' | 'remote'
}

export async function createNexusApp(options: CreateNexusAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const metrics = new NexusMetrics()
  /**
   * §3.5 Memory Quality Metrics: in-process counters for
   * `memory_save_note` approval / denial / pending-review. The
   * counts reset on Nexus restart (process-local, not durable),
   * which is consistent with the v1 contract: §3.5 metrics are
   * recent-window quality signals, not audit history. The
   * `memory_candidate` governance metadata on SessionChannel
   * messages is the durable per-candidate record.
   */
  const memoryApprovalCounters = { approved: 0, denied: 0, pendingReview: 0 }
  const apiKey = options.apiKey ?? process.env.NEXUS_API_KEY
  const executeTimeoutMs = options.executeTimeoutMs ?? 30_000
  const executePolicyMode = options.executePolicyMode ?? 'strict'
  const maxToolOutputBytes = options.maxToolOutputBytes ?? 200_000
  const bashMaxBufferBytes = options.bashMaxBufferBytes ?? 1_000_000
  const executionGate = new ExecutionGate(options.maxConcurrentExecutions ?? 8)
  const activeExecutionRegistry = new ActiveExecutionRegistry()
  const agentScheduler =
    options.agentScheduler ??
    new ExploreAgentScheduler({
      storage: options.storage,
      cwd: options.defaultCwd,
      executionEnvironment: options.agentExecutionEnvironment,
      remoteRunner: options.remoteRunner,
    })
  await app.register(websocket)

  // === Phase 4A+ slice: bootstrap status closure factories ===
  const everCoreStatus = buildEverCoreStatus(options.everCoreStatus)
  const everOSBootstrapStatus = buildEverOSBootstrapStatus()

  // === Phase 4A+ slice: cross-cutting middleware (error + metrics + auth) ===
  registerCoreMiddleware(app, metrics, apiKey)

  // === 路径 C: 结束 ===

  // === Phase 4A+ slice: 37 feature routers registered via routerRegistrar.ts ===
  await registerAllRouters(app, {
    options,
    metrics,
    memoryApprovalCounters,
    everCoreStatus,
    everOSBootstrapStatus,
    activeExecutionRegistry,
    agentScheduler,
  })

  // === Phase 4A+ slice: shared execute route deps built once via factory ===
  const executeSharedDeps = buildExecuteRouteSharedDeps({
    runtime: options.runtime,
    storage: options.storage,
    remoteRunner: options.remoteRunner,
    executeTimeoutMs,
    executePolicyMode,
    maxToolOutputBytes,
    bashMaxBufferBytes,
    defaultCwd: options.defaultCwd,
    executionGate,
    metrics,
    activeExecutionRegistry,
    behaviorMonitor: options.behaviorMonitor,
  })
  registerExecuteHttpRoute(app, executeSharedDeps as ExecuteHttpRouteDeps)
  registerExecuteStreamRoute(app, executeSharedDeps as ExecuteStreamRouteDeps)

  return app
}

// PR-27 helper extracted to src/shared/socketQuery.ts (no callers in
// nexus/app.ts — all WebSocket upgrade logic lives in executeStreamRoute
// which does its own query parsing; this module is exported from
// src/shared/ for reuse by the CLI TUI and future WebSocket routes).
// Phase 4A+ D2: security helpers moved to src/shared/security.ts and are
// re-exported above for legacy `nexus/app.ts` imports.
