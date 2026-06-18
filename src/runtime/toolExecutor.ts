import { performance } from 'node:perf_hooks'
import { errorMessage } from '../shared/errors.js'
import type { RemoteToolRunnerDiagnostics } from '../shared/toolTrace.js'
import type { AnyTool } from '../tools/Tool.js'
import { truncateToolOutput } from '../tools/output.js'
import {
  formatWorkspacePathError,
  isWorkspacePathError,
} from '../tools/builtin/pathSafety.js'
import type { RuntimeExecuteOptions } from './Runtime.js'
import { REMOTE_RUNNER_PROTOCOL_VERSION, remoteRunnerSupportsTool, remoteRunnerUnavailableResult, type RemoteToolRunnerResult } from './remoteRunner.js'

const TOOL_EXECUTION_TIMEOUT_MS = 120_000

export type ToolExecutionResult =
  | {
      kind: 'result'
      success: boolean
      output: unknown
      truncated?: boolean
      originalBytes?: number
      remoteRunner?: RemoteToolRunnerDiagnostics
    }
  | { kind: 'error'; code: string; message: string; details?: unknown; remoteRunner?: RemoteToolRunnerDiagnostics }

export async function executeToolSafely(
  tool: AnyTool,
  input: unknown,
  options: RuntimeExecuteOptions,
  opts?: { timeout?: number; toolUseId?: string },
): Promise<ToolExecutionResult> {
  const maxOutputBytes = options.maxToolOutputBytes ?? 200_000
  const useTimeout = opts?.timeout ?? 0

  if (options.executionEnvironment === 'remote') {
    if (!options.remoteRunner) return remoteRunnerUnavailableResult()
    if (!remoteRunnerSupportsTool(options.remoteRunner, tool)) {
      return {
        kind: 'error',
        code: 'REMOTE_RUNNER_TOOL_UNSUPPORTED',
        message: `Remote runner ${options.remoteRunner.id} does not support tool ${tool.name}.`,
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    let cancellationKind: 'cancelled' | 'timeout' | undefined
    let rejectCancelled: ((error: Error) => void) | undefined
    const cancelRequest = {
      sessionId: options.sessionId,
      requestId: options.requestId,
      toolUseId: opts?.toolUseId,
    }
    const cancelledPromise = new Promise<never>((_, reject) => {
      rejectCancelled = reject
    })
    const cancelRemoteTool = (kind: 'cancelled' | 'timeout') => {
      if (cancelled) return
      cancelled = true
      cancellationKind = kind
      void options.remoteRunner?.cancelTool?.(cancelRequest).catch(() => {})
      rejectCancelled?.(new Error('Remote tool execution cancelled'))
    }
    const onParentAbort = () => cancelRemoteTool('cancelled')
    const onTimeoutAbort = () => cancelRemoteTool('timeout')

    if (useTimeout > 0) timer = setTimeout(() => cancelRemoteTool('timeout'), useTimeout)
    options.signal?.addEventListener('abort', onParentAbort)
    options.timeoutSignal?.addEventListener('abort', onTimeoutAbort)

    try {
      const remoteStartMs = performance.now()
      const result = await Promise.race([
        options.remoteRunner.executeTool({
          protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
          sessionId: options.sessionId,
          requestId: options.requestId,
          toolUseId: opts?.toolUseId,
          toolName: tool.name,
          toolInput: input,
          cwd: options.cwd,
          allowedPaths: options.allowedPaths,
          maxOutputBytes,
          bashMaxBufferBytes: options.bashMaxBufferBytes ?? 1_000_000,
          deadlineMs: useTimeout > 0 ? Date.now() + useTimeout : undefined,
        }),
        cancelledPromise,
      ])
      const roundtripMs = performance.now() - remoteStartMs
      const remoteRunner = normalizeRemoteToolRunnerDiagnostics(
        options.remoteRunner.id,
        result,
        roundtripMs,
        result.kind === 'error' ? result.code : undefined,
      )
      if (result.kind === 'error') return { ...result, remoteRunner }
      const truncated = truncateToolOutput(result.output, maxOutputBytes)
      return {
        kind: 'result',
        success: result.success,
        output: truncated.value,
        truncated: result.truncated || truncated.truncated || undefined,
        originalBytes: result.originalBytes ?? truncated.originalBytes,
        remoteRunner: {
          ...remoteRunner,
          truncated: result.truncated || truncated.truncated || remoteRunner.truncated || undefined,
          originalBytes: result.originalBytes ?? truncated.originalBytes ?? remoteRunner.originalBytes,
        },
      }
    } catch (error) {
      const isTimeout = cancellationKind === 'timeout' || options.timeoutSignal?.aborted
      if (cancelled || options.signal?.aborted || isTimeout) {
        return {
          kind: 'error',
          code: isTimeout ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED',
          message: isTimeout
            ? `Execution timed out while running ${tool.name}.`
            : `Execution cancelled while running ${tool.name}.`,
          remoteRunner: {
            runnerId: options.remoteRunner.id,
            protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
            timedOut: isTimeout || undefined,
            cancelled: !isTimeout || undefined,
            errorCode: isTimeout ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED',
          },
        }
      }
      return {
        kind: 'error',
        code: 'REMOTE_RUNNER_ERROR',
        message: errorMessage(error),
        details: normalizeToolErrorDetails(error, maxOutputBytes),
        remoteRunner: {
          runnerId: options.remoteRunner.id,
          protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
          errorCode: 'REMOTE_RUNNER_ERROR',
        },
      }
    } finally {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onParentAbort)
      options.timeoutSignal?.removeEventListener('abort', onTimeoutAbort)
    }
  }

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
      kind: 'result',
      success: false,
      output: {
        code: 'TOOL_EXECUTION_FAILED',
        toolName: tool.name,
        message: errorMessage(error),
        repairHint: repairHintForToolFailure(tool.name, error, input),
        input: redactRecoverableToolInput(input),
        details: normalizeToolErrorDetails(error, maxOutputBytes),
      },
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (onParentAbort) options.signal?.removeEventListener('abort', onParentAbort)
  }
}

