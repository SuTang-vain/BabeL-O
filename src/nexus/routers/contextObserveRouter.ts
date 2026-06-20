import { defaultContextBroadcaster, redactContext, type RedactionMode } from '../contextBroadcaster.js'
import type { FeatureRouter } from '../router.js'

type WebSocketLike = {
  OPEN: number
  readyState: number
  close(code?: number, reason?: string): void
  send(payload: string): void
}

// R4 of docs/nexus/proposals/long-running-context-assembly.md §20:
// Redact large text fields (systemPrompt, messages) by default. The
// default `summary` mode replaces them with a length-only metadata
// block so observers (TUI, dashboards) can show context size without
// leaking the actual prompt text. `?full=1` opts in to the verbatim
// context for local/debug consumers. This is a default-on policy: an
// observer that wants the raw prompt must explicitly opt in.
function parseRedactionMode(query: Record<string, string | undefined>): RedactionMode {
  if (query.full === '1' || query.full === 'true') return 'full'
  return 'summary'
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
      const redactionMode = parseRedactionMode(q)

      const broadcaster = contextBroadcaster
      const last = sessionId ? broadcaster.getLast(cwd, sessionId) : undefined
      sendJson(socket, {
        type: 'assembled_snapshot',
        cwd,
        filter: { sessionId: sessionId ?? null },
        redaction: redactionMode,
        // Per R4: even the initial snapshot is redacted. The `context`
        // field is null when no event has been published for this pair
        // yet; the redaction contract applies to the populated case.
        context: last ? redactContext(last, redactionMode) : null,
      })

      const handler = (event: { type: string; sessionId: string; context: unknown; timestamp: string }) => {
        if (event.type !== 'assembled') return
        if (sessionId && event.sessionId !== sessionId) return
        const eventContext = event.context as Parameters<typeof redactContext>[0]
        sendJson(socket, {
          type: 'assembled',
          cwd,
          sessionId: event.sessionId,
          redaction: redactionMode,
          context: redactContext(eventContext, redactionMode),
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
