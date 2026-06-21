import { WorkingSetBroadcaster } from '../workingSetBroadcaster.js'
import type { FeatureRouter } from '../router.js'
import type { WorkingSetEvent } from '../../runtime/workingSetTracker.js'

type WebSocketLike = {
  OPEN: number
  readyState: number
  close(code?: number, reason?: string): void
  send(payload: string): void
}

export const workingSetObserveRouter: FeatureRouter = {
  name: 'workingSetObserveRouter',
  register(app, context) {
    const appBroadcaster = context.options.workingSetBroadcaster ?? new WorkingSetBroadcaster()

    app.get('/v1/working-set/observe', { websocket: true }, async (socket, request) => {
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

      const broadcaster = context.options.workingSetBroadcaster ?? appBroadcaster
      const entry = broadcaster.getOrCreateTracker(cwd)
      try {
        await entry.loadPromise
      } catch (err) {
        sendJson(socket, {
          type: 'error',
          code: 'LOAD_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
        socket.close(1011, 'load failed')
        return
      }

      const initialState: Array<{ sessionId: string; ws: unknown }> = []
      for (const [sid, ws] of entry.tracker.entries()) {
        if (sessionId && sid !== sessionId) continue
        initialState.push({ sessionId: sid, ws })
      }
      sendJson(socket, {
        type: 'working_set_snapshot',
        cwd,
        filter: { sessionId: sessionId ?? null },
        sessions: initialState,
      })

      const handler = (event: WorkingSetEvent) => {
        if (sessionId && event.sessionId !== sessionId) return
        if (event.type === 'working_set_updated') {
          sendJson(socket, {
            type: 'working_set_updated',
            sessionId: event.sessionId,
            workspaceId: event.workspaceId,
            ws: event.ws,
            timestamp: event.timestamp,
          })
        } else if (event.type === 'working_set_reset') {
          sendJson(socket, {
            type: 'working_set_reset',
            sessionId: event.sessionId,
            workspaceId: event.workspaceId,
            timestamp: event.timestamp,
          })
        }
      }
      const unsubscribe = entry.tracker.subscribe(handler)

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
