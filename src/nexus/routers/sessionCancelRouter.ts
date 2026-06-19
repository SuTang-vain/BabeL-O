import { z } from 'zod'
import { ConfigManager } from '../../shared/config.js'
import { closeNexusSession } from '../sessionLifecycle.js'
import type { FeatureRouter } from '../router.js'

const sessionCancelSchema = z.object({
  reason: z.string().optional(),
})

export const sessionCancelRouter: FeatureRouter = {
  name: 'sessionCancelRouter',
  register(app, context) {
    app.post('/v1/sessions/:sessionId/cancel', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const body = sessionCancelSchema.parse(request.body ?? {})
      const activeExecution = context.cancelActiveExecution?.(params.sessionId) ?? null
      const { session, permissionsResolved, childSessionsCancelled } = await closeNexusSession({
        storage: context.options.storage,
        sessionId: params.sessionId,
        phase: 'cancelled',
        reason: body.reason ?? 'Session cancelled',
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
        type: 'session_cancelled',
        sessionId: params.sessionId,
        phase: session.phase,
        activeExecutionCancelled: activeExecution !== null,
        requestId: activeExecution?.requestId,
        transport: activeExecution?.transport,
        permissionsResolved,
        childSessionsCancelled,
      }
    })
  },
}
