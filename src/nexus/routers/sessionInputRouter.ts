import { z } from 'zod'
import { eventBase, type NexusEvent } from '../../shared/events.js'
import { PendingPermissionRegistry } from '../../shared/session.js'
import type { FeatureRouter } from '../router.js'

const sessionInputSchema = z.object({
  message: z.string().min(1),
  nextPhase: z.enum(['created', 'executing', 'waiting_permission', 'completed', 'failed', 'cancelled']).optional(),
})

export const sessionInputRouter: FeatureRouter = {
  name: 'sessionInputRouter',
  register(app, context) {
    app.post('/v1/sessions/:sessionId/input', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const body = sessionInputSchema.parse(request.body)
      const session = await context.options.storage.getSession(params.sessionId)
      if (!session) {
        return reply.code(404).send({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: `Session not found: ${params.sessionId}`,
        })
      }

      if (session.phase === 'waiting_permission') {
        const lowerMessage = body.message.trim().toLowerCase()
        const approved = ['y', 'yes', 'approve', 'ok', 'true'].includes(lowerMessage)
        PendingPermissionRegistry.getInstance().resolveSession(params.sessionId, {
          approved,
          reason: approved ? undefined : body.message,
        })
      }

      const event: NexusEvent = {
        type: 'user_message',
        ...eventBase(params.sessionId),
        text: body.message,
      }
      session.lastUserInput = body.message
      session.phase = body.nextPhase ?? 'executing'
      session.updatedAt = event.timestamp
      await context.options.storage.saveSession(session)
      await context.options.storage.appendEvent(params.sessionId, event)

      return {
        type: 'session_input_accepted',
        sessionId: params.sessionId,
        phase: session.phase,
      }
    })
  },
}
