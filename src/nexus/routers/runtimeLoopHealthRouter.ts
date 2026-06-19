import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { applyBehaviorHint, derivePaneStatus } from '../../runtime/loopDiagnostics.js'
import { BEHAVIOR_TRACE_RELATIVE_PATH, type BehaviorTraceEntry } from '../../runtime/behaviorTrace.js'
import { type NexusEvent } from '../../shared/events.js'
import { errorMessage } from '../../shared/errors.js'
import { buildCacheHealthFromEvents } from '../cacheHealth.js'
import type { FeatureRouter } from '../router.js'

const loopHealthQuerySchema = z.object({
  workspaceId: z.string().max(128).optional(),
  paneId: z.string().max(128).optional(),
  sessionId: z.string().max(256).optional(),
  lastN: z.coerce.number().int().positive().max(1000).default(200),
})

export type TaskScopeSummary = {
  cwd: string
  primaryRoot: string
  explicitRoots: string[]
  confirmedExternalRoots: string[]
  inferredCandidateRoots: string[]
  mode: 'single_root' | 'multi_root' | 'cross_project'
  source: 'cwd' | 'prompt_paths' | 'user_confirmation' | 'session_metadata'
  latestDeclaredAt: string
}

export function summarizeTaskScope(events: NexusEvent[]): TaskScopeSummary {
  let summary: TaskScopeSummary = {
    cwd: '',
    primaryRoot: '',
    explicitRoots: [],
    confirmedExternalRoots: [],
    inferredCandidateRoots: [],
    mode: 'single_root',
    source: 'cwd',
    latestDeclaredAt: '',
  }
  for (const event of events) {
    if (event.type !== 'task_scope_declared') continue
    if (event.timestamp < summary.latestDeclaredAt) continue
    summary = {
      cwd: event.cwd,
      primaryRoot: event.primaryRoot,
      explicitRoots: [...event.explicitRoots],
      confirmedExternalRoots: [...event.confirmedExternalRoots],
      inferredCandidateRoots: [...event.inferredCandidateRoots],
      mode: event.mode,
      source: event.source,
      latestDeclaredAt: event.timestamp,
    }
  }
  return summary
}

export function summarizeBehaviorHint(
  cwd: string,
  sessionId: string,
): {
  pendingHints: number
  lastHintAt?: number
  lastHintPattern?: string
} {
  const tracePath = resolve(cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
  if (!existsSync(tracePath)) {
    return { pendingHints: 0 }
  }
  let raw: string
  try {
    raw = readFileSync(tracePath, 'utf8')
  } catch {
    return { pendingHints: 0 }
  }
  const now = Date.now()
  const cooldownMs = 5 * 60_000
  let pendingHints = 0
  let lastHintAt: number | undefined
  let lastHintPattern: string | undefined
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: BehaviorTraceEntry
    try {
      entry = JSON.parse(trimmed) as BehaviorTraceEntry
    } catch {
      continue
    }
    if (entry.sessionId !== sessionId) continue
    const source = (entry.anomaly as { source?: string } | undefined)?.source
    if (source !== 'nexus') continue
    const ts = Date.parse(entry.timestamp)
    if (!Number.isFinite(ts) || ts < now - cooldownMs) continue
    pendingHints += 1
    const tsMs = ts
    if (lastHintAt === undefined || tsMs > lastHintAt) {
      lastHintAt = tsMs
      lastHintPattern = entry.anomaly?.errorMessage || entry.anomaly?.errorCode || entry.anomaly?.driftPath || entry.anomaly?.denialReason || entry.anomaly?.userRedirectSignal || undefined
    }
  }
  return { pendingHints, lastHintAt, lastHintPattern }
}

export const runtimeLoopHealthRouter: FeatureRouter = {
  name: 'runtimeLoopHealthRouter',
  register(app, context) {
    app.get('/v1/runtime/loop/health', async (request, reply) => {
      const query = loopHealthQuerySchema.parse(request.query)
      const candidateIds = new Set<string>()
      try {
        if (query.sessionId) {
          const session = await context.options.storage.getSession(query.sessionId, {
            includeEvents: false,
          })
          if (session) candidateIds.add(session.sessionId)
        } else {
          const sessionList = await context.options.storage.listSessions({ limit: 500 })
          for (const session of sessionList) {
            if (query.workspaceId && query.workspaceId !== 'all') {
              // Phase 1b will replace this with a workspace_id column.
              // For now every session is included unless the caller
              // narrows by paneId explicitly.
            }
            candidateIds.add(session.sessionId)
          }
        }
      } catch (err) {
        return reply.code(500).send({
          type: 'error',
          code: 'LOOP_HEALTH_FAILED',
          message: errorMessage(err),
        })
      }
      if (candidateIds.size === 0) {
        return {
          type: 'loop_health',
          panes: [],
          filter: {
            workspaceId: query.workspaceId,
            paneId: query.paneId,
            sessionId: query.sessionId,
            lastN: query.lastN,
          },
        }
      }

      const panes: Array<Record<string, unknown>> = []
      for (const sessionId of candidateIds) {
        let events: NexusEvent[]
        try {
          const page = await context.options.storage.listEvents(sessionId, {
            order: 'desc',
            limit: query.lastN,
          })
          events = page.events
        } catch (err) {
          panes.push({
            sessionId,
            error: errorMessage(err),
          })
          continue
        }
        const status = derivePaneStatus({ events })
        const taskScope = summarizeTaskScope(events)
        const hintProjection = summarizeBehaviorHint(taskScope.cwd || context.options.storage.toString?.() || '', sessionId)
        const finalSnapshot = applyBehaviorHint(status, {
          pendingHints: hintProjection.pendingHints,
          lastHintAt: hintProjection.lastHintAt,
          lastHintPattern: hintProjection.lastHintPattern,
        })
        const paneCacheHealth = buildCacheHealthFromEvents(events, {
          sessionId,
          lastN: query.lastN,
          kind: 'pane',
        })
        panes.push({
          sessionId,
          agent: 'bbl',
          status: finalSnapshot.status,
          pendingPermissions: finalSnapshot.pendingPermissions,
          pendingScopeBoundaries: finalSnapshot.pendingScopeBoundaries,
          outOfScopeEvidence: finalSnapshot.outOfScopeEvidence,
          lastEventRev: finalSnapshot.lastEventSeq,
          lastEventAt: finalSnapshot.lastEventAt,
          taskScope,
          pendingHints: finalSnapshot.pendingHints,
          lastHintAt: finalSnapshot.lastHintAt,
          lastHintPattern: finalSnapshot.lastHintPattern,
          cacheHealth: paneCacheHealth,
        })
      }

      return {
        type: 'loop_health',
        panes,
        filter: {
          workspaceId: query.workspaceId,
          paneId: query.paneId,
          sessionId: query.sessionId,
          lastN: query.lastN,
        },
      }
    })
  },
}
