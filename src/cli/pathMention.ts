import * as fs from 'node:fs'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'

export const WORKSPACE_PATH_INDEX_LIMIT = 50_000
export const PATH_MENTION_RESULT_LIMIT = 50
const DEFAULT_SCAN_BUDGET_MS = 80

export type WorkspacePathEntry = {
  path: string
  basename: string
  isDir: boolean
}

type WorkspacePathIndexOptions = {
  maxEntries?: number
  scanBudgetMs?: number
  maxDepth?: number
}

type PathMentionCompletion = {
  hits: string[]
  substring: string
}

export class WorkspacePathIndex {
  private entries?: WorkspacePathEntry[]
  private readonly maxEntries: number
  private readonly scanBudgetMs: number
  private readonly maxDepth: number

  constructor(private readonly cwd: string, options: WorkspacePathIndexOptions = {}) {
    this.maxEntries = options.maxEntries ?? WORKSPACE_PATH_INDEX_LIMIT
    this.scanBudgetMs = options.scanBudgetMs ?? DEFAULT_SCAN_BUDGET_MS
    this.maxDepth = options.maxDepth ?? 8
  }

  get built(): boolean {
    return this.entries !== undefined
  }

  get entryCount(): number {
    return this.entries?.length ?? 0
  }

  completeMention(query: string, maxResults = PATH_MENTION_RESULT_LIMIT): string[] {
    const normalizedQuery = normalizeQuery(query)
    const entries = this.getEntries()
    return entries
      .filter(entry => matchesEntry(entry, normalizedQuery))
      .sort((left, right) => compareEntries(left, right, normalizedQuery))
      .slice(0, maxResults)
      .map(entry => `@${entry.path}${entry.isDir ? '/' : ''}`)
  }

  private getEntries(): WorkspacePathEntry[] {
    if (!this.entries) this.entries = buildWorkspacePathEntries(this.cwd, {
      maxEntries: this.maxEntries,
      scanBudgetMs: this.scanBudgetMs,
      maxDepth: this.maxDepth,
    })
    return this.entries
  }
}

export function completePathMention(line: string, cwd: string, index = new WorkspacePathIndex(cwd)): PathMentionCompletion | undefined {
  const token = currentToken(line)
  if (!token || looksLikeUrl(token)) return undefined

  if (token.startsWith('@')) {
    return {
      hits: index.completeMention(token.slice(1)),
      substring: token,
    }
  }

  if (!hasPathSeparator(token)) return undefined
  return completePathToken(token, cwd)
}

function completePathToken(token: string, cwd: string): PathMentionCompletion | undefined {
  const separatorIndex = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'))
  const dirPart = separatorIndex >= 0 ? token.slice(0, separatorIndex + 1) : ''
  const prefix = separatorIndex >= 0 ? token.slice(separatorIndex + 1) : token
  const searchDir = resolveSearchDir(cwd, dirPart)
  if (!searchDir || !isInsideWorkspace(cwd, searchDir)) return { hits: [], substring: token }

  let dirEntries: fs.Dirent[]
  try {
    dirEntries = fs.readdirSync(searchDir, { withFileTypes: true })
  } catch {
    return { hits: [], substring: token }
  }

  const hits = dirEntries
    .filter(entry => entry.name.startsWith(prefix))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, PATH_MENTION_RESULT_LIMIT)
    .map(entry => `${dirPart}${entry.name}${entry.isDirectory() ? '/' : ''}`)

  return { hits, substring: token }
}

function buildWorkspacePathEntries(cwd: string, options: Required<WorkspacePathIndexOptions>): WorkspacePathEntry[] {
  const entries: WorkspacePathEntry[] = []
  const startedAt = performance.now()
  const stack: Array<{ absPath: string; relPath: string; depth: number }> = [{ absPath: cwd, relPath: '', depth: 0 }]

  while (stack.length > 0 && entries.length < options.maxEntries) {
    if (performance.now() - startedAt > options.scanBudgetMs) break
    const current = stack.pop()!
    let dirEntries: fs.Dirent[]
    try {
      dirEntries = fs.readdirSync(current.absPath, { withFileTypes: true })
    } catch {
      continue
    }

    dirEntries.sort((left, right) => right.name.localeCompare(left.name))
    for (const entry of dirEntries) {
      if (entries.length >= options.maxEntries) break
      if (performance.now() - startedAt > options.scanBudgetMs) break
      if (shouldSkipEntry(entry)) continue

      const relPath = joinRelativePath(current.relPath, entry.name)
      if (entry.isDirectory()) {
        entries.push({ path: relPath, basename: entry.name, isDir: true })
        if (current.depth < options.maxDepth && shouldDescendDirectory(entry.name)) {
          stack.push({ absPath: path.join(current.absPath, entry.name), relPath, depth: current.depth + 1 })
        }
      } else if (entry.isFile()) {
        entries.push({ path: relPath, basename: entry.name, isDir: false })
      }
    }
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

function currentToken(line: string): string {
  const match = /(?:^|\s)(\S*)$/.exec(line)
  return match?.[1] ?? ''
}

function hasPathSeparator(token: string): boolean {
  return token.includes('/') || token.includes('\\')
}

function looksLikeUrl(token: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(token)
}

function resolveSearchDir(cwd: string, dirPart: string): string | undefined {
  if (dirPart.length === 0) return cwd
  if (dirPart.startsWith('~/')) return undefined
  return path.resolve(cwd, dirPart)
}

function isInsideWorkspace(cwd: string, candidate: string): boolean {
  const relative = path.relative(cwd, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function joinRelativePath(base: string, name: string): string {
  return base ? `${base}/${name}` : name
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

function matchesEntry(entry: WorkspacePathEntry, query: string): boolean {
  if (query.length === 0) return true
  const basename = entry.basename.toLowerCase()
  const fullPath = entry.path.toLowerCase()
  return basename.includes(query) || fullPath.includes(query) || isSubsequence(query, basename)
}

function compareEntries(left: WorkspacePathEntry, right: WorkspacePathEntry, query: string): number {
  const leftRank = entryRank(left, query)
  const rightRank = entryRank(right, query)
  if (leftRank !== rightRank) return leftRank - rightRank
  if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
  const lengthCmp = left.path.length - right.path.length
  if (lengthCmp !== 0) return lengthCmp
  return left.path.localeCompare(right.path)
}

function entryRank(entry: WorkspacePathEntry, query: string): number {
  if (query.length === 0) return 4
  const basename = entry.basename.toLowerCase()
  const fullPath = entry.path.toLowerCase()
  if (basename === query) return 0
  if (basename.startsWith(query)) return 1
  if (fullPath.startsWith(query)) return 2
  if (basename.includes(query)) return 3
  if (fullPath.includes(query)) return 4
  return 5
}

function isSubsequence(query: string, text: string): boolean {
  let queryIndex = 0
  for (const char of text) {
    if (char === query[queryIndex]) queryIndex += 1
    if (queryIndex === query.length) return true
  }
  return query.length === 0
}

function shouldSkipEntry(entry: fs.Dirent): boolean {
  return entry.isSymbolicLink()
}

function shouldDescendDirectory(name: string): boolean {
  return !new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache']).has(name)
}
