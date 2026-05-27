import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { resolveInsideWorkspace } from './pathSafety.js'

const execFileAsync = promisify(execFile)

const inputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  maxResults: z.number().int().positive().max(500).default(100),
})

export const globTool: ToolDefinition<typeof inputSchema> = {
  name: 'Glob',
  description: 'List files using ripgrep file discovery and a simple substring filter.',
  prompt: () => 'Fast file pattern matching tool. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time. Use this to find files by name patterns.',
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    const searchRoot = input.path
      ? resolveInsideWorkspace(context.cwd, input.path)
      : context.cwd

    let stdout = ''
    try {
      const result = await execFileAsync('rg', ['--files'], {
        cwd: searchRoot,
        maxBuffer: 2_000_000,
        signal: context.signal,
      })
      stdout = result.stdout
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        stdout = (await listFilesFallback(searchRoot, input.maxResults * 20)).join('\n')
      } else {
        throw error
      }
    }
    const needle = normalizeGlobNeedle(input.pattern, searchRoot)
    const files = stdout
      .split('\n')
      .filter(Boolean)
      .filter(file => needle === '' || file.includes(needle))
    const truncated = files.length > input.maxResults
    const sliced = files.slice(0, input.maxResults)
    if (truncated) {
      sliced.push(`... (${files.length - input.maxResults} more results truncated)`)
    }
    return { success: true, output: sliced }
  },
}

function normalizeGlobNeedle(pattern: string, cwd: string): string {
  let needle = pattern.trim().replaceAll('*', '')
  if (needle === '.' || needle === './' || needle === '/') return ''
  if (isAbsolute(needle)) {
    const relativeNeedle = relative(cwd, needle)
    if (relativeNeedle === '' || relativeNeedle === '.') return ''
    if (!relativeNeedle.startsWith('..')) {
      needle = relativeNeedle
    }
  }
  return needle.replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
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
