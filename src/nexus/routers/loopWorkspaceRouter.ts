import { z } from 'zod'
import type { FeatureRouter } from '../router.js'

const loopWorkspaceQuerySchema = z.object({
  workspaceId: z.string().max(128).optional(),
  sessionId: z.string().max(256).optional(),
})

export const loopWorkspaceRouter: FeatureRouter = {
  name: 'loopWorkspaceRouter',
  register(app, context) {
    app.get('/v1/loop/workspaces', async request => {
      const query = loopWorkspaceQuerySchema.parse(request.query)
      const panes = await context.options.storage.listLoopPanes({
        workspaceId: query.workspaceId,
        sessionId: query.sessionId,
      })
      return {
        type: 'loop_workspaces',
        panes,
        filter: {
          workspaceId: query.workspaceId ?? null,
          sessionId: query.sessionId ?? null,
        },
      }
    })
  },
}