function repairHintForToolFailure(toolName: string, error: unknown, input: unknown): string {
  if (toolName === 'Grep') {
    const pattern = input && typeof input === 'object'
      ? (input as { pattern?: unknown }).pattern
      : undefined
    if (typeof pattern === 'string' && pattern.startsWith('-')) {
      return 'The search pattern starts with "-"; Grep must pass "--" before the pattern when invoking ripgrep. Retry the Grep with the same pattern after the tool fix, or use a safer escaped pattern.'
    }
    const message = errorMessage(error)
    if (/regex|regexp|regular expression|unrecognized flag/i.test(message)) {
      return 'Check the Grep regex syntax and escape special characters, or simplify the pattern before retrying.'
    }
  }
  if (toolName === 'Read') {
    return 'Verify the file path with Glob or ListDir, then retry Read with a known in-scope path.'
  }
  if (toolName === 'Write') {
    return 'Verify the parent path is a directory inside the workspace and retry Write with a corrected path.'
  }
  if (toolName === 'Edit') {
    return 'Read the current file contents first, then retry Edit with an exact unique oldString.'
  }
  if (toolName === 'Glob') {
    return 'Verify the search path and glob syntax, or simplify the pattern before retrying Glob.'
  }
  if (toolName === 'Bash') {
    return 'Check whether the command, working directory, and required binaries exist. Prefer dedicated read tools for source inspection.'
  }
  if (toolName === 'TaskCreate') {
    return 'Retry task creation after storage is available, or continue without a persisted task marker.'
  }
  return 'Return a corrected tool call if the task still requires this tool, or answer from existing verified evidence.'
}

function redactRecoverableToolInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (/api[_-]?key|authorization|auth[_-]?token|password|secret|token/i.test(key)) {
      redacted[key] = '[REDACTED]'
    } else {
      redacted[key] = value
    }
  }
  return redacted
}

function normalizeRemoteToolRunnerDiagnostics(
  runnerId: string,
  result: RemoteToolRunnerResult,
  roundtripMs: number,
  errorCode?: string,
): RemoteToolRunnerDiagnostics {
  const metrics = result.metrics ?? {}
  const details = result.kind === 'error' && result.details && typeof result.details === 'object'
    ? result.details as Record<string, unknown>
    : undefined
  const output = result.kind === 'result' && result.output && typeof result.output === 'object'
    ? result.output as Record<string, unknown>
    : undefined
  const normalized: RemoteToolRunnerDiagnostics = {
    runnerId: typeof metrics.runnerId === 'string' ? metrics.runnerId : runnerId,
    protocolVersion: typeof metrics.protocolVersion === 'string' ? metrics.protocolVersion : REMOTE_RUNNER_PROTOCOL_VERSION,
    durationMs: finiteNumber(metrics.durationMs),
    roundtripMs,
    truncated: metrics.truncated ?? (result.kind === 'result' ? result.truncated : undefined),
    originalBytes: finiteNumber(metrics.originalBytes) ?? (result.kind === 'result' ? result.originalBytes : undefined),
    exitCode: finiteNumber(metrics.exitCode) ?? finiteNumber(output?.exitCode) ?? finiteNumber(details?.exitCode),
    signal: typeof metrics.signal === 'string' ? metrics.signal : typeof output?.signal === 'string' ? output.signal : typeof details?.signal === 'string' ? details.signal : undefined,
    cancelled: metrics.cancelled ?? (errorCode === 'REQUEST_CANCELLED' || undefined),
    timedOut: metrics.timedOut ?? (errorCode === 'REQUEST_TIMEOUT' || undefined),
    errorCode,
  }
  return compactRemoteDiagnostics(normalized)
}

function compactRemoteDiagnostics(diagnostics: RemoteToolRunnerDiagnostics): RemoteToolRunnerDiagnostics {
  return Object.fromEntries(
    Object.entries(diagnostics).filter(([, value]) => value !== undefined),
  ) as RemoteToolRunnerDiagnostics
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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
