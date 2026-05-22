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
  updateTaskSession,
  recordTaskSessionEvent,
  failTaskSession,
  cancelTaskSession,
  getTaskSession,
} from './taskSession.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'

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

async function gitHardReset(cwd: string): Promise<void> {
  await runGitCommand(cwd, ['reset', '--hard', 'HEAD'])
  await runGitCommand(cwd, ['clean', '-fd'])
}

async function gitCommit(cwd: string, message: string): Promise<void> {
  await runGitCommand(cwd, ['add', '.'])
  await runGitCommand(cwd, ['commit', '-m', message])
}

export type RunAgentLoopOptions = {
  sessionId: string
  cwd: string
  prompt: string
  stepRunner: AgentStepRunner
  role?: 'executor' | 'optimizer'
  autoApprove?: boolean
  maxRetriesPerTask?: number
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<SessionSnapshot> {
  const { sessionId, cwd, prompt, stepRunner, role = 'executor', autoApprove = false, maxRetriesPerTask = 3 } = options

  // Create Task Session
  const session = createTaskSession({
    sessionId,
    cwd,
    prompt,
    queueId: sessionId,
  })

  let preStashed = false
  if (role === 'optimizer') {
    try {
      preStashed = await gitStash(cwd)
      recordTaskSessionEvent(sessionId, 'git_stash_performed', { preStashed })
    } catch (err) {
      console.warn('Git stash failed or not a git repo:', err)
    }
  }

  try {
    // 1. Planning Phase
    setTaskSessionPhase(sessionId, 'planning')
    
    // Call Planner
    const plannerOutput = await stepRunner<{ sessionId: string; goal: string; queueId: string; context?: string }, {
      summary: string
      tasks: Array<{
        title: string
        description?: string
        dependsOn?: string[]
        metadata?: Record<string, unknown>
      }>
      needsUserInput?: boolean
      userPrompt?: string
    }>({
      roleDefinition: PLANNER_ROLE,
      input: {
        sessionId,
        goal: prompt,
        queueId: sessionId,
        context: `Cwd: ${cwd}. Optimization Mode: ${role === 'optimizer' ? 'enabled' : 'disabled'}`,
      },
    })

    recordTaskSessionEvent(sessionId, 'planner_completed', { plannerOutput })

    // Create tasks in queue
    for (const t of plannerOutput.tasks) {
      createNexusTask({
        queueId: sessionId,
        title: t.title,
        description: t.description,
        dependsOn: t.dependsOn,
        metadata: t.metadata,
        source: 'planner',
      })
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

      recordTaskSessionEvent(sessionId, 'task_claimed', { taskId: task.taskId, title: task.title })

      const taskRole = role === 'optimizer' ? OPTIMIZER_ROLE : EXECUTOR_ROLE
      
      let executorSuccess = false
      let executorResult: { taskId: string; success: boolean; result: string; needsReview?: boolean; metadata?: Record<string, unknown> } | null = null

      try {
        executorResult = await stepRunner<
          { sessionId: string; queueId: string; taskId: string; title: string; description?: string },
          { taskId: string; success: boolean; result: string; needsReview?: boolean; metadata?: Record<string, unknown> }
        >({
          roleDefinition: taskRole,
          input: {
            sessionId,
            queueId: sessionId,
            taskId: task.taskId,
            title: task.title,
            description: task.description,
          },
        })
        executorSuccess = executorResult.success
      } catch (err) {
        executorSuccess = false
        recordTaskSessionEvent(sessionId, 'executor_failed_error', { taskId: task.taskId, error: String(err) })
      }

      if (executorSuccess && executorResult) {
        // Step execution succeeded, check if we need critic review
        const needsReview = executorResult.needsReview ?? true // default to true
        let approved = true
        let criticReason = ''

        if (needsReview && !autoApprove) {
          setTaskSessionPhase(sessionId, 'reviewing')
          try {
            const criticOutput = await stepRunner<
              { sessionId: string; queueId: string; taskId: string; title: string; description?: string; result: string; executorMetadata?: Record<string, unknown> },
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
              },
            })

            approved = criticOutput.approved
            criticReason = criticOutput.reason ?? ''
            recordTaskSessionEvent(sessionId, 'critic_completed', { taskId: task.taskId, approved, reason: criticReason })
          } catch (err) {
            // Critic step failed, default to reject for safety
            approved = false
            criticReason = `Critic evaluation failed: ${String(err)}`
            recordTaskSessionEvent(sessionId, 'critic_failed_error', { taskId: task.taskId, error: String(err) })
          }
        }

        if (approved) {
          // Commit changes if optimizer
          if (role === 'optimizer') {
            try {
              await gitCommit(cwd, `bbl optimize: completed task ${task.taskId} - ${task.title}`)
              recordTaskSessionEvent(sessionId, 'git_commit_performed', { taskId: task.taskId })
            } catch (err) {
              console.warn('Git commit failed:', err)
            }
          }

          // Complete task
          completeNexusTask({
            queueId: sessionId,
            taskId: task.taskId,
            result: executorResult.result,
            metadata: executorResult.metadata,
          })
          setTaskSessionPhase(sessionId, 'executing')
        } else {
          // Critic rejected or failed, rollback changes
          if (role === 'optimizer') {
            try {
              await gitHardReset(cwd)
              recordTaskSessionEvent(sessionId, 'git_rollback_performed', { taskId: task.taskId, reason: criticReason })
            } catch (err) {
              console.error('Git rollback failed:', err)
            }
          }

          // Update task and retry
          const nextRetryCount = task.retryCount + 1
          const status = nextRetryCount >= maxRetriesPerTask ? 'failed' : 'pending'
          
          updateNexusTask(sessionId, task.taskId, {
            status,
            ownerAgentId: status === 'pending' ? null : task.ownerAgentId,
            retryCount: nextRetryCount,
            review: {
              status: 'rejected',
              reason: criticReason,
              reviewerAgentId: 'critic',
            },
          })

          setTaskSessionPhase(sessionId, 'executing')
        }
      } else {
        // Executor failed, rollback changes
        if (role === 'optimizer') {
          try {
            await gitHardReset(cwd)
            recordTaskSessionEvent(sessionId, 'git_rollback_performed', { taskId: task.taskId, reason: 'executor_failed' })
          } catch (err) {
            console.error('Git rollback failed:', err)
          }
        }

        const nextRetryCount = task.retryCount + 1
        const status = nextRetryCount >= maxRetriesPerTask ? 'failed' : 'pending'

        updateNexusTask(sessionId, task.taskId, {
          status,
          ownerAgentId: status === 'pending' ? null : task.ownerAgentId,
          retryCount: nextRetryCount,
          review: {
            status: 'rejected',
            reason: 'Executor step returned failure or crashed',
            reviewerAgentId: 'system',
          },
        })
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
        console.warn('Git stash pop failed (could be due to merge conflicts):', err)
      }
    }
  }

  return getTaskSession(sessionId)
}
