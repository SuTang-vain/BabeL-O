import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { minimatch } from 'minimatch'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { buildPathDriftDiagnostic } from './pathDrift.js'
import { resolveInsideWorkspace } from './pathSafety.js'

const execFileAsync = promisify(execFile)

const inputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  maxResults: z.number().int().positive().max(500).default(100),
})

const GLOB_META = /[*?[\]{]/

function normalizePattern(pattern: string, cwd: string): string {
  if (GLOB_META.test(pattern)) return pattern
  if (isAbsolute(pattern)) {
    const rel = relative(cwd, pattern)
    if (!rel || rel === '.') return '**/*'
    if (!rel.startsWith('..')) return `${rel}/**/*`
    return '**/*'
  }
  return `**/*${pattern}*`
}

export const globTool: ToolDefinition<typeof inputSchema> = {
  name: 'Glob',
  description: 'Find files by glob pattern or substring match.',
  prompt: () => 'Glob is a pattern-based file discovery tool. Supports glob patterns like "**/*.js" or "src/**/*.ts" and plain substring matching. Use Glob when you need files matching a pattern across paths. Use ListDir for directory inventory, Grep for text matches inside files, and Read for source understanding.',
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    const searchRoot = input.path
      ? resolveInsideWorkspace(context.cwd, input.path, context.allowedPaths)
      : context.cwd
    if (!existsSync(searchRoot)) {
      const diagnostic = input.path
        ? buildPathDriftDiagnostic({ cwd: context.cwd, requestedPath: input.path })
        : undefined
      return {
        success: true,
        output: diagnostic
          ? [
              `No files matched because Glob path "${input.path}" does not exist.`,
              { guidance: diagnostic },
            ]
          : [],
      }
    }

    const globPattern = normalizePattern(input.pattern, searchRoot)

    let files: string[]
    try {
      const result = await execFileAsync('rg', ['--files', '--glob', globPattern], {
        cwd: searchRoot,
        maxBuffer: 2_000_000,
        signal: context.signal,
      })
      files = result.stdout.split('\n').filter(Boolean)
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        const allFiles = await listFilesFallback(searchRoot, input.maxResults * 20)
        files = allFiles.filter(file => minimatch(file, globPattern, { dot: true }))
      } else if (error?.status === 1 || error?.code === 1) {
        files = []
      } else {
        throw error
      }
    }

    const truncated = files.length > input.maxResults
    const sliced = files.slice(0, input.maxResults)
    if (truncated) {
      sliced.push(`... (${files.length - input.maxResults} more results truncated; narrow the pattern/path, then use Grep or targeted Read on the most relevant files)`)
    }
    return { success: true, output: sliced }
  },
}

async function listFilesFallback(cwd: string, maxFiles: number): Promise<string[]> {
  const files: string[] = []

  async function visit(path: string): Promise<void> {
    if (files.length >= maxFiles) return
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const fullPath = join(path, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
      } else if (entry.isFile()) {
        files.push(relative(cwd, fullPath))
      }
    }
  }

  await visit(cwd)
  return files
}
