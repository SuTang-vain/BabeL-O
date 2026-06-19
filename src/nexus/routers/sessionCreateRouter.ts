import { z } from 'zod'
import { createId } from '../../shared/id.js'
import type { SessionSnapshot } from '../../shared/session.js'
import type { FeatureRouter } from '../router.js'

const createSessionSchema = z.object({
  cwd: z.string().optional(),
  clientSessionId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const sessionCreateRouter: FeatureRouter = {
  name: 'sessionCreateRouter',
  register(app, context) {
    // Phase 1 of docs/nexus/reference/go-tui-session-observability-governance-plan.md:
    // allocate a canonical server-side session id while preserving an optional
    // clientSessionId back-reference for Go TUI / inspect-session lookups.
    app.post('/v1/sessions', async (request, reply) => {
      const body = createSessionSchema.parse(request.body ?? {})
      const sessionId = createId('session')
      const now = new Date().toISOString()
      const sessionMeta: Record<string, unknown> = { ...(body.metadata ?? {}) }
      if (body.clientSessionId) {
        sessionMeta.clientSessionId = body.clientSessionId
        sessionMeta.clientSessionIdSetAt = now
      }
      const cwd = body.cwd ?? context.options.defaultCwd
      const session: SessionSnapshot = {
        sessionId,
        cwd,
        prompt: '',
        phase: 'created',
        createdAt: now,
        updatedAt: now,
        events: [],
        originCwd: cwd,
        ...(Object.keys(sessionMeta).length > 0 && { metadata: sessionMeta }),
      }
      await context.options.storage.saveSession(session)
      return reply.code(201).send({
        type: 'session_created',
        sessionId,
        clientSessionId: body.clientSessionId,
        createdAt: now,
      })
    })
  },
}
