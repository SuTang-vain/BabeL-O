import { readFile, stat } from 'node:fs/promises'
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
    let fileStat
    try {
      fileStat = await stat(path)
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : ''
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {
          success: false,
          output: `Read could not find "${input.path}". Check the path or use Glob to discover available files.`,
        }
      }
      throw err
    }
    if (fileStat.isDirectory()) {
      return {
        success: false,
        output: `Read expected a file but "${input.path}" is a directory. Use Glob to list files or Read a specific file path inside it.`,
      }
    }
    if (!fileStat.isFile()) {
      return {
        success: false,
        output: `Read expected a regular file but "${input.path}" is not a file.`,
      }
    }
    const file = await readFile(path)
    return {
      success: true,
      output: file.subarray(0, input.maxBytes).toString('utf8'),
    }
  },
}
