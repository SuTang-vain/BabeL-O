import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { resolveInsideWorkspace } from './pathSafety.js'

const inputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
})

export const writeTool: ToolDefinition<typeof inputSchema> = {
  name: 'Write',
  description: 'Write a file inside the workspace, creating parent directories.',
  prompt: () => 'Writes a file to the local filesystem. This will overwrite the existing file. Prefer the Edit tool for modifying existing files. Use this only when creating new files or when a complete rewrite is needed.',
  risk: 'write',
  inputSchema,
  async execute(input, context) {
    const path = resolveInsideWorkspace(context.cwd, input.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, input.content, 'utf8')
    return {
      success: true,
      output: `Wrote ${input.path}`,
    }
  },
}
