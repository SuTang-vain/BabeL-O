import { buildAssemblePreview, type AssembledContextPreview } from '../contextAssemblePreview.js'
import type { FeatureRouter } from '../router.js'

export type ContextAssembleScope = 'minimal' | 'standard' | 'full' | 'task' | 'workspace'

export type ContextAssembleParams = {
  cwd: string
  sessionId?: string
  scope: ContextAssembleScope
  maxTokens: number
}

const validScopes: ContextAssembleScope[] = ['minimal', 'standard', 'full', 'task', 'workspace']

export async function runContextAssemble(params: ContextAssembleParams): Promise<{
  type: 'context_assemble_result'
  cwd: string
  preview: AssembledContextPreview
}> {
  const preview = await buildAssemblePreview(params)
  return {
    type: 'context_assemble_result',
    cwd: params.cwd,
    preview,
  }
}

export const contextAssembleRouter: FeatureRouter = {
  name: 'contextAssembleRouter',
  register(app) {
    // PR-18: Track A Phase 3 — read-only manual context assembly.
    app.post('/v1/context/assemble', async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>
      const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
      if (!cwd) {
        return reply.code(400).send({ error: 'cwd is required in body' })
      }

      const scopeRaw = typeof body.scope === 'string' ? body.scope : 'standard'
      if (!validScopes.includes(scopeRaw as ContextAssembleScope)) {
        return reply.code(400).send({
          error: `Invalid scope: ${scopeRaw}. Must be one of: ${validScopes.join(', ')}`,
        })
      }

      const maxTokensRaw = body.maxTokens
      const maxTokens = typeof maxTokensRaw === 'number' ? maxTokensRaw : typeof maxTokensRaw === 'string' ? Number(maxTokensRaw) : 7500
      if (Number.isNaN(maxTokens) || maxTokens <= 0) {
        return reply.code(400).send({ error: 'maxTokens must be a positive number' })
      }

      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
      return await runContextAssemble({
        cwd,
        sessionId,
        scope: scopeRaw as ContextAssembleScope,
        maxTokens,
      })
    })
  },
}
