export type {
  AgentFinding,
  AgentIsolationMode,
  AgentJob,
  AgentJobError,
  AgentJobFilter,
  AgentJobGovernance,
  AgentJobStatus,
  AgentProfileId,
  AgentResult,
  AgentContextProvenance,
  ContextForkMode,
} from '../../shared/agentJob.js'

import type {
  AgentIsolationMode,
  AgentJob,
  AgentJobFilter,
  AgentJobStatus,
  AgentProfileId,
  ContextForkMode,
} from '../../shared/agentJob.js'

export type AgentProfile = {
  id: AgentProfileId
  displayName: string
  defaultTools: string[]
  defaultContextForkMode: ContextForkMode
  defaultIsolation: AgentIsolationMode
  canEdit: boolean
  canRunBash: boolean
  requiresApproval: boolean
  maxRuntimeMs: number
  maxOutputTokens: number
}

export type AgentSpawnRequest = {
  parentSessionId: string
  prompt: string
  agentType?: AgentProfileId
  contextForkMode?: ContextForkMode
  isolation?: AgentIsolationMode
  allowedTools?: string[]
  maxRuntimeMs?: number
  maxOutputTokens?: number
  metadata?: Record<string, unknown>
}

export type AgentWaitOptions = {
  timeoutMs?: number
}

export interface AgentScheduler {
  spawnAgent(request: AgentSpawnRequest): Promise<AgentJob>
  waitForAgent(jobId: string, options?: AgentWaitOptions): Promise<AgentJob>
  listAgents(filter?: AgentJobFilter): Promise<AgentJob[]>
  cancelAgent(jobId: string, reason?: string): Promise<AgentJob>
}
