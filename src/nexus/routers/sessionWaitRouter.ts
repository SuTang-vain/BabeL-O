import { z } from 'zod'
import type { NexusEvent } from '../../shared/events.js'
import type { FeatureRouter } from '../router.js'

const waitQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  match: z.string().min(1).max(2048).optional(),
  types: z.string().min(1).max(1024).optional(),
  timeout: z.coerce.number().int().min(0).max(60_000).default(0),
  limit: z.coerce.number().int().positive().max(500).default(200),
})

export const sessionWaitRouter: FeatureRouter = {
  name: 'sessionWaitRouter',
  register(app, context) {
    app.get('/v1/sessions/:sessionId/wait', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const query = waitQuerySchema.parse(request.query)
      const session = await context.options.storage.getSession(params.sessionId, {
        includeEvents: false,
      })
      if (!session) {
        return reply.code(404).send({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: `Session not found: ${params.sessionId}`,
        })
      }
      const allowedTypes = query.types
        ? new Set(
            query.types
              .split(',')
              .map(value => value.trim())
              .filter(Boolean),
          )
        : null
      const matcher = query.match ? new RegExp(escapeRegExpForWait(query.match)) : null

      const pollOnce = async (): Promise<{
        events: NexusEvent[]
        lastSeq: number
      }> => {
        const page = await context.options.storage.listEvents(params.sessionId, {
          order: 'asc',
          limit: query.limit,
          cursor: query.since > 0 ? String(query.since) : undefined,
        })
        const filtered: NexusEvent[] = []
        for (const event of page.events) {
          if (allowedTypes && !allowedTypes.has(event.type)) continue
          if (matcher && !matcher.test(JSON.stringify(event))) continue
          filtered.push(event)
        }
        return {
          events: filtered,
          lastSeq: page.lastSeq ?? query.since,
        }
      }

      const initial = await pollOnce()
      if (initial.events.length > 0 || query.timeout === 0) {
        return {
          type: 'session_wait',
          sessionId: params.sessionId,
          events: initial.events,
          nextRevision: String(initial.lastSeq),
          matched: initial.events.length > 0,
          order: 'asc',
          limit: query.limit,
        }
      }

      const deadline = Date.now() + query.timeout
      const intervalMs = 250
      while (Date.now() < deadline) {
        const remaining = Math.max(0, deadline - Date.now())
        await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)))
        const tick = await pollOnce()
        if (tick.events.length > 0) {
          return {
            type: 'session_wait',
            sessionId: params.sessionId,
            events: tick.events,
            nextRevision: String(tick.lastSeq),
            matched: true,
            order: 'asc',
            limit: query.limit,
          }
        }
      }

      return {
        type: 'session_wait',
        sessionId: params.sessionId,
        events: [],
        nextRevision: String(initial.lastSeq),
        matched: false,
        order: 'asc',
        limit: query.limit,
      }
    })
  },
}

function escapeRegExpForWait(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
