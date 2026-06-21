import { z } from 'zod'
import { getModel, UnknownModelError } from '../providers/registry.js'
import { resolvePromptCwd } from '../runtime/systemPromptBuilder.js'
import { ConfigManager } from '../shared/config.js'
import { eventBase } from '../shared/events.js'
import { createId, nowIso } from '../shared/id.js'
import { logger } from '../shared/logger.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusStorage } from '../storage/Storage.js'
import { isWorkspaceAllowed } from '../tools/builtin/pathSafety.js'

export const executeSchema = z.object({
  prompt: z.string().min(1),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  timeoutPolicy: z.enum(['fatal', 'soft']).optional(),
  softTimeoutMs: z.number().int().positive().max(300_000).optional(),
  watchdogTimeoutMs: z.number().int().positive().max(1_800_000).optional(),
  /**
   * Phase 3 of docs/nexus/reference/task-adaptive-recoverable-timeout-plan.md.
   * Maximum number of automatic soft-timeout extensions the runtime
   * may grant when `timeoutPolicy: 'soft'`. Each extension fires
   * after a `timeout_budget_exceeded` event and is announced with a
   * `timeout_extension_granted` event. The hard watchdog is never
   * extended.
   * Defaults to 1 — enough for the model to react to the budget
   * warning with a deliberate choice. Set to 0 to disable
   * extensions entirely (one-shot recoverable signal only).
   */
  maxSoftTimeoutExtensions: z.number().int().nonnegative().max(5).optional(),
  /**
   * Phase 3: how much extra soft budget is granted per extension.
   * Defaults to `softTimeoutMs`. Capped at 300_000ms so it can never
   * outrun the hard watchdog budget.
   */
  softTimeoutExtensionMs: z.number().int().positive().max(300_000).optional(),
  maxToolOutputBytes: z.number().int().positive().max(10_000_000).optional(),
  skipPermissionCheck: z.boolean().optional(),
  /**
   * Per-request policy override (Phase B of
   * docs/nexus/reference/go-tui-permission-policy-governance-plan.md).
   * When omitted, the server-side `executePolicyMode` default applies
   * (which itself defaults to `'strict'` for back-compat with `bbl
   * chat` and HTTP API consumers).
   *   - 'strict': tools not in the allowlist are hard-denied (existing
   *     behavior; `permission_request` never fires for them).
   *   - 'soft-deny': the hard-deny is bypassed; the existing approval
   *     gate then emits `permission_request` for write/execute-risk
   *     tools so the user can approve via the Go TUI permission panel.
   * Read-only Bash subcommands (Phase A classifier) always auto-allow
   * regardless of policy mode.
   */
  policy: z.enum(['strict', 'soft-deny']).optional(),
  /**
   * Per-request tool allowlist (Phase D of
   * docs/nexus/reference/go-tui-permission-policy-governance-plan.md).
   * When set, the runtime applies an allowlist-based policy for this
   * turn only (next turn re-evaluates from the body). The override
   * scopes to a single `executeStream` call. Empty / omitted → no
   * per-turn override; server-startup `denyByDefaultTools()` (or
   * whichever policy the runtime was constructed with) applies.
   * `*` / `all` → allowAllTools. Works orthogonally with
   * `policy: 'soft-deny'`.
   */
  allowedTools: z.array(z.string().min(1)).optional(),
  requestId: z.string().optional(),
  model: z.string().optional(),
  budget: z.number().int().positive().optional(),
  executionEnvironment: z.enum(['local', 'docker', 'remote']).default('local').optional(),
})

export type ExecuteBody = z.infer<typeof executeSchema>

export type ExecuteTimeoutPolicy = 'fatal' | 'soft'

export type ExecuteTimeoutDecision = {
  policy: ExecuteTimeoutPolicy
  softTimeoutMs: number
  watchdogTimeoutMs: number
  /**
   * Phase 3 of task-adaptive-recoverable-timeout: how many soft
   * extensions the runtime will auto-grant after the soft budget is
   * exhausted. 0 means one-shot recoverable signal with no
   * extension. Only consulted under `policy: 'soft'`.
   */
  maxSoftTimeoutExtensions: number
  /**
   * Phase 3: how much soft budget each extension adds. Capped at
   * the remaining hard watchdog budget at issue time so we never
   * out-budget the watchdog. Only consulted under `policy: 'soft'`.
   */
  softTimeoutExtensionMs: number
}

