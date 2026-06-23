import { resolve } from 'node:path'
import { z } from 'zod'
import { eventBase, NEXUS_EVENT_SCHEMA_VERSION } from '../../shared/events.js'
import { createId, nowIso } from '../../shared/id.js'
import type { SessionSnapshot } from '../../shared/session.js'
import type { NexusTask, TaskStatus } from '../../shared/task.js'
import type { NexusStorage } from '../../storage/Storage.js'
import type { FeatureRouter } from '../router.js'
import { removeWorktree } from '../worktree.js'

const taskMutationMetadataSchema = z.record(z.string(), z.unknown())

const taskMutationAuditSchema = z.object({
  actor: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  requestId: z.string().optional(),
  expectedUpdatedAt: z.string().optional(),
})

const createTaskSchema = taskMutationAuditSchema.extend({
  title: z.string().min(1),
  description: z.string().optional(),
  metadata: taskMutationMetadataSchema.optional(),
})

const updateTaskSchema = taskMutationAuditSchema.extend({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']).optional(),
  result: z.string().optional(),
  metadata: taskMutationMetadataSchema.optional(),
})

const taskActionSchema = taskMutationAuditSchema.extend({
  result: z.string().optional(),
  ownerAgentId: z.string().optional(),
  reviewReason: z.string().optional(),
})

const worktreeRecoveryActionSchema = taskMutationAuditSchema.extend({
  action: z.enum(['continue', 'abandon', 'keep']),
})

const subAgentRerunSchema = taskMutationAuditSchema.extend({
  mode: z.enum(['retry-task']).default('retry-task').optional(),
})

type TaskMutationAudit = z.infer<typeof taskMutationAuditSchema>

type TaskActionBody = z.infer<typeof taskActionSchema>

type WorktreeRecoveryActionBody = z.infer<typeof worktreeRecoveryActionSchema>

type SubAgentRerunBody = z.infer<typeof subAgentRerunSchema>

type WorktreeRecoveryMetadata = {
  type?: string
  status?: string
  cwd?: string
  worktreePath?: string
  preservedWorktreePath?: string
  taskId?: string
}

type SubAgentReferenceMetadata = {
  status?: string
  subSessionId?: string
  transcriptPath?: string
  summary?: string
  resultEventRange?: unknown
}

type TaskMutationHttpError = {
  statusCode: number
  payload: { type: 'error'; code: string; message: string; task?: NexusTask }
}

const TERMINAL_SESSION_PHASES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

