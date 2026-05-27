import { setTimeout as delay } from 'node:timers/promises'
import { errorMessage } from '../shared/errors.js'
import { eventBase, type NexusEvent } from '../shared/events.js'
import type { ToolRisk } from '../tools/Tool.js'

export type HookEventName =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'SessionEnd'

export type RuntimeHookContext = {
  sessionId: string
  cwd: string
  role?: string
  signal?: AbortSignal
}

export type RuntimeHookInput = {
  prompt?: string
  toolUseId?: string
  toolName?: string
  toolRisk?: ToolRisk
  toolInput?: unknown
  success?: boolean
  output?: unknown
  errorCode?: string
  errorMessage?: string
  cleanup?: Record<string, unknown>
}

export type RuntimeHookResult = {
  updatedInput?: unknown
  additionalContext?: string
  denyReason?: string
  permissionDecision?: {
    approved: boolean
    reason?: string
  }
  retryHint?: string
  summary?: string
  metadata?: Record<string, unknown>
}

type RuntimeHook = {
  name: string
  events: HookEventName[]
  timeoutMs?: number
  run(input: RuntimeHookInput, context: RuntimeHookContext): Promise<RuntimeHookResult | void> | RuntimeHookResult | void
}

export type HookExecutionResult = {
  events: NexusEvent[]
  results: Array<{ hookName: string; result: RuntimeHookResult }>
}

const DEFAULT_HOOK_TIMEOUT_MS = 1_500

const builtInHooks: RuntimeHook[] = [
  {
    name: 'RecoverInvalidToolInputHook',
    events: ['PostToolUseFailure'],
    run(input) {
      if (input.errorCode !== 'INVALID_TOOL_INPUT' || !input.toolName) return
      return {
        retryHint: [
          `${input.toolName} input did not match its schema.`,
          'Inspect the validation message, then call the same tool again with every required field.',
          'Do not stop the task just because the previous tool input was invalid.',
        ].join(' '),
        metadata: { recoverable: true },
      }
    },
  },
  {
    name: 'BashFailureSummaryHook',
    events: ['PostToolUseFailure'],
    run(input) {
      if (input.toolName !== 'Bash') return
      const output = input.output
      if (!output || typeof output !== 'object') return
      const record = output as Record<string, unknown>
      const exitCode = record.exitCode
      const stderr = firstNonEmptyLine(record.stderr)
      const stdout = firstNonEmptyLine(record.stdout)
      const reason = stderr || stdout
      if (exitCode === undefined && !reason) return
      return {
        summary: `Bash failed${exitCode === undefined ? '' : ` with exit code ${exitCode}`}${reason ? `: ${reason}` : '.'}`,
        retryHint: 'Use the command output to choose the next diagnostic command or adjust the command before retrying.',
      }
    },
  },
  {
    name: 'PermissionExplanationHook',
    events: ['PermissionRequest'],
    run(input) {
      if (!input.toolName || !input.toolRisk) return
      return {
        summary: `${input.toolName} has ${input.toolRisk} risk and requires an explicit approval decision.`,
        metadata: {
          suggestedScopes: ['once', 'session'],
        },
      }
    },
  },
  {
    name: 'SessionCleanupAuditHook',
    events: ['SessionEnd'],
    timeoutMs: 1_500,
    run(input) {
      return {
        summary: 'Session cleanup completed.',
        metadata: input.cleanup,
      }
    },
  },
  {
    name: 'SubagentLifecycleHook',
    events: ['SubagentStart', 'SubagentStop'],
    run(input) {
      const isStart = input.success === undefined
      return {
        summary: isStart
          ? `Subagent started: ${input.toolUseId}`
          : `Subagent ${input.toolUseId} completed with success=${input.success}`,
        metadata: { toolUseId: input.toolUseId, toolInput: input.toolInput },
      }
    },
  },
  {
    name: 'UserPromptAuditHook',
    events: ['UserPromptSubmit'],
    run(input) {
      return {
        summary: 'User prompt received.',
        metadata: { promptPreview: typeof input.prompt === 'string' ? input.prompt.slice(0, 200) : undefined },
      }
    },
  },
]

export async function executeRuntimeHooks(
  hookEvent: HookEventName,
  input: RuntimeHookInput,
  context: RuntimeHookContext,
): Promise<HookExecutionResult> {
  const hooks = builtInHooks.filter(hook => hook.events.includes(hookEvent))
  const events: NexusEvent[] = []
  const results: Array<{ hookName: string; result: RuntimeHookResult }> = []

  for (const hook of hooks) {
    events.push({
      type: 'hook_started',
      ...eventBase(context.sessionId),
      hookName: hook.name,
      hookEvent,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
    })

    try {
      const result = await runHookWithTimeout(hook, input, context)
      const normalized = normalizeHookResult(result)
      if (normalized) {
        results.push({ hookName: hook.name, result: normalized })
      }
      events.push({
        type: 'hook_completed',
        ...eventBase(context.sessionId),
        hookName: hook.name,
        hookEvent,
        toolUseId: input.toolUseId,
        toolName: input.toolName,
        output: normalized,
      })
    } catch (error) {
      events.push({
        type: 'hook_failed',
        ...eventBase(context.sessionId),
        hookName: hook.name,
        hookEvent,
        toolUseId: input.toolUseId,
        toolName: input.toolName,
        message: errorMessage(error),
      })
    }
  }

  return { events, results }
}

export function mergeHookRetryHints(message: string, hookResult: HookExecutionResult): string {
  const hints = hookResult.results
    .map(({ result }) => result.retryHint)
    .filter((hint): hint is string => Boolean(hint?.trim()))
  if (hints.length === 0) return message
  return `${message}\n\nHook retry hints:\n${hints.map(hint => `- ${hint}`).join('\n')}`
}

export function firstHookPermissionDecision(
  hookResult: HookExecutionResult,
): { approved: boolean; reason?: string } | undefined {
  for (const { hookName, result } of hookResult.results) {
    if (!result.permissionDecision) continue
    return {
      approved: result.permissionDecision.approved,
      reason: result.permissionDecision.reason ?? `Permission decided by ${hookName}`,
    }
  }
  return undefined
}

export function firstHookDenyReason(hookResult: HookExecutionResult): string | undefined {
  return hookResult.results.find(({ result }) => result.denyReason)?.result.denyReason
}

export function lastHookUpdatedInput(hookResult: HookExecutionResult): unknown | undefined {
  let updated: unknown
  for (const { result } of hookResult.results) {
    if ('updatedInput' in result) updated = result.updatedInput
  }
  return updated
}

async function runHookWithTimeout(
  hook: RuntimeHook,
  input: RuntimeHookInput,
  context: RuntimeHookContext,
): Promise<RuntimeHookResult | void> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const hookPromise = Promise.resolve(hook.run(input, context))
  const timeoutPromise = delay(timeoutMs, undefined, { signal: context.signal })
    .then(() => {
      throw new Error(`Hook timed out after ${timeoutMs}ms`)
    })
  return Promise.race([hookPromise, timeoutPromise])
}

function normalizeHookResult(result: RuntimeHookResult | void): RuntimeHookResult | undefined {
  if (!result || typeof result !== 'object') return undefined
  return result
}

function firstNonEmptyLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const line = value
    .split(/\r?\n/)
    .map(item => item.trim())
    .find(Boolean)
  if (!line) return undefined
  return line.length > 180 ? `${line.slice(0, 180)}...` : line
}
