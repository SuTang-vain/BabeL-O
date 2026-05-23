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
import {
  CliReadline,
  sessionPermissionApprovals,
  PermissionDecision,
  askPermission,
  handleLocalPermissionRequest
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
              const cached = data.name ? sessionPermissionApprovals.get(data.sessionId)?.has(data.name) : false
              const decision: PermissionDecision = cached
                ? { approved: true, scope: 'session' }
                : await askPermission(rl, data, abortController.signal)
              if (decision.approved && decision.scope === 'session' && data.name) {
                const tools = sessionPermissionApprovals.get(data.sessionId) ?? new Set<string>()
                tools.add(data.name)
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
    const { runtime, storage } = await createDefaultNexusRuntime({
      storagePath,
      allowedTools: ['*'],
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
    if (!session) {
      session = {
        sessionId,
        cwd,
        prompt,
        phase: 'executing' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: [],
      }
    } else {
      session.phase = 'executing'
      session.updatedAt = new Date().toISOString()
      session.lastUserInput = prompt
    }
    await storage.saveSession(session)

    await storage.appendEvent(sessionId, {
      type: 'user_message',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId,
      timestamp: new Date().toISOString(),
      text: prompt,
    })

    try {
      const configManager = ConfigManager.getInstance()
      const settings = configManager.resolveSettings()
      const requestId = createId('req')
      const budget = process.env.BABEL_O_THINKING_BUDGET
        ? parseInt(process.env.BABEL_O_THINKING_BUDGET, 10)
        : undefined

      for await (const event of runtime.executeStream({
        sessionId,
        prompt,
        cwd,
        signal: abortController.signal,
        requestId,
        model: settings.modelId,
        budget,
      })) {
        await storage.appendEvent(sessionId, event)
      }
    } catch (err: any) {
      if (err.message !== 'Aborted' && err.name !== 'AbortError') {
        throw err
      }
    } finally {
      const finalSession = await storage.getSession(sessionId, { includeEvents: false })
      if (finalSession) {
        if (abortController.signal.aborted) {
          finalSession.phase = 'cancelled'
        } else {
          const eventsResult = await storage.listEvents(sessionId, { limit: 100 })
          const events = eventsResult.events
          const errorEvent = events.findLast(e => e.type === 'error')
          const resultEvent = events.findLast(e => e.type === 'result')
          const succeeded = !errorEvent && resultEvent?.type === 'result' && resultEvent.success
          finalSession.phase = succeeded ? 'completed' : 'failed'
          if (resultEvent?.type === 'result') finalSession.result = resultEvent.message
          if (errorEvent?.type === 'error') finalSession.error = errorEvent.message
        }
        finalSession.updatedAt = new Date().toISOString()
        await storage.saveSession(finalSession)
      }
      await storage.close?.()
    }
    return sessionId
  }
}
