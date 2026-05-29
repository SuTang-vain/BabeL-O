import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { realpathSync, existsSync } from 'node:fs'

export class WorkspacePathError extends Error {
  readonly code = 'WORKSPACE_PATH_ESCAPE'

  constructor(
    readonly requestedPath: string,
    readonly cwd: string,
    readonly resolvedPath: string,
  ) {
    super(`Path escapes workspace: ${requestedPath}`)
    this.name = 'WorkspacePathError'
  }
}

function getRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

function isInsideOrSame(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
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
    if (isInsideOrSame(allowed, targetReal)) {
      return true
    }
  }
  return false
}

export function resolveInsideWorkspace(cwd: string, requestedPath: string, allowedPaths?: string[]): string {
  const absolute = resolve(cwd, requestedPath)
  if (!process.env.NEXUS_ALLOWED_WORKSPACES) return absolute

  const cwdReal = getRealpath(cwd)

  if (isPathInsideBase(cwdReal, absolute)) {
    return absolute
  }

  if (allowedPaths && allowedPaths.length > 0) {
    for (const allowed of allowedPaths) {
      const allowedReal = getRealpath(allowed)
      if (isPathInsideBase(allowedReal, absolute)) {
        return absolute
      }
    }
  }

  throw new WorkspacePathError(requestedPath, cwdReal, absolute)
}

function isPathInsideBase(baseReal: string, absolute: string): boolean {
  let current = absolute
  let checkedExistingAncestor = false
  while (current && current !== dirname(current)) {
    if (existsSync(current)) {
      checkedExistingAncestor = true
      const currentReal = realpathSync(current)
      return isInsideOrSame(baseReal, currentReal)
    }
    current = dirname(current)
  }
  if (!checkedExistingAncestor) {
    return isInsideOrSame(baseReal, absolute)
  }
  return false
}

export function isWorkspacePathError(error: unknown): error is WorkspacePathError {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error instanceof WorkspacePathError ||
      (error as { code?: unknown }).code === 'WORKSPACE_PATH_ESCAPE'),
  )
}

export function formatWorkspacePathError(error: WorkspacePathError): string {
  return [
    `Path is outside the current workspace.`,
    `Requested path: ${error.requestedPath}`,
    `Current workspace: ${error.cwd}`,
    `Resolved path: ${error.resolvedPath}`,
    `IMPORTANT: Do NOT retry this path with a different tool. The workspace boundary cannot be bypassed. Either use a path inside the workspace, or inform the user that this path is inaccessible.`,
  ].join('\n')
}
