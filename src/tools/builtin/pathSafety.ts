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

export function resolveInsideWorkspace(cwd: string, requestedPath: string): string {
  const absolute = resolve(cwd, requestedPath)
  const cwdReal = getRealpath(cwd)

  let current = absolute
  let checkedExistingAncestor = false
  while (current && current !== dirname(current)) {
    if (existsSync(current)) {
      checkedExistingAncestor = true
      const currentReal = realpathSync(current)
      if (!isInsideOrSame(cwdReal, currentReal)) {
        throw new WorkspacePathError(requestedPath, cwdReal, absolute)
      }
      break
    }
    current = dirname(current)
  }

  if (!checkedExistingAncestor) {
    if (!isInsideOrSame(cwdReal, absolute)) {
      throw new WorkspacePathError(requestedPath, cwdReal, absolute)
    }
  } else if (!existsSync(absolute)) {
    const parentReal = getRealpath(current)
    if (!isInsideOrSame(cwdReal, parentReal)) {
      throw new WorkspacePathError(requestedPath, cwdReal, absolute)
    }
  } else {
    const absoluteReal = getRealpath(absolute)
    if (!isInsideOrSame(cwdReal, absoluteReal)) {
      throw new WorkspacePathError(requestedPath, cwdReal, absolute)
    }
  }

  const lexicalRel = relative(cwd, absolute)
  if (!checkedExistingAncestor && !isInsideOrSame(cwd, absolute)) {
    throw new WorkspacePathError(requestedPath, cwdReal, absolute)
  }

  return absolute
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
    `Use a path inside the current workspace, correct path casing/typos, or ask the user before switching projects.`,
  ].join('\n')
}
