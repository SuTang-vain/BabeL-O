import type { FastifyInstance } from 'fastify'
import type { CreateNexusAppOptions } from './app.js'
import type { EverCoreStatus } from './everCoreConfig.js'
import type { NexusMetrics } from './metrics.js'
import type { AgentScheduler } from './agents/types.js'
import type { WorkingSetBroadcaster } from './workingSetBroadcaster.js'

// Re-exported from `bootstrapStatus.ts` so existing callers
// (routerRegistrar, app.ts, runtimeStatusRouter) keep their imports stable.
// We also import it locally because FeatureRouterContext references it.
import type { EverOSBootstrapStatusSnapshot } from './bootstrapStatus.js'
export type { EverOSBootstrapStatusSnapshot }

export type FeatureRouterContext = {
  options: CreateNexusAppOptions
  metrics: NexusMetrics
  memoryApprovalCounters?: {
    approved: number
    denied: number
    pendingReview: number
  }
  everCoreStatus(): EverCoreStatus
  everOSBootstrapStatus(): EverOSBootstrapStatusSnapshot
  runtimeMetricsSnapshot(): Promise<unknown>
  getActiveExecutionSnapshot?(sessionId: string):
    | {
        requestId: string
        transport: 'http' | 'websocket'
        startedAt: string
      }
    | null
  cancelActiveExecution?(sessionId: string):
    | {
        requestId: string
        transport: 'http' | 'websocket'
      }
    | null
  agentScheduler?: AgentScheduler
  // R3 of docs/nexus/proposals/long-running-context-assembly.md §20:
  // shared per-app broadcaster so REST PUT /v1/context/working-set/:sessionId
  // and /v1/working-set/observe WebSocket operate on the same per-cwd
  // PersistedWorkingSetTracker instance. When present, PUT routes through
  // broadcaster.mutate(cwd, ...) so mutations reach all observers. When
  // absent, the PUT route falls back to a per-request tracker (legacy
  // behavior; not visible to existing WS subscribers).
  workingSetBroadcaster?: WorkingSetBroadcaster
}

export type FeatureRouter = {
  name: string
  register(app: FastifyInstance, context: FeatureRouterContext): Promise<void> | void
}
