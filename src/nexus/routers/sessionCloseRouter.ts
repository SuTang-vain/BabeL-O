import { z } from 'zod'
import { ConfigManager } from '../../shared/config.js'
import { closeNexusSession } from '../sessionLifecycle.js'
import type { FeatureRouter } from '../router.js'

const sessionCloseSchema = z.object({
  phase: z.enum(['cancelled', 'completed', 'failed']).optional(),
  reason: z.string().optional(),
})

export const sessionCloseRouter: FeatureRouter = {
  name: 'sessionCloseRouter',
  register(app, context) {
    app.post('/v1/sessions/:sessionId/close', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const body = sessionCloseSchema.parse(request.body ?? {})
      const { session, permissionsResolved, childSessionsCancelled } = await closeNexusSession({
        storage: context.options.storage,
        sessionId: params.sessionId,
        phase: body.phase,
        reason: body.reason,
        hooks: ConfigManager.getInstance().load().hooks,
        everCore: context.options.everCoreConfig
          ? { client: context.options.everCoreClient, config: context.options.everCoreConfig }
          : undefined,
      })
      if (!session) {
        return reply.code(404).send({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: `Session not found: ${params.sessionId}`,
        })
      }
      return {
        type: 'session_closed',
        sessionId: params.sessionId,
        phase: session.phase,
        permissionsResolved,
        childSessionsCancelled,
      }
    })
  },
}
