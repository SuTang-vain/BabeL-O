import type { FastifyInstance } from 'fastify'
import type { CreateNexusAppOptions } from './app.js'
import type { EverCoreStatus } from './everCoreConfig.js'
import type { NexusMetrics } from './metrics.js'
import type { AgentScheduler } from './agents/types.js'

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
}

export type FeatureRouter = {
  name: string
  register(app: FastifyInstance, context: FeatureRouterContext): Promise<void> | void
}
