import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { resolveInsideWorkspace } from './pathSafety.js'

const inputSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(1_000_000).default(200_000),
})

export const readTool: ToolDefinition<typeof inputSchema> = {
  name: 'Read',
  description: 'Read a text file inside the workspace.',
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    const path = resolveInsideWorkspace(context.cwd, input.path)
    const file = await readFile(path)
    return {
      success: true,
      output: file.subarray(0, input.maxBytes).toString('utf8'),
    }
  },
}
