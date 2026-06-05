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

export type AgentJobGovernance = {
  maxConcurrentAgents: number
  activeAgents: number
  maxDepth: number
  depth: number
  maxRuntimeMs: number
  timeoutAt?: string
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
  governance?: AgentJobGovernance
  metadata?: Record<string, unknown>
}

export type AgentJobError = {
  code: string
  message: string
  details?: unknown
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
