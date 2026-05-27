import { spawn } from 'node:child_process'
import type { AgentRoleDefinition } from './agentRoles.js'
import {
  PLANNER_ROLE,
  EXECUTOR_ROLE,
  CRITIC_ROLE,
  OPTIMIZER_ROLE,
} from './agentRoles.js'
import {
  createNexusTask,
  createNexusSubTasks,
  claimNexusTask,
  completeNexusTask,
  updateNexusTask,
  areAllNexusTasksCompleted,
  isNexusTaskQueueSettled,
  listNexusTasks,
} from './taskQueue.js'
import {
  createTaskSession,
  setTaskSessionPhase,
  requestTaskSessionInput,
  submitTaskSessionInput,
  recordTaskSessionEvent,
  failTaskSession,
  cancelTaskSession,
  getTaskSession,
} from './taskSession.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import { logger } from '../shared/logger.js'
import {
  isGitRepository,
  createWorktree,
  commitAndMergeWorktree,
  removeWorktree,
  pruneOrphanedWorktrees,
} from './worktree.js'
import { RuntimeAgentStepError } from './runtimeAgentStep.js'
import { executeRuntimeHooks } from '../runtime/hooks.js'

type AgentSubTask = {
  title: string
  description?: string
  requiresIsolation?: boolean
  metadata?: Record<string, unknown>
}

export type PlannerTaskPlan = {
  title: string
  description?: string
  dependsOn?: string[]
  metadata?: Record<string, unknown>
}

export type PlannerAgentResult = {
  summary: string
  tasks: PlannerTaskPlan[]
  needsUserInput?: boolean
  userPrompt?: string
}

export type PlannerReviewDecision =
  | { approved: true; tasks?: PlannerTaskPlan[]; summary?: string }
  | { approved: false; reason?: string }

type ExecutorAgentResult = {
  taskId: string
  success: boolean
  result: string
  needsReview?: boolean
  metadata?: Record<string, unknown>
  subTasks?: AgentSubTask[]
}

export type AgentStepRunner = <TInput, TOutput>(options: {
  roleDefinition: AgentRoleDefinition
  input: TInput
}) => Promise<TOutput>

// Git Utilities helper
function runGitCommand(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => { stdout += data.toString() })
    child.stderr.on('data', (data) => { stderr += data.toString() })
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

async function gitIsClean(cwd: string): Promise<boolean> {
  const { code, stdout } = await runGitCommand(cwd, ['status', '--porcelain'])
  return code === 0 && stdout === ''
}

async function gitStash(cwd: string): Promise<boolean> {
  const { code, stdout } = await runGitCommand(cwd, ['stash', 'push', '--include-untracked', '-m', `babel-optimize-backup-${Date.now()}`])
  if (code === 0 && !stdout.includes('No local changes to save')) {
    return true
  }
  return false
}

async function gitStashPop(cwd: string): Promise<void> {
  await runGitCommand(cwd, ['stash', 'pop'])
}

function parsePorcelainChangedPaths(stdout: string): string[] {
  const paths = new Set<string>()
  for (const entry of stdout.split('\0')) {
    if (!entry) continue
    const status = entry.slice(0, 2)
    const rawPath = entry[2] === ' '
      ? entry.slice(3)
      : entry[1] === ' '
        ? entry.slice(2)
        : entry.slice(3)
    if (!rawPath) continue
    if (status.includes('D')) continue
    paths.add(rawPath)
  }
  return [...paths].sort()
}

async function gitChangedPaths(cwd: string): Promise<string[]> {
  const { code, stdout, stderr } = await runGitCommand(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
  ])
  if (code !== 0) {
    throw new Error(`Failed to inspect git changes: ${stderr}`)
  }
  return parsePorcelainChangedPaths(stdout)
}

async function gitRollbackTracked(cwd: string): Promise<void> {
  await runGitCommand(cwd, ['restore', '--staged', '--worktree', '.'])
}

