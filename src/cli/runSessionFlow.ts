import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Interface as CliReadline } from 'node:readline'
import chalk from 'chalk'
import { NexusClient } from './NexusClient.js'
import { ConfigManager, DEFAULT_CONFIG_DIR } from '../shared/config.js'
import { createId } from '../shared/id.js'
import { PendingPermissionRegistry } from '../shared/session.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../shared/events.js'
import type { PermissionResolution, SessionPhase, TaskSessionTerminalReason } from '../shared/session.js'
import { executeRuntimeHooks } from '../runtime/hooks.js'
import { resolvePromptCwd } from '../runtime/systemPromptBuilder.js'

type PermissionDialogEvent = {
  sessionId?: string
  toolUseId: string
  name?: string
  input?: unknown
  risk?: string
  message?: string
  suggestedRule?: string
}

type CliPermissionDecision = PermissionResolution & {
  scope: 'once' | 'session' | 'rule'
}

interface CustomWebSocket {
  send(data: string): void
  close(): void
  readyState: number
  addEventListener(type: string, listener: (event: any) => void): void
}

export async function runSessionFlow(
  prompt: string,
  cwd: string,
  url: string | undefined,
  rl: CliReadline,
  abortController: AbortController,
  sessionIdArg?: string
): Promise<string> {
  const sessionId = sessionIdArg ?? createId('session')

  if (url) {
    const wsUrl = url.replace(/^http/, 'ws') + '/v1/stream'
    // Dynamic import to prevent loading ws package during startup when running in embedded mode
    const wsModule = await import('ws') as { default: any }
    const WebSocketCtor = (globalThis as any).WebSocket || wsModule.default

    return new Promise<string>((resolve, reject) => {
      let socket: CustomWebSocket | null = null

      const onAbort = () => {
        if (socket) {
          try {
            socket.close()
          } catch {}
        }
        new NexusClient({ baseUrl: url }).cancelSession(sessionId).catch(() => {})
        reject(new Error('Aborted'))
      }

      if (abortController.signal.aborted) {
        onAbort()
        return
      }
      abortController.signal.addEventListener('abort', onAbort)

      try {
        const wsOpts: { headers?: Record<string, string> } = {}
        const apiKey = process.env.NEXUS_API_KEY
        if (apiKey) {
          wsOpts.headers = {
            'X-Nexus-API-Key': apiKey,
          }
        }
        socket = new WebSocketCtor(wsUrl, wsOpts) as CustomWebSocket
      } catch (err) {
        abortController.signal.removeEventListener('abort', onAbort)
        reject(err)
        return
      }

      socket.addEventListener('open', () => {
        // Phase B 推进: align service-mode one-shot execution with the Go TUI default
        // (always sends `policy: 'soft-deny'`). Without this the WS
        // payload omits `policy` and the server falls back to
        // `executePolicyMode: 'strict'`, which hard-denies write/execute
        // tools before they ever reach `permission_request`. Power
        // users can opt back into strict via
        // `BABEL_O_CLI_POLICY_MODE=strict`.
        const cliPolicyMode = resolveCliPolicyMode()
        socket?.send(JSON.stringify({
          prompt,
          cwd,
          sessionId,
          ...(cliPolicyMode && { policy: cliPolicyMode }),
        }))
      })

      socket.addEventListener('message', async (event: { data: string }) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'permission_request') {
            /* TUI render removed */
            try {
              const decision = await askCliPermission(rl, data, abortController.signal)
              if (socket && socket.readyState === 1 /* OPEN */) {
                socket.send(JSON.stringify({
                  type: 'permission_response',
                  sessionId: data.sessionId,
                  toolUseId: data.toolUseId,
                  approved: decision.approved,
                  reason: decision.reason,
                  scope: decision.scope,
                  ...(decision.rule && { rule: decision.rule }),
                  ...(decision.feedback && { feedback: decision.feedback }),
                }))
              }
            } catch (err: any) {
              if (err.name === 'AbortError') {
                // User aborted during prompt
              } else {
                reject(err)
              }
            }
          } else {
            /* TUI render removed */
            if (data.type === 'result' || data.type === 'error') {
              abortController.signal.removeEventListener('abort', onAbort)
              socket?.close()
              resolve(sessionId)
            }
          }
        } catch (err) {
          abortController.signal.removeEventListener('abort', onAbort)
          reject(err)
        }
      })

      socket.addEventListener('close', () => {
        abortController.signal.removeEventListener('abort', onAbort)
        resolve(sessionId)
      })

      socket.addEventListener('error', (err: any) => {
        abortController.signal.removeEventListener('abort', onAbort)
        console.error(chalk.red(`WebSocket error: ${err.message || err}`))
        reject(err)
      })
    })
  } else {
    fs.mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true })
    const storagePath = path.join(DEFAULT_CONFIG_DIR, 'db.sqlite')
    const { createDefaultNexusRuntime } = await import('../nexus/createRuntime.js')
    const { defaultEverCoreRuntimeManager } = await import('../nexus/everCoreRuntimeManager.js')
    const {
      assertAgentRemoteExecutionReady,
      assertRemoteRunnerReady,
      configureRemoteRunnerFromEnv,
      parseAgentExecutionEnvironment,
    } = await import('../nexus/remoteRunnerConfig.js')
    const agentExecutionEnvironment = parseAgentExecutionEnvironment(process.env.NEXUS_AGENT_EXECUTION_ENVIRONMENT)
    const remoteRunner = await configureRemoteRunnerFromEnv()
    assertRemoteRunnerReady(remoteRunner.status)
    assertAgentRemoteExecutionReady(agentExecutionEnvironment, remoteRunner.status)
    const configManager = ConfigManager.getInstance()
    const providerSettings = configManager.resolveSettings()
    const everCore = await defaultEverCoreRuntimeManager.acquireFromEnv(process.env, { cwd, providerSettings })
    const { runtime, storage } = await createDefaultNexusRuntime({
      storagePath,
      allowedTools: ['*'],
      cwd,
      enableMcp: process.env.BABEL_O_ENABLE_MCP === '1',
      remoteRunner: remoteRunner.runner,
      agentExecutionEnvironment,
      memoryProvider: everCore.memoryProvider,
      everCore: {
        client: everCore.client,
        config: everCore.config,
        dispose: everCore.dispose,
      },
    })
    const originalAppendEvent = storage.appendEvent.bind(storage)

    storage.appendEvent = async (sid, ev) => {
      await originalAppendEvent(sid, ev)
      if (ev.type === 'permission_request') {
        /* TUI render removed */
        void handleLocalPermissionRequest(sid, ev, rl, abortController.signal).catch(err => {
          console.error(chalk.red(`Permission prompt error: ${err.message || err}`))
          PendingPermissionRegistry.getInstance().resolve(sid, ev.toolUseId, {
            approved: false,
            reason: 'Permission prompt failed',
          })
        })
      } else {
        /* TUI render removed */
      }
    }

    let session = await storage.getSession(sessionId, { includeEvents: false })
    const effectiveCwd = resolveCliRequestCwd(prompt, cwd, session?.cwd)
    if (!session) {
      session = {
        sessionId,
        cwd: effectiveCwd,
        prompt,
        phase: 'executing' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: [],
      }
    } else {
      session.phase = 'executing'
      session.cwd = effectiveCwd
      session.updatedAt = new Date().toISOString()
      session.lastUserInput = prompt
    }
    session.result = undefined
    session.error = undefined
    session.terminalReason = undefined
    await storage.saveSession(session)

    await storage.appendEvent(sessionId, {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: new Date().toISOString(),
      text: prompt,
    })

    const requestId = createId('req')
    const currentTurnEvents: NexusEvent[] = []
    const userPromptHooks = await executeRuntimeHooks(
      'UserPromptSubmit',
      { prompt },
      { sessionId, cwd: session.cwd },
      { config: configManager.load().hooks },
    )
    for (const ev of userPromptHooks.events) {
      await storage.appendEvent(sessionId, ev)
    }

    try {
      const settings = providerSettings
      const budget = process.env.BABEL_O_THINKING_BUDGET
        ? parseInt(process.env.BABEL_O_THINKING_BUDGET, 10)
        : undefined
      // `timeoutController` is intentionally a dead signal in the local
      // CLI path: `bbl` is a per-process one-shot runner where the user
      // already has a clean cancellation channel via Ctrl-C / signal,
      // and stacking a second timeout on top would only re-classify a
      // user-initiated cancel as REQUEST_TIMEOUT (see
      // docs/nexus/reference/go-tui-execute-timeout-governance-plan.md
      // Phase E). The Nexus HTTP / WebSocket path *does* arm a real
      // timeout via its own constructor option; CLI does not.
      const timeoutController = new AbortController()

      for await (const event of runtime.executeStream({
        sessionId,
        prompt,
        cwd: session.cwd,
        signal: abortController.signal,
        timeoutSignal: timeoutController.signal,
        requestId,
        model: settings.modelId,
        budget,
        remoteRunner: remoteRunner.runner,
        // Phase B 推进: align embedded one-shot CLI execution with the Go TUI
        // default. Without `policyMode: 'soft-deny'` the
        // `LocalCodingRuntime` hard-deny gate fires before the
        // approval gate, and write/execute tools never reach
        // `permission_request`. Power users can opt back into
        // strict via `BABEL_O_CLI_POLICY_MODE=strict`.
        policyMode: resolveCliPolicyMode() ?? 'soft-deny',
      })) {
        currentTurnEvents.push(event)
        await storage.appendEvent(sessionId, event)
      }
    } catch (err: any) {
      if (err.message !== 'Aborted' && err.name !== 'AbortError') {
        throw err
      }
    } finally {
      const finalSession = await storage.getSession(sessionId, { includeEvents: false })
      if (finalSession) {
        const outcome = resolveFinalSessionOutcome([...currentTurnEvents].reverse(), {
          aborted: abortController.signal.aborted,
          requestId,
        })
        finalSession.phase = outcome.phase
        finalSession.result = outcome.result
        finalSession.error = outcome.error
        finalSession.terminalReason = outcome.terminalReason
        finalSession.updatedAt = new Date().toISOString()
        await storage.saveSession(finalSession)
      }
      await storage.close?.()
      await defaultEverCoreRuntimeManager.shutdown()
    }
    PendingPermissionRegistry.getInstance().resolveSession(sessionId, {
      approved: false,
      reason: 'Session finished',
    })
    return sessionId
  }
}

