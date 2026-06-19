import { PersistedWorkingSetTracker } from '../../runtime/persistedWorkingSetTracker.js'
import type { FeatureRouter } from '../router.js'

export const contextWorkingSetWriteRouter: FeatureRouter = {
  name: 'contextWorkingSetWriteRouter',
  register(app) {
    app.put('/v1/context/working-set/:sessionId', async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, string | undefined>
      const cwd = q.cwd
      if (!cwd) {
        return reply.code(400).send({ error: 'cwd query param is required' })
      }
      const sessionId = (request.params as { sessionId: string }).sessionId
      const body = (request.body ?? {}) as {
        workspaceId?: string
        entries?: Array<{
          key?: unknown
          value?: unknown
          updatedAt?: unknown
          confidence?: unknown
        }>
      }
      if (!Array.isArray(body.entries)) {
        return reply.code(400).send({ error: 'body.entries must be an array' })
      }
      const validated: Array<{
        key: string
        value: string
        updatedAt: string
        confidence: number
      }> = []
      for (let i = 0; i < body.entries.length; i++) {
        const e = body.entries[i]!
        if (typeof e.key !== 'string' || e.key.length === 0) {
          return reply.code(400).send({ error: `entries[${i}].key must be a non-empty string` })
        }
        if (typeof e.value !== 'string') {
          return reply.code(400).send({ error: `entries[${i}].value must be a string` })
        }
        if (e.updatedAt !== undefined && typeof e.updatedAt !== 'string') {
          return reply.code(400).send({
            error: `entries[${i}].updatedAt must be a string when present`,
          })
        }
        if (e.confidence !== undefined && (typeof e.confidence !== 'number' || e.confidence < 0 || e.confidence > 1)) {
          return reply.code(400).send({
            error: `entries[${i}].confidence must be a number in [0,1]`,
          })
        }
        validated.push({
          key: e.key,
          value: e.value,
          updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date().toISOString(),
          confidence: typeof e.confidence === 'number' ? e.confidence : 1,
        })
      }
      return await runWorkingSetPut({
        cwd,
        sessionId,
        workspaceId: body.workspaceId,
        entries: validated,
      })
    })
  },
}

// Per design §7.3 row "GET / PUT" + user explicit approval (2026-06-17).
// Write op: replaces a session's working set entries and auto-persists.
// Caller submits the full desired entries set (write-through, not a delta).
export async function runWorkingSetPut({
  cwd,
  sessionId,
  workspaceId,
  entries,
}: {
  cwd: string
  sessionId: string
  workspaceId?: string
  entries: Array<{
    key: string
    value: string
    updatedAt: string
    confidence: number
  }>
}): Promise<{
  type: 'working_set_session'
  cwd: string
  sessionId: string
  workspaceId: string
  version: number
  updatedAt: string
  entries: Array<{
    key: string
    value: string
    updatedAt: string
    confidence: number
  }>
}> {
  const tracker = new PersistedWorkingSetTracker(cwd)
  await tracker.load()
  const prev = tracker.get(sessionId)
  const resolvedWorkspaceId = workspaceId ?? prev?.workspaceId ?? ''
  const updated = tracker.update(sessionId, {
    workspaceId: resolvedWorkspaceId,
    entries,
  })
  await tracker.flush()
  return {
    type: 'working_set_session',
    cwd,
    sessionId,
    workspaceId: updated.workspaceId,
    version: updated.version,
    updatedAt: updated.updatedAt,
    entries: updated.entries,
  }
}
