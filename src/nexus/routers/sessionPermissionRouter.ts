import { z } from 'zod'
import { PendingPermissionRegistry } from '../../shared/session.js'
import type { FeatureRouter } from '../router.js'

const permissionApproveSchema = z.object({
  toolUseId: z.string(),
  scope: z.enum(['once', 'session', 'rule']).optional(),
  rule: z.string().optional(),
  feedback: z.string().optional(),
})

const permissionDenySchema = z.object({
  toolUseId: z.string(),
  reason: z.string().optional(),
  scope: z.enum(['once', 'session', 'rule']).optional(),
  rule: z.string().optional(),
  feedback: z.string().optional(),
})

function permissionRequestNotFound(sessionId: string, toolUseId: string) {
  return {
    type: 'error',
    code: 'PERMISSION_REQUEST_NOT_FOUND',
    message: `No pending permission request found for session ${sessionId} and tool use ${toolUseId}`,
  }
}

export const sessionPermissionRouter: FeatureRouter = {
  name: 'sessionPermissionRouter',
  register(app) {
    app.post('/v1/sessions/:sessionId/approve', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const body = permissionApproveSchema.parse(request.body)
      const resolved = PendingPermissionRegistry.getInstance().resolve(params.sessionId, body.toolUseId, {
        approved: true,
        scope: body.scope ?? 'once',
        ...(body.rule && { rule: body.rule }),
        ...(body.feedback && { feedback: body.feedback }),
      })
      if (!resolved) {
        return reply.code(404).send(permissionRequestNotFound(params.sessionId, body.toolUseId))
      }
      return {
        type: 'permission_resolved',
        sessionId: params.sessionId,
        toolUseId: body.toolUseId,
        approved: true,
        scope: body.scope ?? 'once',
        ...(body.rule && { rule: body.rule }),
        ...(body.feedback && { feedback: body.feedback }),
      }
    })

    app.post('/v1/sessions/:sessionId/deny', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const body = permissionDenySchema.parse(request.body)
      const resolved = PendingPermissionRegistry.getInstance().resolve(params.sessionId, body.toolUseId, {
        approved: false,
        reason: body.reason,
        ...(body.scope && { scope: body.scope }),
        ...(body.rule && { rule: body.rule }),
        ...(body.feedback && { feedback: body.feedback }),
      })
      if (!resolved) {
        return reply.code(404).send(permissionRequestNotFound(params.sessionId, body.toolUseId))
      }
      return {
        type: 'permission_resolved',
        sessionId: params.sessionId,
        toolUseId: body.toolUseId,
        approved: false,
        ...(body.reason && { reason: body.reason }),
        ...(body.feedback && { feedback: body.feedback }),
      }
    })
  },
}
