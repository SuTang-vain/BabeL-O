import { execFile } from 'node:child_process'
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
    const { stdout } = await execFileAsync('rg', ['--files'], {
      cwd: context.cwd,
      maxBuffer: 2_000_000,
      signal: context.signal,
    })
    const needle = input.pattern.replaceAll('*', '')
    const files = stdout
      .split('\n')
      .filter(Boolean)
      .filter(file => file.includes(needle))
      .slice(0, input.maxResults)
    return { success: true, output: files }
  },
}
