import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { logger } from '../shared/logger.js'

const gitOperationLocks = new Map<string, Promise<void>>()
const gitOperationLockStats = new Map<string, { active: number; maxActive: number }>()

export async function withGitOperationLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(cwd)
  const previous = gitOperationLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolveRelease => {
    release = resolveRelease
  })
  const next = previous.then(() => current, () => current)
  gitOperationLocks.set(key, next)
  await previous

  const stats = gitOperationLockStats.get(key) ?? { active: 0, maxActive: 0 }
  stats.active += 1
  stats.maxActive = Math.max(stats.maxActive, stats.active)
  gitOperationLockStats.set(key, stats)

  try {
    return await fn()
  } finally {
    stats.active -= 1
    release()
    if (gitOperationLocks.get(key) === next) {
      gitOperationLocks.delete(key)
    }
  }
}

export function getGitOperationLockStatsForTest(cwd: string): { active: number; maxActive: number } {
  const stats = gitOperationLockStats.get(resolve(cwd))
  return stats ? { ...stats } : { active: 0, maxActive: 0 }
}

export function resetGitOperationLocksForTest(): void {
  gitOperationLocks.clear()
  gitOperationLockStats.clear()
}

export function runGitCommand(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Add local user config overrides to git commit to prevent failures when global configs are missing
    const child = spawn('git', args, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  });
}

export function parsePorcelainChangedPaths(stdout: string): string[] {
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

async function stagePorcelainChanges(worktreePath: string): Promise<string[]> {
  const { code, stdout, stderr } = await runGitCommand(worktreePath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
  ])
  if (code !== 0) {
    throw new Error(`Failed to inspect worktree changes: ${stderr}`)
  }
  const paths = parsePorcelainChangedPaths(stdout)
  if (paths.length === 0) return []
  const { code: addCode, stderr: addStderr, stdout: addStdout } = await runGitCommand(worktreePath, ['add', '--', ...paths])
  if (addCode !== 0) {
    throw new Error(`Failed to stage worktree changes: ${addStderr || addStdout}`)
  }
  return paths
}

/**
 * Checks if the directory is a Git repository.
 */
export async function isGitRepository(cwd: string): Promise<boolean> {
  const { code } = await runGitCommand(cwd, ['rev-parse', '--is-inside-work-tree'])
  return code === 0
}

/**
 * Creates a detached worktree for the given taskId inside the .babel-o/worktrees/ directory.
 * Returns the absolute path of the created worktree.
 */
export async function createWorktree(cwd: string, taskId: string): Promise<string> {
  return withGitOperationLock(cwd, async () => {
    const worktreePath = join(cwd, '.babel-o', 'worktrees', taskId)

    // Create worktree pointing to HEAD in detached state
    const { code, stderr, stdout } = await runGitCommand(cwd, [
      'worktree',
      'add',
      '--detach',
      worktreePath,
      'HEAD',
    ])

    if (code !== 0) {
      throw new Error(`Failed to create git worktree: ${stderr || stdout}`)
    }

    return worktreePath
  })
}

/**
 * Checks if there are any changes in the worktree, commits them,
 * and cherry-picks them back to the main repository.
 * Returns the cherry-picked commit hash, or an empty string if no changes were found.
 */
