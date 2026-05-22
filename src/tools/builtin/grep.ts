import { execFile } from 'node:child_process'
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
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    try {
      const { stdout } = await execFileAsync(
        'rg',
        ['-n', '--max-count', String(input.maxMatches), input.pattern, input.path],
        {
          cwd: context.cwd,
          maxBuffer: 1_000_000,
          signal: context.signal,
        },
      )
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
      throw error
    }
  },
}
