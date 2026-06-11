import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { appendPathDriftGuidance, buildPathDriftDiagnostic } from './pathDrift.js'
import { resolveInsideWorkspace } from './pathSafety.js'

const DEFAULT_MAX_ENTRIES = 200
const SKIPPED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'target',
  'vendor',
])

const inputSchema = z.object({
  path: z.string().min(1).default('.'),
  maxEntries: z.number().int().positive().max(1_000).default(DEFAULT_MAX_ENTRIES),
  includeHidden: z.boolean().default(false),
  includeFiles: z.boolean().default(true),
  includeDirectories: z.boolean().default(true),
  maxDepth: z.number().int().min(1).max(2).default(1),
})

export type ListDirEntry = {
  path: string
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  depth: number
}

export type ListDirOutput = {
  path: string
  resolvedPath: string
  maxDepth: 1 | 2
  entries: ListDirEntry[]
  counts: {
    files: number
    directories: number
    symlinks: number
    other: number
    shown: number
    skippedHidden: number
    skippedByType: number
    skippedDirectories: number
  }
  truncated: boolean
  skippedDirs: string[]
  guidance: string
}

export const listDirTool: ToolDefinition<typeof inputSchema> = {
  name: 'ListDir',
  description: 'List immediate directory contents as structured inventory.',
  prompt: () => [
    'ListDir is a read-only directory inventory tool, not a file-content search tool.',
    'Use ListDir to inspect directory shape, immediate children, counts, and whether output was truncated.',
    'Set maxDepth to 1 for direct children or 2 for one nested level; never use maxDepth 3 or higher.',
    'Use Glob for pattern-based file discovery across paths, Grep for locating text inside files, and Read for understanding file contents.',
    'Prefer ListDir over Bash ls/find/tree for directory inventory because it is workspace-safe, depth-limited, structured, and auto-approved as read-only.',
    'For ordinary source inspection, pair ListDir with Grep and Read instead of Bash sed/head/grep pipelines.',
  ].join(' '),
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    if (!input.includeFiles && !input.includeDirectories) {
      return {
        success: false,
        output: 'ListDir requires at least one of includeFiles or includeDirectories to be true.',
      }
    }

    const resolvedPath = resolveInsideWorkspace(context.cwd, input.path, context.allowedPaths)
    let pathStat
    try {
      pathStat = await stat(resolvedPath)
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : ''
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {
          success: false,
          output: appendPathDriftGuidance(
            `ListDir could not find directory "${input.path}". Use ListDir on an existing parent directory or Glob for pattern-based discovery.`,
            buildPathDriftDiagnostic({ cwd: context.cwd, requestedPath: input.path }),
          ),
        }
      }
      throw err
    }

    if (!pathStat.isDirectory()) {
      return {
        success: false,
        output: `ListDir expected a directory but "${input.path}" is not a directory. Use Read for file contents.`,
      }
    }

    const maxDepth = input.maxDepth as 1 | 2
    const state: WalkState = {
      cwd: context.cwd,
      root: resolvedPath,
      input,
      maxDepth,
      entries: [],
      counts: {
        files: 0,
        directories: 0,
        symlinks: 0,
        other: 0,
        shown: 0,
        skippedHidden: 0,
        skippedByType: 0,
        skippedDirectories: 0,
      },
      truncated: false,
      skippedDirs: [],
    }

    await collectDirectory(state, resolvedPath, 1)

    const output: ListDirOutput = {
      path: input.path,
      resolvedPath,
      maxDepth,
      entries: state.entries,
      counts: state.counts,
      truncated: state.truncated,
      skippedDirs: state.skippedDirs,
      guidance: 'ListDir only proves directory inventory. Use Glob for pattern discovery, Grep for content matches, and Read before making source-level claims.',
    }
    return { success: true, output }
  },
}

type WalkState = {
  cwd: string
  root: string
  input: z.infer<typeof inputSchema>
  maxDepth: 1 | 2
  entries: ListDirEntry[]
  counts: ListDirOutput['counts']
  truncated: boolean
  skippedDirs: string[]
}

async function collectDirectory(state: WalkState, dir: string, depth: 1 | 2): Promise<void> {
  if (state.truncated) return
  let dirEntries
  try {
    dirEntries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  dirEntries.sort((left, right) => {
    const leftType = left.isDirectory() ? 0 : 1
    const rightType = right.isDirectory() ? 0 : 1
    if (leftType !== rightType) return leftType - rightType
    return left.name.localeCompare(right.name)
  })

  for (const entry of dirEntries) {
    if (state.entries.length >= state.input.maxEntries) {
      state.truncated = true
      return
    }
    if (!state.input.includeHidden && entry.name.startsWith('.')) {
      state.counts.skippedHidden += 1
      continue
    }

    const fullPath = join(dir, entry.name)
    const type = entryType(entry)
    incrementTypeCount(state, type)

    if (type === 'directory' && SKIPPED_DIR_NAMES.has(entry.name)) {
      state.counts.skippedDirectories += 1
      state.skippedDirs.push(formatRelativePath(state.cwd, fullPath))
      continue
    }

    const typeAllowed = type === 'directory'
      ? state.input.includeDirectories
      : state.input.includeFiles
    if (!typeAllowed) {
      state.counts.skippedByType += 1
    } else {
      state.entries.push({
        path: formatRelativePath(state.cwd, fullPath),
        name: entry.name,
        type,
        depth,
      })
      state.counts.shown = state.entries.length
    }

    if (type === 'directory' && depth < state.maxDepth) {
      await collectDirectory(state, fullPath, 2)
    }
  }
}

function entryType(entry: Dirent): ListDirEntry['type'] {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'other'
}

function incrementTypeCount(state: WalkState, type: ListDirEntry['type']): void {
  if (type === 'file') state.counts.files += 1
  else if (type === 'directory') state.counts.directories += 1
  else if (type === 'symlink') state.counts.symlinks += 1
  else state.counts.other += 1
}

function formatRelativePath(cwd: string, path: string): string {
  const rel = relative(cwd, path)
  return rel || '.'
}
