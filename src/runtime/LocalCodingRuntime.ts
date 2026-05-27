import { z } from 'zod'
import { performance } from 'node:perf_hooks'
import { errorMessage } from '../shared/errors.js'
import { eventBase, type NexusEvent } from '../shared/events.js'
import { createId, nowIso } from '../shared/id.js'
import type { AnyTool } from '../tools/Tool.js'
import { truncateToolOutput } from '../tools/output.js'
import {
  formatWorkspacePathError,
  isWorkspacePathError,
} from '../tools/builtin/pathSafety.js'
import type {
  NexusRuntime,
  RuntimeExecuteOptions,
  RuntimeToolAuditEntry,
} from './Runtime.js'
import { checkOptimizerSafety } from './safetyCheck.js'
import { PendingPermissionRegistry } from '../shared/session.js'
import { classifyAction } from './classifier.js'
import type { NexusStorage } from '../storage/Storage.js'
import {
  executeRuntimeHooks,
  firstHookDenyReason,
  firstHookPermissionDecision,
  lastHookUpdatedInput,
} from './hooks.js'


type ParsedIntent =
  | { kind: 'tool'; toolName: string; input: unknown }
  | { kind: 'text'; text: string }

export type ToolPolicy = {
  isAllowed(tool: AnyTool): boolean
  describe(): { mode: 'allow_all' | 'allowlist'; allowedTools?: string[] }
}

export class LocalCodingRuntime implements NexusRuntime {
  constructor(
    private readonly tools: Map<string, AnyTool>,
    private toolPolicy: ToolPolicy = allowAllTools(),
    private readonly storage?: NexusStorage,
  ) {}

  listTools(): RuntimeToolAuditEntry[] {
    return [...this.tools.values()]
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        allowed: this.toolPolicy.isAllowed(tool),
        inputSchema: tool.modelInputSchema ?? z.toJSONSchema(tool.inputSchema),
        source: tool.source ?? { type: 'builtin' as const },
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  withToolPolicy<T>(toolPolicy: ToolPolicy, fn: () => T): T {
    const previousPolicy = this.toolPolicy
    this.toolPolicy = toolPolicy
    try {
      return fn()
    } finally {
      this.toolPolicy = previousPolicy
    }
  }

  async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    yield {
      type: 'session_started',
      ...eventBase(options.sessionId),
      cwd: options.cwd,
      requestId: options.requestId,
      model: options.model,
      budget: options.budget,
    }

    const executionStartMs = performance.now()
    let toolCallCount = 0
    let totalToolDurationMs = 0

    for await (const event of this._executeInner(options, (duration) => {
      toolCallCount += 1
      totalToolDurationMs += duration
    })) {
      yield event
    }

    yield {
      type: 'execution_metrics',
      ...eventBase(options.sessionId),
      requestId: options.requestId,
      executeDurationMs: performance.now() - executionStartMs,
      toolCallCount,
      toolRoundtripDurationMs: totalToolDurationMs,
    }
  }

