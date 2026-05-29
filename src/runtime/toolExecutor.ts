import { errorMessage } from '../shared/errors.js'
import type { AnyTool } from '../tools/Tool.js'
import { truncateToolOutput } from '../tools/output.js'
import {
  formatWorkspacePathError,
  isWorkspacePathError,
} from '../tools/builtin/pathSafety.js'
import type { RuntimeExecuteOptions } from './Runtime.js'

const TOOL_EXECUTION_TIMEOUT_MS = 120_000

export type ToolExecutionResult =
  | {
      kind: 'result'
      success: boolean
      output: unknown
      truncated?: boolean
      originalBytes?: number
    }
  | { kind: 'error'; code: string; message: string; details?: unknown }

export async function executeToolSafely(
  tool: AnyTool,
  input: unknown,
  options: RuntimeExecuteOptions,
  opts?: { timeout?: number },
): Promise<ToolExecutionResult> {
  const maxOutputBytes = options.maxToolOutputBytes ?? 200_000
  const useTimeout = opts?.timeout ?? 0

  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let onParentAbort: (() => void) | undefined

  if (useTimeout > 0) {
    controller = new AbortController()
    timer = setTimeout(() => controller!.abort(), useTimeout)
    onParentAbort = () => controller!.abort()
    options.signal?.addEventListener('abort', onParentAbort)
  }

  const signal = controller?.signal ?? options.signal

  try {
    const result = await tool.execute(input, {
      cwd: options.cwd,
      sessionId: options.sessionId,
      signal,
      maxOutputBytes,
      bashMaxBufferBytes: options.bashMaxBufferBytes ?? 1_000_000,
      executionEnvironment: options.executionEnvironment,
      storage: options.storage,
      allowedPaths: options.allowedPaths,
    })
    const truncated = truncateToolOutput(result.output, maxOutputBytes)
    return {
      kind: 'result',
      success: result.success,
      output: truncated.value,
      truncated: truncated.truncated || undefined,
      originalBytes: truncated.originalBytes,
    }
  } catch (error) {
    const parentAborted = options.signal?.aborted
    const childAborted = controller?.signal.aborted
    if (parentAborted || childAborted) {
      const isToolTimeout = useTimeout > 0 && childAborted && !parentAborted
      const isRequestTimeout = !isToolTimeout && options.timeoutSignal?.aborted
      return {
        kind: 'error',
        code: isToolTimeout || isRequestTimeout ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED',
        message: isToolTimeout
          ? `Tool ${tool.name} timed out after ${useTimeout}ms.`
          : isRequestTimeout
            ? `Execution timed out while running ${tool.name}.`
            : `Execution cancelled while running ${tool.name}.`,
      }
    }
    if (isWorkspacePathError(error)) {
      return {
        kind: 'result',
        success: false,
        output: {
          code: error.code,
          message: formatWorkspacePathError(error),
          requestedPath: error.requestedPath,
          cwd: error.cwd,
          resolvedPath: error.resolvedPath,
        },
      }
    }
    return {
      kind: 'error',
      code: 'TOOL_ERROR',
      message: errorMessage(error),
      details: normalizeToolErrorDetails(error, maxOutputBytes),
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (onParentAbort) options.signal?.removeEventListener('abort', onParentAbort)
  }
}

export function normalizeToolErrorDetails(error: unknown, maxBytes: number): unknown {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  const details: Record<string, unknown> = {}

  if (record.code !== undefined) details.code = record.code
  if (record.signal !== undefined) details.signal = record.signal
  if (record.exitCode !== undefined) details.exitCode = record.exitCode

  for (const streamName of ['stdout', 'stderr'] as const) {
    const value = record[streamName]
    if (typeof value !== 'string' || value.length === 0) continue
    const truncated = truncateToolOutput(value, maxBytes)
    details[streamName] = truncated.value
    if (truncated.truncated) {
      details[`${streamName}Truncated`] = true
      details[`${streamName}OriginalBytes`] = truncated.originalBytes
    }
  }

  return Object.keys(details).length > 0 ? details : undefined
}

export { TOOL_EXECUTION_TIMEOUT_MS }