function resolveCliRequestCwd(prompt: string, requestedCwd: string, sessionCwd?: string): string {
  // Bug 4 (§13.2): delegate to the shared `resolvePromptCwd` so the CLI
  // path agrees with app.ts Site A and the runtime Site B. Previously
  // this had a third divergent copy (no dirname fallback, no Bug 1 Layer B
  // system-dir guard). Sentinel detects "no prompt path won" → fall back.
  const SENTINEL = '\x00\x01no-prompt-cwd\x00\x01'
  const resolved = resolvePromptCwd(prompt, SENTINEL)
  if (resolved !== SENTINEL) return resolved
  return sessionCwd ?? requestedCwd
}

export const REQUEST_INTERRUPTED_WITHOUT_TERMINAL_EVENT = 'REQUEST_INTERRUPTED_WITHOUT_TERMINAL_EVENT'

function selectCurrentTurnEvents(eventsNewestFirst: NexusEvent[], requestId?: string): NexusEvent[] {
  if (!requestId) return eventsNewestFirst
  const boundaryIndex = eventsNewestFirst.findIndex(
    event => event.type === 'session_started' && event.requestId === requestId,
  )
  if (boundaryIndex === -1) return []
  return eventsNewestFirst.slice(0, boundaryIndex + 1)
}

