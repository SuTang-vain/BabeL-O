import { z } from 'zod'
import { eventBase } from '../../shared/events.js'
import type { FeatureRouter } from '../router.js'

const questionResponseSchema = z.object({
  toolUseId: z.string(),
  selectedIndices: z.array(z.number().int().min(0)),
  selectedLabels: z.array(z.string()),
})

export const sessionQuestionRouter: FeatureRouter = {
  name: 'sessionQuestionRouter',
  register(app, context) {
    app.post('/v1/sessions/:sessionId/questions/:toolUseId/response', async (request, reply) => {
      const params = z.object({ sessionId: z.string(), toolUseId: z.string() }).parse(request.params)
      const body = questionResponseSchema.parse(request.body)

      // Persist the response as an event so the runtime can pick it up.
      await context.options.storage.appendEvent(params.sessionId, {
        type: 'ask_user_question_response',
        ...eventBase(params.sessionId),
        toolUseId: params.toolUseId,
        selectedIndices: body.selectedIndices,
        selectedLabels: body.selectedLabels,
      })

      return {
        type: 'question_response_recorded',
        sessionId: params.sessionId,
        toolUseId: params.toolUseId,
        selectedIndices: body.selectedIndices,
        selectedLabels: body.selectedLabels,
      }
    })
  },
}