async function gitCommit(cwd: string, message: string): Promise<void> {
  const changedPaths = await gitChangedPaths(cwd)
  if (changedPaths.length === 0) return
  const { code: addCode, stderr: addStderr, stdout: addStdout } = await runGitCommand(cwd, ['add', '--', ...changedPaths])
  if (addCode !== 0) {
    throw new Error(`Git stage failed: ${addStderr || addStdout}`)
  }
  const { code, stderr, stdout } = await runGitCommand(cwd, [
    '-c',
    'user.name=BabeL-O Agent',
    '-c',
    'user.email=agent@babel-o.local',
    'commit',
    '-m',
    message,
  ])
  if (code !== 0) {
    throw new Error(`Git commit failed: ${stderr || stdout}`)
  }
}

export type RunAgentLoopOptions = {
  sessionId: string
  cwd: string
  prompt: string
  stepRunner: AgentStepRunner
  role?: 'executor' | 'optimizer'
  autoApprove?: boolean
  maxRetriesPerTask?: number
  enableSubAgents?: boolean
  maxSubAgentDepth?: number
  maxSubTasksPerTask?: number
  reviewPlan?: (plan: PlannerAgentResult) => Promise<PlannerReviewDecision> | PlannerReviewDecision
  parentSessionId?: string
  tasks?: PlannerTaskPlan[]
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<SessionSnapshot> {
  const {
    sessionId,
    cwd,
    prompt,
    stepRunner,
    role = 'executor',
    autoApprove = false,
    maxRetriesPerTask = 3,
    enableSubAgents = false,
    maxSubAgentDepth = 1,
    maxSubTasksPerTask = 5,
    reviewPlan,
    parentSessionId,
    tasks,
  } = options

  // Create Task Session
  const session = createTaskSession({
    sessionId,
    cwd,
    prompt,
    queueId: sessionId,
    parentSessionId,
  })

  // Prune any leftovers
  try {
    if (await isGitRepository(cwd)) {
      await pruneOrphanedWorktrees(cwd)
    }
  } catch (err) {
    logger.warn('Failed to prune orphaned worktrees', err)
  }

  let preStashed = false
  if (role === 'optimizer') {
    try {
      preStashed = await gitStash(cwd)
      recordTaskSessionEvent(sessionId, 'git_stash_performed', { preStashed })
    } catch (err) {
      logger.warn('Git stash failed or workspace is not a git repository', err)
    }
  }

  try {
    // 1. Planning Phase
    let plannerOutput: PlannerAgentResult
    if (tasks && tasks.length > 0) {
      plannerOutput = {
        summary: 'Execution of pre-planned tasks',
        tasks: tasks,
      }
      recordTaskSessionEvent(sessionId, 'pre_planned_tasks_loaded', { plannerOutput })
    } else {
      setTaskSessionPhase(sessionId, 'planning')
      
      // Call Planner
      plannerOutput = await stepRunner<{ sessionId: string; goal: string; queueId: string; context?: string }, PlannerAgentResult>({
        roleDefinition: PLANNER_ROLE,
        input: {
          sessionId,
          goal: prompt,
          queueId: sessionId,
          context: `Cwd: ${cwd}. Optimization Mode: ${role === 'optimizer' ? 'enabled' : 'disabled'}`,
        },
      })

      recordTaskSessionEvent(sessionId, 'planner_completed', { plannerOutput })

      if (reviewPlan) {
        requestTaskSessionInput(sessionId, {
          kind: 'planner_review',
          prompt: 'Review the proposed optimization plan.',
          metadata: {
            summary: plannerOutput.summary,
            tasks: plannerOutput.tasks,
          },
        })
        const decision = await reviewPlan(plannerOutput)
        if (!decision.approved) {
          const reason = decision.reason || 'Planner plan rejected by user.'
          recordTaskSessionEvent(sessionId, 'planner_review_rejected', { reason })
          cancelTaskSession(sessionId, reason, 'PLANNER_REJECTED')
          return getTaskSession(sessionId)
        }
        plannerOutput = {
          ...plannerOutput,
          summary: decision.summary ?? plannerOutput.summary,
          tasks: decision.tasks ?? plannerOutput.tasks,
        }
        submitTaskSessionInput(sessionId, {
          message: 'Planner plan approved',
          metadata: {
            summary: plannerOutput.summary,
            tasks: plannerOutput.tasks,
          },
          nextPhase: 'planning',
        })
        recordTaskSessionEvent(sessionId, 'planner_review_approved', {
          summary: plannerOutput.summary,
          tasks: plannerOutput.tasks,
        })
      }
    }

    // Create tasks in queue
    for (const t of plannerOutput.tasks) {
      const task = createNexusTask({
        queueId: sessionId,
        title: t.title,
        description: t.description,
        dependsOn: t.dependsOn,
        metadata: t.metadata,
        source: 'planner',
      })
      recordTaskSessionEvent(sessionId, 'task_created', { task })
    }

    setTaskSessionPhase(sessionId, 'executing')

    // 2. Executing Phase
    while (!areAllNexusTasksCompleted(sessionId)) {
      if (isNexusTaskQueueSettled(sessionId)) {
        throw new Error('Task queue settled but not all tasks completed successfully.')
      }

      // Try to claim a task
      let task: NexusTask | undefined
      try {
        task = claimNexusTask({
          queueId: sessionId,
          ownerAgentId: role === 'optimizer' ? 'optimizer' : 'executor',
        })
      } catch (err) {
        // No claimable task at the moment (might be blocked by dependencies or running tasks)
        // In our sequential single-thread implementation, if no claimable task and queue not settled, we have a deadlock
        throw new Error('Task queue deadlock: No claimable task found but queue is not settled.')
      }

      recordTaskSessionEvent(sessionId, 'task_claimed', { task })

      const taskRole = role === 'optimizer' ? OPTIMIZER_ROLE : EXECUTOR_ROLE
      
      const requiresIsolation = task.metadata?.requiresIsolation === true
      let isIsolated = false
      let isolatedWorktreeMerged = false
      let taskCwd = cwd

      try {
        if (requiresIsolation) {
          try {
            if (await isGitRepository(cwd)) {
              taskCwd = await createWorktree(cwd, task.taskId)
              isIsolated = true
              recordTaskSessionEvent(sessionId, 'worktree_created', { taskId: task.taskId, worktreePath: taskCwd })
            } else {
              logger.warn(`Task ${task.taskId} requested isolation but workspace is not a Git repository. Falling back to in-place execution.`)
            }
          } catch (err) {
            logger.warn(`Failed to create worktree for task ${task.taskId}. Falling back to in-place execution.`, err)
          }
        }

        let executorSuccess = false
        let executorResult: ExecutorAgentResult | null = null

        const isSubAgentTask = enableSubAgents &&
          task.metadata?.parentTaskId !== undefined &&
          String(task.metadata.parentTaskId) !== String(task.taskId) &&
          getParentTaskSnapshot(sessionId, String(task.metadata.parentTaskId)) !== undefined

        if (isSubAgentTask) {
          const subSessionId = `${sessionId}-sub-${task.taskId}`
          const subAgentHooks = await executeRuntimeHooks(
            'SubagentStart',
            {
              toolUseId: task.taskId,
              toolName: 'Subagent',
              toolInput: { prompt: task.title, sessionId: subSessionId, parentSessionId: sessionId },
            },
            { sessionId, cwd: taskCwd },
          )
          for (const ev of subAgentHooks.events) {
            recordTaskSessionEvent(sessionId, 'hook_event', { hookEvent: ev })
          }
          recordTaskSessionEvent(sessionId, 'sub_agent_session_started', {
            taskId: task.taskId,
            subSessionId,
            title: task.title,
          })
          try {
            const subSession = await runAgentLoop({
              sessionId: subSessionId,
              cwd: taskCwd,
              prompt: task.title,
              stepRunner,
              role: role,
              autoApprove: true,
              maxRetriesPerTask,
              enableSubAgents,
              maxSubAgentDepth,
              maxSubTasksPerTask,
              parentSessionId: sessionId,
              tasks: [
                {
                  title: task.title,
                  description: task.description,
                  metadata: task.metadata ? { ...task.metadata, parentTaskId: undefined } : undefined,
                },
              ],
            })

            if (subSession.phase === 'completed') {
              executorSuccess = true
              const resultStr = subSession.terminalReason ? String(subSession.terminalReason) : 'Completed successfully via sub-agent session'
              executorResult = {
                taskId: task.taskId,
                success: true,
                result: resultStr,
                needsReview: false,
              }
              recordTaskSessionEvent(sessionId, 'sub_agent_session_completed', {
                taskId: task.taskId,
                subSessionId,
                result: resultStr,
              })
            } else {
              executorSuccess = false
              recordTaskSessionEvent(sessionId, 'sub_agent_session_failed', {
                taskId: task.taskId,
                subSessionId,
                phase: subSession.phase,
                error: subSession.terminalReason || 'Sub-agent session failed to complete',
              })
            }
          } catch (err) {
            executorSuccess = false
            recordTaskSessionEvent(sessionId, 'sub_agent_session_error', {
              taskId: task.taskId,
              subSessionId,
              error: String(err),
            })
          } finally {
            const subAgentStopHooks = await executeRuntimeHooks(
              'SubagentStop',
              {
                toolUseId: task.taskId,
                toolName: 'Subagent',
                toolInput: { prompt: task.title, sessionId: subSessionId, parentSessionId: sessionId },
                success: executorSuccess,
              },
              { sessionId, cwd: taskCwd },
            )
            for (const ev of subAgentStopHooks.events) {
              recordTaskSessionEvent(sessionId, 'hook_event', { hookEvent: ev })
            }
          }
        } else {
          try {
            executorResult = await stepRunner<
              {
                sessionId: string
                queueId: string
                taskId: string
                title: string
                description?: string
                orchestration?: {
                  enableSubAgents: boolean
                  currentDepth: number
                  maxDepth: number
                  remainingDepth: number
                  delegatedSubTaskIds?: string[]
                }
                cwd?: string
              },
              ExecutorAgentResult
            >({
              roleDefinition: taskRole,
              input: {
                sessionId,
                queueId: sessionId,
                taskId: task.taskId,
                title: task.title,
                description: task.description,
                orchestration: buildTaskOrchestrationContext(
                  task,
                  enableSubAgents,
                  maxSubAgentDepth,
                ),
                cwd: taskCwd,
              },
            })
            executorSuccess = executorResult.success
          } catch (err) {
            executorSuccess = false
            recordTaskSessionEvent(sessionId, 'executor_failed_error', {
              taskId: task.taskId,
              error: err instanceof Error ? err.message : String(err),
              diagnostics: err instanceof RuntimeAgentStepError ? err.summary : undefined,
            })
          }
        }

        if (executorSuccess && executorResult) {
          const subTaskDecision = maybeDelegateSubTasks({
            sessionId,
            task,
            executorResult,
            enableSubAgents,
            maxSubAgentDepth,
            maxSubTasksPerTask,
            role,
          })
          if (subTaskDecision.delegated) {
            if (isIsolated) {
              try {
                await commitAndMergeWorktree(cwd, taskCwd, task.taskId, task.title)
                isolatedWorktreeMerged = true
                recordTaskSessionEvent(sessionId, 'worktree_merged', { taskId: task.taskId })
              } catch (err) {
                logger.error(`Failed to merge isolated worktree changes for task ${task.taskId}`, err)
              }
              await removeWorktree(cwd, taskCwd, task.taskId)
              isIsolated = false
            }
            setTaskSessionPhase(sessionId, 'executing')
            continue
          }

          // Step execution succeeded, check if we need critic review
          const needsReview = executorResult.needsReview ?? true // default to true
          let approved = true
          let criticReason = ''

          if (needsReview && !autoApprove) {
            setTaskSessionPhase(sessionId, 'reviewing')
            try {
              const criticOutput = await stepRunner<
                { sessionId: string; queueId: string; taskId: string; title: string; description?: string; result: string; executorMetadata?: Record<string, unknown>; cwd?: string },
                { approved: boolean; reason?: string; retryTaskTitle?: string; retryTaskDescription?: string }
              >({
                roleDefinition: CRITIC_ROLE,
                input: {
                  sessionId,
                  queueId: sessionId,
                  taskId: task.taskId,
                  title: task.title,
                  description: task.description,
                  result: executorResult.result,
                  executorMetadata: executorResult.metadata,
                  cwd: taskCwd,
                },
              })

              approved = criticOutput.approved
              criticReason = criticOutput.reason ?? ''
              recordTaskSessionEvent(sessionId, 'critic_completed', { taskId: task.taskId, title: task.title, approved, reason: criticReason })
            } catch (err) {
              // Critic step failed, default to reject for safety
              approved = false
              criticReason = `Critic evaluation failed: ${String(err)}`
              recordTaskSessionEvent(sessionId, 'critic_failed_error', { taskId: task.taskId, title: task.title, error: String(err) })
            }
          }

          if (approved) {
            if (isIsolated) {
              try {
                await commitAndMergeWorktree(cwd, taskCwd, task.taskId, task.title)
                isolatedWorktreeMerged = true
                recordTaskSessionEvent(sessionId, 'worktree_merged', { taskId: task.taskId })
              } catch (err) {
                logger.error(`Failed to merge worktree for task ${task.taskId}`, err)
                approved = false
                criticReason = `Merge worktree failed: ${String(err)}`
              }
              await removeWorktree(cwd, taskCwd, task.taskId)
              isIsolated = false
            }

            if (approved) {
              // Commit in-place optimizer changes. Isolated worktrees already
              // produced a cherry-picked commit during merge.
              if (role === 'optimizer' && !isolatedWorktreeMerged) {
                try {
                  await gitCommit(cwd, `bbl optimize: completed task ${task.taskId} - ${task.title}`)
                  recordTaskSessionEvent(sessionId, 'git_commit_performed', { taskId: task.taskId })
                } catch (err) {
                  logger.warn('Git commit failed', err)
                }
              }

              // Complete task
              const completedTask = completeNexusTask({
                queueId: sessionId,
                taskId: task.taskId,
                result: executorResult.result,
                metadata: executorResult.metadata,
              })
              recordTaskSessionEvent(sessionId, 'task_completed', { task: completedTask })
              setTaskSessionPhase(sessionId, 'executing')
            }
          }

          if (!approved) {
            // Critic rejected or failed, rollback changes
            if (isIsolated) {
              await removeWorktree(cwd, taskCwd, task.taskId)
              isIsolated = false
            } else if (role === 'optimizer') {
              try {
                await gitRollbackTracked(cwd)
                recordTaskSessionEvent(sessionId, 'git_rollback_performed', { taskId: task.taskId, reason: criticReason })
              } catch (err) {
                logger.error('Git rollback failed', err)
              }
            }

            // Update task and retry
            const nextRetryCount = task.retryCount + 1
            const status = nextRetryCount >= maxRetriesPerTask ? 'failed' : 'pending'

            const updatedTask = updateNexusTask(sessionId, task.taskId, {
              status,
              ownerAgentId: status === 'pending' ? null : task.ownerAgentId,
              retryCount: nextRetryCount,
              review: {
                status: 'rejected',
                reason: criticReason,
                reviewerAgentId: 'critic',
              },
            })
            recordTaskSessionEvent(sessionId, 'task_updated', { task: updatedTask })

            setTaskSessionPhase(sessionId, 'executing')
          }
        } else {
          // Executor failed, rollback changes
          if (isIsolated) {
            await removeWorktree(cwd, taskCwd, task.taskId)
            isIsolated = false
          } else if (role === 'optimizer') {
            try {
              await gitRollbackTracked(cwd)
              recordTaskSessionEvent(sessionId, 'git_rollback_performed', { taskId: task.taskId, reason: 'executor_failed' })
            } catch (err) {
              logger.error('Git rollback failed', err)
            }
          }

          const nextRetryCount = task.retryCount + 1
          const status = nextRetryCount >= maxRetriesPerTask ? 'failed' : 'pending'

          const updatedTask = updateNexusTask(sessionId, task.taskId, {
            status,
            ownerAgentId: status === 'pending' ? null : task.ownerAgentId,
            retryCount: nextRetryCount,
            review: {
              status: 'rejected',
              reason: 'Executor step returned failure or crashed',
              reviewerAgentId: 'system',
            },
          })
          recordTaskSessionEvent(sessionId, 'task_updated', { task: updatedTask })
        }
      } finally {
        if (isIsolated) {
          try {
            await removeWorktree(cwd, taskCwd, task.taskId)
          } catch (err) {
            // Silently ignore if already removed
          }
        }
      }
    }

    // All tasks completed successfully
    setTaskSessionPhase(sessionId, 'completed')
    recordTaskSessionEvent(sessionId, 'session_completed_success')
  } catch (err) {
    failTaskSession(sessionId, err)
  } finally {
    if (role === 'optimizer' && preStashed) {
      try {
        await gitStashPop(cwd)
        recordTaskSessionEvent(sessionId, 'git_stash_pop_performed')
      } catch (err) {
        logger.warn('Git stash pop failed', err)
      }
    }
  }

  return getTaskSession(sessionId)
}

function buildTaskOrchestrationContext(
  task: NexusTask,
  enableSubAgents: boolean,
  maxSubAgentDepth: number,
): {
  enableSubAgents: boolean
  currentDepth: number
  maxDepth: number
  remainingDepth: number
  delegatedSubTaskIds?: string[]
} {
  const currentDepth = getTaskDepth(task)
  return {
    enableSubAgents,
    currentDepth,
    maxDepth: maxSubAgentDepth,
    remainingDepth: Math.max(0, maxSubAgentDepth - currentDepth),
    delegatedSubTaskIds: getDelegatedSubTaskIds(task),
  }
}

function maybeDelegateSubTasks(options: {
  sessionId: string
  task: NexusTask
  executorResult: ExecutorAgentResult
  enableSubAgents: boolean
  maxSubAgentDepth: number
  maxSubTasksPerTask: number
  role: 'executor' | 'optimizer'
}): { delegated: boolean } {
  const rawSubTasks = options.executorResult.subTasks ?? []
  const subTasks = normalizeSubTasks(rawSubTasks, options.maxSubTasksPerTask)
  if (subTasks.length === 0) return { delegated: false }

  const currentDepth = getTaskDepth(options.task)
  if (!options.enableSubAgents || currentDepth >= options.maxSubAgentDepth) {
    recordTaskSessionEvent(options.sessionId, 'subtasks_rejected_depth_limit', {
      taskId: options.task.taskId,
      requested: rawSubTasks.length,
      enableSubAgents: options.enableSubAgents,
      currentDepth,
      maxSubAgentDepth: options.maxSubAgentDepth,
    })
    options.executorResult.metadata = {
      ...(options.executorResult.metadata ?? {}),
      subTasksRejected: true,
      subTasksRejectedReason: options.enableSubAgents
        ? 'maxSubAgentDepth reached'
        : 'subagents disabled',
    }
    return { delegated: false }
  }

  const created = createNexusSubTasks({
    queueId: options.sessionId,
    parentTaskId: options.task.taskId,
    createdBySessionId: options.sessionId,
    source: 'executor',
    subTasks: subTasks.map(subTask => ({
      ...subTask,
      metadata: {
        ...(subTask.metadata ?? {}),
        parentTaskId: options.task.taskId,
        depth: currentDepth + 1,
        delegatedBy: options.role,
      },
    })),
  })

  const parentTask = getParentTaskSnapshot(options.sessionId, options.task.taskId)
  recordTaskSessionEvent(options.sessionId, 'task_blocked', { task: parentTask })
  recordTaskSessionEvent(options.sessionId, 'subtasks_delegated', {
    parentTask,
    parentTaskId: options.task.taskId,
    subTaskIds: created.map(task => task.taskId),
    subTasks: created,
    requested: rawSubTasks.length,
    accepted: created.length,
    currentDepth,
    nextDepth: currentDepth + 1,
  })

  return { delegated: true }
}

function getParentTaskSnapshot(queueId: string, taskId: string): NexusTask | undefined {
  return listNexusTasks(queueId).tasks.find(task => task.taskId === taskId)
}

function normalizeSubTasks(
  subTasks: AgentSubTask[],
  maxSubTasksPerTask: number,
): AgentSubTask[] {
  const seenTitles = new Set<string>()
  const normalized: AgentSubTask[] = []
  for (const subTask of subTasks) {
    const title = subTask.title.trim()
    if (!title || seenTitles.has(title)) continue
    seenTitles.add(title)
    normalized.push({
      ...subTask,
      title,
      description: subTask.description?.trim() || undefined,
    })
    if (normalized.length >= maxSubTasksPerTask) break
  }
  return normalized
}

function getTaskDepth(task: NexusTask): number {
  const rawDepth = task.metadata?.depth
  return typeof rawDepth === 'number' && Number.isInteger(rawDepth) && rawDepth >= 0
    ? rawDepth
    : 0
}

function getDelegatedSubTaskIds(task: NexusTask): string[] | undefined {
  const rawIds = task.metadata?.delegatedSubTaskIds
  if (!Array.isArray(rawIds)) return undefined
  const ids = rawIds.filter(id => typeof id === 'string')
  return ids.length > 0 ? ids : undefined
}
