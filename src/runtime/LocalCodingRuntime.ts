import { z } from 'zod'
import { eventBase, type NexusEvent } from '../shared/events.js'
import type { RemoteToolRunnerDiagnostics } from '../shared/toolTrace.js'
import { createId, nowIso } from '../shared/id.js'
import type { AnyTool, ToolRisk } from '../tools/Tool.js'
import { classifyBashRisk, tokenizeBashCommand } from '../tools/builtin/bashClassifier.js'
import type { NexusTask } from '../shared/task.js'
import type {
  NexusRuntime,
  RuntimeExecuteOptions,
  RuntimeToolAuditEntry,
} from './Runtime.js'
import { checkOptimizerSafety } from './safetyCheck.js'
import { PendingPermissionRegistry } from '../shared/session.js'
import { classifyAction } from './classifier.js'
import { buildPerRequestAllowedToolsPolicy } from './perRequestPolicy.js'
import type { HooksConfig } from '../shared/config.js'
import type { NexusStorage } from '../storage/Storage.js'
import {
  executeRuntimeHooks,
  firstHookDenyReason,
  firstHookPermissionDecision,
  lastHookUpdatedInput,
} from './hooks.js'
import {
  absorbRemoteToolRunnerMetrics,
  buildRuntimeExecutionMetricsEvent,
  createRuntimeExecutionMetrics,
  parseLocalRuntimeIntent,
} from './runtimePipeline.js'


function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

export type ToolPolicy = {
  /**
   * Per-input policy check. The runtime invokes this at the
   * policy-block gate with the parsed tool input so session-rules
   * policies can substring-match the input. Existing allow-all
   * / allowlist policies ignore the second arg.
   */
  isAllowed(tool: AnyTool, input?: unknown): boolean
  describe(): { mode: 'allow_all' | 'allowlist' | 'session_rules'; allowedTools?: string[] }
}

export class LocalCodingRuntime implements NexusRuntime {
  /**
   * Per-session accumulated allow rules from user
   * `scope: 'session'` approvals. Keyed by sessionId; values are
   * substring patterns matched against the tool input (e.g.
   * `git:status` matches a Bash call with command `git status`).
   * Phase A.1 of the enhanced permission panel. Process-local
   * (lost on server restart — matches the
   * "no persistent permission decision across restarts" boundary).
   */
  private readonly sessionRules = new Map<string, string[]>()

  constructor(
    private readonly tools: Map<string, AnyTool>,
    private toolPolicy: ToolPolicy = allowAllTools(),
    private readonly storage?: NexusStorage,
    private readonly hooks?: HooksConfig,
  ) {}

