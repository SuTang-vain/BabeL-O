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
  updateTaskSession,
} from './taskSession.js'
import { performance } from 'node:perf_hooks'
import type { HooksConfig } from '../shared/config.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import { logger } from '../shared/logger.js'
import { estimateTextTokens } from '../runtime/tokenEstimator.js'
import {
  isGitRepository,
  createWorktree,
  commitAndMergeWorktree,
  removeWorktree,
  pruneOrphanedWorktrees,
  isWorktreeMergeConflictError,
  type WorktreeMergeConflictDiagnostic,
} from './worktree.js'
import { RuntimeAgentStepError, buildAgentRoleCapabilityDiagnostics, type RuntimeAgentStepUsageSummary } from './runtimeAgentStep.js'
import { executeRuntimeHooks } from '../runtime/hooks.js'
import { ConfigManager } from '../shared/config.js'
import {
  buildPreviousSubAgentsMetadata,
  buildSubAgentLifecycleMetadata,
  buildSubAgentSessionId,
  buildTaskOrchestrationContext,
  getSubAgentStatus,
  getTaskDepth,
  getTaskSessionEventRange,
  normalizeSubTasks,
  summarizeSubAgentSession,
  toParentSubAgentReference,
  type AgentSubTask,
  type SubAgentApprovalInheritanceOptions,
} from './agentLoopSubAgents.js'
import {
  gitCommit,
  gitRollbackTracked,
  gitStash,
  gitStashPop,
  recordGitStatusSnapshot,
  requireInPlaceOptimizerApproval,
  type GitStatusSnapshot,
  type InPlaceOptimizerApprovalRequest,
} from './agentLoopWorktree.js'

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

export type { SubAgentApprovalInheritanceOptions } from './agentLoopSubAgents.js'

export type AgentStepRunner = <TInput, TOutput>(options: {
  roleDefinition: AgentRoleDefinition
  input: TInput
}) => Promise<TOutput>

async function runAgentRoleStep<TInput, TOutput>(options: {
  sessionId: string
  stepRunner: AgentStepRunner
  roleDefinition: AgentRoleDefinition
  input: TInput
  taskId?: string
}): Promise<TOutput> {
  const startedAt = performance.now()
  try {
    const output = await options.stepRunner<TInput, TOutput>({
      roleDefinition: options.roleDefinition,
      input: options.input,
    })
    recordAgentRoleStepMetrics({
      sessionId: options.sessionId,
      roleDefinition: options.roleDefinition,
      taskId: options.taskId,
      input: options.input,
      output,
      durationMs: performance.now() - startedAt,
      success: true,
    })
    return output
  } catch (error) {
    recordAgentRoleStepMetrics({
      sessionId: options.sessionId,
      roleDefinition: options.roleDefinition,
      taskId: options.taskId,
      input: options.input,
      durationMs: performance.now() - startedAt,
      success: false,
      capabilityDiagnostics: error instanceof RuntimeAgentStepError
        ? error.summary.capabilityDiagnostics
        : undefined,
      errorCode: error instanceof RuntimeAgentStepError
        ? error.summary.errorCode ?? 'RUNTIME_AGENT_STEP_ERROR'
        : 'AGENT_ROLE_STEP_ERROR',
      failureType: error instanceof RuntimeAgentStepError && error.summary.structuredOutput
        ? error.summary.structuredOutput.failureType
        : undefined,
    })
    throw error
  }
}

function recordAgentRoleStepMetrics(options: {
  sessionId: string
  roleDefinition: AgentRoleDefinition
  taskId?: string
  input: unknown
  output?: unknown
  durationMs: number
  success: boolean
  capabilityDiagnostics?: RuntimeAgentStepUsageSummary['capabilityDiagnostics']
  errorCode?: string
  failureType?: string
}): void {
  const capabilityDiagnostics = options.capabilityDiagnostics ?? buildRoleStepCapabilityDiagnostics(options.roleDefinition)
  recordTaskSessionEvent(options.sessionId, 'agent_loop_role_step_metrics', {
    role: options.roleDefinition.role,
    taskId: options.taskId,
    capabilityDiagnostics,
    durationMs: Math.round(options.durationMs * 100) / 100,
    inputTokens: estimateTextTokens(stringifyForMetrics(options.input)),
    outputTokens: options.output === undefined ? 0 : estimateTextTokens(stringifyForMetrics(options.output)),
    success: options.success,
    errorCode: options.errorCode,
    failureType: options.failureType,
  })
}

