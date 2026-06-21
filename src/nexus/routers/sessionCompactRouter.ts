import { z } from 'zod'
import { compactSession } from '../../runtime/compact.js'
import { assembleContext } from '../../runtime/contextAssembler.js'
import { buildSystemPrompt, mapEventsToMessages } from '../../runtime/LLMCodingRuntime.js'
import { buildPostCompactGroundingEvents } from '../../runtime/runtimePipeline.js'
import type { FeatureRouter } from '../router.js'

const sessionCompactSchema = z.object({
  modelId: z.string().optional(),
  trigger: z.enum(['manual', 'auto', 'reactive']).default('manual').optional(),
})

export const sessionCompactRouter: FeatureRouter = {
  name: 'sessionCompactRouter',
  register(app, context) {
    app.post('/v1/sessions/:sessionId/compact', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const body = sessionCompactSchema.parse(request.body ?? {})
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
      const initialPrompt = session.lastUserInput ?? session.prompt
      const result = await compactSession({
        storage: context.options.storage,
        sessionId: params.sessionId,
        modelId: body.modelId,
        trigger: body.trigger ?? 'manual',
        mapEventsToMessages,
        initialPrompt,
      })
      const persistedEvents = await context.options.storage.listEvents(params.sessionId, {
        order: 'asc',
        limit: 10_000,
      })
      const assembled = await assembleContext({
        runtimeOptions: {
          sessionId: params.sessionId,
          prompt: initialPrompt,
          cwd: session.cwd,
        },
        events: persistedEvents.events,
        modelId: body.modelId ?? 'local/coding-runtime',
        buildSystemPrompt,
        mapEventsToMessages,
      })
      const groundingEvents = buildPostCompactGroundingEvents({
        sessionId: params.sessionId,
        source: 'post_compact',
        boundaryId: result.contextEvent.boundaryId,
        gitStatus: assembled.gitStatus,
      })
      for (const event of groundingEvents) {
        await context.options.storage.appendEvent(params.sessionId, event)
      }
      return {
        type: 'compact_result',
        sessionId: params.sessionId,
        event: result.event,
        contextEvent: result.contextEvent,
        groundingEvents,
        beforeEventCount: result.beforeEventCount,
        afterEventCount: result.afterEventCount,
      }
    })
  },
}
