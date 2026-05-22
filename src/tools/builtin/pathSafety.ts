import { resolve, relative } from 'node:path'

export function resolveInsideWorkspace(cwd: string, requestedPath: string): string {
  const absolute = resolve(cwd, requestedPath)
  const rel = relative(cwd, absolute)
  if (rel.startsWith('..') || rel === '..' || rel === '') {
    if (absolute !== resolve(cwd)) {
      throw new Error(`Path escapes workspace: ${requestedPath}`)
    }
  }
  return absolute
}
