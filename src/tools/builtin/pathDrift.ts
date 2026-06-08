import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type PathDriftDiagnostic = {
  code: 'PATH_DRIFT_SUSPECTED'
  attemptedPath: string
  cwd: string
  candidatePath?: string
  reason: 'missing-workspace-parent-segment' | 'sibling-root-confusion'
  guidance: string
}

export function buildPathDriftDiagnostic(options: {
  cwd: string
  requestedPath: string
}): PathDriftDiagnostic | undefined {
  const attemptedPath = resolve(options.cwd, options.requestedPath)
  const cwd = resolve(options.cwd)
  if (existsSync(attemptedPath)) return undefined

  const candidate = candidateUnderCwd({ cwd, attemptedPath })
  if (candidate && isInsideOrSame(cwd, candidate) && existsSync(candidate)) {
    return {
      code: 'PATH_DRIFT_SUSPECTED',
      attemptedPath,
      cwd,
      candidatePath: candidate,
      reason: 'missing-workspace-parent-segment',
      guidance: 'The requested path does not exist, but a similar path exists under the current cwd. If you are inspecting the current project, retry with cwd-relative paths or the candidatePath. Do not treat the missing path as evidence that the file is absent from the project.',
    }
  }

  if (isAbsolute(options.requestedPath) && basename(attemptedPath) === basename(cwd) && shareParentPrefix(attemptedPath, cwd)) {
    return {
      code: 'PATH_DRIFT_SUSPECTED',
      attemptedPath,
      cwd,
      reason: 'sibling-root-confusion',
      guidance: 'The requested absolute path looks like a sibling or shortened variant of the current workspace root, but it does not exist. Verify the current cwd and prefer cwd-relative paths before continuing.',
    }
  }

  return undefined
}

export function appendPathDriftGuidance(message: string, diagnostic: PathDriftDiagnostic | undefined): string {
  if (!diagnostic) return message
  return `${message}\n${JSON.stringify({ guidance: diagnostic })}`
}

function candidateUnderCwd(options: { cwd: string; attemptedPath: string }): string | undefined {
  const cwdParts = splitPath(options.cwd)
  const attemptedParts = splitPath(options.attemptedPath)
  const workspaceName = cwdParts[cwdParts.length - 1]
  if (!workspaceName || attemptedParts.length === 0) return undefined

  for (let index = attemptedParts.length - 1; index >= 0; index -= 1) {
    if (attemptedParts[index] !== workspaceName) continue
    if (!sharesPrefixBeforeWorkspace(cwdParts, attemptedParts, index)) continue
    return join(options.cwd, ...attemptedParts.slice(index + 1))
  }

  return undefined
}

function sharesPrefixBeforeWorkspace(cwdParts: string[], attemptedParts: string[], workspaceIndex: number): boolean {
  const cwdParentParts = cwdParts.slice(0, -1)
  const attemptedParentParts = attemptedParts.slice(0, workspaceIndex)
  let shared = 0
  for (let index = 0; index < Math.min(cwdParentParts.length, attemptedParentParts.length); index += 1) {
    if (cwdParentParts[index] !== attemptedParentParts[index]) break
    shared += 1
  }
  return shared >= Math.max(1, Math.min(cwdParentParts.length, attemptedParentParts.length) - 1)
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

function isInsideOrSame(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function shareParentPrefix(left: string, right: string): boolean {
  const leftParent = dirname(left)
  const rightParent = dirname(right)
  const leftParts = splitPath(leftParent)
  const rightParts = splitPath(rightParent)
  let shared = 0
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] !== rightParts[index]) break
    shared += 1
  }
  return shared >= Math.max(1, Math.min(leftParts.length, rightParts.length) - 1)
}
