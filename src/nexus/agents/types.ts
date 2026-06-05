export type ContextForkMode =
  | 'minimal'
  | 'working-set'
  | 'task-focused'
  | 'full-summary'
  | 'debug-replay'

export type AgentProfileId =
  | 'explore'
  | 'review'
  | 'test'
  | 'implement'
  | 'debug'
  | 'general'

export type AgentJobStatus =
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AgentIsolationMode = 'none' | 'worktree'

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

export type AgentJob = {
  jobId: string
  parentSessionId: string
  childSessionId: string
  parentTaskId?: string
  agentType: AgentProfileId
  status: AgentJobStatus
  prompt: string
  contextForkMode: ContextForkMode
  isolation: AgentIsolationMode
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  result?: AgentResult
  error?: AgentJobError
  transcriptPath?: string
  metadata?: Record<string, unknown>
}

export type AgentJobError = {
  code: string
  message: string
  details?: unknown
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

export type AgentJobFilter = {
  parentSessionId?: string
  status?: AgentJobStatus
  agentType?: AgentProfileId
}

export type AgentFinding = {
  severity: 'info' | 'warning' | 'error'
  message: string
  file?: string
  line?: number
  evidence?: string
}

export type AgentResult = {
  summary: string
  findings?: AgentFinding[]
  changedFiles?: string[]
  testsRun?: string[]
  commandsRun?: string[]
  nextSteps?: string[]
  confidence?: 'low' | 'medium' | 'high'
}

export interface AgentScheduler {
  spawnAgent(request: AgentSpawnRequest): Promise<AgentJob>
  waitForAgent(jobId: string, options?: AgentWaitOptions): Promise<AgentJob>
  listAgents(filter?: AgentJobFilter): Promise<AgentJob[]>
  cancelAgent(jobId: string, reason?: string): Promise<AgentJob>
}
