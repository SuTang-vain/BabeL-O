import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { resolveInsideWorkspace } from './pathSafety.js'

const inputSchema = z.object({
  path: z.string().min(1),
  oldString: z.string(),
  newString: z.string(),
})

export const editTool: ToolDefinition<typeof inputSchema> = {
  name: 'Edit',
  description: 'Replace one exact string in a file inside the workspace.',
  risk: 'write',
  inputSchema,
  async execute(input, context) {
    const path = resolveInsideWorkspace(context.cwd, input.path)
    const before = await readFile(path, 'utf8')
    if (!before.includes(input.oldString)) {
      return {
        success: false,
        output: `String not found in ${input.path}`,
      }
    }
    const after = before.replace(input.oldString, input.newString)
    await writeFile(path, after, 'utf8')
    return {
      success: true,
      output: `Edited ${input.path}`,
    }
  },
}
