import { resolve, relative, dirname } from 'node:path'
import { realpathSync, existsSync } from 'node:fs'

function getRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

export function isWorkspaceAllowed(cwd: string): boolean {
  const allowedEnv = process.env.NEXUS_ALLOWED_WORKSPACES
  if (!allowedEnv) {
    return true
  }
  const targetReal = getRealpath(cwd)
  const allowedPaths = allowedEnv
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => getRealpath(p))

  for (const allowed of allowedPaths) {
    const rel = relative(allowed, targetReal)
    if (!rel.startsWith('..') && rel !== '..') {
      return true
    }
  }
  return false
}

export function resolveInsideWorkspace(cwd: string, requestedPath: string): string {
  const absolute = resolve(cwd, requestedPath)
  const cwdReal = getRealpath(cwd)

  let current = absolute
  while (current && current !== dirname(current)) {
    if (existsSync(current)) {
      const currentReal = realpathSync(current)
      const rel = relative(cwdReal, currentReal)
      if (rel.startsWith('..') || rel === '..') {
        throw new Error(`Path escapes workspace: ${requestedPath}`)
      }
      break
    }
    current = dirname(current)
  }

  const relUnresolved = relative(cwd, absolute)
  if (relUnresolved.startsWith('..') || relUnresolved === '..') {
    throw new Error(`Path escapes workspace: ${requestedPath}`)
  }

  return absolute
}

