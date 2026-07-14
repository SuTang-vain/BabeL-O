import { lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import type { ToolResultContentBlock } from '../providers/adapters/ModelAdapter.js'
import { eventBase, type NexusEvent } from '../shared/events.js'
import { createId, nowIso } from '../shared/id.js'
import { PendingPermissionRegistry, type PermissionResolution } from '../shared/session.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { AnyTool, ToolRisk } from '../tools/Tool.js'
import { classifyAction } from './classifier.js'
import type { AuthorizationLevel, UserIntentGuidance } from './intentGuidance.js'
import { deriveBashSuggestedRule, type ToolPolicy } from './LocalCodingRuntime.js'
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
import { defaultProviderSessionRules, type ProviderSessionRules } from './providerSessionRules.js'

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

export function resolveEffectiveToolRisk(tool: AnyTool, input: unknown): ToolRisk {
  return resolveEffectiveToolRiskWithRule(tool, input).risk
}

/**
 * Like {@link resolveEffectiveToolRisk} but additionally returns the
 * classifier `rule` (e.g. `command:sqlite3-not-allowlisted`) when the
 * tool's `riskForInput` returns the rich `{ kind, rule }` shape. Used
 * by deny code paths so the model-visible message can explain WHY the
 * tool was rejected (Bug 1.2 fix, 2026-06-20).
 */
export function resolveEffectiveToolRiskWithRule(
  tool: AnyTool,
  input: unknown,
): { risk: ToolRisk; rule?: string } {
  if (typeof tool.riskForInput === 'function') {
    try {
      const result = tool.riskForInput(input)
      if (typeof result === 'string') return { risk: result }
      if (result && typeof result === 'object' && 'kind' in result) {
        return { risk: result.kind, rule: result.rule }
      }
      return { risk: tool.risk }
    } catch {
      return { risk: tool.risk }
    }
  }
  return { risk: tool.risk }
}

type RequestedReadCoverage = {
  startByte: number
  requestedEndByte: number
  requiresFullFile: boolean
  mode: 'auto' | 'full' | 'preview'
}

export function resetProviderSessionRulesForTest(): void {
  defaultProviderSessionRules.clear()
}

function providerSuggestedRule(tool: AnyTool, input: unknown): string | undefined {
  return tool.suggestedAllowRule ?? (tool.name === 'Bash' ? deriveBashSuggestedRule(input) : undefined)
}

function shouldPersistProviderSessionRule(decision: PermissionResolution): decision is PermissionResolution & { rule: string } {
  return decision.approved &&
    (decision.scope === 'session' || decision.scope === 'rule') &&
    typeof decision.rule === 'string' &&
    decision.rule.length > 0
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

type TurnToolAuthorizationDecision =
  | { action: 'allow' }
  | {
    action: 'deny_recoverable'
    requiredAuthorizationLevel: AuthorizationLevel
    reason: string
    suggestedUserWording: string
  }
  | {
    action: 'require_permission'
    requiredAuthorizationLevel: AuthorizationLevel
    reason: string
    suggestedUserWording: string
  }

function authorizeToolForTurn(options: {
  guidance?: UserIntentGuidance
  toolName: string
  toolInput: unknown
  effectiveRisk: ToolRisk
}): TurnToolAuthorizationDecision {
  const authorization = options.guidance?.authorization
  if (!authorization) return { action: 'allow' }

  const level = authorization.level
  const impact = classifyToolAuthorizationImpact(options.toolName, options.toolInput, options.effectiveRisk)

  if (level === 'destructive') {
    if (impact === 'destructive') {
      return {
        action: 'require_permission',
        requiredAuthorizationLevel: 'destructive',
        reason: 'Destructive operation requires exact-target confirmation even when requested.',
        suggestedUserWording: 'Please confirm the exact destructive target before continuing.',
      }
    }
    return { action: 'allow' }
  }

  if (impact === 'destructive') {
    return {
      action: 'deny_recoverable',
      requiredAuthorizationLevel: 'destructive',
      reason: `Turn authorization is ${level}; destructive tool use is not authorized.`,
      suggestedUserWording: 'Please explicitly confirm the destructive target before I run this.',
    }
  }

  if (level === 'shared_change') {
    return { action: 'allow' }
  }

  if (impact === 'shared_change') {
    return {
      action: 'deny_recoverable',
      requiredAuthorizationLevel: 'shared_change',
      reason: `Turn authorization is ${level}; shared or remote side effects are not authorized.`,
      suggestedUserWording: 'Please explicitly ask me to push, release, merge, or create/close the PR.',
    }
  }

  if (level === 'none' && options.effectiveRisk !== 'read') {
    return {
      action: 'deny_recoverable',
      requiredAuthorizationLevel: 'local_change',
      reason: 'The latest user turn did not authorize tool-backed mutation or execution.',
      suggestedUserWording: 'Please say that you want me to apply this change before I edit or run mutating commands.',
    }
  }

  if (level === 'inspect' && options.effectiveRisk !== 'read') {
    if (options.toolName === 'Bash') return { action: 'allow' }
    return {
      action: 'deny_recoverable',
      requiredAuthorizationLevel: 'local_change',
      reason: 'Turn authorization is inspect; only read-only tools are authorized.',
      suggestedUserWording: 'Please ask me to make the local change if you want me to edit or run mutating commands.',
    }
  }

  if (level === 'local_change') {
    return { action: 'allow' }
  }

  if (impact === 'local_change') {
    if (options.toolName === 'Bash') return { action: 'allow' }
    return {
      action: 'deny_recoverable',
      requiredAuthorizationLevel: 'local_change',
      reason: `Turn authorization is ${level}; local file or command mutation is not authorized.`,
      suggestedUserWording: 'Please explicitly authorize the local change before I edit files or run mutating commands.',
    }
  }

  return { action: 'allow' }
}

function classifyToolAuthorizationImpact(
  toolName: string,
  toolInput: unknown,
  effectiveRisk: ToolRisk,
): 'read' | 'local_change' | 'shared_change' | 'destructive' {
  if (effectiveRisk === 'read') return 'read'
  if (toolName === 'Bash') {
    const command = getBashCommand(toolInput)
    if (command && isDestructiveCommand(command)) return 'destructive'
    if (command && isSharedChangeCommand(command)) return 'shared_change'
    if (command && isLocalMutationCommand(command)) return 'local_change'
    return 'read'
  }
  if (toolName === 'Task') return 'local_change'
  if (effectiveRisk === 'write' || effectiveRisk === 'execute' || effectiveRisk === 'task') return 'local_change'
  return 'read'
}

function getBashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('command' in input)) return undefined
  const command = (input as { command: unknown }).command
  return typeof command === 'string' ? command : undefined
}

function isSharedChangeCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?push(?:\s|$)/iu.test(command) ||
    /(?:^|[;&|]\s*)npm\s+publish(?:\s|$)/iu.test(command) ||
    /(?:^|[;&|]\s*)gh\s+release(?:\s|$)/iu.test(command) ||
    /(?:^|[;&|]\s*)gh\s+pr\s+(?:merge|close|create)(?:\s|$)/iu.test(command) ||
    /(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?(?:merge|checkout)\s+(?:main|master|develop)(?:\s|$)/iu.test(command) ||
    /\brelease\b/iu.test(command)
}

function isLocalMutationCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?(?:commit|add|checkout\s+-b|switch\s+-c|branch|stash|tag)(?:\s|$)/iu.test(command) ||
    /(?:^|[;&|]\s*)npm\s+(?:install|i|ci|update|link|unlink)(?:\s|$)/iu.test(command) ||
    /(?:^|[;&|]\s*)(?:pnpm|yarn)\s+(?:install|add|remove|update|link|unlink)(?:\s|$)/iu.test(command) ||
    /(?:^|[;&|]\s*)(?:touch|mkdir|mv|cp|chmod|chown)(?:\s|$)/iu.test(command) ||
    /(?:>|>>)\s*\S+/u.test(command)
}

function isDestructiveCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)rm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r|r|f)[^\s]*(?:\s|$)/iu.test(command) ||
    /(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?reset\s+--hard(?:\s|$)/iu.test(command) ||
    /(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?branch\s+-D(?:\s|$)/iu.test(command) ||
    /(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?push\s+--force(?:\s|$)/iu.test(command) ||
    /\b(?:delete|overwrite)\b/iu.test(command) ||
    /(删除|移除|覆盖|强制删除|清空|重置)/u.test(command)
}

async function* requestScopeBoundaryPermission(options: {
  runtimeOptions: RuntimeExecuteOptions
  storage: NexusStorage
  tool: AnyTool
  toolUseId: string
  toolInput: unknown
  risk: ToolRisk
  boundary: ToolScopeBoundary
  suggestedRule?: string
  providerSessionRules: ProviderSessionRules
}): AsyncGenerator<NexusEvent, boolean> {
  const { runtimeOptions, tool, toolUseId, toolInput, risk, boundary, suggestedRule } = options
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
    risk,
    message: `Tool ${tool.name} crosses the current task scope. ${boundary.reason}`,
    ...(suggestedRule && { suggestedRule }),
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
      toolRisk: risk,
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
  if (shouldPersistProviderSessionRule(decision)) {
    options.providerSessionRules.addRule(runtimeOptions.sessionId, decision.rule)
  }

  await options.storage.savePermissionAudit({
    auditId: createId('audit'),
    sessionId: runtimeOptions.sessionId,
    toolUseId,
    toolName: tool.name,
    toolRisk: risk,
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
  providerSessionRules?: ProviderSessionRules
  userIntentGuidance?: UserIntentGuidance
}): AsyncGenerator<NexusEvent, ProviderToolCallExecutionOutcome> {
  const { toolCall, runtimeOptions, metrics, readFileCache } = options
  const providerSessionRules = options.providerSessionRules ?? defaultProviderSessionRules
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

  let parsed = tool.inputSchema.safeParse(resolvedInput)
  if (!parsed.success) {
    yield {
      type: 'tool_started',
      ...eventBase(runtimeOptions.sessionId),
      toolUseId: toolCall.id,
      name: tool.name,
      input: resolvedInput,
    }
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

  let toolInput = parsed.data
  let { risk: effectiveRisk, rule: classifierRule } = resolveEffectiveToolRiskWithRule(tool, toolInput)

  yield {
    type: 'tool_started',
    ...eventBase(runtimeOptions.sessionId),
    toolUseId: toolCall.id,
    name: tool.name,
    input: toolInput,
    ...(effectiveRisk !== tool.risk && { effectiveRisk }),
  }

  let policyAllowed = options.toolPolicy.isAllowed(tool, toolInput) ||
    providerSessionRules.isAllowed(runtimeOptions.sessionId, tool, toolInput)

  if (
    effectiveRisk !== 'read' &&
    !policyAllowed &&
    runtimeOptions.policyMode !== 'soft-deny'
  ) {
    const ruleSuffix = classifierRule ? ` (classifier: ${classifierRule})` : ''
    const message = `Tool denied by Nexus policy: ${tool.name}${ruleSuffix}`
    yield {
      type: 'tool_denied',
      ...eventBase(runtimeOptions.sessionId),
      toolUseId: toolCall.id,
      name: tool.name,
      risk: effectiveRisk,
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
      toolRisk: effectiveRisk,
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
  for (const hookEvent of preToolHooks.events) yield hookEvent
  const hookDenyReason = firstHookDenyReason(preToolHooks)
  if (hookDenyReason) {
    yield {
      type: 'tool_denied',
      ...eventBase(runtimeOptions.sessionId),
      toolUseId: toolCall.id,
      name: tool.name,
      risk: effectiveRisk,
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
    parsed = tool.inputSchema.safeParse(resolvedInput)
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
          toolRisk: effectiveRisk,
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
    toolInput = parsed.data
    {
      const recomputed = resolveEffectiveToolRiskWithRule(tool, toolInput)
      effectiveRisk = recomputed.risk
      classifierRule = recomputed.rule
    }
    policyAllowed = options.toolPolicy.isAllowed(tool, toolInput) ||
      providerSessionRules.isAllowed(runtimeOptions.sessionId, tool, toolInput)
    if (
      effectiveRisk !== 'read' &&
      !policyAllowed &&
      runtimeOptions.policyMode !== 'soft-deny'
    ) {
      const ruleSuffix = classifierRule ? ` (classifier: ${classifierRule})` : ''
      const message = `Tool denied by Nexus policy: ${tool.name}${ruleSuffix}`
      yield {
        type: 'tool_denied',
        ...eventBase(runtimeOptions.sessionId),
        toolUseId: toolCall.id,
        name: tool.name,
        risk: effectiveRisk,
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
  }

  const safetyCheck = checkOptimizerSafety(tool.name, toolInput, runtimeOptions.role)
  if (!safetyCheck.allowed) {
    const message = safetyCheck.reason!
    yield {
      type: 'tool_denied',
      ...eventBase(runtimeOptions.sessionId),
      toolUseId: toolCall.id,
      name: tool.name,
      risk: effectiveRisk,
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

  const suggestedRule = providerSuggestedRule(tool, toolInput)
  const authorizationDecision = authorizeToolForTurn({
    guidance: options.userIntentGuidance,
    toolName: tool.name,
    toolInput,
    effectiveRisk,
  })
  if (authorizationDecision.action === 'deny_recoverable') {
    const authorization = options.userIntentGuidance?.authorization
    const message = `${authorizationDecision.reason} Required authorization: ${authorizationDecision.requiredAuthorizationLevel}.`
    yield {
      type: 'tool_denied',
      ...eventBase(runtimeOptions.sessionId),
      toolUseId: toolCall.id,
      name: tool.name,
      risk: effectiveRisk,
      message,
      denialKind: 'policy',
      ...(authorization && {
        authorizationLevel: authorization.level,
        consentScope: authorization.consentScope,
        authorizationReason: authorization.reason,
      }),
      requiredAuthorizationLevel: authorizationDecision.requiredAuthorizationLevel,
      suggestedUserWording: authorizationDecision.suggestedUserWording,
      recoverable: true,
    }
    return recoverableDeniedToolResult({
      toolUseId: toolCall.id,
      toolName: tool.name,
      message: authorization
        ? `${message}\nAuthorization level: ${authorization.level}. Consent scope: ${authorization.consentScope}.`
        : message,
    })
  }
  const scopeBoundary = options.taskScope
    ? classifyToolScopeBoundary({
      taskScope: options.taskScope,
      toolUseId: toolCall.id,
      toolName: tool.name,
      toolInput,
    })
    : undefined

  if (scopeBoundary && !runtimeOptions.skipPermissionCheck) {
    const approved = yield* requestScopeBoundaryPermission({
      runtimeOptions,
      storage: options.storage,
      tool,
      toolUseId: toolCall.id,
      toolInput,
      risk: effectiveRisk,
      boundary: scopeBoundary,
      suggestedRule,
      providerSessionRules,
    })
    if (!approved) {
      const denyMessage = scopeBoundary.reason
      yield {
        type: 'tool_denied',
        ...eventBase(runtimeOptions.sessionId),
        toolUseId: toolCall.id,
        name: tool.name,
        risk: effectiveRisk,
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

  if ((effectiveRisk === 'write' || effectiveRisk === 'execute' || authorizationDecision.action === 'require_permission') && !runtimeOptions.skipPermissionCheck && !scopeBoundary) {
    const { autoApprove, reason } = classifyAction(tool.name, toolInput, { cwd: runtimeOptions.cwd })
    const sessionRuleApproved = providerSessionRules.isAllowed(runtimeOptions.sessionId, tool, toolInput)
    const requiresTurnAuthorizationPermission = authorizationDecision.action === 'require_permission'
    let approved = requiresTurnAuthorizationPermission ? false : autoApprove || sessionRuleApproved
    let decisionReason = sessionRuleApproved
      ? 'Approved by session rule'
      : requiresTurnAuthorizationPermission
        ? authorizationDecision.reason
        : `Auto-approved: ${reason}`

    let permissionDecision: PermissionResolution | undefined

    if (approved) {
      await options.storage.savePermissionAudit({
        auditId: createId('audit'),
        sessionId: runtimeOptions.sessionId,
        toolUseId: toolCall.id,
        toolName: tool.name,
        toolRisk: effectiveRisk,
        toolInput,
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
        input: toolInput,
        risk: effectiveRisk,
        message: `Tool ${tool.name} requires user permission to run. Reason: ${requiresTurnAuthorizationPermission ? authorizationDecision.reason : reason}`,
        ...(suggestedRule && { suggestedRule }),
        ...(requiresTurnAuthorizationPermission && options.userIntentGuidance?.authorization && {
          authorizationLevel: options.userIntentGuidance.authorization.level,
          requiredAuthorizationLevel: authorizationDecision.requiredAuthorizationLevel,
          consentScope: options.userIntentGuidance.authorization.consentScope,
          authorizationReason: options.userIntentGuidance.authorization.reason,
          suggestedUserWording: authorizationDecision.suggestedUserWording,
        }),
        source: tool.source,
      }

      const permissionHooks = await executeRuntimeHooks(
        'PermissionRequest',
        {
          toolUseId: toolCall.id,
          toolName: tool.name,
          toolRisk: effectiveRisk,
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
        PendingPermissionRegistry.getInstance().resolve(runtimeOptions.sessionId, toolCall.id, hookDecision)
      }
      const decision = hookDecision ?? await pendingPermission
      permissionDecision = decision

      approved = decision.approved
      decisionReason = decision.reason ?? 'User review'
      if (shouldPersistProviderSessionRule(decision)) {
        providerSessionRules.addRule(runtimeOptions.sessionId, decision.rule)
      }

      await options.storage.savePermissionAudit({
        auditId: createId('audit'),
        sessionId: runtimeOptions.sessionId,
        toolUseId: toolCall.id,
        toolName: tool.name,
        toolRisk: effectiveRisk,
        toolInput,
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
        ...(decision.scope && { scope: decision.scope }),
        ...(decision.rule && { rule: decision.rule }),
        ...(decision.feedback && { feedback: decision.feedback }),
      }
    }

    if (!approved) {
      const denyMessage = decisionReason || `Tool execution denied by user: ${tool.name}`
      const recoverableMessage = permissionDecision?.feedback
        ? `${denyMessage}\nUser feedback: ${permissionDecision.feedback}`
        : denyMessage
      yield {
        type: 'tool_denied',
        ...eventBase(runtimeOptions.sessionId),
        toolUseId: toolCall.id,
        name: tool.name,
        risk: effectiveRisk,
        message: recoverableMessage,
        denialKind: 'permission',
        recoverable: true,
      }
      return recoverableDeniedToolResult({
        toolUseId: toolCall.id,
        toolName: tool.name,
        message: recoverableMessage,
      })
    }
  }

  metrics.toolCallCount += 1
  const toolStartMs = performance.now()

  if (tool.name === 'Read' && toolInput && typeof toolInput === 'object' && 'path' in toolInput) {
    const readPath = resolve(runtimeOptions.cwd, String((toolInput as { path: string }).path))
    const cached = readFileCache.get(readPath)
    if (cached) {
      try {
        const stat = lstatSync(readPath)
        const requested = requestedReadCoverage(toolInput as Record<string, unknown>, stat.size)
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

  // Phase C2 (cwd-drift plan §11): defensive merge before executeToolSafely.
  // executeToolSafely builds ToolContext from RuntimeExecuteOptions.storage,
  // so context tools (contextSearch / contextRecent) return
  // CONTEXT_STORAGE_UNAVAILABLE when that field is unset — even though this
  // function received storage as a side-channel (used above for permission
  // audit / scope persistence). Merge the side-channel storage into the
  // options passed to executeToolSafely so ToolContext.storage is non-null.
  // The LLMCodingRuntime.runExecuteStreamInner injection covers the normal
  // path; this merge is the defense-in-depth for any caller that reaches
  // executeProviderToolCall without having normalized runtimeOptions.storage.
  const toolRuntimeOptions = runtimeOptions.storage
    ? runtimeOptions
    : { ...runtimeOptions, storage: options.storage }

  const result = await executeToolSafely(tool, toolInput, toolRuntimeOptions, {
    timeout: TOOL_EXECUTION_TIMEOUT_MS,
    toolUseId: toolCall.id,
  })
  metrics.toolRoundtripDurationMs += performance.now() - toolStartMs
  absorbRemoteToolRunnerMetrics(metrics, result.remoteRunner)

  if (tool.name === 'Read' && result.kind === 'result' && result.success && toolInput && typeof toolInput === 'object' && 'path' in toolInput) {
    const readPath = resolve(runtimeOptions.cwd, String((toolInput as { path: string }).path))
    try {
      const stat = lstatSync(readPath)
      const requested = requestedReadCoverage(toolInput as Record<string, unknown>, stat.size)
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
              mode: readModeFromInput(toolInput as Record<string, unknown>),
              maxBytes: positiveNumber((toolInput as Record<string, unknown>).maxBytes) ?? 200_000,
              offset: positiveOrZeroNumber((toolInput as Record<string, unknown>).offset),
              limit: positiveNumber((toolInput as Record<string, unknown>).limit),
              byteOffset: positiveOrZeroNumber((toolInput as Record<string, unknown>).byteOffset),
              byteLimit: positiveNumber((toolInput as Record<string, unknown>).byteLimit),
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

  // §3.1.2 AskUserQuestion pending_question interception.
  // When the AskUserQuestion tool returns `{ status: 'pending_question' }`,
  // the runtime emits the ask_user_question event with the real toolUseId,
  // waits for the user's response via the question-response HTTP endpoint
  // (which writes ask_user_question_response to storage), then replaces
  // the tool output with the user's selection before continuing the provider
  // loop. Without this interception the model receives the raw
  // pending_question output and never sees the user's answer.
  let finalOutput: unknown = result.output
  if (
    result.success &&
    tool.name === 'AskUserQuestion' &&
    finalOutput !== null &&
    typeof finalOutput === 'object' &&
    (finalOutput as Record<string, unknown>).status === 'pending_question'
  ) {
    const pendingOutput = finalOutput as Record<string, unknown>
    // Emit the ask_user_question event with the real toolUseId so
    // the Go TUI (or any WebSocket consumer) receives the question
    // and opens the selection dialog.
    const askEvent = {
      type: 'ask_user_question' as const,
      ...eventBase(runtimeOptions.sessionId),
      toolUseId: toolCall.id,
      question: String(pendingOutput.question ?? ''),
      ...(pendingOutput.header ? { header: String(pendingOutput.header) } : {}),
      options: (pendingOutput.options as Array<{ label: string; description?: string }>) ?? [],
      multiSelect: Boolean(pendingOutput.multiSelect),
    }
    yield askEvent

    // Wait for the user's response. Poll storage until we find a
    // matching ask_user_question_response event, or abort/timeout.
    const response = await waitForQuestionResponse({
      storage: options.storage,
      sessionId: runtimeOptions.sessionId,
      toolUseId: toolCall.id,
      timeoutSignal: runtimeOptions.timeoutSignal,
      signal: runtimeOptions.signal,
    })

    if (response === null) {
      // Timed out or cancelled — return a terminal error.
      const cancelled = runtimeOptions.signal?.aborted || runtimeOptions.timeoutSignal?.aborted
      yield buildRuntimeErrorEvent({
        sessionId: runtimeOptions.sessionId,
        code: cancelled ? 'REQUEST_CANCELLED' : 'QUESTION_TIMEOUT',
        message: cancelled
          ? 'Question cancelled while waiting for user response.'
          : `Timed out waiting for user response to question about "${String(pendingOutput.question ?? '').slice(0, 60)}".`,
      })
      return { kind: 'terminal' }
    }

    // Replace the tool output with the user's selection so it becomes
    // the provider-visible tool_result.
    finalOutput = {
      status: 'answered',
      selectedIndices: response.selectedIndices,
      selectedLabels: response.selectedLabels,
      question: pendingOutput.question,
    }
  }

  yield {
    type: 'tool_completed',
    ...eventBase(runtimeOptions.sessionId),
    toolUseId: toolCall.id,
    name: tool.name,
    success: result.success,
    output: finalOutput,
    truncated: result.truncated,
    originalBytes: result.originalBytes,
    remoteRunner: result.remoteRunner,
  }

  // TaskCreate real-time notification: the tool persists the task via
  // storage.saveTask() but no longer calls storage.appendEvent() for
  // task_created. The runtime yields task_created here so that
  // processRuntimeExecutionEvent handles both storage persistence and
  // WebSocket broadcast in a single path. The Go TUI relies on
  // WebSocket task_created events for real-time task-board updates
  // (mid-turn, before the end-of-turn REST poll).
  if (
    result.success &&
    tool.name === 'TaskCreate' &&
    finalOutput !== null &&
    typeof finalOutput === 'object'
  ) {
    const taskOutput = finalOutput as Record<string, unknown>
    if (typeof taskOutput.taskId === 'string' && typeof taskOutput.title === 'string') {
      yield {
        type: 'task_created',
        ...eventBase(runtimeOptions.sessionId),
        taskId: taskOutput.taskId,
        title: taskOutput.title,
      }
    }
  }

  // TaskUpdate real-time notification: emit a task_updated event so
  // WebSocket consumers (Go TUI, loop driver, etc.) receive the status
  // change in real time without waiting for an end-of-turn HTTP poll.
  if (
    result.success &&
    tool.name === 'TaskUpdate' &&
    finalOutput !== null &&
    typeof finalOutput === 'object'
  ) {
    const taskOutput = finalOutput as Record<string, unknown>
    if (typeof taskOutput.taskId === 'string' && typeof taskOutput.title === 'string') {
      yield {
        type: 'task_updated',
        ...eventBase(runtimeOptions.sessionId),
        taskId: taskOutput.taskId,
        title: taskOutput.title,
        status:
          typeof taskOutput.status === 'string'
            ? (taskOutput.status as 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'cancelled')
            : undefined,
      }
    }
  }

  const postHookName = result.success ? 'PostToolUse' : 'PostToolUseFailure'
  const postToolHooks = await executeRuntimeHooks(
    postHookName,
    {
      toolUseId: toolCall.id,
      toolName: tool.name,
      toolRisk: effectiveRisk,
      toolInput,
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

// ─── §3.1.2 AskUserQuestion response waiter ──────────────────────
//
// Polls storage for a matching ask_user_question_response event.
// Returns the user's selection or null if the operation was cancelled
// or timed out. The caller (executeProviderToolCall) uses null to
// decide between a terminal error or a recoverable tool_denied.

type QuestionResponse = {
  selectedIndices: number[]
  selectedLabels: string[]
}

const QUESTION_RESPONSE_POLL_MS = 250
const QUESTION_RESPONSE_MAX_WAIT_MS = 180_000

async function waitForQuestionResponse(params: {
  storage: NexusStorage
  sessionId: string
  toolUseId: string
  timeoutSignal?: AbortSignal
  signal?: AbortSignal
}): Promise<QuestionResponse | null> {
  const { storage, sessionId, toolUseId, timeoutSignal, signal } = params
  const deadlineMs = Date.now() + QUESTION_RESPONSE_MAX_WAIT_MS

  // Resolve immediately if the request was already cancelled before
  // we even start polling.
  if (signal?.aborted || timeoutSignal?.aborted) return null

  while (Date.now() < deadlineMs) {
    if (signal?.aborted || timeoutSignal?.aborted) return null

    try {
      const result = await storage.listEvents(sessionId, {
        limit: 20,
        order: 'desc',
        eventTypes: ['ask_user_question_response'],
      })
      for (const event of result.events) {
        if (
          event.type === 'ask_user_question_response' &&
          event.toolUseId === toolUseId
        ) {
          return {
            selectedIndices: event.selectedIndices,
            selectedLabels: event.selectedLabels,
          }
        }
      }
    } catch {
      // Storage errors are non-fatal; retry on the next poll.
    }

    // Wait before the next poll, respecting cancellation signals.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, QUESTION_RESPONSE_POLL_MS)
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timeoutSignal?.addEventListener('abort', onAbort, { once: true })
      // Cleanup to avoid leaking listeners when the timeout fires
      // normally (no abort).
      timer.unref?.()
    })

    if (signal?.aborted || timeoutSignal?.aborted) return null
  }

  return null
}