  listTools(): RuntimeToolAuditEntry[] {
    return [...this.tools.values()]
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        allowed: this.toolPolicy.isAllowed(tool),
        inputSchema: tool.modelInputSchema ?? z.toJSONSchema(tool.inputSchema),
        requiresApproval: tool.requiresApproval ?? (tool.risk === 'write' || tool.risk === 'execute'),
        suggestedAllowRule: tool.suggestedAllowRule ?? tool.name,
        mcpServerAllowed: tool.mcpServerAllowed,
        source: tool.source ?? { type: 'builtin' as const },
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Compute the effective risk for a tool invocation, honouring any
   * per-input risk override (e.g. Bash's read-only subcommand classifier).
   * Falls back to the tool's static `risk` field when no override exists.
   */
  private effectiveRisk(tool: AnyTool, input: unknown): ToolRisk {
    if (typeof tool.riskForInput === 'function') {
      try {
        return tool.riskForInput(input as Parameters<typeof tool.riskForInput>[0])
      } catch {
        return tool.risk
      }
    }
    return tool.risk
  }

  withToolPolicy<T>(toolPolicy: ToolPolicy, fn: () => T): T {
    const previousPolicy = this.toolPolicy
    this.toolPolicy = toolPolicy
    let result: T
    try {
      result = fn()
    } catch (error) {
      this.toolPolicy = previousPolicy
      throw error
    }
    this.toolPolicy = previousPolicy
    if (isAsyncIterable(result)) {
      const iterable = result
      const runtime = this
      return (async function* () {
        const activePolicy = runtime.toolPolicy
        runtime.toolPolicy = toolPolicy
        try {
          for await (const item of iterable) {
            yield item
          }
        } finally {
          runtime.toolPolicy = activePolicy
        }
      })() as T
    }
    return result
  }

  async *executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    // Phase A.1 enhanced permission panel: when the user has
    // accumulated `scope: 'session'` rules for this sessionId,
    // wrap the run with a session-rules policy. The policy
    // allows the tool when one of the accumulated rules is
    // present (as a substring) in the tool's input
    // stringification. Continues to layer with `policyMode`
    // (Phase B) and `allowedTools` (Phase D) — both are applied
    // on top of the server-startup policy; this session-rules
    // policy is applied on top of the Phase D per-turn
    // allowlist, so a session rule auto-allows the tool even if
    // the user didn't pass it explicitly in the current body.
    const sessionRules = this.sessionRules.get(options.sessionId) ?? []
    if (sessionRules.length > 0) {
      const sessionPolicy = buildSessionRulesPolicy(sessionRules)
      yield* this.withToolPolicy(sessionPolicy, () => this.executeStreamWithAllowedTools({
        ...options,
        sessionApprovedRules: sessionRules,
      }))
      return
    }
    yield* this.executeStreamWithAllowedTools(options)
  }

  private async *executeStreamWithAllowedTools(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    // Phase D of docs/nexus/reference/go-tui-permission-policy-governance-plan.md:
    // when the request body carries `allowedTools`, apply a per-turn
    // allowlist-based policy override. The override is scoped to this
    // turn only — the next turn re-evaluates from the (possibly
    // different) body. `policyMode: 'soft-deny'` continues to work
    // orthogonally: allowedTools controls the *policy* (which tools
    // are isAllowed), while policyMode controls whether the
    // policy-block gate fires for tools outside the allowlist.
    if (options.allowedTools && options.allowedTools.length > 0) {
      const overridePolicy = buildPerRequestAllowedToolsPolicy(options.allowedTools)
      yield* this.withToolPolicy(overridePolicy, () => this.runExecuteStreamInner(options))
      return
    }
    yield* this.runExecuteStreamInner(options)
  }

  private async *runExecuteStreamInner(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    if (!options.storage && this.storage) {
      options = { ...options, storage: this.storage }
    }
    if (!options.hooks && this.hooks) {
      options = { ...options, hooks: this.hooks }
    }
    yield {
      type: 'session_started',
      ...eventBase(options.sessionId),
      cwd: options.cwd,
      requestId: options.requestId,
      model: options.model,
      budget: options.budget,
    }

    const metrics = createRuntimeExecutionMetrics()

    for await (const event of this._executeInner(options, (duration, remoteRunner) => {
      metrics.toolCallCount += 1
      metrics.toolRoundtripDurationMs += duration
      absorbRemoteToolRunnerMetrics(metrics, remoteRunner)
    })) {
      yield event
    }

    yield buildRuntimeExecutionMetricsEvent(options, metrics, { provider: false, context: false })
  }

  private async *_executeInner(
    options: RuntimeExecuteOptions,
    recordToolRun: (duration: number, remoteRunner?: RemoteToolRunnerDiagnostics) => void,
  ): AsyncIterable<NexusEvent> {
    try {
      const intent = parseLocalRuntimeIntent(options.prompt)
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

      if (intent.kind === 'file_question') {
        yield* this.executeFileQuestion(options, intent, recordToolRun)
        return
      }

      if (intent.kind === 'task_status') {
        yield* this.executeTaskStatus(options)
        return
      }

      if (intent.kind === 'task_update') {
        yield* this.executeTaskUpdate(options, intent)
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
      let toolInput = parsed.data
      let effectiveRisk: ToolRisk = this.effectiveRisk(tool, toolInput)
      // Compute per-input effective risk (e.g. Bash's read-only
      // subcommand classifier). The policy block and approval gate
      // both key off this value, not the static `tool.risk`. Read-only
      // subcommands of otherwise-execute tools therefore skip both gates
      // without losing the tool's identity in audit logs.
      //
      // Phase B of
      // docs/nexus/reference/go-tui-permission-policy-governance-plan.md:
      // when `options.policyMode === 'soft-deny'`, bypass this policy block
      // for tools not in the allowlist. The approval gate below then
      // emits `permission_request` for write/execute-risk tools so the
      // user can approve via the Go TUI permission panel. Under
      // `'strict'` (the default), behaviour is unchanged.
      if (
        effectiveRisk !== 'read' &&
        !this.toolPolicy.isAllowed(tool, toolInput) &&
        options.policyMode !== 'soft-deny'
      ) {
        const message = `Tool denied by Nexus policy: ${tool.name}`
        yield {
          type: 'tool_denied',
          ...eventBase(options.sessionId),
          name: tool.name,
          risk: effectiveRisk,
          message,
          denialKind: 'policy',
          recoverable: true,
        }
        yield {
          type: 'result',
          ...eventBase(options.sessionId),
          success: false,
          message,
        }
        return
      }

      const safetyCheck = checkOptimizerSafety(tool.name, toolInput, options.role)
      if (!safetyCheck.allowed) {
        const message = safetyCheck.reason!
        yield {
          type: 'tool_denied',
          ...eventBase(options.sessionId),
          name: tool.name,
          risk: effectiveRisk,
          message,
          denialKind: 'optimizer_safety',
          recoverable: true,
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
        input: toolInput,
        ...(effectiveRisk !== tool.risk && { effectiveRisk }),
      }

      const preToolHooks = await executeRuntimeHooks(
        'PreToolUse',
        {
          toolUseId,
          toolName: tool.name,
          toolRisk: effectiveRisk,
          toolInput,
        },
        {
          sessionId: options.sessionId,
          cwd: options.cwd,
          role: options.role,
          signal: options.signal,
        },
        { config: options.hooks, hooks: options.runtimeHooks },
      )
      for (const hookEvent of preToolHooks.events) yield hookEvent
      const hookDenyReason = firstHookDenyReason(preToolHooks)
      if (hookDenyReason) {
        yield {
          type: 'tool_denied',
          ...eventBase(options.sessionId),
          name: tool.name,
          risk: effectiveRisk,
          message: hookDenyReason,
          denialKind: 'hook',
          recoverable: true,
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
      if (hookUpdatedInput !== undefined) {
        toolInput = tool.inputSchema.parse(hookUpdatedInput)
        // Hooks can rewrite the input, which can change the per-input
        // risk (e.g. a hook that strips dangerous patterns from a Bash
        // command). Recompute so the approval gate matches the
        // post-hook input.
        effectiveRisk = this.effectiveRisk(tool, toolInput)
      }

      // Check if the tool requires authorization.
      if ((effectiveRisk === 'write' || effectiveRisk === 'execute') && !options.skipPermissionCheck) {
        const { autoApprove, reason } = classifyAction(tool.name, toolInput, { cwd: options.cwd })
        const sessionRuleApproved = isApprovedBySessionRule(options.sessionApprovedRules, tool, toolInput)
        let approved = autoApprove || sessionRuleApproved
        let decisionReason = sessionRuleApproved
          ? 'Approved by session rule'
          : `Auto-approved: ${reason}`

        if (approved) {
          if (this.storage) {
            await this.storage.savePermissionAudit({
              auditId: createId('audit'),
              sessionId: options.sessionId,
              toolUseId,
              toolName: tool.name,
              toolRisk: effectiveRisk,
              toolInput,
              decision: 'approved',
              reason: decisionReason,
              timestamp: nowIso(),
            })
          }
        } else {
          const pendingPermission = PendingPermissionRegistry.getInstance().register(
            options.sessionId,
            toolUseId
          )

          // Enhanced permission panel (Phase A.1): surface a
          // model-suggested allow rule from the tool's
          // `suggestedAllowRule` (e.g. `Bash` → `bash:*`) plus
          // a per-input deriver for tools like Bash that produce
          // command subcategories. The Go TUI permission panel
          // presents this as the default for the
          // "Approve for this session" / "Approve with editable
          // rule" options.
          const suggestedRule = tool.suggestedAllowRule
            ?? (tool.name === 'Bash' ? deriveBashSuggestedRule(toolInput) : undefined)

          yield {
            type: 'permission_request',
            ...eventBase(options.sessionId),
            toolUseId,
            name: tool.name,
            input: toolInput,
            risk: effectiveRisk,
            message: `Tool ${tool.name} requires user permission to run. Reason: ${reason}`,
            ...(suggestedRule && { suggestedRule }),
            source: tool.source,
          }

          const permissionHooks = await executeRuntimeHooks(
            'PermissionRequest',
            {
              toolUseId,
              toolName: tool.name,
              toolRisk: effectiveRisk,
              toolInput,
            },
            {
              sessionId: options.sessionId,
              cwd: options.cwd,
              role: options.role,
              signal: options.signal,
            },
            { config: options.hooks, hooks: options.runtimeHooks },
          )
          for (const hookEvent of permissionHooks.events) yield hookEvent

          const hookDecision = firstHookPermissionDecision(permissionHooks)
          if (hookDecision) {
            PendingPermissionRegistry.getInstance().resolve(options.sessionId, toolUseId, hookDecision)
          }
          const decision = hookDecision ?? await pendingPermission

          approved = decision.approved
          decisionReason = decision.reason ?? 'User review'
          // Phase A.1 of the enhanced permission panel: persist
          // `scope: 'session'` rules into the per-session rules
          // map so the remaining turns of this session auto-allow
          // matching tool calls. Strict invariants:
          //  - only user-issued approvals can add rules (no
          //    auto-approval / classification paths)
          //  - rules are process-local (lost on server restart)
          //  - `scope: 'once'` never touches the map
          if (
            approved &&
            (decision.scope === 'session' || decision.scope === 'rule') &&
            typeof decision.rule === 'string' &&
            decision.rule.length > 0
          ) {
            this.addSessionRule(options.sessionId, decision.rule)
          }

          if (this.storage) {
            await this.storage.savePermissionAudit({
              auditId: createId('audit'),
                sessionId: options.sessionId,
                toolUseId,
                toolName: tool.name,
                toolRisk: effectiveRisk,
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
            ...(decision.scope && { scope: decision.scope }),
            ...(decision.rule && { rule: decision.rule }),
            ...(decision.feedback && { feedback: decision.feedback }),
          }
        }

        if (!approved) {
          const denyMessage = decisionReason || `Tool execution denied by user: ${tool.name}`
          yield {
            type: 'tool_denied',
            ...eventBase(options.sessionId),
            name: tool.name,
            risk: effectiveRisk,
            message: denyMessage,
            denialKind: 'permission',
            terminal: true,
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
      const result = await executeToolSafely(tool, toolInput, options, { toolUseId })
      recordToolRun(performance.now() - toolStartMs, result.remoteRunner)
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
        remoteRunner: result.remoteRunner,
      }

      const postToolHooks = await executeRuntimeHooks(
        result.success ? 'PostToolUse' : 'PostToolUseFailure',
        {
          toolUseId,
          toolName: tool.name,
          toolRisk: effectiveRisk,
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
        { config: options.hooks, hooks: options.runtimeHooks },
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

  private async *executeTaskStatus(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    const tasks = options.storage ? await options.storage.listTasks(options.sessionId) : []
    const message = tasks.length === 0
      ? 'No tasks in this session.'
      : tasks.map(task => `${task.taskId} ${task.status} ${task.title}`).join('\n')

    yield {
      type: 'task_session_event',
      ...eventBase(options.sessionId),
      eventId: createId('event'),
      eventType: 'task_status',
      phase: options.sessionId,
      payload: { tasks },
    }
    yield {
      type: 'assistant_delta',
      ...eventBase(options.sessionId),
      text: message,
    }
    yield {
      type: 'result',
      ...eventBase(options.sessionId),
      success: true,
      message,
    }
  }

  private async *executeTaskUpdate(
    options: RuntimeExecuteOptions,
    intent: { selector: string; status: 'pending' | 'in_progress' | 'completed' | 'failed'; result?: string },
  ): AsyncIterable<NexusEvent> {
    const tasks = options.storage ? await options.storage.listTasks(options.sessionId) : []
    const task = findTaskBySelector(tasks, intent.selector)
    if (!task || !options.storage) {
      const message = `Task not found: ${intent.selector}`
      yield {
        type: 'assistant_delta',
        ...eventBase(options.sessionId),
        text: message,
      }
      yield {
        type: 'result',
        ...eventBase(options.sessionId),
        success: false,
        message,
      }
      return
    }

    const updated: NexusTask = {
      ...task,
      status: intent.status,
      result: intent.result ?? task.result,
      updatedAt: nowIso(),
    }
    await options.storage.saveTask(updated)
    yield {
      type: 'task_session_event',
      ...eventBase(options.sessionId),
      eventId: createId('event'),
      eventType: 'task_updated',
      phase: options.sessionId,
      payload: { task: updated },
    }
    const message = `Task updated: ${updated.taskId} ${updated.status} ${updated.title}`
    yield {
      type: 'assistant_delta',
      ...eventBase(options.sessionId),
      text: message,
    }
    yield {
      type: 'result',
      ...eventBase(options.sessionId),
      success: true,
      message,
    }
  }

  private async *executeFileQuestion(
    options: RuntimeExecuteOptions,
    intent: { path: string; question: string },
    recordToolRun: (duration: number, remoteRunner?: RemoteToolRunnerDiagnostics) => void,
  ): AsyncIterable<NexusEvent> {
    const tool = this.tools.get('Read')
    if (!tool) {
      yield {
        type: 'error',
        ...eventBase(options.sessionId),
        code: 'TOOL_NOT_FOUND',
        message: 'Tool not found: Read',
      }
      return
    }
    if (!this.toolPolicy.isAllowed(tool)) {
      const message = 'Tool denied by Nexus policy: Read'
      yield {
        type: 'tool_denied',
        ...eventBase(options.sessionId),
        name: tool.name,
        risk: tool.risk,
        message,
        denialKind: 'policy',
        recoverable: true,
      }
      yield {
        type: 'result',
        ...eventBase(options.sessionId),
        success: false,
        message,
      }
      return
    }

    const toolInput = tool.inputSchema.parse({ path: intent.path, mode: 'full' })
    const toolUseId = createId('tool')
    yield {
      type: 'tool_started',
      ...eventBase(options.sessionId),
      toolUseId,
      name: tool.name,
      input: toolInput,
    }

    const toolStartMs = performance.now()
    const result = await executeToolSafely(tool, toolInput, options, { toolUseId })
    recordToolRun(performance.now() - toolStartMs, result.remoteRunner)
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
      remoteRunner: result.remoteRunner,
    }

    const answer = result.success
      ? `I read ${intent.path}. Relevant content for your question (${intent.question}):\n${String(result.output).trim()}`
      : `I could not answer from ${intent.path}: ${String(result.output)}`
    yield {
      type: 'assistant_delta',
      ...eventBase(options.sessionId),
      text: answer,
    }
    yield {
      type: 'result',
      ...eventBase(options.sessionId),
      success: result.success,
      message: answer,
    }
  }

  /**
   * Public API: accumulate a user-issued `scope: 'session'` rule
   * for the given session. Subsequent turns of the session auto-
   * allow tool calls whose stringified input contains the rule.
   * Phase A.1 of the enhanced permission panel.
   */
  addSessionRule(sessionId: string, rule: string): void {
    const trimmed = rule.trim()
    if (!trimmed) return
    const existing = this.sessionRules.get(sessionId) ?? []
    if (existing.includes(trimmed)) return
    existing.push(trimmed)
    this.sessionRules.set(sessionId, existing)
  }

  /**
   * Test-only accessor for the accumulated session rules. Used by
   * the test suite to verify the turn-boundary invariant without
   * reaching into private fields.
   */
  getSessionRulesForTest(sessionId: string): readonly string[] {
    return this.sessionRules.get(sessionId) ?? []
  }
}

function isApprovedBySessionRule(
  rules: readonly string[] | undefined,
  tool: AnyTool,
  input: unknown,
): boolean {
  if (!rules || rules.length === 0) return false
  return buildSessionRulesPolicy(rules).isAllowed(tool, input)
}

import {
  executeToolSafely,
  normalizeToolErrorDetails,
} from './toolExecutor.js'

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
      return { mode: 'allowlist', allowedTools: ['listdir', 'glob', 'grep', 'read', 'websearch', 'task'] }
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

/**
 * Derive a per-input suggested allow rule for the Bash tool
 * (Phase A.1 of the enhanced permission panel). Returns strings
 * like `git:status`, `npm:install`, or `bash:*` (whole tool
 * fallback). The classifier here mirrors the read-only subcommand
 * allowlist in `src/tools/builtin/bashClassifier.ts` so the
 * suggested rule is always at least as specific as the actual
 * risk classification.
 */
export function deriveBashSuggestedRule(input: unknown): string | undefined {
  const command = getBashCommand(input)
  if (!command) return undefined
  const tokens = tokenizeBashCommand(command)
  if (tokens.length === 0) return undefined
  const [head] = tokens
  const normalizedHead = head.toLowerCase()
  const bashRisk = classifyBashRisk(command)

  if (normalizedHead === 'sed') {
    return bashRisk.kind === 'read' ? 'bash:sed-read' : 'bash:*'
  }
  if (normalizedHead === 'grep') {
    return bashRisk.kind === 'read' ? 'bash:grep-read' : 'bash:*'
  }

  // Per-subcommand granularity for known subcommand-style tools.
  // Empty Set means "any subcommand of this command".
  const BASH_SUB_RULES: Record<string, Set<string> | null> = {
    git: new Set(['status', 'log', 'diff', 'show', 'remote', 'rev-parse', 'ls-files', 'tag', 'branch']),
    ls: new Set(),
    cat: new Set(),
    head: new Set(),
    tail: new Set(),
    wc: new Set(),
    file: new Set(),
    stat: new Set(),
    readlink: new Set(),
    realpath: new Set(),
    pwd: new Set(),
    echo: new Set(),
    whoami: new Set(),
    hostname: new Set(),
    date: new Set(),
    uname: new Set(),
    env: new Set(),
    printenv: new Set(),
    ps: new Set(),
    top: new Set(),
    uptime: new Set(),
  }
  if (Object.prototype.hasOwnProperty.call(BASH_SUB_RULES, normalizedHead)) {
    const subs = BASH_SUB_RULES[normalizedHead]
    if (subs !== null) {
      // Find first non-flag token to use as the subcommand.
      const sub = tokens.slice(1).find(t => !t.startsWith('-'))
      if (sub && subs.has(sub)) {
        return bashRisk.kind === 'read' ? `${normalizedHead}:${sub}` : 'bash:*'
      }
      if (sub && !subs.has(sub)) {
        // Subcommand is known-dangerous (e.g. `git push`); still
        // suggest a default rule so the user can decide.
        return `${normalizedHead}:${sub}`
      }
    }
    return bashRisk.kind === 'read' ? `${normalizedHead}:*` : 'bash:*'
  }

  // Fall back to the whole tool (any arguments) when the command
  // is something we don't model in the classifier.
  return `bash:*`
}

function findTaskBySelector(tasks: NexusTask[], selector: string): NexusTask | undefined {
  return tasks.find(task => task.taskId === selector) ??
    tasks.find(task => task.taskId.endsWith(selector)) ??
    tasks.find(task => task.title === selector)
}

/**
 * Build a `ToolPolicy` that auto-allows any tool call whose
 * stringified input contains one of the accumulated session
 * `scope: 'session'` rules. Used by `executeStream` to apply
 * user-issued session approvals to the remaining turns without
 * requiring per-turn permission requests. Phase A.1 of the
 * enhanced permission panel.
 */
export function buildSessionRulesPolicy(rules: readonly string[]): ToolPolicy {
  // Normalize rules for substring matching. Empty / whitespace
  // rules are dropped (they'd match every input, which is too
  // permissive to be useful as a session rule).
  const normalised = rules
    .map(r => r.trim())
    .filter(r => r.length > 0)
  if (normalised.length === 0) {
    return denyByDefaultTools()
  }
  return {
    isAllowed(tool, input) {
      // `tool.suggestedAllowRule ?? tool.name` keeps the test
      // name canonical: `Bash` → `bash`, `Write` → `write`.
      const toolNeedle = (tool.suggestedAllowRule ?? tool.name).toLowerCase()
      const inputBlob = safeStringify(input).toLowerCase()
      const derivedRule = tool.name === 'Bash' ? deriveBashSuggestedRule(input)?.toLowerCase() : undefined
      return normalised.some(rule => {
        const lower = rule.toLowerCase()
        if (matchesStructuredSessionRule(lower, toolNeedle, derivedRule)) return true
        return matchesLegacySessionRule(lower, toolNeedle, inputBlob)
      })
    },
    describe() {
      return { mode: 'session_rules', allowedTools: [...normalised] }
    },
  }
}

function matchesStructuredSessionRule(
  rule: string,
  toolNeedle: string,
  derivedRule: string | undefined,
): boolean {
  if (!rule.includes(':')) return false
  const [toolPart, ...rest] = rule.split(':')
  const rulePart = rest.join(':')
  if (toolPart === 'bash') {
    if (!derivedRule) return false
    if (rulePart === '*' || rulePart === '') return true
    return derivedRule === rule
  }
  if (derivedRule && derivedRule === rule) return true
  if (toolPart !== toolNeedle) return false
  return rulePart === '*' || rulePart === ''
}

function matchesLegacySessionRule(rule: string, toolNeedle: string, inputBlob: string): boolean {
  if (rule.includes(':')) {
    const [toolPart, ...rest] = rule.split(':')
    const commandPart = rest.join(':')
    if (toolPart !== toolNeedle) return false
    if (commandPart === '*' || commandPart === '') return true
    return inputBlob.includes(commandPart)
  }
  return inputBlob.includes(rule) || toolNeedle.includes(rule)
}

function getBashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('command' in input)) return undefined
  const command = (input as { command: unknown }).command
  if (typeof command !== 'string') return undefined
  const trimmed = command.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Stringify a value for rule-substring matching, swallowing
 * circular-reference errors. We don't need a full JSON serializer
 * here — `String(v)` covers primitives, arrays, and plain
 * objects without throwing.
 */
function safeStringify(value: unknown): string {
  try {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  } catch {
    try { return String(value) } catch { return '' }
  }
}