export type WatchdogState = {
  /**
   * Phase 5 of the task-adaptive-recoverable-timeout plan: set
   * to true by the hard watchdog timer when it actually fires.
   * Lets the execute loop decorate the resulting REQUEST_TIMEOUT
   * error with `details.kind='watchdog'` so downstream consumers
   * (Go TUI friendly message, metrics, future SDK clients) can
   * distinguish a watchdog cutoff from a fresh fatal cutoff.
   *
   * Stays false under legacy `fatal` policy because under fatal
   * the soft and watchdog timeouts collapse, so every cutoff is
   * effectively the same fatal cutoff; not marking it preserves
   * back-compat with the existing `REQUEST_TIMEOUT` shape.
   */
  fired: boolean
}

export type PreparedExecution = {
  sessionId: string
  session: SessionSnapshot
  cwd: string
  body: ExecuteBody
  requestId: string
  abortController: AbortController
  timeoutController: AbortController
  timeout: ReturnType<typeof setTimeout>
  timeoutDecision: ExecuteTimeoutDecision
  policyMode: 'strict' | 'soft-deny'
  allowedTools?: readonly string[]
  allowedPaths?: string[]
  watchdog: WatchdogState
  // Bug 2 (§13.4): Phase B continuity inputs derived in prepareExecution.
  storedSessionCwd?: string
  latestTaskPrimaryRoot?: string
}

export type PrepareError = { code: string; message: string; status: number }

export function resolveExecuteTimeoutDecision(body: ExecuteBody, defaultExecuteTimeoutMs: number): ExecuteTimeoutDecision {
  const policy = body.timeoutPolicy ?? 'fatal'
  const legacyTimeoutMs = body.timeoutMs ?? defaultExecuteTimeoutMs
  const softTimeoutMs = body.softTimeoutMs ?? legacyTimeoutMs
  const watchdogTimeoutMs = body.watchdogTimeoutMs ?? (policy === 'soft' ? Math.max(legacyTimeoutMs * 3, legacyTimeoutMs + 300_000) : legacyTimeoutMs)
  // Phase 3 defaults: a single auto extension equal to the soft
  // budget gives the model one full window to react to the budget
  // warning. fatal policy keeps maxSoftTimeoutExtensions=0 so
  // legacy callers never see the new extension cycle.
  const maxSoftTimeoutExtensions = policy === 'soft' ? (body.maxSoftTimeoutExtensions ?? 1) : 0
  const softTimeoutExtensionMs = body.softTimeoutExtensionMs ?? softTimeoutMs
  return {
    policy,
    softTimeoutMs,
    watchdogTimeoutMs,
    maxSoftTimeoutExtensions,
    softTimeoutExtensionMs,
  }
}

export type PrepareExecutionOptions = {
  storage: NexusStorage
  defaultCwd: string
  remoteRunnerAvailable: boolean
  executeTimeoutMs: number
  executePolicyMode: 'strict' | 'soft-deny'
}

