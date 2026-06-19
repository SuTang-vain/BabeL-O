import type { FastifyInstance } from 'fastify'
import type { CreateNexusAppOptions } from './app.js'
import type { EverCoreStatus } from './everCoreConfig.js'
import type { NexusMetrics } from './metrics.js'
import type { EverOSBootstrapErrorCode } from '../shared/everosBootstrapStore.js'
import type { AgentScheduler } from './agents/types.js'

export type EverOSBootstrapStatusSnapshot = {
  configured: boolean
  path: string
  status: 'not_configured' | 'invalid' | string
  optedIn?: boolean
  optedOut?: boolean
  externalHintShown?: boolean
  sourceRepo?: string
  sourceRef?: string
  sourceCommit?: string
  sourceDir?: string
  dataDir?: string
  managedCommand?: string
  lastCheckedAt?: string
  lastBuildAt?: string
  errorCode?: EverOSBootstrapErrorCode
  errorMessage?: string
  autoBootstrapPolicy?: 'off' | 'on' | 'prompt'
  fallbackBuildTool?: 'uv' | 'pip' | 'none'
  mcpToolsEnabled?: boolean
}

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
