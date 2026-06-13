import { lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import type { ToolResultContentBlock } from '../providers/adapters/ModelAdapter.js'
import { eventBase, type NexusEvent } from '../shared/events.js'
import { createId, nowIso } from '../shared/id.js'
import { PendingPermissionRegistry } from '../shared/session.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { AnyTool } from '../tools/Tool.js'
import { classifyAction } from './classifier.js'
import type { ToolPolicy } from './LocalCodingRuntime.js'
import type { RuntimeExecuteOptions } from './Runtime.js'
import {
  executeRuntimeHooks,
  firstHookDenyReason,
  firstHookPermissionDecision,
  lastHookUpdatedInput,
  mergeHookRetryHints,
} from './hooks.js'
import {
  absorbRemoteToolRunnerMetrics,
  buildRuntimeErrorEvent,
  buildRuntimeResultEvent,
  resolveProviderToolCallInput,
  type RuntimeExecutionMetrics,
  type RuntimeProviderToolCall,
} from './runtimePipeline.js'
import {
  buildScopeBoundaryConfirmedEvent,
  buildScopeBoundaryDetectedEvent,
  classifyToolScopeBoundary,
  type TaskScopeDeclaredEvent,
  type ToolScopeBoundary,
} from './taskScope.js'
import { checkOptimizerSafety } from './safetyCheck.js'
import { executeToolSafely, TOOL_EXECUTION_TIMEOUT_MS } from './toolExecutor.js'
import { replaceLargeToolResult } from './toolResultBudget.js'

export type ProviderToolCallExecutionOutcome =
  | { kind: 'continue'; toolResult: ToolResultContentBlock }
  | { kind: 'terminal' }

export type ReadFileCacheEntry = {
  mtime: number
  size: number
  ranges: ReadFileCacheRange[]
}

export type ReadFileCacheRange = {
  startByte: number
  endByte: number
  completeFile: boolean
  truncated: boolean
  mode: 'auto' | 'full' | 'preview'
  maxBytes: number
  offset?: number
  limit?: number
  byteOffset?: number
  byteLimit?: number
  toolUseId: string
  providerVisible: boolean
}

type RequestedReadCoverage = {
  startByte: number
  requestedEndByte: number
  requiresFullFile: boolean
  mode: 'auto' | 'full' | 'preview'
}

function recoverableDeniedToolResult(options: {
  toolUseId: string
  toolName: string
  message: string
}): ProviderToolCallExecutionOutcome {
  return {
    kind: 'continue',
    toolResult: {
      type: 'tool_result',
      toolUseId: options.toolUseId,
      content: `${options.message}\nChoose an allowed alternative, ask the user for confirmation, or answer from existing context.`,
      isError: true,
      toolName: options.toolName,
    },
  }
}

async function* requestScopeBoundaryPermission(options: {
  runtimeOptions: RuntimeExecuteOptions
  storage: NexusStorage
  tool: AnyTool
  toolUseId: string
  toolInput: unknown
  boundary: ToolScopeBoundary
}): AsyncGenerator<NexusEvent, boolean> {
  const { runtimeOptions, tool, toolUseId, toolInput, boundary } = options
  yield buildScopeBoundaryDetectedEvent({
    sessionId: runtimeOptions.sessionId,
    requestId: runtimeOptions.requestId,
    boundary,
  })

  const pendingPermission = PendingPermissionRegistry.getInstance().register(
    runtimeOptions.sessionId,
    toolUseId,
  )

  yield {
    type: 'permission_request',
    ...eventBase(runtimeOptions.sessionId),
    toolUseId,
    name: tool.name,
    input: toolInput,
    risk: tool.risk,
    message: `Tool ${tool.name} crosses the current task scope. ${boundary.reason}`,
    scopeRisk: boundary.scopeRisk,
    targetRoot: boundary.targetRoot,
    taskPrimaryRoot: boundary.taskPrimaryRoot,
    scopeReason: boundary.reason,
    source: tool.source,
  }

  const permissionHooks = await executeRuntimeHooks(
    'PermissionRequest',
    {
      toolUseId,
      toolName: tool.name,
      toolRisk: tool.risk,
      toolInput,
    },
    {
      sessionId: runtimeOptions.sessionId,
      cwd: runtimeOptions.cwd,
      role: runtimeOptions.role,
      signal: runtimeOptions.signal,
    },
    { config: runtimeOptions.hooks, hooks: runtimeOptions.runtimeHooks },
  )
  for (const hookEvent of permissionHooks.events) yield hookEvent

  const hookDecision = firstHookPermissionDecision(permissionHooks)
  if (hookDecision) {
    PendingPermissionRegistry.getInstance().resolve(runtimeOptions.sessionId, toolUseId, hookDecision)
  }
  const decision = hookDecision ?? await pendingPermission
  const approved = decision.approved
  const decisionReason = decision.reason ?? 'User review'

  await options.storage.savePermissionAudit({
    auditId: createId('audit'),
    sessionId: runtimeOptions.sessionId,
    toolUseId,
    toolName: tool.name,
    toolRisk: tool.risk,
    toolInput,
    decision: approved ? 'approved' : 'denied',
    reason: decisionReason,
    timestamp: nowIso(),
  })

  yield {
    type: 'permission_response',
    ...eventBase(runtimeOptions.sessionId),
    toolUseId,
    approved,
    reason: decisionReason,
    ...(decision.scope && { scope: decision.scope }),
    ...(decision.rule && { rule: decision.rule }),
    ...(decision.feedback && { feedback: decision.feedback }),
  }

  if (approved) {
    yield buildScopeBoundaryConfirmedEvent({
      sessionId: runtimeOptions.sessionId,
      requestId: runtimeOptions.requestId,
      targetRoot: boundary.targetRoot,
      confirmationScope: decision.scope === 'session' || decision.scope === 'rule' ? 'session' : 'once',
      confirmedBy: 'user',
      message: `User confirmed ${boundary.targetRoot} for the current task scope.`,
    })
  }

  return approved
}

export async function* executeProviderToolCall(options: {
  toolCall: RuntimeProviderToolCall
  tools: Map<string, AnyTool>
  toolPolicy: ToolPolicy
  runtimeOptions: RuntimeExecuteOptions
  storage: NexusStorage
  metrics: RuntimeExecutionMetrics
  readFileCache: Map<string, ReadFileCacheEntry>
  taskScope?: TaskScopeDeclaredEvent
}): AsyncGenerator<NexusEvent, ProviderToolCallExecutionOutcome> {
  const { toolCall, runtimeOptions, metrics, readFileCache } = options
  let resolvedInput = resolveProviderToolCallInput(toolCall)

  if (resolvedInput && typeof resolvedInput === 'object' && '_parseError' in (resolvedInput as Record<string, unknown>)) {
    const rawPreview = (resolvedInput as Record<string, unknown>)._rawInput as string || '(empty)'
    const repairHint = 'Use a single pathMatches string or pathMatches array; do not repeat JSON keys.'
    const errorMsg = [
      `Failed to parse tool input for ${toolCall.name}. The model output was not valid JSON.`,
      repairHint,
      `Raw input preview: ${rawPreview}`,
    ].join('\n')
    yield {
      type: 'tool_started',
      ...eventBase(runtimeOptions.sessionId),
      toolUseId: toolCall.id,
      name: toolCall.name,
      input: { _parseError: true, rawPreview },
    }
    yield {
      type: 'tool_completed',
      ...eventBase(runtimeOptions.sessionId),
      toolUseId: toolCall.id,
      name: toolCall.name,
      success: false,
      output: {
        code: 'TOOL_INPUT_PARSE_ERROR',
        message: 'Tool input was not valid JSON.',
        repairHint,
        rawPreview,
      },
    }
    return {
      kind: 'continue',
      toolResult: {
        type: 'tool_result',
        toolUseId: toolCall.id,
        content: errorMsg,
        isError: true,
        toolName: toolCall.name,
      },
    }
  }

  const tool = options.tools.get(toolCall.name)
  if (!tool) {
    const availableTools = [...options.tools.keys()].join(', ')
    const errorMsg = `Unknown tool "${toolCall.name}". Available tools: ${availableTools}. Check the tool name and try again.`
    yield {
      type: 'tool_completed',
      ...eventBase(runtimeOptions.sessionId),
      toolUseId: toolCall.id,
      name: toolCall.name,
      success: false,
      output: { code: 'TOOL_NOT_FOUND', message: errorMsg },
    }
    return {
      kind: 'continue',
      toolResult: {
        type: 'tool_result',
        toolUseId: toolCall.id,
        content: errorMsg,
        isError: true,
        toolName: toolCall.name,
      },
    }
  }

  yield {
    type: 'tool_started',
    ...eventBase(runtimeOptions.sessionId),
    toolUseId: toolCall.id,
    name: tool.name,
    input: resolvedInput,
  }

  if (!options.toolPolicy.isAllowed(tool)) {
    const message = `Tool denied by Nexus policy: ${tool.name}`
    yield {
      type: 'tool_denied',
      ...eventBase(runtimeOptions.sessionId),
      name: tool.name,
      risk: tool.risk,
      message,
      denialKind: 'policy',
      recoverable: true,
    }
    return recoverableDeniedToolResult({
      toolUseId: toolCall.id,
      toolName: tool.name,
      message,
    })
  }

  const preToolHooks = await executeRuntimeHooks(
    'PreToolUse',
    {
      toolUseId: toolCall.id,
      toolName: tool.name,
      toolRisk: tool.risk,
      toolInput: resolvedInput,
    },
    {
      sessionId: runtimeOptions.sessionId,
      cwd: runtimeOptions.cwd,
      role: runtimeOptions.role,
      signal: runtimeOptions.signal,
    },
    { config: runtimeOptions.hooks, hooks: runtimeOptions.runtimeHooks },
  )
  for (const hookEvent of preToolHooks.events) yield hookEvent
  const hookDenyReason = firstHookDenyReason(preToolHooks)
  if (hookDenyReason) {
    yield {
      type: 'tool_denied',
      ...eventBase(runtimeOptions.sessionId),
      name: tool.name,
      risk: tool.risk,
      message: hookDenyReason,
      denialKind: 'hook',
      recoverable: true,
    }
    return recoverableDeniedToolResult({
      toolUseId: toolCall.id,
      toolName: tool.name,
      message: hookDenyReason,
    })
  }
  const hookUpdatedInput = lastHookUpdatedInput(preToolHooks)
  if (hookUpdatedInput !== undefined) {
    resolvedInput = hookUpdatedInput
  }

  const parsed = tool.inputSchema.safeParse(resolvedInput)
  if (!parsed.success) {
    let message = [
      `Invalid input for tool ${tool.name}.`,
      z.prettifyError(parsed.error),
      `Return a corrected ${tool.name} tool call with all required fields.`,
    ].join('\n')
    const failureHooks = await executeRuntimeHooks(
      'PostToolUseFailure',
      {
        toolUseId: toolCall.id,
        toolName: tool.name,
        toolRisk: tool.risk,
        toolInput: resolvedInput,
        success: false,
        output: {
          code: 'INVALID_TOOL_INPUT',
          message,
          input: resolvedInput,
        },
        errorCode: 'INVALID_TOOL_INPUT',
        errorMessage: message,
      },
      {
        sessionId: runtimeOptions.sessionId,
        cwd: runtimeOptions.cwd,
        role: runtimeOptions.role,
        signal: runtimeOptions.signal,
      },
      { config: runtimeOptions.hooks, hooks: runtimeOptions.runtimeHooks },
    )
    for (const hookEvent of failureHooks.events) yield hookEvent
    message = mergeHookRetryHints(message, failureHooks)
    yield {
      type: 'tool_completed',
      ...eventBase(runtimeOptions.sessionId),
      toolUseId: toolCall.id,
      name: tool.name,
      success: false,
      output: {
        code: 'INVALID_TOOL_INPUT',
        message,
        input: resolvedInput,
      },
    }
    return {
      kind: 'continue',
      toolResult: {
        type: 'tool_result',
        toolUseId: toolCall.id,
        content: message,
        isError: true,
        toolName: tool.name,
      },
    }
  }

  const safetyCheck = checkOptimizerSafety(tool.name, parsed.data, runtimeOptions.role)
  if (!safetyCheck.allowed) {
    const message = safetyCheck.reason!
    yield {
      type: 'tool_denied',
      ...eventBase(runtimeOptions.sessionId),
      name: tool.name,
      risk: tool.risk,
      message,
      denialKind: 'optimizer_safety',
      recoverable: true,
    }
    return recoverableDeniedToolResult({
      toolUseId: toolCall.id,
      toolName: tool.name,
      message,
    })
  }

  const scopeBoundary = options.taskScope
    ? classifyToolScopeBoundary({
      taskScope: options.taskScope,
      toolUseId: toolCall.id,
      toolName: tool.name,
      toolInput: parsed.data,
    })
    : undefined

  if (scopeBoundary && !runtimeOptions.skipPermissionCheck) {
    const approved = yield* requestScopeBoundaryPermission({
      runtimeOptions,
      storage: options.storage,
      tool,
      toolUseId: toolCall.id,
      toolInput: parsed.data,
      boundary: scopeBoundary,
    })
    if (!approved) {
      const denyMessage = scopeBoundary.reason
      yield {
        type: 'tool_denied',
        ...eventBase(runtimeOptions.sessionId),
        name: tool.name,
        risk: tool.risk,
        message: denyMessage,
        denialKind: 'permission',
        recoverable: true,
      }
      return recoverableDeniedToolResult({
        toolUseId: toolCall.id,
        toolName: tool.name,
        message: denyMessage,
      })
    }
  }

  if ((tool.risk === 'write' || tool.risk === 'execute') && !runtimeOptions.skipPermissionCheck && !scopeBoundary) {
    const { autoApprove, reason } = classifyAction(tool.name, parsed.data, { cwd: runtimeOptions.cwd })
    let approved = autoApprove
    let decisionReason = `Auto-approved: ${reason}`

    if (autoApprove) {
      await options.storage.savePermissionAudit({
        auditId: createId('audit'),
        sessionId: runtimeOptions.sessionId,
        toolUseId: toolCall.id,
        toolName: tool.name,
        toolRisk: tool.risk,
        toolInput: parsed.data,
        decision: 'approved',
        reason: decisionReason,
        timestamp: nowIso(),
      })
    } else {
      const pendingPermission = PendingPermissionRegistry.getInstance().register(
        runtimeOptions.sessionId,
        toolCall.id
      )

      yield {
        type: 'permission_request',
        ...eventBase(runtimeOptions.sessionId),
        toolUseId: toolCall.id,
        name: tool.name,
        input: parsed.data,
        risk: tool.risk,
        message: `Tool ${tool.name} requires user permission to run. Reason: ${reason}`,
        source: tool.source,
      }

      const permissionHooks = await executeRuntimeHooks(
        'PermissionRequest',
        {
          toolUseId: toolCall.id,
          toolName: tool.name,
          toolRisk: tool.risk,
          toolInput: parsed.data,
        },
        {
          sessionId: runtimeOptions.sessionId,
          cwd: runtimeOptions.cwd,
          role: runtimeOptions.role,
          signal: runtimeOptions.signal,
        },
        { config: runtimeOptions.hooks, hooks: runtimeOptions.runtimeHooks },
      )
      for (const hookEvent of permissionHooks.events) yield hookEvent

      const hookDecision = firstHookPermissionDecision(permissionHooks)
      if (hookDecision) {
        PendingPermissionRegistry.getInstance().resolve(runtimeOptions.sessionId, toolCall.id, hookDecision)
      }
      const decision = hookDecision ?? await pendingPermission

      approved = decision.approved
      decisionReason = decision.reason ?? 'User review'

      await options.storage.savePermissionAudit({
        auditId: createId('audit'),
        sessionId: runtimeOptions.sessionId,
        toolUseId: toolCall.id,
        toolName: tool.name,
        toolRisk: tool.risk,
        toolInput: parsed.data,
        decision: approved ? 'approved' : 'denied',
        reason: decisionReason,
        timestamp: nowIso(),
      })

      yield {
        type: 'permission_response',
        ...eventBase(runtimeOptions.sessionId),
        toolUseId: toolCall.id,
        approved,
        reason: decisionReason,
      }
    }

    if (!approved) {
      const denyMessage = decisionReason || `Tool execution denied by user: ${tool.name}`
      yield {
        type: 'tool_denied',
        ...eventBase(runtimeOptions.sessionId),
        name: tool.name,
        risk: tool.risk,
        message: denyMessage,
        denialKind: 'permission',
        terminal: true,
      }
      yield buildRuntimeResultEvent(runtimeOptions.sessionId, false, denyMessage)
      return { kind: 'terminal' }
    }
  }

  metrics.toolCallCount += 1
  const toolStartMs = performance.now()

  if (tool.name === 'Read' && parsed.data && typeof parsed.data === 'object' && 'path' in parsed.data) {
    const readPath = resolve(runtimeOptions.cwd, String((parsed.data as { path: string }).path))
    const cached = readFileCache.get(readPath)
    if (cached) {
      try {
        const stat = lstatSync(readPath)
        const requested = requestedReadCoverage(parsed.data as Record<string, unknown>, stat.size)
        const covered = requested ? findCoveringReadRange(cached, requested) : undefined
        if (stat.mtimeMs === cached.mtime && stat.size === cached.size && requested && covered) {
          metrics.toolRoundtripDurationMs += performance.now() - toolStartMs
          const stubMsg = `File unchanged. The requested byte range ${requested.startByte}-${requested.requestedEndByte} was already returned in full by Read call ${covered.toolUseId}; use that earlier ${covered.completeFile ? 'full-file' : 'range'} result instead of re-reading.`
          yield { type: 'tool_completed', ...eventBase(runtimeOptions.sessionId), toolUseId: toolCall.id, name: tool.name, success: true, output: stubMsg }
          return {
            kind: 'continue',
            toolResult: { type: 'tool_result', toolUseId: toolCall.id, content: stubMsg, isError: false, toolName: tool.name },
          }
        }
      } catch {}
    }
  }

  const result = await executeToolSafely(tool, parsed.data, runtimeOptions, {
    timeout: TOOL_EXECUTION_TIMEOUT_MS,
    toolUseId: toolCall.id,
  })
  metrics.toolRoundtripDurationMs += performance.now() - toolStartMs
  absorbRemoteToolRunnerMetrics(metrics, result.remoteRunner)

  if (tool.name === 'Read' && result.kind === 'result' && result.success && parsed.data && typeof parsed.data === 'object' && 'path' in parsed.data) {
    const readPath = resolve(runtimeOptions.cwd, String((parsed.data as { path: string }).path))
    try {
      const stat = lstatSync(readPath)
      const requested = requestedReadCoverage(parsed.data as Record<string, unknown>, stat.size)
      if (requested) {
        const previous = readFileCache.get(readPath)
        const ranges = previous && previous.mtime === stat.mtimeMs && previous.size === stat.size ? previous.ranges : []
        readFileCache.set(readPath, {
          mtime: stat.mtimeMs,
          size: stat.size,
          ranges: [
            ...ranges,
            {
              startByte: requested.startByte,
              endByte: Math.min(requested.requestedEndByte, stat.size),
              completeFile: requested.startByte === 0 && requested.requestedEndByte >= stat.size && !result.truncated,
              truncated: Boolean(result.truncated),
              mode: readModeFromInput(parsed.data as Record<string, unknown>),
              maxBytes: positiveNumber((parsed.data as Record<string, unknown>).maxBytes) ?? 200_000,
              offset: positiveOrZeroNumber((parsed.data as Record<string, unknown>).offset),
              limit: positiveNumber((parsed.data as Record<string, unknown>).limit),
              byteOffset: positiveOrZeroNumber((parsed.data as Record<string, unknown>).byteOffset),
              byteLimit: positiveNumber((parsed.data as Record<string, unknown>).byteLimit),
              toolUseId: toolCall.id,
              providerVisible: true,
            },
          ],
        })
      }
    } catch {}
  }
  if (result.kind === 'error') {
    yield buildRuntimeErrorEvent({
      sessionId: runtimeOptions.sessionId,
      code: result.code,
      message: result.message,
      details: result.details,
    })
    return { kind: 'terminal' }
  }

  yield {
    type: 'tool_completed',
    ...eventBase(runtimeOptions.sessionId),
    toolUseId: toolCall.id,
    name: tool.name,
    success: result.success,
    output: result.output,
    truncated: result.truncated,
    originalBytes: result.originalBytes,
    remoteRunner: result.remoteRunner,
  }

  const postHookName = result.success ? 'PostToolUse' : 'PostToolUseFailure'
  const postToolHooks = await executeRuntimeHooks(
    postHookName,
    {
      toolUseId: toolCall.id,
      toolName: tool.name,
      toolRisk: tool.risk,
      toolInput: parsed.data,
      success: result.success,
      output: result.output,
      errorCode: result.success ? undefined : 'TOOL_RESULT_FAILED',
      errorMessage: result.success ? undefined : `${tool.name} returned success=false.`,
    },
    {
      sessionId: runtimeOptions.sessionId,
      cwd: runtimeOptions.cwd,
      role: runtimeOptions.role,
      signal: runtimeOptions.signal,
    },
    { config: runtimeOptions.hooks, hooks: runtimeOptions.runtimeHooks },
  )
  for (const hookEvent of postToolHooks.events) yield hookEvent

  const blockContent =
    typeof result.output === 'string'
      ? result.output
      : JSON.stringify(result.output, null, 2)
  const contentWithHints = result.success
    ? blockContent
    : mergeHookRetryHints(blockContent, postToolHooks)
  const finalContent = await replaceLargeToolResult({
    content: contentWithHints,
    toolUseId: toolCall.id,
    toolName: tool.name,
    sessionId: runtimeOptions.sessionId,
    cwd: runtimeOptions.cwd,
  })
  return {
    kind: 'continue',
    toolResult: {
      type: 'tool_result',
      toolUseId: toolCall.id,
      content: finalContent,
      isError: !result.success,
      toolName: tool.name,
    },
  }
}

function requestedReadCoverage(input: Record<string, unknown>, fileSize: number): RequestedReadCoverage | undefined {
  if (input.lineOffset !== undefined || input.lineLimit !== undefined) {
    return undefined
  }
  const maxBytes = positiveNumber(input.maxBytes) ?? 200_000
  const offset = positiveOrZeroNumber(input.byteOffset) ?? positiveOrZeroNumber(input.offset)
  const limit = positiveNumber(input.byteLimit) ?? positiveNumber(input.limit)
  const mode = readModeFromInput(input)
  const startByte = offset ?? 0
  if (startByte > fileSize) {
    return { startByte, requestedEndByte: startByte, requiresFullFile: false, mode }
  }
  if (mode === 'full' && offset === undefined && limit === undefined) {
    return { startByte: 0, requestedEndByte: fileSize, requiresFullFile: true, mode }
  }
  if (limit !== undefined) {
    return {
      startByte,
      requestedEndByte: Math.min(fileSize, startByte + Math.min(limit, maxBytes)),
      requiresFullFile: false,
      mode,
    }
  }
  if (mode === 'preview') {
    return {
      startByte,
      requestedEndByte: Math.min(fileSize, startByte + Math.min(50_000, maxBytes)),
      requiresFullFile: false,
      mode,
    }
  }
  return {
    startByte,
    requestedEndByte: Math.min(fileSize, startByte + maxBytes),
    requiresFullFile: startByte === 0 && maxBytes >= fileSize,
    mode,
  }
}

function findCoveringReadRange(entry: ReadFileCacheEntry, requested: RequestedReadCoverage): ReadFileCacheRange | undefined {
  return entry.ranges.find(range => {
    if (!range.providerVisible || range.truncated) return false
    if (range.mode === 'preview' && requested.mode !== 'preview') return false
    if (requested.requiresFullFile && !range.completeFile) return false
    return range.startByte <= requested.startByte && range.endByte >= requested.requestedEndByte
  })
}

function readModeFromInput(input: Record<string, unknown>): 'auto' | 'full' | 'preview' {
  return input.mode === 'full' || input.mode === 'preview' ? input.mode : 'auto'
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function positiveOrZeroNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