export const sessionTaskMutationRouter: FeatureRouter = {
  name: 'sessionTaskMutationRouter',
  register(app, context) {
    app.post('/v1/sessions/:sessionId/tasks', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const body = createTaskSchema.parse(request.body)
      const session = await getMutableSession(context.options.storage, params.sessionId)
      if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
      if (isTerminalSessionPhase(session.phase)) return reply.code(409).send(createSessionNotMutablePayload(session))
      const existing = body.requestId ? await findTaskByMutationRequestId(context.options.storage, params.sessionId, body.requestId) : undefined
      if (existing) return { type: 'task_created', task: existing, idempotent: true }
      const task: NexusTask = {
        taskId: createId('task'),
        sessionId: params.sessionId,
        title: body.title,
        description: body.description,
        status: 'pending',
        source: 'user',
        metadata: attachMutationRequestId(body.metadata, body.requestId),
        dependsOn: [],
        blocks: [],
        retryCount: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      await context.options.storage.saveTask(task)
      await context.options.storage.appendEvent(params.sessionId, {
        type: 'task_created',
        ...eventBase(params.sessionId),
        taskId: task.taskId,
        title: task.title,
      })
      await appendTaskMutationAudit(context.options.storage, params.sessionId, 'task_created', undefined, task, body)
      return { type: 'task_created', task }
    })

    app.patch('/v1/sessions/:sessionId/tasks/:taskId', async (request, reply) => {
      const params = z.object({ sessionId: z.string(), taskId: z.string() }).parse(request.params)
      const body = updateTaskSchema.parse(request.body)
      const task = await context.options.storage.getTask(params.taskId)
      if (!task || task.sessionId !== params.sessionId) {
        return reply.code(404).send({
          type: 'error',
          code: 'TASK_NOT_FOUND',
          message: `Task not found: ${params.taskId}`,
        })
      }
      const session = await getMutableSession(context.options.storage, params.sessionId)
      if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
      if (isTerminalSessionPhase(session.phase)) return reply.code(409).send(createSessionNotMutablePayload(session))
      const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
      if (conflict) return reply.code(409).send(conflict)
      const updated: NexusTask = {
        ...task,
        ...pickTaskPatch(body),
        metadata: mergeTaskMetadata(task.metadata, body.metadata, body.requestId),
        updatedAt: nowIso(),
      }
      await context.options.storage.saveTask(updated)
      await appendTaskMutationAudit(context.options.storage, params.sessionId, 'task_updated', task, updated, body)
      return {
        type: 'task_updated',
        task: updated,
      }
    })

    app.post('/v1/sessions/:sessionId/tasks/:taskId/claim', async (request, reply) => {
      return mutateTaskAction(context.options.storage, request.params, request.body, reply, 'task_claimed', task => ({
        ...task,
        status: 'in_progress',
      }))
    })

    app.post('/v1/sessions/:sessionId/tasks/:taskId/complete', async (request, reply) => {
      return mutateTaskAction(context.options.storage, request.params, request.body, reply, 'task_completed', (task, body) => ({
        ...task,
        status: 'completed',
        result: body.result,
      }))
    })

    app.post('/v1/sessions/:sessionId/tasks/:taskId/fail', async (request, reply) => {
      return mutateTaskAction(context.options.storage, request.params, request.body, reply, 'task_failed', async (task, body) => {
        const failedTask: NexusTask = {
          ...task,
          status: 'failed',
          result: body.result,
        }
        const blockedTasksFailed = await propagateFailedDependency(context.options.storage, task.sessionId, failedTask)
        return {
          ...failedTask,
          metadata: {
            ...(failedTask.metadata ?? {}),
            ...(blockedTasksFailed.length > 0 ? { blockedTasksFailed } : {}),
          },
        }
      })
    })

    app.post('/v1/sessions/:sessionId/tasks/:taskId/cancel', async (request, reply) => {
      return mutateTaskAction(context.options.storage, request.params, request.body, reply, 'task_cancelled', async (task, body) => {
        const childSessionsCancelled = await cancelChildSessionsForTask(context.options.storage, task.sessionId, task.taskId, body.reason ?? 'Task cancelled')
        const blockedTasksFailed = await failBlockedTasksForDependency(context.options.storage, task.sessionId, task.taskId, body.reason ?? 'Task cancelled')
        return {
          ...task,
          status: 'cancelled',
          metadata: {
            ...(task.metadata ?? {}),
            ...(childSessionsCancelled.length > 0 ? { childSessionsCancelled } : {}),
            ...(blockedTasksFailed.length > 0 ? { blockedTasksFailed } : {}),
          },
        }
      })
    })

    app.post('/v1/sessions/:sessionId/tasks/:taskId/retry', async (request, reply) => {
      return mutateTaskAction(context.options.storage, request.params, request.body, reply, 'task_retried', async task => {
        const blockedTasksRestored = await restoreTasksFailedByDependency(context.options.storage, task.sessionId, task.taskId)
        return {
          ...task,
          status: 'pending',
          retryCount: task.retryCount + 1,
          result: undefined,
          review: task.review?.status === 'pending' ? task.review : undefined,
          metadata: {
            ...(task.metadata ?? {}),
            ...(blockedTasksRestored.length > 0 ? { blockedTasksRestored } : {}),
          },
        }
      })
    })

    app.post('/v1/sessions/:sessionId/tasks/:taskId/rerun-subagent', async (request, reply) => {
      const params = z.object({ sessionId: z.string(), taskId: z.string() }).parse(request.params)
      const body = subAgentRerunSchema.parse(request.body ?? {})
      const task = await context.options.storage.getTask(params.taskId)
      if (!task || task.sessionId !== params.sessionId) {
        return reply.code(404).send({
          type: 'error',
          code: 'TASK_NOT_FOUND',
          message: `Task not found: ${params.taskId}`,
        })
      }
      const session = await context.options.storage.getSession(params.sessionId, {
        includeEvents: false,
      })
      if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
      const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
      if (conflict) return reply.code(409).send(conflict)
      const updated = await applySubAgentRerunAction(context.options.storage, session, task, body)
      await appendTaskMutationAudit(context.options.storage, params.sessionId, 'subagent_rerun_requested', task, updated, body)
      return {
        type: 'subagent_rerun_requested',
        task: updated,
      }
    })

    app.post('/v1/sessions/:sessionId/tasks/:taskId/worktree-recovery', async (request, reply) => {
      const params = z.object({ sessionId: z.string(), taskId: z.string() }).parse(request.params)
      const body = worktreeRecoveryActionSchema.parse(request.body ?? {})
      const task = await context.options.storage.getTask(params.taskId)
      if (!task || task.sessionId !== params.sessionId) {
        return reply.code(404).send({
          type: 'error',
          code: 'TASK_NOT_FOUND',
          message: `Task not found: ${params.taskId}`,
        })
      }
      const session = await getMutableSession(context.options.storage, params.sessionId)
      if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
      const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
      if (conflict) return reply.code(409).send(conflict)
      const updated = await applyWorktreeRecoveryAction(context.options.storage, session, task, body)
      await appendTaskMutationAudit(context.options.storage, params.sessionId, 'worktree_recovery_action', task, updated, body)
      return {
        type: 'worktree_recovery_action',
        action: body.action,
        task: updated,
      }
    })

    app.post('/v1/sessions/:sessionId/tasks/:taskId/approve', async (request, reply) => {
      return mutateTaskAction(context.options.storage, request.params, request.body, reply, 'task_approved', (task, body) => {
        assertPendingTaskReview(task)
        return {
          ...task,
          review: {
            ...task.review,
            status: 'approved',
            reason: body.reviewReason ?? body.reason,
          },
        }
      })
    })

    app.post('/v1/sessions/:sessionId/tasks/:taskId/reject', async (request, reply) => {
      return mutateTaskAction(context.options.storage, request.params, request.body, reply, 'task_rejected', (task, body) => {
        assertPendingTaskReview(task)
        return {
          ...task,
          review: {
            ...task.review,
            status: 'rejected',
            reason: body.reviewReason ?? body.reason,
          },
        }
      })
    })
  },
}

