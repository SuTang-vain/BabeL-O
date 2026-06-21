import { PersistedWorkingSetTracker } from '../../runtime/persistedWorkingSetTracker.js'
import type { FeatureRouter } from '../router.js'

export type WorkingSetSession = {
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
}

export type WorkspaceEntryContributor = {
  sessionId: string
  value: string
  updatedAt: string
  confidence: number
}

export type WorkspaceAggregatedEntry = {
  key: string
  contributors: WorkspaceEntryContributor[]
}

export async function runWorkingSetList({ cwd }: { cwd: string }): Promise<{
  type: 'working_set_list'
  cwd: string
  sessions: WorkingSetSession[]
}> {
  const tracker = new PersistedWorkingSetTracker(cwd)
  await tracker.load()
  const sessions: WorkingSetSession[] = []
  for (const [sessionId, ws] of tracker.entries()) {
    sessions.push({
      sessionId,
      workspaceId: ws.workspaceId,
      version: ws.version,
      updatedAt: ws.updatedAt,
      entries: ws.entries,
    })
  }
  return { type: 'working_set_list', cwd, sessions }
}

export async function runWorkingSetGet({ cwd, sessionId }: { cwd: string; sessionId: string }): Promise<{
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
  const ws = tracker.get(sessionId)
  if (!ws) {
    throw new Error(`session not found: ${sessionId}`)
  }
  return {
    type: 'working_set_session',
    cwd,
    sessionId,
    workspaceId: ws.workspaceId,
    version: ws.version,
    updatedAt: ws.updatedAt,
    entries: ws.entries,
  }
}

export async function runWorkspaceWorkingSetGet({ cwd, workspaceId }: { cwd: string; workspaceId: string }): Promise<{
  type: 'workspace_working_set'
  cwd: string
  workspaceId: string
  sessions: WorkingSetSession[]
  aggregateEntries: WorkspaceAggregatedEntry[]
}> {
  const tracker = new PersistedWorkingSetTracker(cwd)
  await tracker.load()
  const sessions: WorkingSetSession[] = []
  for (const [sessionId, ws] of tracker.entries()) {
    if (ws.workspaceId === workspaceId) {
      sessions.push({
        sessionId,
        workspaceId: ws.workspaceId,
        version: ws.version,
        updatedAt: ws.updatedAt,
        entries: ws.entries,
      })
    }
  }

  const byKey = new Map<string, WorkspaceEntryContributor[]>()
  for (const session of sessions) {
    for (const entry of session.entries) {
      const list = byKey.get(entry.key) ?? []
      list.push({
        sessionId: session.sessionId,
        value: entry.value,
        updatedAt: entry.updatedAt,
        confidence: entry.confidence,
      })
      byKey.set(entry.key, list)
    }
  }
  const aggregateEntries: WorkspaceAggregatedEntry[] = []
  for (const [key, contributors] of byKey.entries()) {
    aggregateEntries.push({ key, contributors })
  }
  aggregateEntries.sort((a, b) => a.key.localeCompare(b.key))

  return {
    type: 'workspace_working_set',
    cwd,
    workspaceId,
    sessions,
    aggregateEntries,
  }
}

export const contextWorkingSetReadRouter: FeatureRouter = {
  name: 'contextWorkingSetReadRouter',
  register(app) {
    // PR-12: Track A Phase 2 — read-only context working-set endpoints.
    app.get('/v1/context/working-set', async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, string | undefined>
      const cwd = q.cwd
      if (!cwd) {
        return reply.code(400).send({ error: 'cwd query param is required' })
      }
      return await runWorkingSetList({ cwd })
    })

    app.get('/v1/context/working-set/:sessionId', async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, string | undefined>
      const cwd = q.cwd
      if (!cwd) {
        return reply.code(400).send({ error: 'cwd query param is required' })
      }
      const sessionId = (request.params as { sessionId: string }).sessionId
      return await runWorkingSetGet({ cwd, sessionId })
    })

    // PR-20: Track A Phase 3 — workspace aggregate working-set read.
    app.get('/v1/context/working-set/workspace/:wsId', async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, string | undefined>
      const cwd = q.cwd
      if (!cwd) {
        return reply.code(400).send({ error: 'cwd query param is required' })
      }
      const workspaceId = (request.params as { wsId: string }).wsId
      if (!workspaceId) {
        return reply.code(400).send({ error: 'workspaceId path param is required' })
      }
      return await runWorkspaceWorkingSetGet({ cwd, workspaceId })
    })
  },
}
