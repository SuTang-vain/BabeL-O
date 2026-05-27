import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const execFileAsync = promisify(execFile)

const inputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default('.'),
  maxMatches: z.number().int().positive().max(200).default(50),
})

export const grepTool: ToolDefinition<typeof inputSchema> = {
  name: 'Grep',
  description: 'Search file contents using ripgrep.',
  prompt: () => 'A powerful search tool built on ripgrep. Supports full regex syntax. Use this to search file content by pattern. Prefer this tool over bash grep commands.',
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    try {
      const probeLimit = input.maxMatches + 1
      const { stdout } = await execFileAsync(
        'rg',
        ['-n', '--max-count', String(probeLimit), input.pattern, input.path],
        {
          cwd: context.cwd,
          maxBuffer: 1_000_000,
          signal: context.signal,
        },
      )
      const lines = stdout.split('\n').filter(line => line.length > 0)
      if (lines.length > input.maxMatches) {
        const truncated = lines.slice(0, input.maxMatches).join('\n') + '\n... (matches truncated for context budget)'
        return { success: true, output: truncated }
      }
      return { success: true, output: stdout }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 1
      ) {
        return { success: true, output: '' }
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        const output = await grepFallback(context.cwd, input.path, input.pattern, input.maxMatches)
        return { success: true, output }
      }
      throw error
    }
  },
}

async function grepFallback(
  cwd: string,
  searchPath: string,
  pattern: string,
  maxMatches: number,
): Promise<string> {
  const root = join(cwd, searchPath)
  const results: string[] = []
  const probeLimit = maxMatches + 1
  const needle = pattern.toLowerCase()

  async function visit(path: string): Promise<void> {
    if (results.length >= probeLimit) return
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      await scanFile(path)
      return
    }

    for (const entry of entries) {
      if (results.length >= probeLimit) return
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const fullPath = join(path, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
      } else if (entry.isFile()) {
        await scanFile(fullPath)
      }
    }
  }

  async function scanFile(filePath: string): Promise<void> {
    if (results.length >= probeLimit) return
    let text = ''
    try {
      text = await readFile(filePath, 'utf8')
    } catch {
      return
    }
    const lines = text.split('\n')
    for (let index = 0; index < lines.length && results.length < probeLimit; index++) {
      if (lines[index]!.toLowerCase().includes(needle)) {
        results.push(`${filePath}:${index + 1}:${lines[index]}`)
      }
    }
  }

  await visit(root)
  if (results.length > maxMatches) {
    return results.slice(0, maxMatches).join('\n') + '\n... (matches truncated for context budget)'
  }
  return results.join('\n')
}