async function mutateTaskAction(
  storage: NexusStorage,
  rawParams: unknown,
  rawBody: unknown,
  reply: {
    code: (statusCode: number) => { send: (payload: unknown) => unknown }
  },
  eventType: string,
  apply: (task: NexusTask, body: TaskActionBody) => NexusTask | Promise<NexusTask>,
): Promise<unknown> {
  const params = z.object({ sessionId: z.string(), taskId: z.string() }).parse(rawParams)
  const body = taskActionSchema.parse(rawBody ?? {})
  const task = await storage.getTask(params.taskId)
  if (!task || task.sessionId !== params.sessionId) {
    return reply.code(404).send({
      type: 'error',
      code: 'TASK_NOT_FOUND',
      message: `Task not found: ${params.taskId}`,
    })
  }
  const session = await getMutableSession(storage, params.sessionId)
  if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
  if (isTerminalSessionPhase(session.phase)) return reply.code(409).send(createSessionNotMutablePayload(session))
  const conflict = checkTaskRevision(task, body.expectedUpdatedAt)
  if (conflict) return reply.code(409).send(conflict)
  let applied: NexusTask
  try {
    applied = await apply(task, body)
  } catch (error) {
    if (isTaskMutationHttpError(error)) return reply.code(error.statusCode).send(error.payload)
    throw error
  }
  const updated = {
    ...applied,
    ownerAgentId: body.ownerAgentId ?? applied.ownerAgentId,
    metadata: mergeTaskMetadata(task.metadata, applied.metadata, body.requestId),
    updatedAt: nowIso(),
  }
  await storage.saveTask(updated)
  await appendTaskMutationAudit(storage, params.sessionId, eventType, task, updated, body)
  return { type: eventType, task: updated }
}

