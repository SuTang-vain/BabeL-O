import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { resolveInsideWorkspace } from './pathSafety.js'

const DEFAULT_MAX_BYTES = 200_000
const LARGE_FILE_PREVIEW_BYTES = 50_000

const inputSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(1_000_000).default(DEFAULT_MAX_BYTES),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(1_000_000).optional(),
  mode: z.enum(['auto', 'full', 'preview']).default('auto'),
})

export const readTool: ToolDefinition<typeof inputSchema> = {
  name: 'Read',
  description: 'Read a text file inside the workspace.',
  prompt: () => 'Reads a text file inside the workspace. Use offset/limit for targeted ranges and mode="preview" for large files; default auto mode returns a preview with a follow-up range hint for large files instead of flooding context. Use full mode only when the user explicitly needs the whole file.',
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    const path = resolveInsideWorkspace(context.cwd, input.path, context.allowedPaths)
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
    const start = input.offset ?? 0
    const requestedBytes = input.limit ?? input.maxBytes
    const shouldPreview = input.mode === 'preview' || (input.mode === 'auto' && input.offset === undefined && input.limit === undefined && file.length > input.maxBytes)
    const readBytes = shouldPreview
      ? Math.min(LARGE_FILE_PREVIEW_BYTES, input.maxBytes, file.length)
      : input.mode === 'full' && input.offset === undefined && input.limit === undefined
        ? Math.min(file.length, input.maxBytes)
        : Math.min(requestedBytes, input.maxBytes, Math.max(0, file.length - start))
    const end = Math.min(file.length, start + readBytes)
    const output = file.subarray(start, end).toString('utf8')

    if (shouldPreview) {
      const remainingBytes = Math.max(0, file.length - end)
      return {
        success: true,
        output: [
          `<read-preview path="${input.path}" bytes="${file.length}" shown="${end - start}" remaining="${remainingBytes}">`,
          output,
          '</read-preview>',
          `Use Read with offset=${end} and limit=${Math.min(input.maxBytes, LARGE_FILE_PREVIEW_BYTES)} for the next range, or use Grep/Glob to target symbols before reading more.`,
        ].join('\n'),
      }
    }

    if (end < file.length) {
      return {
        success: true,
        output: [
          output,
          `\n<read-truncated path="${input.path}" bytes="${file.length}" shownRange="${start}-${end}">Use Read with offset=${end} and limit=${Math.min(input.maxBytes, requestedBytes)} to continue.</read-truncated>`,
        ].join(''),
      }
    }

    return {
      success: true,
      output,
    }
  },
}
