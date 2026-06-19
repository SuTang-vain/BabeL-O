import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../../shared/events.js'
import { BEHAVIOR_TRACE_RELATIVE_PATH, type BehaviorTraceEntry } from '../../runtime/behaviorTrace.js'
import { searchEvents, summarizeWindow } from '../../tools/contextTools.js'
import type { FeatureRouter } from '../router.js'

export function parseSinceFromQuery(s: string): number | undefined {
  const match = s.trim().match(/^(\d+)\s*([hmdw])$/i)
  if (!match) return undefined
  const n = Number(match[1])
  const unit = match[2]!.toLowerCase()
  if (unit === 'm') return n * 60_000
  if (unit === 'h') return n * 60 * 60_000
  if (unit === 'd') return n * 24 * 60 * 60_000
  if (unit === 'w') return n * 7 * 24 * 60 * 60_000
  return undefined
}

export type ContextHistoryParams = {
  cwd: string
  scope: 'search' | 'summarize'
  query?: string
  sinceMs?: number
  maxTokens: number
  summarizeScope: 'all' | 'error' | 'denial' | 'scope-drift' | 'user-redirect' | 'trajectory-end' | 'cross-session'
}

export async function runContextHistory(params: ContextHistoryParams): Promise<{
  type: 'context_history_result'
  scope: 'search' | 'summarize'
  content: string
  hitCount: number
  tokenEstimate: number
  truncated: boolean
  contentTruncated?: number
}> {
  const tracePath = resolve(params.cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
  if (!existsSync(tracePath)) {
    return {
      type: 'context_history_result',
      scope: params.scope,
      content: '(no behavior trace file yet)',
      hitCount: 0,
      tokenEstimate: 5,
      truncated: false,
    }
  }

  let entries: BehaviorTraceEntry[] = []
  try {
    const raw = readFileSync(tracePath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed) as BehaviorTraceEntry)
      } catch {
        // skip malformed lines
      }
    }
  } catch (error) {
    throw new Error(`Failed to read trace file: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (params.scope === 'search') {
    if (!params.query) {
      throw new Error('query is required for search scope')
    }
    const events: NexusEvent[] = entries.map((e, i) => ({
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: e.sessionId,
      timestamp: e.timestamp,
      toolUseId: `trc_${i}`,
      name: 'behavior_trace',
      input: {
        trigger: e.trigger,
        errorMessage: e.anomaly?.errorMessage,
        errorCode: e.anomaly?.errorCode,
        denialReason: e.anomaly?.denialReason,
        driftPath: e.anomaly?.driftPath,
        userRedirectSignal: e.anomaly?.userRedirectSignal,
        source: (e.anomaly as { source?: string } | undefined)?.source,
      },
    }))
    const result = searchEvents(events, params.query, {
      sinceMs: params.sinceMs,
      maxTokens: params.maxTokens,
    })
    return {
      type: 'context_history_result',
      scope: 'search',
      content: result.content,
      hitCount: result.hitCount,
      tokenEstimate: result.tokenEstimate,
      truncated: result.truncated,
      contentTruncated: result.truncatedAt,
    }
  }

  const summary = summarizeWindow(entries, {
    scope: params.summarizeScope,
    sinceMs: params.sinceMs,
    maxTokens: params.maxTokens,
  })
  return {
    type: 'context_history_result',
    scope: 'summarize',
    content: summary.content,
    hitCount: summary.hitCount,
    tokenEstimate: summary.tokenEstimate,
    truncated: summary.truncated,
    contentTruncated: summary.truncatedAt,
  }
}

export async function runBehaviorTraceGet({ cwd, sessionId, limit, sinceMs }: { cwd: string; sessionId?: string; limit: number; sinceMs: number }): Promise<{
  type: 'behavior_trace_result'
  cwd: string
  sessionId: string
  entries: BehaviorTraceEntry[]
  count: number
}> {
  let all: BehaviorTraceEntry[] = []
  const tracePath = resolve(cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
  if (existsSync(tracePath)) {
    try {
      const raw = readFileSync(tracePath, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          all.push(JSON.parse(trimmed) as BehaviorTraceEntry)
        } catch {
          // skip malformed lines (mirrors runContextHistory)
        }
      }
    } catch (error) {
      throw new Error(`Failed to read trace file: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const cutoff = Date.now() - Math.max(0, sinceMs)
  let filtered = all.filter(e => {
    const ts = Date.parse(e.timestamp ?? '')
    if (!Number.isFinite(ts)) return false
    if (ts < cutoff) return false
    if (sessionId && e.sessionId !== sessionId) return false
    return true
  })

  if (filtered.length > limit) {
    filtered = filtered.slice(filtered.length - limit)
  }

  return {
    type: 'behavior_trace_result',
    cwd,
    sessionId: sessionId ?? '',
    entries: filtered,
    count: filtered.length,
  }
}

export const contextHistoryRouter: FeatureRouter = {
  name: 'context-history',
  register(app) {
    app.get('/v1/context/history', async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, string | undefined>
      const cwd = q.cwd
      if (!cwd) {
        return reply.code(400).send({ error: 'cwd query param is required' })
      }
      const scope = (q.scope === 'search' ? 'search' : 'summarize') as 'search' | 'summarize'
      const query = q.query
      const maxTokens = q.maxTokens ? Number(q.maxTokens) : 5000
      if (Number.isNaN(maxTokens) || maxTokens <= 0) {
        return reply.code(400).send({ error: 'maxTokens must be a positive number' })
      }
      const sinceMs = q.since ? parseSinceFromQuery(q.since) : undefined
      if (q.since && sinceMs === undefined) {
        return reply.code(400).send({
          error: `Invalid since: ${q.since}. Use e.g. 24h, 30m, 1d, 1w.`,
        })
      }
      const summarizeScope = (q.summarizeScope ?? 'all') as ContextHistoryParams['summarizeScope']
      return await runContextHistory({
        cwd,
        scope,
        query,
        sinceMs,
        maxTokens,
        summarizeScope,
      })
    })

    app.get('/v1/context/trace', async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, string | undefined>
      const cwd = q.cwd
      if (!cwd) {
        return reply.code(400).send({ error: 'cwd query param is required' })
      }
      const sessionId = q.sessionId
      const limit = q.limit ? Math.max(1, Math.min(1000, Number(q.limit))) : 100
      if (q.limit && (Number.isNaN(limit) || limit <= 0)) {
        return reply.code(400).send({ error: 'limit must be a positive number' })
      }
      const sinceMs = q.sinceMs ? Number(q.sinceMs) : 24 * 60 * 60 * 1000
      if (q.sinceMs && (Number.isNaN(sinceMs) || sinceMs < 0)) {
        return reply.code(400).send({ error: 'sinceMs must be a non-negative number' })
      }
      return await runBehaviorTraceGet({ cwd, sessionId, limit, sinceMs })
    })
  },
}
