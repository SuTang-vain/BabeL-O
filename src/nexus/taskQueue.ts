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
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['completed', 'failed'])
const TERMINAL_TASK_TTL_MS = 24 * 60 * 60 * 1000
const TERMINAL_TASK_SWEEP_INTERVAL_MS = 60 * 60 * 1000

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

  if (updates.status === 'failed') {
    propagateFailures(queue)
  }

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

export function createNexusSubTasks(options: {
  queueId: string
  parentTaskId: string
  ownerAgentId?: string
  createdBySessionId?: string
  source?: NexusTask['source']
  subTasks: Array<{
    title: string
    description?: string
    requiresIsolation?: boolean
    metadata?: Record<string, unknown>
  }>
}): NexusTask[] {
  const queue = getQueue(options.queueId)
  const parent = queue.get(options.parentTaskId)
  if (!parent) {
    throw new TaskQueueError(
      `Parent task not found: ${options.parentTaskId}`,
      'TASK_NOT_FOUND',
      404,
    )
  }

  const created = options.subTasks.map(subTask =>
    createNexusTask({
      queueId: options.queueId,
      title: subTask.title,
      description: subTask.description,
      ownerAgentId: options.ownerAgentId,
      createdBySessionId: options.createdBySessionId,
      source: options.source ?? 'executor',
      metadata: {
        ...(subTask.metadata ?? {}),
        parentTaskId: options.parentTaskId,
        requiresIsolation: subTask.requiresIsolation ?? false,
      },
    }),
  )

  parent.status = 'blocked'
  parent.ownerAgentId = undefined
  parent.dependsOn = Array.from(new Set([...parent.dependsOn, ...created.map(task => task.taskId)]))
  parent.metadata = {
    ...(parent.metadata ?? {}),
    delegatedSubTaskIds: created.map(task => task.taskId),
  }
  parent.updatedAt = now()
  persistNexusTask(cloneTask(parent))

  return created
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

export function clearTaskQueue(queueId: string): boolean {
  taskCounters.delete(queueId)
  return taskQueues.delete(queueId)
}

export function pruneTaskQueues(options: {
  olderThanMs?: number
  nowMs?: number
} = {}): number {
  const olderThanMs = options.olderThanMs ?? TERMINAL_TASK_TTL_MS
  const nowMs = options.nowMs ?? Date.now()
  let pruned = 0

  for (const [queueId, queue] of taskQueues.entries()) {
    for (const [taskId, task] of queue.entries()) {
      if (!TERMINAL_TASK_STATUSES.has(task.status)) continue
      const updatedAtMs = Date.parse(task.updatedAt)
      if (!Number.isFinite(updatedAtMs)) continue
      if (nowMs - updatedAtMs < olderThanMs) continue
      queue.delete(taskId)
      pruned += 1
    }
    if (queue.size === 0) {
      taskQueues.delete(queueId)
      taskCounters.delete(queueId)
    }
  }

  return pruned
}

const taskQueueSweeper = setInterval(() => {
  pruneTaskQueues()
}, TERMINAL_TASK_SWEEP_INTERVAL_MS)
taskQueueSweeper.unref?.()

export function taskQueueStatsForTest(): { queues: number; tasks: number } {
  let tasks = 0
  for (const queue of taskQueues.values()) {
    tasks += queue.size
  }
  return {
    queues: taskQueues.size,
    tasks,
  }
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

function propagateFailures(queue: Map<string, NexusTask>): void {
  let changed = true
  while (changed) {
    changed = false
    for (const task of queue.values()) {
      if (task.status === 'completed' || task.status === 'failed') continue
      const hasFailedDep = task.dependsOn.some(depId => {
        const dep = queue.get(depId)
        return dep?.status === 'failed'
      })
      if (hasFailedDep) {
        const failedDependencies = task.dependsOn
          .map(depId => queue.get(depId))
          .filter((dep): dep is NexusTask => dep?.status === 'failed')
        task.status = 'failed'
        task.result = failedDependencies
          .map(dep => dep.result || `Dependency ${dep.taskId} failed`)
          .join('\n') || 'Dependency failed'
        task.metadata = {
          ...(task.metadata ?? {}),
          failedDependencies: failedDependencies.map(dep => ({
            taskId: dep.taskId,
            title: dep.title,
            result: dep.result,
            metadata: dep.metadata,
          })),
        }
        task.updatedAt = now()
        persistNexusTask(cloneTask(task))
        changed = true
      }
    }
  }
}