async function applySubAgentRerunAction(storage: NexusStorage, session: SessionSnapshot, task: NexusTask, body: SubAgentRerunBody): Promise<NexusTask> {
  const subAgent = getFailedSubAgentMetadata(task)
  if (!subAgent) {
    throw createTaskMutationHttpError(409, 'SUBAGENT_RERUN_NOT_AVAILABLE', `Task ${task.taskId} does not reference a failed sub-agent.`, task)
  }

  const previousSubAgents = Array.isArray(task.metadata?.previousSubAgents) ? [...task.metadata.previousSubAgents] : []
  const blockedTasksRestored = await restoreTasksFailedByDependency(storage, task.sessionId, task.taskId)
  const rerunRequest = {
    requestedAt: nowIso(),
    requestedBy: body.actor ?? 'external',
    source: body.source ?? 'sdk',
    reason: body.reason,
    previousSubSessionId: subAgent.subSessionId,
    previousTranscriptPath: subAgent.transcriptPath,
    nextRetryCount: task.retryCount + 1,
  }
  const updated: NexusTask = {
    ...task,
    status: 'pending',
    ownerAgentId: undefined,
    retryCount: task.retryCount + 1,
    result: undefined,
    review: task.review?.status === 'pending' ? task.review : undefined,
    metadata: {
      ...(task.metadata ?? {}),
      previousSubAgents: [...previousSubAgents, subAgent],
      subAgentRerun: rerunRequest,
      ...(blockedTasksRestored.length > 0 ? { blockedTasksRestored } : {}),
    },
    updatedAt: nowIso(),
  }
  await storage.saveTask(updated)

  if (session.phase === 'failed' || session.phase === 'cancelled') {
    await storage.saveSession({
      ...session,
      phase: 'executing',
      terminalReason: undefined,
      error: undefined,
      failureReason: undefined,
      lastUserInput: 'sub-agent rerun requested',
      updatedAt: nowIso(),
    })
  }
  return updated
}

function getFailedSubAgentMetadata(task: NexusTask): SubAgentReferenceMetadata | undefined {
  const subAgent = task.metadata?.subAgent
  if (typeof subAgent !== 'object' || subAgent === null) return undefined
  const typed = subAgent as SubAgentReferenceMetadata
  if (typed.status !== 'failed' && typed.status !== 'cancelled') return undefined
  if (!typed.subSessionId || !typed.transcriptPath) return undefined
  return typed
}

async function applyWorktreeRecoveryAction(storage: NexusStorage, session: SessionSnapshot, task: NexusTask, body: WorktreeRecoveryActionBody): Promise<NexusTask> {
  const recovery = getWorktreeRecoveryMetadata(task)
  if (!recovery) {
    throw createTaskMutationHttpError(409, 'WORKTREE_RECOVERY_NOT_AVAILABLE', `Task ${task.taskId} does not have pending worktree recovery metadata.`, task)
  }

  const nextRecovery = {
    ...recovery,
    status: body.action === 'continue' ? 'retry_requested' : body.action === 'abandon' ? 'abandoned' : 'kept',
    selectedAction: body.action,
    selectedAt: nowIso(),
    selectedBy: body.actor ?? 'external',
    reason: body.reason,
  }

  if (body.action === 'abandon' || body.action === 'continue') {
    const { cwd, worktreePath } = assertRecoverableWorktreePath(session, task, recovery)
    await removeWorktree(cwd, worktreePath, task.taskId)
  }

  const updated: NexusTask = {
    ...task,
    status: body.action === 'continue' ? 'pending' : task.status,
    ownerAgentId: body.action === 'continue' ? undefined : task.ownerAgentId,
    retryCount: body.action === 'continue' ? task.retryCount + 1 : task.retryCount,
    result: body.action === 'continue' ? undefined : task.result,
    review: body.action === 'continue' ? (task.review?.status === 'pending' ? task.review : undefined) : task.review,
    metadata: {
      ...(task.metadata ?? {}),
      worktreeRecovery: nextRecovery,
    },
    updatedAt: nowIso(),
  }
  await storage.saveTask(updated)

  const nextSession: SessionSnapshot = {
    ...session,
    phase: body.action === 'continue' && session.phase === 'waiting_user' ? 'executing' : session.phase,
    pendingInput: body.action === 'continue' ? undefined : session.pendingInput,
    lastUserInput: `worktree recovery ${body.action}`,
    updatedAt: nowIso(),
  }
  await storage.saveSession(nextSession)
  return updated
}