export async function prepareExecution(body: ExecuteBody, options: PrepareExecutionOptions): Promise<PreparedExecution | PrepareError> {
  if (body.executionEnvironment === 'remote' && !options.remoteRunnerAvailable) {
    return {
      code: 'NOT_IMPLEMENTED',
      message: `Execution environment '${body.executionEnvironment}' is not implemented yet.`,
      status: 501,
    }
  }
  const sessionId = body.sessionId ?? createId('session')
  let session = await options.storage.getSession(sessionId, {
    includeEvents: false,
  })
  let cwd = resolveRequestCwd({
    prompt: body.prompt,
    requestedCwd: body.cwd,
    sessionCwd: session?.cwd,
    defaultCwd: options.defaultCwd,
  })
  const trustedWorkspaceCwd = body.cwd ?? session?.originCwd ?? session?.cwd ?? options.defaultCwd
  if (!isWorkspaceAllowed(trustedWorkspaceCwd)) {
    return {
      code: 'INVALID_REQUEST',
      message: `Workspace directory not allowed: ${trustedWorkspaceCwd}`,
      status: 400,
    }
  }
  if (!isWorkspaceAllowed(cwd)) {
    cwd = trustedWorkspaceCwd
  }

  let allowedPaths = session?.allowedPaths ? [...session.allowedPaths] : []
  if (session && session.cwd && session.cwd !== cwd && !allowedPaths.includes(session.cwd)) {
    allowedPaths.push(session.cwd)
  }

  const configManager = ConfigManager.getInstance()
  const settings = configManager.resolveSettings({ model: body.model })
  const targetModelId = settings.modelId || 'local/coding-runtime'
  try {
    const modelDef = getModel(targetModelId)
    if (modelDef && !modelDef.capabilities.toolCalling) {
      return {
        code: 'INVALID_REQUEST',
        message: `Model "${targetModelId}" does not support tool calling`,
        status: 400,
      }
    }
  } catch (err) {
    if (!(err instanceof UnknownModelError)) throw err
  }
  const abortController = new AbortController()
  const timeoutController = new AbortController()
  const timeoutDecision = resolveExecuteTimeoutDecision(body, options.executeTimeoutMs)
  // Phase 5: when the hard watchdog fires, mark a shared
  // WatchdogState so the execute loop can decorate the
  // resulting REQUEST_TIMEOUT error with details.kind='watchdog'
  // and distinguish a system-safety cutoff from a fresh fatal
  // cutoff in metrics, friendly messages, and persistence.
  const watchdog: WatchdogState = { fired: false }
  const watchdogTimeoutMs = timeoutDecision.watchdogTimeoutMs
  const timeout = setTimeout(() => {
    // Single-source hard watchdog (Phase 2 of
    // docs/nexus/proposals/provider-stream-silent-hang-abort-propagation-plan.md).
    // This is the ONLY watchdog timer for both HTTP and WS execute
    // paths. Firing marks `watchdog.fired` (so the settlement path
    // can decorate the resulting REQUEST_TIMEOUT with
    // `details.kind='watchdog'` under soft policy) and aborts both
    // controllers so the provider stream reader unblocks (Phase 1)
    // and the runtime catch yields REQUEST_TIMEOUT.
    logger.warn(
      `hard watchdog fired after ${watchdogTimeoutMs}ms (session=${sessionId}); aborting stream consumer`,
    )
    watchdog.fired = true
    timeoutController.abort()
    abortController.abort()
  }, watchdogTimeoutMs)
  // Resolve effective policy mode: per-request body field overrides
  // server-side default. Defaults to 'strict' to preserve HTTP API
  // back-compat. See Phase B of
  // docs/nexus/reference/go-tui-permission-policy-governance-plan.md.
  const policyMode = body.policy ?? options.executePolicyMode
  // Per-request allowlist (Phase D): scoped to this turn only. When
  // omitted, the runtime falls back to its server-startup policy.
  const allowedTools = body.allowedTools
  // Bug 4 (§13.2): session.cwd is the authoritative persisted root. It
  // must NOT be overwritten by a prompt-derived cwd every turn (that
  // was the cross-turn drift cause in session_10320709). The trusted
  // cwd is body.cwd (explicit caller) or session.originCwd (immutable
  // creation root); a prompt-derived cwd stays in allowedPaths (so
  // the runtime can still access it via Phase B continuity) but does
  // not corrupt session.cwd.
  const trustedSessionCwd = body.cwd ?? session?.originCwd ?? session?.cwd ?? cwd
  if (!session) {
    session = createSessionSnapshot(sessionId, trustedSessionCwd, body.prompt)
  } else {
    session.phase = 'executing'
    session.cwd = trustedSessionCwd
    session.updatedAt = nowIso()
    session.lastUserInput = body.prompt
    session.allowedPaths = allowedPaths.length > 0 ? allowedPaths : undefined
  }
  await options.storage.saveSession(session)
  await options.storage.appendEvent(sessionId, {
    type: 'user_message',
    ...eventBase(sessionId),
    text: body.prompt,
  })
  const requestId = body.requestId ?? createId('req')
  // Bug 2 (§13.4): derive Phase B continuity inputs from the session's
  // immutable originCwd + the most recent task_scope_declared.primaryRoot.
  // originCwd is the creation cwd (never drifts); latestTaskPrimaryRoot
  // is the last declared task root. Both are passed to executeStream so
  // LLMCodingRuntime.resolveCwdWithContinuity can pull a drifted requestCwd
  // back to the project root instead of inheriting session.cwd drift.
  const storedSessionCwd = session.originCwd ?? session.cwd
  const latestTaskPrimaryRoot = await resolveLatestTaskPrimaryRoot(options.storage, sessionId)
  return {
    sessionId,
    session,
    cwd,
    body,
    requestId,
    abortController,
    timeoutController,
    timeout,
    timeoutDecision,
    policyMode,
    allowedTools,
    allowedPaths: allowedPaths.length > 0 ? allowedPaths : undefined,
    watchdog,
    storedSessionCwd,
    ...(latestTaskPrimaryRoot !== undefined && { latestTaskPrimaryRoot }),
  }
}