  private async *_executeInner(
    options: RuntimeExecuteOptions,
    recordToolRun: (duration: number) => void,
  ): AsyncIterable<NexusEvent> {
    try {
      const intent = parseIntent(options.prompt)
      if (intent.kind === 'text') {
        yield {
          type: 'assistant_delta',
          ...eventBase(options.sessionId),
          text: intent.text,
        }
        yield {
          type: 'result',
          ...eventBase(options.sessionId),
          success: true,
          message: intent.text,
        }
        return
      }

      const tool = this.tools.get(intent.toolName)
      if (!tool) {
        yield {
          type: 'error',
          ...eventBase(options.sessionId),
          code: 'TOOL_NOT_FOUND',
          message: `Tool not found: ${intent.toolName}`,
        }
        return
      }

      if (!this.toolPolicy.isAllowed(tool)) {
        const message = `Tool denied by Nexus policy: ${tool.name}`
        yield {
          type: 'tool_denied',
          ...eventBase(options.sessionId),
          name: tool.name,
          risk: tool.risk,
          message,
        }
        yield {
          type: 'result',
          ...eventBase(options.sessionId),
          success: false,
          message,
        }
        return
      }

      const parsed = tool.inputSchema.safeParse(intent.input)
      if (!parsed.success) {
        yield {
          type: 'error',
          ...eventBase(options.sessionId),
          code: 'INVALID_TOOL_INPUT',
          message: z.prettifyError(parsed.error),
        }
        return
      }

      const safetyCheck = checkOptimizerSafety(tool.name, parsed.data, options.role)
      if (!safetyCheck.allowed) {
        const message = safetyCheck.reason!
        yield {
          type: 'tool_denied',
          ...eventBase(options.sessionId),
          name: tool.name,
          risk: tool.risk,
          message,
        }
        yield {
          type: 'result',
          ...eventBase(options.sessionId),
          success: false,
          message,
        }
        return
      }

      const toolUseId = createId('tool')
      yield {
        type: 'tool_started',
        ...eventBase(options.sessionId),
        toolUseId,
        name: tool.name,
        input: parsed.data,
      }

      const preToolHooks = await executeRuntimeHooks(
        'PreToolUse',
        {
          toolUseId,
          toolName: tool.name,
          toolRisk: tool.risk,
          toolInput: parsed.data,
        },
        {
          sessionId: options.sessionId,
          cwd: options.cwd,
          role: options.role,
          signal: options.signal,
        },
      )
      for (const hookEvent of preToolHooks.events) yield hookEvent
      const hookDenyReason = firstHookDenyReason(preToolHooks)
      if (hookDenyReason) {
        yield {
          type: 'tool_denied',
          ...eventBase(options.sessionId),
          name: tool.name,
          risk: tool.risk,
          message: hookDenyReason,
        }
        yield {
          type: 'result',
          ...eventBase(options.sessionId),
          success: false,
          message: hookDenyReason,
        }
        return
      }
      const hookUpdatedInput = lastHookUpdatedInput(preToolHooks)
      const toolInput = hookUpdatedInput === undefined
        ? parsed.data
        : tool.inputSchema.parse(hookUpdatedInput)

      // Check if the tool requires authorization.
      if ((tool.risk === 'write' || tool.risk === 'execute') && !options.skipPermissionCheck) {
        const { autoApprove, reason } = classifyAction(tool.name, toolInput)
        let approved = autoApprove
        let decisionReason = `Auto-approved: ${reason}`

        if (autoApprove) {
          if (this.storage) {
            await this.storage.savePermissionAudit({
              auditId: createId('audit'),
              sessionId: options.sessionId,
              toolUseId,
              toolName: tool.name,
              toolRisk: tool.risk,
              toolInput,
              decision: 'approved',
              reason: decisionReason,
              timestamp: nowIso(),
            })
          }
        } else {
          yield {
            type: 'permission_request',
            ...eventBase(options.sessionId),
            toolUseId,
            name: tool.name,
            input: toolInput,
            risk: tool.risk,
            message: `Tool ${tool.name} requires user permission to run. Reason: ${reason}`,
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
              sessionId: options.sessionId,
              cwd: options.cwd,
              role: options.role,
              signal: options.signal,
            },
          )
          for (const hookEvent of permissionHooks.events) yield hookEvent

          const hookDecision = firstHookPermissionDecision(permissionHooks)
          const decision = hookDecision ?? await PendingPermissionRegistry.getInstance().register(
            options.sessionId,
            toolUseId
          )

          approved = decision.approved
          decisionReason = decision.reason ?? 'User review'

          if (this.storage) {
            await this.storage.savePermissionAudit({
              auditId: createId('audit'),
                sessionId: options.sessionId,
                toolUseId,
                toolName: tool.name,
                toolRisk: tool.risk,
                toolInput,
                decision: approved ? 'approved' : 'denied',
                reason: decisionReason,
                timestamp: nowIso(),
            })
          }

          yield {
            type: 'permission_response',
            ...eventBase(options.sessionId),
            toolUseId,
            approved,
            reason: decisionReason,
          }
        }

        if (!approved) {
          const denyMessage = decisionReason || `Tool execution denied by user: ${tool.name}`
          yield {
            type: 'tool_denied',
            ...eventBase(options.sessionId),
            name: tool.name,
            risk: tool.risk,
            message: denyMessage,
          }
          yield {
            type: 'result',
            ...eventBase(options.sessionId),
            success: false,
            message: denyMessage,
          }
          return
        }
      }

      const toolStartMs = performance.now()
      const result = await executeToolSafely(tool, toolInput, options)
      recordToolRun(performance.now() - toolStartMs)
      if (result.kind === 'error') {
        yield {
          type: 'error',
          ...eventBase(options.sessionId),
          code: result.code,
          message: result.message,
          details: result.details,
        }
        return
      }

      yield {
        type: 'tool_completed',
        ...eventBase(options.sessionId),
        toolUseId,
        name: tool.name,
        success: result.success,
        output: result.output,
        truncated: result.truncated,
        originalBytes: result.originalBytes,
      }

      const postToolHooks = await executeRuntimeHooks(
        result.success ? 'PostToolUse' : 'PostToolUseFailure',
        {
          toolUseId,
          toolName: tool.name,
          toolRisk: tool.risk,
          toolInput,
          success: result.success,
          output: result.output,
          errorCode: result.success ? undefined : 'TOOL_RESULT_FAILED',
          errorMessage: result.success ? undefined : `${tool.name} returned success=false.`,
        },
        {
          sessionId: options.sessionId,
          cwd: options.cwd,
          role: options.role,
          signal: options.signal,
        },
      )
      for (const hookEvent of postToolHooks.events) yield hookEvent

      const summary = result.success
        ? `${tool.name} completed.`
        : `${tool.name} failed.`
      yield {
        type: 'assistant_delta',
        ...eventBase(options.sessionId),
        text: summary,
      }
      yield {
        type: 'result',
        ...eventBase(options.sessionId),
        success: result.success,
        message: summary,
      }
    } catch (err: any) {
      const isTimeout = options.timeoutSignal?.aborted
      const isCancelled = !isTimeout && (options.signal?.aborted || err.message?.includes('Abort') || err.name === 'AbortError')
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: isTimeout ? 'REQUEST_TIMEOUT' : isCancelled ? 'REQUEST_CANCELLED' : 'PROVIDER_ERROR',
        message: isCancelled
          ? 'Execution cancelled by user.'
          : err instanceof Error ? err.message : String(err),
      }
    }
  }
}

