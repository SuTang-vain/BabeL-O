import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { errorMessage } from '../../shared/errors.js'
import type { ToolDefinition } from '../Tool.js'
import { appendPathDriftGuidance, buildPathDriftDiagnostic } from './pathDrift.js'
import { resolveInsideWorkspace } from './pathSafety.js'

const inputSchema = z.object({
  path: z.string().min(1),
  oldString: z.string(),
  newString: z.string(),
})

export const editTool: ToolDefinition<typeof inputSchema> = {
  name: 'Edit',
  description: 'Replace one exact string in a file inside the workspace.',
  prompt: () => 'Performs exact string replacements in files. The old_string must be unique in the file. Use this for targeted modifications to existing files. Always read the file first before editing.',
  risk: 'write',
  inputSchema,
  async execute(input, context) {
    const path = resolveInsideWorkspace(context.cwd, input.path, context.allowedPaths)
    let before: string
    try {
      before = await readFile(path, 'utf8')
    } catch (error) {
      const code = filesystemErrorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {
          success: false,
          output: {
            code: 'EDIT_FILE_NOT_FOUND',
            message: appendPathDriftGuidance(
              `Edit could not find "${input.path}". Read or Glob the target first, then retry with an existing in-scope file path.`,
              buildPathDriftDiagnostic({ cwd: context.cwd, requestedPath: input.path }),
            ),
            path: input.path,
            repairHint: 'Use Glob/ListDir to discover the file, then retry Edit with the exact path and a unique oldString.',
            details: filesystemErrorDetails(error),
          },
        }
      }
      return {
        success: false,
        output: {
          code: 'EDIT_READ_FAILED',
          message: errorMessage(error),
          path: input.path,
          repairHint: 'Read the file first and verify it is a regular readable text file before retrying Edit.',
          details: filesystemErrorDetails(error),
        },
      }
    }
    const occurrences = before.split(input.oldString).length - 1
    if (occurrences === 0) {
      return {
        success: false,
        output: {
          code: 'EDIT_OLD_STRING_NOT_FOUND',
          message: `String not found in ${input.path}`,
          path: input.path,
          repairHint: 'Read the current file contents, then retry Edit with an oldString copied exactly from the file.',
        },
      }
    }
    if (occurrences > 1) {
      return {
        success: false,
        output: {
          code: 'EDIT_OLD_STRING_NOT_UNIQUE',
          message: `String is not unique in ${input.path} (found ${occurrences} occurrences). Provide more context to make it unique.`,
          path: input.path,
          occurrences,
          repairHint: 'Retry Edit with a larger oldString that uniquely identifies the intended occurrence.',
        },
      }
    }
    const after = before.replace(input.oldString, input.newString)
    try {
      await writeFile(path, after, 'utf8')
    } catch (error) {
      return {
        success: false,
        output: {
          code: 'EDIT_WRITE_FAILED',
          message: errorMessage(error),
          path: input.path,
          repairHint: 'Verify the file is writable and still inside the workspace, then retry Edit after re-reading the file.',
          details: filesystemErrorDetails(error),
        },
      }
    }
    return {
      success: true,
      output: `Edited ${input.path}`,
    }
  },
}

function filesystemErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return ''
  return String((error as { code?: unknown }).code)
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
