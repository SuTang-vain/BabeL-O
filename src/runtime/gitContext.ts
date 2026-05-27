import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 5_000

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    // Check if we are inside a git repository first.
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-dir'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    })
    if (!stdout.trim()) return null
  } catch {
    return null
  }

  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    })
    return { stdout, stderr }
  } catch {
    return null
  }
}

function formatLines(label: string, text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const lines = trimmed.split('\n')
  return lines.map(line => `  ${line}`).join('\n')
}

/**
 * Collect Git context for the workspace:
 *   - current branch (or detached HEAD)
 *   - working tree status (`git status --short`)
 *   - recent 5 commits (`git log -5 --oneline`)
 *
 * Returns a formatted multi-line string suitable for injection into
 * the system prompt, or an empty string if not a git repository.
 */
export async function collectGitContext(cwd: string): Promise<string> {
  const parts: string[] = []

  // Current branch
  const branchResult = await runGit(cwd, ['branch', '--show-current'])
  if (branchResult) {
    const branch = branchResult.stdout.trim()
    if (branch) {
      parts.push(`Branch: ${branch}`)
    } else {
      // Detached HEAD — show the abbreviated commit hash
      const headResult = await runGit(cwd, ['rev-parse', '--short', 'HEAD'])
      if (headResult) {
        parts.push(`HEAD (detached at ${headResult.stdout.trim()})`)
      }
    }
  } else {
    return '' // Not a git repository
  }

  // Working tree status
  const statusResult = await runGit(cwd, ['status', '--short'])
  if (statusResult && statusResult.stdout.trim()) {
    const output = statusResult.stdout.trim()
    const count = output.split('\n').length
    parts.push(`Status (${count} file${count !== 1 ? 's' : ''} changed):\n${formatLines('', output)}`)
  } else {
    parts.push('Status: clean')
  }

  // Recent commits
  const logResult = await runGit(cwd, ['log', '-5', '--oneline'])
  if (logResult && logResult.stdout.trim()) {
    parts.push(`Recent commits:\n${formatLines('', logResult.stdout)}`)
  }

  if (parts.length === 0) return ''
  return `## Git Status\n${parts.join('\n')}`
}
