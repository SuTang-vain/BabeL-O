export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type NexusTask = {
  taskId: string
  sessionId: string
  title: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  result?: string
}
