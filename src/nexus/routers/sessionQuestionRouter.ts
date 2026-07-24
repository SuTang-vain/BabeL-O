import { z } from 'zod'
import { eventBase } from '../../shared/events.js'
import type { FeatureRouter } from '../router.js'

const questionResponseSchema = z.object({
  toolUseId: z.string(),
  // Accept null (Go nil slices marshal to JSON null) and coerce to
  // empty arrays so a cancelled question doesn't 400 the HTTP
  // endpoint and leave the runtime's waitForQuestionResponse polling
  // until its 180s deadline.
  selectedIndices: z.array(z.number().int().min(0)).nullish().transform(v => v ?? []),
  selectedLabels: z.array(z.string()).nullish().transform(v => v ?? []),
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
