import { z } from 'zod'
import { goTuiClientSessionPersistenceHint, isGoTuiClientSessionId } from '../../shared/session.js'
import { buildSessionAssetsSnapshot } from '../sessionAssets.js'
import type { FeatureRouter } from '../router.js'

const eventListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
})

const sessionDetailQuerySchema = z.object({
  recentEventLimit: z.coerce.number().int().min(0).max(500).default(100),
})

const booleanQuery = (defaultValue: boolean) =>
  z.preprocess(value => {
    if (value === undefined) return defaultValue
    if (value === true || value === 'true' || value === '1') return true
    if (value === false || value === 'false' || value === '0') return false
    return value
  }, z.boolean())

const sessionAssetsQuerySchema = z.object({
  eventLimit: z.coerce.number().int().min(0).max(500).default(200),
  toolTraceLimit: z.coerce.number().int().min(0).max(500).default(200),
  childSessionLimit: z.coerce.number().int().min(0).max(500).default(200),
  includeEvents: booleanQuery(true),
  includeToolTraces: booleanQuery(true),
  includePermissionAudits: booleanQuery(true),
  includeExecutionMetrics: booleanQuery(true),
})

export const sessionReadRouter: FeatureRouter = {
  name: 'sessionReadRouter',
  register(app, context) {
    app.get('/v1/sessions', async request => {
      const query = z
        .object({
          limit: z.coerce.number().int().positive().max(200).default(50),
        })
        .parse(request.query)
      return {
        type: 'sessions_list',
        sessions: await context.options.storage.listSessions({ limit: query.limit }),
      }
    })

    app.get('/v1/sessions/:sessionId', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const query = sessionDetailQuerySchema.parse(request.query)
      const session = await context.options.storage.getSession(params.sessionId, {
        includeEvents: false,
      })
      if (!session) {
        if (isGoTuiClientSessionId(params.sessionId)) {
          return reply.code(404).send({
            type: 'error',
            code: 'SESSION_NOT_FOUND',
            subtype: 'go_tui_client_placeholder',
            message: goTuiClientSessionPersistenceHint(params.sessionId),
            hint: goTuiClientSessionPersistenceHint(params.sessionId),
            sessionId: params.sessionId,
          })
        }
        return reply.code(404).send({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: `Session not found: ${params.sessionId}`,
        })
      }
      const eventPage =
        query.recentEventLimit > 0
          ? await context.options.storage.listEvents(params.sessionId, {
              limit: query.recentEventLimit,
              order: 'desc',
            })
          : { events: [] }
      return {
        type: 'session',
        session: {
          ...session,
          events: [...eventPage.events].reverse(),
        },
        eventsTruncated: eventPage.nextCursor !== undefined,
        recentEventLimit: query.recentEventLimit,
      }
    })

    app.get('/v1/sessions/:sessionId/assets', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const query = sessionAssetsQuerySchema.parse(request.query)
      const snapshot = await buildSessionAssetsSnapshot({
        storage: context.options.storage,
        sessionId: params.sessionId,
        assetOptions: query,
      })
      if (!snapshot) {
        return reply.code(404).send({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: `Session not found: ${params.sessionId}`,
        })
      }
      return snapshot
    })

    app.get('/v1/sessions/:sessionId/events', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
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
      const page = await context.options.storage.listEvents(params.sessionId, query)
      return {
        type: 'session_events',
        sessionId: params.sessionId,
        events: page.events,
        nextCursor: page.nextCursor,
        order: query.order,
        limit: query.limit,
      }
    })
  },
}
