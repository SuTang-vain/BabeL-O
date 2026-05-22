import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const execFileAsync = promisify(execFile)

const inputSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(30_000).default(10_000),
})

export const bashTool: ToolDefinition<typeof inputSchema> = {
  name: 'Bash',
  description: 'Run a shell command in the workspace.',
  risk: 'execute',
  inputSchema,
  async execute(input, context) {
    const { stdout, stderr } = await execFileAsync(
      process.env.SHELL ?? '/bin/sh',
      ['-lc', input.command],
      {
        cwd: context.cwd,
        timeout: input.timeoutMs,
        signal: context.signal,
        maxBuffer: context.bashMaxBufferBytes,
      },
    )
    return {
      success: true,
      output: { stdout, stderr },
    }
  },
}