async function executeToolSafely(
  tool: AnyTool,
  input: unknown,
  options: RuntimeExecuteOptions,
): Promise<
  | {
      kind: 'result'
      success: boolean
      output: unknown
      truncated?: boolean
      originalBytes?: number
    }
  | { kind: 'error'; code: string; message: string; details?: unknown }
> {
  try {
    const result = await tool.execute(input, {
      cwd: options.cwd,
      sessionId: options.sessionId,
      signal: options.signal,
      maxOutputBytes: options.maxToolOutputBytes ?? 200_000,
      bashMaxBufferBytes: options.bashMaxBufferBytes ?? 1_000_000,
      executionEnvironment: options.executionEnvironment,
    })
    const truncated = truncateToolOutput(
      result.output,
      options.maxToolOutputBytes ?? 200_000,
    )
    return {
      kind: 'result',
      success: result.success,
      output: truncated.value,
      truncated: truncated.truncated || undefined,
      originalBytes: truncated.originalBytes,
    }
  } catch (error) {
    if (options.signal?.aborted) {
      const isTimeout = options.timeoutSignal?.aborted
      return {
        kind: 'error',
        code: isTimeout ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED',
        message: isTimeout
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
      details: normalizeToolErrorDetails(error, options.maxToolOutputBytes ?? 200_000),
    }
  }
}

function normalizeToolErrorDetails(error: unknown, maxBytes: number): unknown {
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

export function allowAllTools(): ToolPolicy {
  return {
    isAllowed() {
      return true
    },
    describe() {
      return { mode: 'allow_all' }
    },
  }
}

export function denyByDefaultTools(): ToolPolicy {
  return {
    isAllowed(tool) {
      return tool.risk === 'read' || tool.risk === 'task'
    },
    describe() {
      return { mode: 'allowlist', allowedTools: ['read', 'grep', 'glob', 'task'] }
    },
  }
}

export function allowlistedTools(allowedTools: Iterable<string>): ToolPolicy {
  const allowed = new Set([...allowedTools].map(normalizeToolName).filter(Boolean))
  return {
    isAllowed(tool) {
      return allowed.has(normalizeToolName(tool.name))
    },
    describe() {
      return { mode: 'allowlist', allowedTools: [...allowed].sort() }
    },
  }
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase()
}

function parseIntent(prompt: string): ParsedIntent {
  const trimmed = prompt.trim()
  const [verb = '', ...rest] = splitCommand(trimmed)
  const arg = rest.join(' ')

  if (verb.includes(':') && arg) {
    try {
      return {
        kind: 'tool',
        toolName: verb,
        input: JSON.parse(arg),
      }
    } catch {
      return {
        kind: 'tool',
        toolName: verb,
        input: {},
      }
    }
  }

  if (verb === 'read' && arg) {
    return { kind: 'tool', toolName: 'Read', input: { path: arg } }
  }
  if (verb === 'write' && rest.length >= 2) {
    const [path, ...content] = rest
    return {
      kind: 'tool',
      toolName: 'Write',
      input: { path, content: content.join(' ') },
    }
  }
  if (verb === 'edit' && rest.length >= 3) {
    const [path, oldString, ...newString] = rest
    return {
      kind: 'tool',
      toolName: 'Edit',
      input: { path, oldString, newString: newString.join(' ') },
    }
  }
  if (verb === 'grep' && arg) {
    return { kind: 'tool', toolName: 'Grep', input: { pattern: arg } }
  }
  if (verb === 'glob' && arg) {
    return { kind: 'tool', toolName: 'Glob', input: { pattern: arg } }
  }
  if (verb === 'bash' && arg) {
    return { kind: 'tool', toolName: 'Bash', input: { command: arg } }
  }
  if (verb === 'task' && arg) {
    return { kind: 'tool', toolName: 'TaskCreate', input: { title: arg } }
  }

  return {
    kind: 'text',
    text:
      `BabeL-O local runtime is active. I can already run explicit coding tools: ` +
      '`read <file>`, `write <file> <text>`, `edit <file> <old> <new>`, ' +
      '`grep <pattern>`, `glob <pattern>`, `bash <command>`, `task <title>`. ' +
      `You said: ${trimmed || '(empty prompt)'}`,
  }
}

function splitCommand(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return matches.map(part => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1)
    }
    return part
  })
}
