import { z } from 'zod'
import type { FeatureRouter } from '../router.js'

const sessionResumeSchema = z.object({
  recentEventLimit: z.number().int().min(0).max(500).default(100).optional(),
  includeTasks: z.boolean().default(true).optional(),
  includeChildSessions: z.boolean().default(true).optional(),
})

export const sessionResumeRouter: FeatureRouter = {
  name: 'sessionResumeRouter',
  register(app, context) {
    app.post('/v1/sessions/:sessionId/resume', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const body = sessionResumeSchema.parse(request.body ?? {})
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

      const eventPage = await context.options.storage.listEvents(params.sessionId, {
        limit: body.recentEventLimit ?? 100,
        order: 'desc',
      })
      const tasks = body.includeTasks === false ? [] : await context.options.storage.listTasks(params.sessionId)
      const childSessions =
        body.includeChildSessions === false
          ? []
          : await context.options.storage.listChildSessions(params.sessionId, {
              limit: 200,
              includeEvents: false,
            })
      const activeExecution = context.getActiveExecutionSnapshot?.(params.sessionId) ?? null

      return {
        type: 'session_resume_snapshot',
        sessionId: params.sessionId,
        session: {
          ...session,
          events: [...eventPage.events].reverse(),
        },
        eventsTruncated: eventPage.nextCursor !== undefined,
        recentEventLimit: body.recentEventLimit ?? 100,
        tasks,
        childSessions,
        activeExecution,
      }
    })
  },
}
