import type { NexusTask } from '../shared/task.js'
import { recordTaskSessionEvent } from './taskSession.js'
import {
  parsePorcelainChangedPaths,
  runGitCommand,
  withGitOperationLock,
} from './worktree.js'

export type GitStatusSnapshot = {
  cwd: string
  head?: string
  changedPaths: string[]
}

export type InPlaceOptimizerApprovalReason = 'task_not_isolated' | 'worktree_unavailable'

export type InPlaceOptimizerApprovalRequest = {
  sessionId: string
  taskId: string
  title: string
  cwd: string
  reason: InPlaceOptimizerApprovalReason
  gitStatus: GitStatusSnapshot
}

export async function gitStash(cwd: string): Promise<boolean> {
  return withGitOperationLock(cwd, async () => {
    const { code, stdout } = await runGitCommand(cwd, ['stash', 'push', '--include-untracked', '-m', `babel-optimize-backup-${Date.now()}`])
    if (code === 0 && !stdout.includes('No local changes to save')) {
      return true
    }
    return false
  })
}

export async function gitStashPop(cwd: string): Promise<void> {
  await withGitOperationLock(cwd, async () => {
    await runGitCommand(cwd, ['stash', 'pop'])
  })
}

export function recordGitStatusSnapshot(options: {
  sessionId: string
  eventType: string
  task: NexusTask
  cwd: string
  mode: 'isolated' | 'in_place'
  note?: string
}): Promise<void> {
  return gitStatusSnapshot(options.cwd)
    .then(snapshot => {
      recordTaskSessionEvent(options.sessionId, options.eventType, {
        taskId: options.task.taskId,
        title: options.task.title,
        mode: options.mode,
        snapshot,
        note: options.note,
      })
    })
    .catch(err => {
      recordTaskSessionEvent(options.sessionId, `${options.eventType}_failed`, {
        taskId: options.task.taskId,
        title: options.task.title,
        mode: options.mode,
        error: err instanceof Error ? err.message : String(err),
      })
    })
}

export async function gitRollbackTracked(cwd: string): Promise<void> {
  await withGitOperationLock(cwd, async () => {
    await runGitCommand(cwd, ['restore', '--staged', '--worktree', '.'])
  })
}

export async function requireInPlaceOptimizerApproval(options: {
  sessionId: string
  task: NexusTask
  cwd: string
  reason: InPlaceOptimizerApprovalReason
  allowInPlaceOptimizer: boolean
  confirmInPlaceOptimizer?: (request: InPlaceOptimizerApprovalRequest) => Promise<boolean> | boolean
}): Promise<void> {
  const gitStatus = await gitStatusSnapshot(options.cwd)
  const request: InPlaceOptimizerApprovalRequest = {
    sessionId: options.sessionId,
    taskId: options.task.taskId,
    title: options.task.title,
    cwd: options.cwd,
    reason: options.reason,
    gitStatus,
  }
  if (options.allowInPlaceOptimizer) {
    recordTaskSessionEvent(options.sessionId, 'optimizer_in_place_approved', request)
    return
  }
  if (options.confirmInPlaceOptimizer && await options.confirmInPlaceOptimizer(request)) {
    recordTaskSessionEvent(options.sessionId, 'optimizer_in_place_approved', request)
    return
  }
  recordTaskSessionEvent(options.sessionId, 'optimizer_in_place_blocked', request)
  throw new Error('In-place optimizer execution requires explicit opt-in or approval.')
}

export async function gitCommit(cwd: string, message: string): Promise<void> {
  await withGitOperationLock(cwd, async () => {
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
  })
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

async function gitStatusSnapshot(cwd: string): Promise<GitStatusSnapshot> {
  const [headResult, changedPaths] = await Promise.all([
    runGitCommand(cwd, ['rev-parse', 'HEAD']),
    gitChangedPaths(cwd),
  ])
  return {
    cwd,
    head: headResult.code === 0 ? headResult.stdout.trim() : undefined,
    changedPaths,
  }
}