function getWorktreeRecoveryMetadata(task: NexusTask): WorktreeRecoveryMetadata | undefined {
  const recovery = task.metadata?.worktreeRecovery
  if (typeof recovery !== 'object' || recovery === null) return undefined
  const typed = recovery as WorktreeRecoveryMetadata
  if (typed.type !== 'worktree_merge_conflict') return undefined
  if (typed.status && !['awaiting_manual_recovery', 'kept'].includes(typed.status)) return undefined
  return typed
}

function assertRecoverableWorktreePath(session: SessionSnapshot, task: NexusTask, recovery: WorktreeRecoveryMetadata): { cwd: string; worktreePath: string } {
  const cwd = recovery.cwd
  const worktreePath = recovery.preservedWorktreePath ?? recovery.worktreePath
  if (!cwd || !worktreePath) {
    throw createTaskMutationHttpError(409, 'WORKTREE_RECOVERY_INVALID', `Task ${task.taskId} worktree recovery metadata is missing cwd or worktreePath.`, task)
  }
  const resolvedCwd = resolve(cwd)
  const resolvedWorktreePath = resolve(worktreePath)
  const expectedPrefix = resolve(resolvedCwd, '.babel-o', 'worktrees')
  if (resolvedCwd !== resolve(session.cwd) || !resolvedWorktreePath.startsWith(`${expectedPrefix}/`)) {
    throw createTaskMutationHttpError(409, 'WORKTREE_RECOVERY_INVALID', `Task ${task.taskId} worktree recovery path is outside the session worktree directory.`, task)
  }
  return { cwd: resolvedCwd, worktreePath: resolvedWorktreePath }
}

function pickTaskPatch(body: z.infer<typeof updateTaskSchema>): Partial<NexusTask> {
  const patch: Partial<NexusTask> = {}
  if (body.title !== undefined) patch.title = body.title
  if (body.description !== undefined) patch.description = body.description
  if (body.status !== undefined) patch.status = body.status
  if (body.result !== undefined) patch.result = body.result
  return patch
}

function checkTaskRevision(task: NexusTask, expectedUpdatedAt?: string): { type: 'error'; code: string; message: string; task: NexusTask } | undefined {
  if (expectedUpdatedAt && task.updatedAt !== expectedUpdatedAt) {
    return {
      type: 'error',
      code: 'TASK_REVISION_CONFLICT',
      message: `Task ${task.taskId} was updated after expected revision ${expectedUpdatedAt}.`,
      task,
    }
  }
  return undefined
}

async function getMutableSession(storage: NexusStorage, sessionId: string): Promise<SessionSnapshot | null> {
  return storage.getSession(sessionId, { includeEvents: false })
}

function isTerminalSessionPhase(phase: SessionSnapshot['phase']): boolean {
  return TERMINAL_SESSION_PHASES.has(phase)
}

function createSessionNotFoundPayload(sessionId: string): {
  type: 'error'
  code: string
  message: string
} {
  return {
    type: 'error',
    code: 'SESSION_NOT_FOUND',
    message: `Session not found: ${sessionId}`,
  }
}

