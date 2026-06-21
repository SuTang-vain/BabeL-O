import { z } from 'zod'
import type { FeatureRouter } from '../router.js'

const toolTraceListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
})

export const sessionInspectionRouter: FeatureRouter = {
  name: 'sessionInspectionRouter',
  register(app, context) {
    app.get('/v1/sessions/:sessionId/tool-traces', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const query = toolTraceListQuerySchema.parse(request.query)
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
      const page = await context.options.storage.listToolTraces(params.sessionId, query)
      return {
        type: 'tool_traces',
        sessionId: params.sessionId,
        traces: page.traces,
        nextCursor: page.nextCursor,
        order: query.order,
        limit: query.limit,
      }
    })

    app.get('/v1/sessions/:sessionId/permission-audits', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
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
      const audits = await context.options.storage.listPermissionAudits(params.sessionId)
      return {
        type: 'permission_audits',
        sessionId: params.sessionId,
        audits,
      }
    })
  },
}
