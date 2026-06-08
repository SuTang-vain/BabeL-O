import * as fs from 'node:fs'
import * as path from 'node:path'
import chalk from 'chalk'
import { NexusClient } from './NexusClient.js'
import {
  renderEvent,
  startSession,
  stopSpinner
} from './renderEvents.js'
import { ConfigManager, DEFAULT_CONFIG_DIR } from '../shared/config.js'
import { createId } from '../shared/id.js'
import { PendingPermissionRegistry } from '../shared/session.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../shared/events.js'
import type { SessionPhase, TaskSessionTerminalReason } from '../shared/session.js'
import { executeRuntimeHooks } from '../runtime/hooks.js'
import { extractAbsolutePaths } from '../runtime/LLMCodingRuntime.js'
import { resolvePromptPath } from '../runtime/systemPromptBuilder.js'
import {
  CliReadline,
  sessionPermissionApprovals,
  isSessionPermissionCached,
  PermissionDecision,
  askPermission,
  handleLocalPermissionRequest,
  encodeSessionPermissionRule
} from './ui.js'

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
        socket?.send(JSON.stringify({ prompt, cwd, sessionId }))
      })

      socket.addEventListener('message', async (event: { data: string }) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'permission_request') {
            renderEvent(data)
            try {
              const cached = isSessionPermissionCached(data.sessionId, data)
              const decision: PermissionDecision = cached
                ? { approved: true, scope: 'session', reason: 'Approved from session permission cache' }
                : await askPermission(rl, data, abortController.signal)
              if (decision.approved && decision.scope === 'session' && data.name) {
                const tools = sessionPermissionApprovals.get(data.sessionId) ?? new Set<string>()
                if (decision.rule) {
                  tools.add(encodeSessionPermissionRule(data.name, decision.rule))
                } else {
                  tools.add(data.name)
                }
                sessionPermissionApprovals.set(data.sessionId, tools)
              }
              if (socket && socket.readyState === 1 /* OPEN */) {
                socket.send(JSON.stringify({
                  type: 'permission_response',
                  sessionId: data.sessionId,
                  toolUseId: data.toolUseId,
                  approved: decision.approved,
                  reason: decision.reason,
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
            renderEvent(data)
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
    const { configureEverCoreFromEnv } = await import('../nexus/everCoreConfig.js')
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
    const everCore = await configureEverCoreFromEnv(process.env, { cwd, providerSettings })
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
        renderEvent(ev)
        void handleLocalPermissionRequest(sid, ev, rl, abortController.signal).catch(err => {
          console.error(chalk.red(`Permission prompt error: ${err.message || err}`))
          PendingPermissionRegistry.getInstance().resolve(sid, ev.toolUseId, {
            approved: false,
            reason: 'Permission prompt failed',
          })
        })
      } else {
        renderEvent(ev)
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
    }
    PendingPermissionRegistry.getInstance().resolveSession(sessionId, {
      approved: false,
      reason: 'Session finished',
    })
    return sessionId
  }
}

function resolveCliRequestCwd(prompt: string, requestedCwd: string, sessionCwd?: string): string {
  const explicitCwd = resolveExplicitPromptCwd(prompt)
  if (explicitCwd) return explicitCwd
  return sessionCwd ?? requestedCwd
}

function resolveExplicitPromptCwd(prompt: string): string | undefined {
  for (const candidate of extractAbsolutePaths(prompt)) {
    const resolved = resolvePromptPath(candidate)
    if (!fs.existsSync(resolved)) continue
    try {
      const stat = fs.lstatSync(resolved)
      if (stat.isDirectory()) return resolved
    } catch {
      continue
    }
  }
  return undefined
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
