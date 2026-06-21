import { z } from 'zod'
import type { FeatureRouter } from '../router.js'

const loopPaneUpsertSchema = z.object({
  paneId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  tabId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(256),
  agent: z.string().min(1).max(64),
  cwd: z.string().min(1).max(4096),
  label: z.string().max(256).nullable().optional(),
  lastRev: z.number().int().min(0).default(0),
})

const loopPaneParamsSchema = z.object({
  workspaceId: z.string(),
  tabId: z.string(),
  paneId: z.string(),
})

const loopPanePatchSchema = z.object({
  label: z.string().max(256).nullable().optional(),
  lastRev: z.number().int().min(0).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  sessionId: z.string().min(1).max(256).optional(),
})

export const loopPaneRouter: FeatureRouter = {
  name: 'loopPaneRouter',
  register(app, context) {
    app.post('/v1/loop/workspaces/:workspaceId/panes', async (request, reply) => {
      const params = z.object({ workspaceId: z.string() }).parse(request.params)
      const body = loopPaneUpsertSchema.parse(request.body)
      if (body.workspaceId !== params.workspaceId) {
        return reply.code(400).send({
          type: 'error',
          code: 'WORKSPACE_MISMATCH',
          message: `workspaceId in body (${body.workspaceId}) does not match URL (${params.workspaceId}).`,
        })
      }
      const pane = await context.options.storage.upsertLoopPane({
        paneId: body.paneId,
        workspaceId: body.workspaceId,
        tabId: body.tabId,
        sessionId: body.sessionId,
        agent: body.agent,
        cwd: body.cwd,
        label: body.label ?? null,
        lastRev: body.lastRev,
        updatedAt: new Date().toISOString(),
      })
      return { type: 'loop_pane', pane }
    })

    app.patch('/v1/loop/workspaces/:workspaceId/tabs/:tabId/panes/:paneId', async (request, reply) => {
      const params = loopPaneParamsSchema.parse(request.params)
      const body = loopPanePatchSchema.parse(request.body)
      const existing = await context.options.storage.listLoopPanes({
        paneId: params.paneId,
      })
      const current = existing[0]
      if (!current) {
        return reply.code(404).send(createPaneNotFoundPayload(params.paneId))
      }
      const merged: typeof current = {
        ...current,
        workspaceId: params.workspaceId,
        tabId: params.tabId,
        label: body.label === undefined ? current.label : body.label,
        cwd: body.cwd ?? current.cwd,
        sessionId: body.sessionId ?? current.sessionId,
        lastRev: body.lastRev ?? current.lastRev,
        updatedAt: new Date().toISOString(),
      }
      await context.options.storage.upsertLoopPane(merged)
      return { type: 'loop_pane', pane: merged }
    })

    app.delete('/v1/loop/workspaces/:workspaceId/tabs/:tabId/panes/:paneId', async (request, reply) => {
      const params = loopPaneParamsSchema.parse(request.params)
      const deleted = await context.options.storage.deleteLoopPane(params.paneId)
      if (!deleted) {
        return reply.code(404).send(createPaneNotFoundPayload(params.paneId))
      }
      return { type: 'loop_pane_deleted', paneId: params.paneId }
    })
  },
}

function createPaneNotFoundPayload(paneId: string): {
  type: 'error'
  code: string
  message: string
} {
  return {
    type: 'error',
    code: 'PANE_NOT_FOUND',
    message: `Pane not found: ${paneId}`,
  }
}
