import { z } from 'zod'
import type { FeatureRouter } from '../router.js'

const booleanQuery = (defaultValue: boolean) =>
  z.preprocess(value => {
    if (value === undefined) return defaultValue
    if (value === true || value === 'true' || value === '1') return true
    if (value === false || value === 'false' || value === '0') return false
    return value
  }, z.boolean())

const childSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(200),
  eventLimit: z.coerce.number().int().min(0).max(100).default(5),
  failedOnly: booleanQuery(false),
  includeEvents: booleanQuery(true),
})

const eventListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
})

export const sessionChildrenRouter: FeatureRouter = {
  name: 'sessionChildrenRouter',
  register(app, context) {
    app.get('/v1/sessions/:sessionId/children', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const query = childSessionsQuerySchema.parse(request.query)
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

      const childSessions = (
        await context.options.storage.listChildSessions(params.sessionId, {
          limit: query.limit,
          includeEvents: false,
        })
      ).filter(child => !query.failedOnly || child.phase === 'failed' || child.phase === 'cancelled' || child.metadata?.status === 'failed' || child.metadata?.status === 'cancelled')

      const children = await Promise.all(
        childSessions.map(async child => {
          const page =
            query.includeEvents && query.eventLimit > 0
              ? await context.options.storage.listEvents(child.sessionId, {
                  limit: query.eventLimit,
                  order: 'desc',
                })
              : undefined
          return {
            session: { ...child, events: [] },
            transcriptPath: typeof child.metadata?.transcriptPath === 'string' ? child.metadata.transcriptPath : `nexus://sessions/${child.sessionId}/events`,
            events: page
              ? {
                  items: [...page.events].reverse(),
                  truncated: page.nextCursor !== undefined,
                  limit: query.eventLimit,
                  order: 'asc',
                }
              : undefined,
          }
        }),
      )

      return {
        type: 'child_sessions',
        sessionId: params.sessionId,
        children,
        limit: query.limit,
        eventLimit: query.eventLimit,
      }
    })

    app.get('/v1/sessions/:sessionId/children/:childSessionId/events', async (request, reply) => {
      const params = z.object({ sessionId: z.string(), childSessionId: z.string() }).parse(request.params)
      const query = eventListQuerySchema.parse(request.query)
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
      const child = await context.options.storage.getSession(params.childSessionId, {
        includeEvents: false,
      })
      if (!child || child.parentSessionId !== params.sessionId) {
        return reply.code(404).send({
          type: 'error',
          code: 'CHILD_SESSION_NOT_FOUND',
          message: `Child session not found: ${params.childSessionId}`,
        })
      }
      const page = await context.options.storage.listEvents(params.childSessionId, query)
      return {
        type: 'child_session_events',
        sessionId: params.sessionId,
        childSessionId: params.childSessionId,
        transcriptPath: typeof child.metadata?.transcriptPath === 'string' ? child.metadata.transcriptPath : `nexus://sessions/${child.sessionId}/events`,
        events: page.events,
        nextCursor: page.nextCursor,
        order: query.order,
        limit: query.limit,
      }
    })
  },
}
