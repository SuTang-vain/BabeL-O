import type { NexusTask, TaskStatus } from '../shared/task.js'
import { persistNexusTask } from './storageBridge.js'

export class TaskQueueError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'TaskQueueError'
  }
}

const taskQueues = new Map<string, Map<string, NexusTask>>()
const taskCounters = new Map<string, number>()

function now(): string {
  return new Date().toISOString()
}

function getQueue(queueId: string): Map<string, NexusTask> {
  let queue = taskQueues.get(queueId)
  if (!queue) {
    queue = new Map()
    taskQueues.set(queueId, queue)
  }
  return queue
}

function nextTaskId(queueId: string): string {
  const next = (taskCounters.get(queueId) ?? 0) + 1
  taskCounters.set(queueId, next)
  return String(next)
}

function cloneTask(task: NexusTask): NexusTask {
  return {
    ...task,
    dependsOn: [...task.dependsOn],
    blocks: [...task.blocks],
    review: task.review ? { ...task.review } : undefined,
    metadata: task.metadata ? { ...task.metadata } : undefined,
  }
}

export function createNexusTask(options: {
  queueId: string // mapped to task.sessionId in storage
  title: string
  description?: string
  ownerAgentId?: string
  createdBySessionId?: string
  source?: NexusTask['source']
  dependsOn?: string[]
  blocks?: string[]
  metadata?: Record<string, unknown>
}): NexusTask {
  const queue = getQueue(options.queueId)
  const timestamp = now()
  const task: NexusTask = {
    taskId: nextTaskId(options.queueId),
    sessionId: options.queueId,
    title: options.title,
    description: options.description,
    status: options.dependsOn?.length ? 'blocked' : 'pending',
    ownerAgentId: options.ownerAgentId,
    createdBySessionId: options.createdBySessionId,
    source: options.source ?? 'user',
    dependsOn: options.dependsOn ?? [],
    blocks: options.blocks ?? [],
    retryCount: 0,
    review: { status: 'pending' },
    metadata: options.metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  queue.set(task.taskId, task)
  const created = cloneTask(task)
  persistNexusTask(created)
  return created
}

export type NexusTaskQueueSnapshot = {
  queueId: string
  tasks: NexusTask[]
}

export function listNexusTasks(queueId: string): NexusTaskQueueSnapshot {
  return {
    queueId,
    tasks: Array.from(getQueue(queueId).values()).map(cloneTask),
  }
}

export function getNexusTask(queueId: string, taskId: string): NexusTask {
  const task = getQueue(queueId).get(taskId)
  if (!task) {
    throw new TaskQueueError(
      `Task not found: ${taskId}`,
      'TASK_NOT_FOUND',
      404,
    )
  }
  return cloneTask(task)
}

export function updateNexusTask(
  queueId: string,
  taskId: string,
  updates: {
    title?: string
    description?: string
    status?: TaskStatus
    ownerAgentId?: string | null
    dependsOn?: string[]
    blocks?: string[]
    retryCount?: number
    review?: NexusTask['review']
    metadata?: Record<string, unknown>
    result?: string
  },
): NexusTask {
  const queue = getQueue(queueId)
  const task = queue.get(taskId)
  if (!task) {
    throw new TaskQueueError(
      `Task not found: ${taskId}`,
      'TASK_NOT_FOUND',
      404,
    )
  }

  if (updates.title !== undefined) task.title = updates.title
  if (updates.description !== undefined) task.description = updates.description
  if (updates.status !== undefined) task.status = updates.status
  if (updates.ownerAgentId !== undefined) {
    task.ownerAgentId = updates.ownerAgentId ?? undefined
  }
  if (updates.dependsOn !== undefined) task.dependsOn = updates.dependsOn
  if (updates.blocks !== undefined) task.blocks = updates.blocks
  if (updates.retryCount !== undefined) task.retryCount = updates.retryCount
  if (updates.review !== undefined) task.review = updates.review
  if (updates.metadata !== undefined) task.metadata = updates.metadata
  if (updates.result !== undefined) task.result = updates.result
  task.updatedAt = now()

  const updated = cloneTask(task)
  persistNexusTask(updated)
  return updated
}

export function claimNexusTask(options: {
  queueId: string
  taskId?: string
  ownerAgentId: string
}): NexusTask {
  const queue = getQueue(options.queueId)
  const task = options.taskId
    ? queue.get(options.taskId)
    : Array.from(queue.values()).find(candidate =>
        isTaskClaimable(candidate, queue),
      )

  if (!task) {
    throw new TaskQueueError(
      options.taskId
        ? `Task not found: ${options.taskId}`
        : `No claimable task in queue: ${options.queueId}`,
      options.taskId ? 'TASK_NOT_FOUND' : 'NO_CLAIMABLE_TASK',
      options.taskId ? 404 : 409,
    )
  }

  if (!isTaskClaimable(task, queue)) {
    throw new TaskQueueError(
      `Task is not claimable: ${task.taskId}`,
      'TASK_NOT_CLAIMABLE',
      409,
    )
  }

  task.status = 'in_progress'
  task.ownerAgentId = options.ownerAgentId
  task.updatedAt = now()
  const claimed = cloneTask(task)
  persistNexusTask(claimed)
  return claimed
}

export function completeNexusTask(options: {
  queueId: string
  taskId: string
  ownerAgentId?: string
  result?: string
  metadata?: Record<string, unknown>
}): NexusTask {
  const queue = getQueue(options.queueId)
  const task = queue.get(options.taskId)
  if (!task) {
    throw new TaskQueueError(
      `Task not found: ${options.taskId}`,
      'TASK_NOT_FOUND',
      404,
    )
  }

  if (
    options.ownerAgentId &&
    task.ownerAgentId &&
    task.ownerAgentId !== options.ownerAgentId
  ) {
    throw new TaskQueueError(
      `Task is owned by another agent: ${task.taskId}`,
      'TASK_OWNER_MISMATCH',
      409,
    )
  }

  task.status = 'completed'
  task.ownerAgentId = options.ownerAgentId ?? task.ownerAgentId
  task.review = task.review ?? { status: 'approved' }
  if (task.review) {
    task.review.status = 'approved'
  }
  task.metadata = {
    ...(task.metadata ?? {}),
    ...(options.metadata ?? {}),
  }
  task.result = options.result
  task.updatedAt = now()

  const unblockedTasks = unblockTasks(queue)
  const completed = cloneTask(task)
  persistNexusTask(completed)
  for (const unblockedTask of unblockedTasks) {
    persistNexusTask(unblockedTask)
  }
  return completed
}

export function areAllNexusTasksCompleted(queueId: string): boolean {
  const tasks = Array.from(getQueue(queueId).values())
  return tasks.length > 0 && tasks.every(task => task.status === 'completed')
}

export function isNexusTaskQueueSettled(queueId: string): boolean {
  const tasks = Array.from(getQueue(queueId).values())
  return (
    tasks.length > 0 &&
    tasks.every(task => task.status === 'completed' || task.status === 'failed')
  )
}

export function resetTaskQueuesForTest(): void {
  taskQueues.clear()
  taskCounters.clear()
}

export function hydrateNexusTasks(tasks: NexusTask[]): void {
  taskQueues.clear()
  taskCounters.clear()
  for (const task of tasks) {
    const queue = getQueue(task.sessionId)
    queue.set(task.taskId, cloneTask(task))
    const numericTaskId = Number(task.taskId)
    if (Number.isInteger(numericTaskId) && numericTaskId > 0) {
      taskCounters.set(
        task.sessionId,
        Math.max(taskCounters.get(task.sessionId) ?? 0, numericTaskId),
      )
    }
  }
}

export const hydrateNexusTasksForTest = hydrateNexusTasks

function isTaskClaimable(
  task: NexusTask,
  queue: Map<string, NexusTask>,
): boolean {
  if (task.status !== 'pending') return false
  if (task.ownerAgentId) return false
  return task.dependsOn.every(dependencyId => {
    const dependency = queue.get(dependencyId)
    return dependency?.status === 'completed'
  })
}

function unblockTasks(queue: Map<string, NexusTask>): NexusTask[] {
  const unblockedTasks: NexusTask[] = []
  for (const task of queue.values()) {
    if (task.status !== 'blocked') continue
    if (
      task.dependsOn.every(dependencyId => {
        const dependency = queue.get(dependencyId)
        return dependency?.status === 'completed'
      })
    ) {
      task.status = 'pending'
      task.updatedAt = now()
      unblockedTasks.push(cloneTask(task))
    }
  }
  return unblockedTasks
}
