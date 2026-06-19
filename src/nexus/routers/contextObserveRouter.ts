import { defaultContextBroadcaster } from '../contextBroadcaster.js'
import type { FeatureRouter } from '../router.js'

type WebSocketLike = {
  OPEN: number
  readyState: number
  close(code?: number, reason?: string): void
  send(payload: string): void
}

export const contextObserveRouter: FeatureRouter = {
  name: 'contextObserveRouter',
  register(app, context) {
    const contextBroadcaster = context.options.contextBroadcaster ?? defaultContextBroadcaster

    app.get('/v1/context/observe', { websocket: true }, async (socket, request) => {
      const q = (request.query ?? {}) as Record<string, string | undefined>
      const cwd = typeof q.cwd === 'string' ? q.cwd : undefined
      if (!cwd) {
        sendJson(socket, {
          type: 'error',
          code: 'MISSING_CWD',
          message: 'cwd query param is required',
        })
        socket.close(1008, 'missing cwd')
        return
      }
      const sessionId = typeof q.sessionId === 'string' ? q.sessionId : undefined

      const broadcaster = contextBroadcaster
      const last = sessionId ? broadcaster.getLast(cwd, sessionId) : undefined
      sendJson(socket, {
        type: 'assembled_snapshot',
        cwd,
        filter: { sessionId: sessionId ?? null },
        context: last ?? null,
      })

      const handler = (event: { type: string; sessionId: string; context: unknown; timestamp: string }) => {
        if (event.type !== 'assembled') return
        if (sessionId && event.sessionId !== sessionId) return
        sendJson(socket, {
          type: 'assembled',
          cwd,
          sessionId: event.sessionId,
          context: event.context,
          timestamp: event.timestamp,
        })
      }
      const unsubscribe = broadcaster.subscribe(cwd, handler)

      const cleanup = () => {
        try {
          unsubscribe()
        } catch {
          /* ignore */
        }
      }
      socket.once('close', cleanup)
      socket.once('error', cleanup)
    })
  },
}

function sendJson(socket: WebSocketLike, value: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(value))
  }
}