export async function commitAndMergeWorktree(
  cwd: string,
  worktreePath: string,
  taskId: string,
  taskTitle: string,
): Promise<string> {
  return withGitOperationLock(cwd, async () => {
    // Get parent HEAD commit
    const { code: parentHeadCode, stdout: parentHead, stderr: parentHeadStderr } = await runGitCommand(cwd, [
      'rev-parse',
      'HEAD',
    ])
    if (parentHeadCode !== 0) {
      throw new Error(`Failed to get parent HEAD commit: ${parentHeadStderr}`)
    }

    await stagePorcelainChanges(worktreePath)

    // Check if there are uncommitted changes to commit
    const { code: diffCode } = await runGitCommand(worktreePath, [
      'diff-index',
      '--quiet',
      'HEAD',
      '--',
    ])

    // If there are uncommitted changes, commit them inside the worktree
    if (diffCode !== 0) {
      const commitMsg = `babel-optimize: completed task ${taskId} - ${taskTitle}`
      const { code: commitCode, stderr: commitStderr, stdout: commitStdout } = await runGitCommand(worktreePath, [
        '-c',
        'user.name=BabeL-O Agent',
        '-c',
        'user.email=agent@babel-o.local',
        'commit',
        '-m',
        commitMsg,
      ])
      if (commitCode !== 0) {
        throw new Error(`Failed to commit changes in worktree: ${commitStderr || commitStdout}`)
      }
    }

    // Get worktree HEAD commit
    const { code: worktreeHeadCode, stdout: worktreeHead, stderr: worktreeHeadStderr } = await runGitCommand(worktreePath, [
      'rev-parse',
      'HEAD',
    ])
    if (worktreeHeadCode !== 0) {
      throw new Error(`Failed to get worktree HEAD commit: ${worktreeHeadStderr}`)
    }

    const parentHeadHash = parentHead.trim()
    const worktreeHeadHash = worktreeHead.trim()

    if (parentHeadHash === worktreeHeadHash) {
      return ''
    }

    // Get the list of commits in range parentHead..worktreeHead in chronological order
    const { code: revListCode, stdout: revListStr, stderr: revListStderr } = await runGitCommand(worktreePath, [
      'rev-list',
      '--reverse',
      `${parentHeadHash}..${worktreeHeadHash}`,
    ])
    if (revListCode !== 0) {
      throw new Error(`Failed to get commit range: ${revListStderr}`)
    }

    const commits = revListStr.split('\n').map(c => c.trim()).filter(Boolean)
    let lastCommitHash = ''

    // Cherry-pick all commits in the range sequentially in the main workspace
    for (const commitHash of commits) {
      const { code: cpCode, stderr: cpStderr, stdout: cpStdout } = await runGitCommand(cwd, [
        'cherry-pick',
        commitHash,
      ])

      if (cpCode !== 0) {
        // Get the list of conflicting files before aborting the cherry-pick
        const { stdout: conflictFiles } = await runGitCommand(cwd, [
          'diff',
          '--name-only',
          '--diff-filter=U',
        ])
        const filesList = conflictFiles.split('\n').map(f => f.trim()).filter(Boolean)

        // If cherry-pick fails, abort it to clean up the main repo state and throw error
        await runGitCommand(cwd, ['cherry-pick', '--abort'])

        const filesInfo = filesList.length > 0 ? ` Conflicting files: ${filesList.join(', ')}.` : ''
        throw new Error(`Cherry-pick failed with conflicts.${filesInfo}\nDetails: ${cpStderr || cpStdout}`)
      }
      lastCommitHash = commitHash
    }

    return lastCommitHash
  })
}

/**
 * Removes the worktree and cleans up directories and git metadata.
 */
export async function removeWorktree(
  cwd: string,
  worktreePath: string,
  taskId: string,
): Promise<void> {
  await withGitOperationLock(cwd, async () => {
    // Prune/remove worktree from main repo
    await runGitCommand(cwd, ['worktree', 'remove', '--force', worktreePath])
    await runGitCommand(cwd, ['worktree', 'prune'])

    // Ensure the directory is cleaned up
    if (existsSync(worktreePath)) {
      try {
        await rm(worktreePath, { recursive: true, force: true })
      } catch (err) {
        logger.warn(`Failed to remove worktree directory at ${worktreePath}`, err)
      }
    }
  })
}

/**
 * Prunes any orphaned worktrees left in the .babel-o/worktrees directory.
 */
export async function pruneOrphanedWorktrees(cwd: string): Promise<void> {
  await withGitOperationLock(cwd, async () => {
    const worktreesDir = join(cwd, '.babel-o', 'worktrees')
    if (!existsSync(worktreesDir)) {
      return
    }

    await runGitCommand(cwd, ['worktree', 'prune'])
  })
}
