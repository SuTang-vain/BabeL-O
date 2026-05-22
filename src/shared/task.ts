export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type NexusTask = {
  taskId: string
  sessionId: string // queueId in agent coordination loop
  title: string
  description?: string
  status: TaskStatus
  ownerAgentId?: string
  createdBySessionId?: string
  source?: 'planner' | 'executor' | 'critic' | 'user' | 'system'
  dependsOn: string[]
  blocks: string[]
  retryCount: number
  review?: {
    status: 'pending' | 'approved' | 'rejected'
    reason?: string
    reviewerAgentId?: string
  }
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
  result?: string
}