export function resolveFinalSessionOutcome(
  eventsNewestFirst: NexusEvent[],
  options: { aborted?: boolean; requestId?: string } = {},
): {
  phase: SessionPhase
  result?: string
  error?: string
  terminalReason?: TaskSessionTerminalReason
} {
  if (options.aborted) {
    return {
      phase: 'cancelled',
      terminalReason: {
        category: 'cancelled',
        code: 'REQUEST_CANCELLED',
        message: 'Execution cancelled by user.',
      },
    }
  }

  const currentTurnEvents = selectCurrentTurnEvents(eventsNewestFirst, options.requestId)
  const terminalEvent = currentTurnEvents.find(event =>
    event.type === 'error' || event.type === 'result'
  )
  if (!terminalEvent) {
    const message = 'The latest request ended without a result or error event. Previous turn results were not reused.'
    return {
      phase: 'failed',
      error: message,
      terminalReason: {
        category: 'runtime',
        code: REQUEST_INTERRUPTED_WITHOUT_TERMINAL_EVENT,
        message,
      },
    }
  }

  if (terminalEvent.type === 'error') {
    return {
      phase: 'failed',
      error: terminalEvent.message,
      terminalReason: {
        category: 'runtime',
        code: terminalEvent.code,
        message: terminalEvent.message,
      },
    }
  }

  return {
    phase: terminalEvent.success ? 'completed' : 'failed',
    result: terminalEvent.message,
    terminalReason: terminalEvent.success
      ? undefined
      : {
          category: 'runtime',
          code: 'RESULT_FAILED',
          message: terminalEvent.message,
        },
  }
}