export function isPrepareError(r: PreparedExecution | PrepareError): r is PrepareError {
  return 'status' in r
}

function createSessionSnapshot(sessionId: string, cwd: string, prompt: string): SessionSnapshot {
  const timestamp = nowIso()
  return {
    sessionId,
    cwd,
    prompt,
    phase: 'executing',
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [],
    // Bug 2 (§13.4): originCwd is the immutable creation cwd. The execute
    // path creates a session lazily on first turn; that cwd is the origin.
    originCwd: cwd,
  }
}

function resolveRequestCwd(options: { prompt: string; requestedCwd?: string; sessionCwd?: string; defaultCwd: string }): string {
  const explicitCwd = resolveExplicitPromptCwd(options.prompt)
  if (explicitCwd) {
    return explicitCwd
  }
  if (options.requestedCwd && options.requestedCwd !== options.defaultCwd) {
    return options.requestedCwd
  }
  return options.sessionCwd ?? options.requestedCwd ?? options.defaultCwd
}

function resolveExplicitPromptCwd(prompt: string): string | undefined {
  // Bug 4 (§13.2): delegate to the shared `resolvePromptCwd` so Site A
  // (app.ts, used by resolveRequestCwd to set session.cwd) and Site B
  // (runtime, used by runExecuteStreamInner to set options.cwd) can never
  // disagree on the same prompt. Previously Site A only accepted an
  // existing directory (no dirname fallback) while Site B had a dirname
  // fallback — that divergence let session.cwd and options.cwd drift
  // apart across turns (session_10320709). We pass a sentinel baseCwd
  // and treat a return of that sentinel as "no prompt path won" →
  // undefined, so resolveRequestCwd still falls back to requestedCwd /
  // sessionCwd / defaultCwd.
  const SENTINEL = '\x00\x01no-prompt-cwd\x00\x01'
  const resolved = resolvePromptCwd(prompt, SENTINEL)
  return resolved === SENTINEL ? undefined : resolved
}

// Bug 2 (§13.4): scan the session's recent events (desc order, bounded) for
// the most recent `task_scope_declared` and return its primaryRoot. Used as
// the Phase B continuity `latestTaskPrimaryRoot` input so the runtime can
// recover a drifted requestCwd to the last declared project root. Returns
// undefined when no task_scope_declared exists yet (first turn).
async function resolveLatestTaskPrimaryRoot(storage: NexusStorage, sessionId: string): Promise<string | undefined> {
  try {
    const result = await storage.listEvents(sessionId, { limit: 50, order: 'desc' })
    for (const event of result.events) {
      if (event.type === 'task_scope_declared') {
        const root = (event as { primaryRoot?: unknown }).primaryRoot
        if (typeof root === 'string' && root.length > 0) return root
      }
    }
  } catch {
    // Never block execution on a continuity-input lookup failure; the
    // runtime falls back to the simple 2-arg resolver.
  }
  return undefined
}
