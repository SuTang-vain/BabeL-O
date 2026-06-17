import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { errorMessage } from '../../shared/errors.js'
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
    const path = resolveInsideWorkspace(context.cwd, input.path, context.allowedPaths)
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, input.content, 'utf8')
    } catch (error) {
      return {
        success: false,
        output: {
          code: 'WRITE_FAILED',
          message: errorMessage(error),
          path: input.path,
          repairHint: 'Verify the parent path exists as a directory inside the workspace, then retry Write with a corrected path.',
          details: filesystemErrorDetails(error),
        },
      }
    }
    return {
      success: true,
      output: `Wrote ${input.path}`,
    }
  },
}

function filesystemErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  const details: Record<string, unknown> = {}
  if (record.code !== undefined) details.code = record.code
  if (record.path !== undefined) details.path = record.path
  if (record.syscall !== undefined) details.syscall = record.syscall
  if (record.errno !== undefined) details.errno = record.errno
  return Object.keys(details).length > 0 ? details : undefined
}