/**
 * Resolve the per-turn `policyMode` for the CLI's embedded +
 * service-mode paths. Phase B 推进: one-shot CLI execution defaults
 * to `'soft-deny'` to match the Go TUI's hardcoded default. Without
 * this, write/execute tools reach the `LocalCodingRuntime` hard-deny
 * gate first and are blocked before any `permission_request` fires,
 * leaving the operator no way to approve.
 *
 * Override: set `BABEL_O_CLI_POLICY_MODE=strict` to opt back into
 * hard-deny behavior for CLI one-shot execution. Unset / unknown
 * values fall back to `'soft-deny'` (matches Go TUI) so a typo
 * doesn't silently downgrade safety.
 */
export function resolveCliPolicyMode(): 'strict' | 'soft-deny' {
  const raw = process.env.BABEL_O_CLI_POLICY_MODE
  if (!raw) return 'soft-deny'
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'strict') return 'strict'
  if (normalized === 'soft-deny' || normalized === 'softdeny' || normalized === 'soft_deny') {
    return 'soft-deny'
  }
  // Unknown / typo: log once and keep the safe default.
  // (We avoid `process.exit` here because the helper is also imported
  // by tests that construct fake env.)
  return 'soft-deny'
}

async function handleLocalPermissionRequest(
  sessionId: string,
  event: PermissionDialogEvent,
  rl: CliReadline,
  signal: AbortSignal,
): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  try {
    const decision = await askCliPermission(rl, event, signal)
    const resolved = PendingPermissionRegistry.getInstance().resolve(sessionId, event.toolUseId, {
      approved: decision.approved,
      reason: decision.reason,
      scope: decision.scope,
      ...(decision.rule && { rule: decision.rule }),
      ...(decision.feedback && { feedback: decision.feedback }),
    })
    if (!resolved) {
      console.error(chalk.red(`Permission request not found: ${event.toolUseId}`))
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      PendingPermissionRegistry.getInstance().resolve(sessionId, event.toolUseId, {
        approved: false,
        reason: 'Cancelled by user',
      })
    } else {
      throw err
    }
  }
}

async function askCliPermission(
  rl: CliReadline,
  event: PermissionDialogEvent,
  signal: AbortSignal,
): Promise<CliPermissionDecision> {
  renderCliPermissionRequest(event)
  const answer = await questionWithAbort(
    rl,
    chalk.yellow('Approve? [y] once / [s] session / [r] edit rule / [n] reject: '),
    signal,
  )
  const normalized = answer.trim().toLowerCase()
  if (normalized === 's' || normalized === 'session') {
    const rule = event.suggestedRule ?? defaultPermissionRule(event)
    return {
      approved: true,
      scope: 'session',
      rule,
      reason: `Approved for this session: ${rule}`,
    }
  }
  if (normalized === 'r' || normalized === 'rule') {
    const defaultRule = event.suggestedRule ?? defaultPermissionRule(event)
    const ruleAnswer = await questionWithAbort(
      rl,
      chalk.yellow(`Allow rule (default: ${defaultRule}): `),
      signal,
    )
    const rule = ruleAnswer.trim() || defaultRule
    return {
      approved: true,
      scope: 'rule',
      rule,
      reason: `Approved with rule: ${rule}`,
    }
  }
  if (normalized === 'n' || normalized === 'no' || normalized === 'reject') {
    const reason = await questionWithAbort(
      rl,
      chalk.yellow('Reason, or press Enter to reject: '),
      signal,
    )
    return {
      approved: false,
      scope: 'once',
      reason: reason.trim() || 'Denied by user',
      ...(reason.trim() && { feedback: reason.trim() }),
    }
  }
  return {
    approved: true,
    scope: 'once',
    reason: 'Approved once from CLI',
  }
}

function renderCliPermissionRequest(event: PermissionDialogEvent): void {
  const tool = event.name ?? 'tool'
  const risk = event.risk ? ` (${event.risk} risk)` : ''
  const input = formatPermissionInput(event.input)
  console.error(chalk.yellow(`\nPermission required: ${tool}${risk}`))
  if (event.message) console.error(chalk.dim(event.message))
  if (input) console.error(`  ${input}`)
  const rule = event.suggestedRule ?? defaultPermissionRule(event)
  console.error(chalk.dim(`  suggested rule: ${rule}`))
}

function formatPermissionInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  if (typeof record.command === 'string') return record.command
  if (typeof record.path === 'string') return record.path
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

function defaultPermissionRule(event: PermissionDialogEvent): string {
  if (event.name === 'Bash') return 'bash:*'
  if (event.name && event.name.trim().length > 0) return `${event.name}:*`
  return '*'
}

function questionWithAbort(
  rl: CliReadline,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    rl.question(query, answer => {
      signal.removeEventListener('abort', onAbort)
      resolve(answer)
    })
  })
}

function abortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}