function createSessionNotMutablePayload(session: SessionSnapshot): {
  type: 'error'
  code: string
  message: string
  session: SessionSnapshot
} {
  return {
    type: 'error',
    code: 'SESSION_NOT_MUTABLE',
    message: `Session ${session.sessionId} is ${session.phase} and cannot accept task mutations.`,
    session,
  }
}

function assertPendingTaskReview(task: NexusTask): void {
  if (task.review?.status === 'pending') return
  throw createTaskMutationHttpError(409, 'TASK_REVIEW_NOT_PENDING', `Task ${task.taskId} does not have a pending review.`, task)
}

function createTaskMutationHttpError(statusCode: number, code: string, message: string, task?: NexusTask): TaskMutationHttpError {
  return {
    statusCode,
    payload: {
      type: 'error',
      code,
      message,
      task,
    },
  }
}

function isTaskMutationHttpError(error: unknown): error is TaskMutationHttpError {
  return typeof error === 'object' && error !== null && 'statusCode' in error && 'payload' in error
}

function attachMutationRequestId(metadata: Record<string, unknown> | undefined, requestId: string | undefined): Record<string, unknown> | undefined {
  if (!requestId) return metadata
  return {
    ...(metadata ?? {}),
    mutationRequestId: requestId,
  }
}

function mergeTaskMetadata(current: Record<string, unknown> | undefined, patch: Record<string, unknown> | undefined, requestId: string | undefined): Record<string, unknown> | undefined {
  if (!current && !patch && !requestId) return undefined
  return {
    ...(current ?? {}),
    ...(patch ?? {}),
    ...(requestId ? { mutationRequestId: requestId } : {}),
  }
}

async function findTaskByMutationRequestId(storage: NexusStorage, sessionId: string, requestId: string): Promise<NexusTask | undefined> {
  const tasks = await storage.listTasks(sessionId)
  return tasks.find(task => task.metadata?.mutationRequestId === requestId)
}

async function cancelChildSessionsForTask(storage: NexusStorage, sessionId: string, taskId: string, reason: string): Promise<string[]> {
  const cancelled: string[] = []
  for (const child of await storage.listChildSessions(sessionId, {
    limit: 200,
  })) {
    if (TERMINAL_SESSION_PHASES.has(child.phase)) continue
    if (!isChildSessionForTask(child, taskId)) continue
    child.phase = 'cancelled'
    child.terminalReason = {
      category: 'cancelled',
      code: 'TASK_CANCELLED',
      message: reason,
    }
    child.updatedAt = nowIso()
    child.metadata = {
      ...(child.metadata ?? {}),
      status: 'cancelled',
      cancelledByTaskId: taskId,
      cancelReason: reason,
    }
    await storage.saveSession(child)
    cancelled.push(child.sessionId)
  }
  return cancelled
}

function isChildSessionForTask(child: { currentTaskId?: string; metadata?: Record<string, unknown> }, taskId: string): boolean {
  return child.currentTaskId === taskId || child.metadata?.parentTaskId === taskId || child.metadata?.taskId === taskId
}

async function failBlockedTasksForDependency(storage: NexusStorage, sessionId: string, taskId: string, reason: string): Promise<string[]> {
  const failed: string[] = []
  for (const task of await storage.listTasks(sessionId)) {
    if (task.taskId === taskId) continue
    if (!task.dependsOn.includes(taskId)) continue
    if (!isDependencyFailureTarget(task)) continue
    const updated: NexusTask = {
      ...task,
      status: 'failed',
      result: `Dependency task ${taskId} was cancelled.`,
      metadata: {
        ...(task.metadata ?? {}),
        failedDependencyTaskId: taskId,
        failedDependencyReason: reason,
      },
      updatedAt: nowIso(),
    }
    await storage.saveTask(updated)
    failed.push(task.taskId)
  }
  return failed
}