function buildRoleStepCapabilityDiagnostics(roleDefinition: AgentRoleDefinition) {
  const providerDiagnostics = ConfigManager.getInstance().getProviderDiagnostics(roleDefinition.role)
  return buildAgentRoleCapabilityDiagnostics(roleDefinition.role, providerDiagnostics)
}

function stringifyForMetrics(value: unknown): string {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return String(value)
  }
}

function getCancelledTaskSession(sessionId: string): SessionSnapshot | null {
  try {
    const session = getTaskSession(sessionId)
    return session.phase === 'cancelled' ? session : null
  } catch {
    return null
  }
}

export type { GitStatusSnapshot, InPlaceOptimizerApprovalRequest, InPlaceOptimizerApprovalReason } from './agentLoopWorktree.js'

export type RunAgentLoopOptions = {
  sessionId: string
  cwd: string
  prompt: string
  stepRunner: AgentStepRunner
  role?: 'executor' | 'optimizer'
  autoApprove?: boolean
  allowInPlaceOptimizer?: boolean
  confirmInPlaceOptimizer?: (request: InPlaceOptimizerApprovalRequest) => Promise<boolean> | boolean
  maxRetriesPerTask?: number
  enableSubAgents?: boolean
  maxSubAgentDepth?: number
  maxSubTasksPerTask?: number
  subAgentApprovalInheritance?: SubAgentApprovalInheritanceOptions
  reviewPlan?: (plan: PlannerAgentResult) => Promise<PlannerReviewDecision> | PlannerReviewDecision
  parentSessionId?: string
  assignedAgentId?: string
  currentTaskId?: string
  sessionMetadata?: Record<string, unknown>
  tasks?: PlannerTaskPlan[]
  hooks?: HooksConfig
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<SessionSnapshot> {
  const {
    sessionId,
    cwd,
    prompt,
    stepRunner,
    role = 'executor',
    autoApprove = false,
    allowInPlaceOptimizer = false,
    confirmInPlaceOptimizer,
    maxRetriesPerTask = 3,
    enableSubAgents = false,
    maxSubAgentDepth = 1,
    maxSubTasksPerTask = 5,
    subAgentApprovalInheritance,
    reviewPlan,
    parentSessionId,
    assignedAgentId,
    currentTaskId,
    sessionMetadata,
    tasks,
    hooks,
  } = options

  // Create Task Session
  const session = createTaskSession({
    sessionId,
    cwd,
    prompt,
    queueId: sessionId,
    parentSessionId,
    assignedAgentId,
    currentTaskId,
    metadata: sessionMetadata,
  })

  let isGitWorkspace = false
  try {
    isGitWorkspace = await isGitRepository(cwd)
    if (isGitWorkspace) {
      await pruneOrphanedWorktrees(cwd)
    }
  } catch (err) {
    logger.warn('Failed to inspect git workspace', err)
  }

  let preStashed = false

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
      plannerOutput = await runAgentRoleStep<{ sessionId: string; goal: string; queueId: string; context?: string }, PlannerAgentResult>({
        sessionId,
        stepRunner,
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
      const cancelledSession = getCancelledTaskSession(sessionId)
      if (cancelledSession) return cancelledSession

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
      let inPlaceOptimizerApproved = false
      let taskCwd = cwd
      let taskAllowedPaths: string[] | undefined

      try {
        if (requiresIsolation) {
          if (!isGitWorkspace) {
            logger.warn(`Task ${task.taskId} requested isolation but workspace is not a Git repository. Falling back to in-place execution.`)
          } else {
            try {
              taskCwd = await createWorktree(cwd, task.taskId)
              taskAllowedPaths = [taskCwd]
              isIsolated = true
              recordTaskSessionEvent(sessionId, 'worktree_created', { taskId: task.taskId, worktreePath: taskCwd })
            } catch (err) {
              recordTaskSessionEvent(sessionId, 'worktree_create_failed', {
                taskId: task.taskId,
                title: task.title,
                error: err instanceof Error ? err.message : String(err),
              })
              await requireInPlaceOptimizerApproval({
                sessionId,
                task,
                cwd,
                reason: 'worktree_unavailable',
                allowInPlaceOptimizer,
                confirmInPlaceOptimizer,
              })
              inPlaceOptimizerApproved = true
            }
          }
        }
        if (role === 'optimizer' && isGitWorkspace && !isIsolated && !inPlaceOptimizerApproved) {
          await requireInPlaceOptimizerApproval({
            sessionId,
            task,
            cwd,
            reason: 'task_not_isolated',
            allowInPlaceOptimizer,
            confirmInPlaceOptimizer,
          })
          if (!preStashed) {
            try {
              preStashed = await gitStash(cwd)
              recordTaskSessionEvent(sessionId, 'git_stash_performed', { preStashed })
            } catch (err) {
              logger.warn('Git stash failed', err)
            }
          }
        }
        if (isGitWorkspace || isIsolated) {
          await recordGitStatusSnapshot({
            sessionId,
            eventType: 'git_status_before_task',
            task,
            cwd: taskCwd,
            mode: isIsolated ? 'isolated' : 'in_place',
          })
        }

        let executorSuccess = false
        let executorResult: ExecutorAgentResult | null = null

        const isSubAgentTask = enableSubAgents &&
          task.metadata?.parentTaskId !== undefined &&
          String(task.metadata.parentTaskId) !== String(task.taskId) &&
          getParentTaskSnapshot(sessionId, String(task.metadata.parentTaskId)) !== undefined

        if (isSubAgentTask) {
          const subSessionId = buildSubAgentSessionId(sessionId, task)
          const subAgentMetadata = buildSubAgentLifecycleMetadata({
            parentSessionId: sessionId,
            subSessionId,
            task,
            role,
            approvalInheritance: subAgentApprovalInheritance,
          })
          const subAgentHooks = await executeRuntimeHooks(
            'SubagentStart',
            {
              toolUseId: task.taskId,
              toolName: 'Subagent',
              toolInput: { prompt: task.title, sessionId: subSessionId, parentSessionId: sessionId },
            },
            { sessionId, cwd: taskCwd },
            { config: hooks },
          )
          for (const ev of subAgentHooks.events) {
            recordTaskSessionEvent(sessionId, 'hook_event', { hookEvent: ev })
          }
          recordTaskSessionEvent(sessionId, 'sub_agent_session_started', {
            taskId: task.taskId,
            subSessionId,
            title: task.title,
            ...subAgentMetadata,
          })
          recordTaskSessionEvent(sessionId, 'subagent_started', {
            taskId: task.taskId,
            subSessionId,
            title: task.title,
            ...subAgentMetadata,
          })
          recordTaskSessionEvent(sessionId, 'subagent_permission_inheritance', {
            taskId: task.taskId,
            subSessionId,
            agentId: subAgentMetadata.agentId,
            permissionInheritance: subAgentMetadata.permissionInheritance,
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
              subAgentApprovalInheritance,
              allowInPlaceOptimizer,
              confirmInPlaceOptimizer,
              parentSessionId: sessionId,
              assignedAgentId: subAgentMetadata.agentId,
              currentTaskId: task.taskId,
              sessionMetadata: subAgentMetadata,
              tasks: [
                {
                  title: task.title,
                  description: task.description,
                  metadata: task.metadata ? { ...task.metadata, parentTaskId: undefined } : undefined,
                },
              ],
              hooks,
            })

            const cancelledSubSession = getCancelledTaskSession(subSessionId)
            if (subSession.phase === 'completed' && !cancelledSubSession) {
              executorSuccess = true
              const resultStr = subSession.result ?? summarizeSubAgentSession(subSession)
              const completedMetadata = {
                ...subAgentMetadata,
                status: 'completed' as const,
                resultEventRange: getTaskSessionEventRange(subSession),
                summary: resultStr,
              }
              updateTaskSession(subSessionId, { metadata: completedMetadata })
              executorResult = {
                taskId: task.taskId,
                success: true,
                result: resultStr,
                needsReview: false,
                metadata: {
                  subAgent: toParentSubAgentReference(completedMetadata, subSessionId),
                },
              }
              recordTaskSessionEvent(sessionId, 'sub_agent_session_completed', {
                taskId: task.taskId,
                subSessionId,
                result: resultStr,
                ...completedMetadata,
              })
              recordTaskSessionEvent(sessionId, 'subagent_completed', {
                taskId: task.taskId,
                subSessionId,
                result: resultStr,
                ...completedMetadata,
              })
            } else {
              executorSuccess = false
              const endedSubSession = cancelledSubSession ?? subSession
              const failedMetadata = {
                ...subAgentMetadata,
                status: endedSubSession.phase === 'cancelled' ? 'cancelled' as const : 'failed' as const,
                resultEventRange: getTaskSessionEventRange(endedSubSession),
                summary: summarizeSubAgentSession(endedSubSession),
                error: endedSubSession.terminalReason || 'Sub-agent session failed to complete',
              }
              updateTaskSession(subSessionId, { metadata: failedMetadata })
              executorResult = {
                taskId: task.taskId,
                success: false,
                result: summarizeSubAgentSession(endedSubSession),
                needsReview: false,
                metadata: {
                  subAgent: toParentSubAgentReference(failedMetadata, subSessionId),
                },
              }
              recordTaskSessionEvent(sessionId, 'sub_agent_session_failed', {
                taskId: task.taskId,
                subSessionId,
                phase: endedSubSession.phase,
                ...failedMetadata,
              })
              recordTaskSessionEvent(sessionId, failedMetadata.status === 'cancelled' ? 'subagent_cancelled' : 'subagent_failed', {
                taskId: task.taskId,
                subSessionId,
                phase: endedSubSession.phase,
                ...failedMetadata,
              })
            }
          } catch (err) {
            executorSuccess = false
            const cancelledSubSession = getCancelledTaskSession(subSessionId)
            const failedMetadata = {
              ...subAgentMetadata,
              status: cancelledSubSession ? 'cancelled' as const : 'failed' as const,
              ...(cancelledSubSession ? { resultEventRange: getTaskSessionEventRange(cancelledSubSession) } : {}),
              summary: cancelledSubSession ? summarizeSubAgentSession(cancelledSubSession) : String(err),
              error: cancelledSubSession?.terminalReason ?? String(err),
            }
            try {
              updateTaskSession(subSessionId, { metadata: failedMetadata })
            } catch {
              // The child session may fail before creation.
            }
            executorResult = {
              taskId: task.taskId,
              success: false,
              result: cancelledSubSession ? summarizeSubAgentSession(cancelledSubSession) : String(err),
              needsReview: false,
              metadata: {
                subAgent: toParentSubAgentReference(failedMetadata, subSessionId),
              },
            }
            recordTaskSessionEvent(sessionId, cancelledSubSession ? 'sub_agent_session_failed' : 'sub_agent_session_error', {
              taskId: task.taskId,
              subSessionId,
              phase: cancelledSubSession?.phase,
              ...failedMetadata,
            })
            recordTaskSessionEvent(sessionId, cancelledSubSession ? 'subagent_cancelled' : 'subagent_failed', {
              taskId: task.taskId,
              subSessionId,
              phase: cancelledSubSession?.phase,
              ...failedMetadata,
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
              { config: hooks },
            )
            for (const ev of subAgentStopHooks.events) {
              recordTaskSessionEvent(sessionId, 'hook_event', { hookEvent: ev })
            }
          }
        } else {
          try {
            executorResult = await runAgentRoleStep<
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
                allowedPaths?: string[]
              },
              ExecutorAgentResult
            >({
              sessionId,
              stepRunner,
              roleDefinition: taskRole,
              taskId: task.taskId,
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
                allowedPaths: taskAllowedPaths,
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

        if (isGitWorkspace || isIsolated) {
          await recordGitStatusSnapshot({
            sessionId,
            eventType: 'git_status_after_task',
            task,
            cwd: taskCwd,
            mode: isIsolated ? 'isolated' : 'in_place',
          })
        }

        const cancelledSessionAfterExecutor = getCancelledTaskSession(sessionId)
        if (cancelledSessionAfterExecutor) return cancelledSessionAfterExecutor

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
                await recordGitStatusSnapshot({
                  sessionId,
                  eventType: 'git_status_after_resolution',
                  task,
                  cwd,
                  mode: 'isolated',
                  note: 'worktree_merged',
                })
                await removeWorktree(cwd, taskCwd, task.taskId)
                isIsolated = false
              } catch (err) {
                logger.error(`Failed to merge isolated worktree changes for task ${task.taskId}`, err)
                if (isWorktreeMergeConflictError(err)) {
                  handleWorktreeMergeConflict({
                    sessionId,
                    task,
                    diagnostic: err.diagnostic,
                    executorResult,
                  })
                  isIsolated = false
                  return getTaskSession(sessionId)
                }
              }
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
              const criticOutput = await runAgentRoleStep<
                { sessionId: string; queueId: string; taskId: string; title: string; description?: string; result: string; executorMetadata?: Record<string, unknown>; cwd?: string; allowedPaths?: string[] },
                { approved: boolean; reason?: string; retryTaskTitle?: string; retryTaskDescription?: string }
              >({
                sessionId,
                stepRunner,
                roleDefinition: CRITIC_ROLE,
                taskId: task.taskId,
                input: {
                  sessionId,
                  queueId: sessionId,
                  taskId: task.taskId,
                  title: task.title,
                  description: task.description,
                  result: executorResult.result,
                  executorMetadata: executorResult.metadata,
                  cwd: taskCwd,
                  allowedPaths: taskAllowedPaths,
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
                await recordGitStatusSnapshot({
                  sessionId,
                  eventType: 'git_status_after_resolution',
                  task,
                  cwd,
                  mode: 'isolated',
                  note: 'worktree_merged',
                })
                await removeWorktree(cwd, taskCwd, task.taskId)
                isIsolated = false
              } catch (err) {
                logger.error(`Failed to merge worktree for task ${task.taskId}`, err)
                if (isWorktreeMergeConflictError(err)) {
                  handleWorktreeMergeConflict({
                    sessionId,
                    task,
                    diagnostic: err.diagnostic,
                    executorResult,
                  })
                  isIsolated = false
                  return getTaskSession(sessionId)
                }
                approved = false
                criticReason = `Merge worktree failed: ${String(err)}`
              }
            }

            if (approved) {
              // Commit in-place optimizer changes. Isolated worktrees already
              // produced a cherry-picked commit during merge.
              if (role === 'optimizer' && isGitWorkspace && !isolatedWorktreeMerged) {
                try {
                  await gitCommit(cwd, `bbl optimize: completed task ${task.taskId} - ${task.title}`)
                  recordTaskSessionEvent(sessionId, 'git_commit_performed', { taskId: task.taskId })
                  await recordGitStatusSnapshot({
                    sessionId,
                    eventType: 'git_status_after_resolution',
                    task,
                    cwd,
                    mode: 'in_place',
                    note: 'git_commit_performed',
                  })
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
            } else if (role === 'optimizer' && isGitWorkspace) {
              try {
                await gitRollbackTracked(cwd)
                recordTaskSessionEvent(sessionId, 'git_rollback_performed', { taskId: task.taskId, reason: criticReason })
                await recordGitStatusSnapshot({
                  sessionId,
                  eventType: 'git_status_after_resolution',
                  task,
                  cwd,
                  mode: 'in_place',
                  note: 'git_rollback_performed',
                })
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
              await recordGitStatusSnapshot({
                sessionId,
                eventType: 'git_status_after_resolution',
                task,
                cwd,
                mode: 'in_place',
                note: 'git_rollback_performed',
              })
            } catch (err) {
              logger.error('Git rollback failed', err)
            }
          }

          const nextRetryCount = task.retryCount + 1
          const subAgentStatus = getSubAgentStatus(executorResult?.metadata)
          const status = subAgentStatus === 'cancelled' || nextRetryCount >= maxRetriesPerTask ? 'failed' : 'pending'

          const updatedTask = updateNexusTask(sessionId, task.taskId, {
            status,
            ownerAgentId: status === 'pending' ? null : task.ownerAgentId,
            retryCount: nextRetryCount,
            result: executorResult?.result,
            metadata: {
              ...(task.metadata ?? {}),
              ...buildPreviousSubAgentsMetadata(task, executorResult),
              ...(executorResult?.metadata ?? {}),
            },
            review: {
              status: 'rejected',
              reason: subAgentStatus === 'cancelled'
                ? 'Sub-agent session was cancelled'
                : 'Executor step returned failure or crashed',
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

function handleWorktreeMergeConflict(options: {
  sessionId: string
  task: NexusTask
  diagnostic: WorktreeMergeConflictDiagnostic
  executorResult?: ExecutorAgentResult | null
}): void {
  const recovery = {
    ...options.diagnostic,
    status: 'awaiting_manual_recovery',
    preservedWorktreePath: options.diagnostic.worktreePath,
  }
  const updatedTask = updateNexusTask(options.sessionId, options.task.taskId, {
    status: 'failed',
    ownerAgentId: options.task.ownerAgentId,
    result: `Worktree merge conflict: ${options.diagnostic.conflictingFiles.join(', ') || 'unknown files'}`,
    metadata: {
      ...(options.task.metadata ?? {}),
      ...(options.executorResult?.metadata ?? {}),
      worktreeRecovery: recovery,
    },
    review: {
      status: 'rejected',
      reason: 'Worktree merge conflict requires manual recovery',
      reviewerAgentId: 'system',
    },
  })
  recordTaskSessionEvent(options.sessionId, 'worktree_merge_conflict', {
    taskId: options.task.taskId,
    task: updatedTask,
    recovery,
  })
  requestTaskSessionInput(options.sessionId, {
    kind: 'user_input',
    requestedBy: 'system',
    reason: 'worktree_merge_conflict',
    prompt: `Worktree merge conflict for task ${options.task.taskId}. Choose continue, abandon, or keep after reviewing the preserved worktree.`,
    metadata: {
      taskId: options.task.taskId,
      worktreeRecovery: recovery,
    },
  })
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
