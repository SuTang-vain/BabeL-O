import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const execFileAsync = promisify(execFile)

const inputSchema = z.object({
  pattern: z.string().min(1),
  maxResults: z.number().int().positive().max(500).default(100),
})

export const globTool: ToolDefinition<typeof inputSchema> = {
  name: 'Glob',
  description: 'List files using ripgrep file discovery and a simple substring filter.',
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    let stdout = ''
    try {
      const result = await execFileAsync('rg', ['--files'], {
        cwd: context.cwd,
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
        stdout = (await listFilesFallback(context.cwd, input.maxResults * 20)).join('\n')
      } else {
        throw error
      }
    }
    const needle = input.pattern.replaceAll('*', '')
    const files = stdout
      .split('\n')
      .filter(Boolean)
      .filter(file => file.includes(needle))
      .slice(0, input.maxResults)
    return { success: true, output: files }
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