async function propagateFailedDependency(storage: NexusStorage, sessionId: string, failedTask: NexusTask): Promise<string[]> {
  const failed: string[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const task of await storage.listTasks(sessionId)) {
      if (task.taskId === failedTask.taskId) continue
      if (!isDependencyFailureTarget(task)) continue
      const failedDependencies = await getFailedDependencies(storage, task, failedTask)
      if (failedDependencies.length === 0) continue
      const updated: NexusTask = {
        ...task,
        status: 'failed',
        result: failedDependencies.map(dep => dep.result || `Dependency ${dep.taskId} failed`).join('\n') || 'Dependency failed',
        metadata: {
          ...(task.metadata ?? {}),
          failedDependencies: failedDependencies.map(dep => ({
            taskId: dep.taskId,
            title: dep.title,
            result: dep.result,
            metadata: dep.metadata,
          })),
        },
        updatedAt: nowIso(),
      }
      await storage.saveTask(updated)
      failed.push(task.taskId)
      changed = true
    }
  }
  return [...new Set(failed)]
}

async function getFailedDependencies(storage: NexusStorage, task: NexusTask, currentFailedTask: NexusTask): Promise<NexusTask[]> {
  const failed: NexusTask[] = []
  for (const dependencyId of task.dependsOn) {
    if (dependencyId === currentFailedTask.taskId) {
      failed.push(currentFailedTask)
      continue
    }
    const dependency = await storage.getTask(dependencyId)
    if (dependency?.status === 'failed') failed.push(dependency)
  }
  return failed
}

async function restoreTasksFailedByDependency(storage: NexusStorage, sessionId: string, dependencyTaskId: string): Promise<string[]> {
  const restored: string[] = []
  for (const task of await storage.listTasks(sessionId)) {
    if (task.taskId === dependencyTaskId) continue
    if (task.status !== 'failed') continue
    if (!task.dependsOn.includes(dependencyTaskId)) continue
    if (!hasFailedDependencyMetadata(task, dependencyTaskId)) continue
    const metadata = { ...(task.metadata ?? {}) }
    delete metadata.failedDependencyTaskId
    delete metadata.failedDependencyReason
    delete metadata.failedDependencies
    const updated: NexusTask = {
      ...task,
      status: 'blocked',
      result: undefined,
      metadata,
      updatedAt: nowIso(),
    }
    await storage.saveTask(updated)
    restored.push(task.taskId)
  }
  return restored
}

function isDependencyFailureTarget(task: NexusTask): boolean {
  return task.status === 'blocked' || task.status === 'pending' || task.status === 'in_progress'
}

function hasFailedDependencyMetadata(task: NexusTask, dependencyTaskId: string): boolean {
  if (task.metadata?.failedDependencyTaskId === dependencyTaskId) return true
  const failedDependencies = task.metadata?.failedDependencies
  return Array.isArray(failedDependencies) && failedDependencies.some(dep => typeof dep === 'object' && dep !== null && (dep as { taskId?: unknown }).taskId === dependencyTaskId)
}

async function appendTaskMutationAudit(storage: NexusStorage, sessionId: string, eventType: string, previous: NexusTask | undefined, next: NexusTask, audit: TaskMutationAudit): Promise<void> {
  await storage.appendEvent(sessionId, {
    type: 'task_session_event',
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId,
    eventId: createId('task_event'),
    eventType,
    phase: next.status,
    timestamp: nowIso(),
    payload: {
      actor: audit.actor ?? 'external',
      source: audit.source ?? 'sdk',
      reason: audit.reason,
      requestId: audit.requestId,
      taskId: next.taskId,
      parentTaskId: typeof next.metadata?.parentTaskId === 'string' ? next.metadata.parentTaskId : undefined,
      previous: previous ? taskAuditSnapshot(previous) : undefined,
      next: taskAuditSnapshot(next),
    },
  })
}

function taskAuditSnapshot(task: NexusTask): {
  taskId: string
  title: string
  description?: string
  status: TaskStatus
  ownerAgentId?: string
  retryCount: number
  result?: string
  metadata?: Record<string, unknown>
  review?: NexusTask['review']
  updatedAt: string
} {
  return {
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    status: task.status,
    ownerAgentId: task.ownerAgentId,
    retryCount: task.retryCount,
    result: task.result,
    metadata: task.metadata,
    review: task.review,
    updatedAt: task.updatedAt,
  }
}
