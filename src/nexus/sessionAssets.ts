import type { NexusEvent } from '../shared/events.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import type { ToolTrace } from '../shared/toolTrace.js'
import type { ExecutionMetrics, NexusStorage, PermissionAudit } from '../storage/Storage.js'

export type SessionAssetOptions = {
  eventLimit?: number
  toolTraceLimit?: number
  childSessionLimit?: number
  includeEvents?: boolean
  includeToolTraces?: boolean
  includePermissionAudits?: boolean
  includeExecutionMetrics?: boolean
}

export type UsageSummary = {
  eventCount: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export type CriticReviewAsset = {
  taskId?: string
  title?: string
  status: 'pending' | 'approved' | 'rejected' | 'unknown'
  approved?: boolean
  reason?: string
  reviewerAgentId?: string
  source: 'task_review' | 'critic_event'
  timestamp?: string
}

export type SessionAssetsSnapshot = {
  type: 'session_assets'
  schemaVersion: '2026-05-31.babel-o.session-assets.v1'
  sessionId: string
  session: SessionSnapshot
  tasks: NexusTask[]
  childSessions: SessionSnapshot[]
  events?: {
    items: NexusEvent[]
    nextCursor?: string
    limit: number
    order: 'asc'
    truncated: boolean
  }
  toolTraces?: {
    items: ToolTrace[]
    nextCursor?: string
    limit: number
    order: 'asc'
    truncated: boolean
  }
  permissionAudits?: PermissionAudit[]
  criticReviews: CriticReviewAsset[]
  usageSummary: UsageSummary
  executionMetrics?: ExecutionMetrics | null
}

const SESSION_ASSETS_SCHEMA_VERSION = '2026-05-31.babel-o.session-assets.v1' as const

export async function buildSessionAssetsSnapshot(options: {
  storage: NexusStorage
  sessionId: string
  assetOptions?: SessionAssetOptions
}): Promise<SessionAssetsSnapshot | null> {
  const assetOptions = options.assetOptions ?? {}
  const session = await options.storage.getSession(options.sessionId, {
    includeEvents: false,
  })
  if (!session) return null

  const eventLimit = assetOptions.eventLimit ?? 200
  const toolTraceLimit = assetOptions.toolTraceLimit ?? 200
  const childSessionLimit = assetOptions.childSessionLimit ?? 200
  const tasks = await options.storage.listTasks(options.sessionId)
  const allEvents = await listAllEvents(options.storage, options.sessionId)
  const eventPage = assetOptions.includeEvents === false
    ? undefined
    : await options.storage.listEvents(options.sessionId, {
        limit: eventLimit,
        order: 'asc',
      })
  const toolTracePage = assetOptions.includeToolTraces === false
    ? undefined
    : await options.storage.listToolTraces(options.sessionId, {
        limit: toolTraceLimit,
        order: 'asc',
      })

  return {
    type: 'session_assets',
    schemaVersion: SESSION_ASSETS_SCHEMA_VERSION,
    sessionId: options.sessionId,
    session: { ...session, events: [] },
    tasks,
    childSessions: await options.storage.listChildSessions(options.sessionId, {
      limit: childSessionLimit,
      includeEvents: false,
    }),
    events: eventPage
      ? {
          items: eventPage.events,
          nextCursor: eventPage.nextCursor,
          limit: eventLimit,
          order: 'asc',
          truncated: eventPage.nextCursor !== undefined,
        }
      : undefined,
    toolTraces: toolTracePage
      ? {
          items: toolTracePage.traces,
          nextCursor: toolTracePage.nextCursor,
          limit: toolTraceLimit,
          order: 'asc',
          truncated: toolTracePage.nextCursor !== undefined,
        }
      : undefined,
    permissionAudits: assetOptions.includePermissionAudits === false
      ? undefined
      : await options.storage.listPermissionAudits(options.sessionId),
    criticReviews: collectCriticReviews(tasks, allEvents),
    usageSummary: summarizeUsage(allEvents),
    executionMetrics: assetOptions.includeExecutionMetrics === false
      ? undefined
      : await options.storage.getExecutionMetrics(options.sessionId),
  }
}

async function listAllEvents(
  storage: NexusStorage,
  sessionId: string,
): Promise<NexusEvent[]> {
  const events: NexusEvent[] = []
  let cursor: string | undefined
  do {
    const page = await storage.listEvents(sessionId, {
      limit: 500,
      cursor,
      order: 'asc',
    })
    events.push(...page.events)
    cursor = page.nextCursor
  } while (cursor)
  return events
}

function summarizeUsage(events: NexusEvent[]): UsageSummary {
  return events.reduce<UsageSummary>((summary, event) => {
    if (event.type !== 'usage') return summary
    summary.eventCount += 1
    summary.inputTokens += event.inputTokens
    summary.outputTokens += event.outputTokens
    summary.cacheCreationInputTokens += event.cacheCreationInputTokens ?? 0
    summary.cacheReadInputTokens += event.cacheReadInputTokens ?? 0
    return summary
  }, {
    eventCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  })
}

function collectCriticReviews(
  tasks: NexusTask[],
  events: NexusEvent[],
): CriticReviewAsset[] {
  const reviews: CriticReviewAsset[] = []
  for (const task of tasks) {
    if (!task.review) continue
    reviews.push({
      taskId: task.taskId,
      title: task.title,
      status: task.review.status,
      approved: task.review.status === 'approved'
        ? true
        : task.review.status === 'rejected'
          ? false
          : undefined,
      reason: task.review.reason,
      reviewerAgentId: task.review.reviewerAgentId,
      source: 'task_review',
      timestamp: task.updatedAt,
    })
  }

  for (const event of events) {
    if (event.type !== 'task_session_event') continue
    if (event.eventType !== 'critic_completed') continue
    const payload = asRecord(event.payload)
    const approved = typeof payload.approved === 'boolean' ? payload.approved : undefined
    reviews.push({
      taskId: typeof payload.taskId === 'string' ? payload.taskId : undefined,
      title: typeof payload.title === 'string' ? payload.title : undefined,
      status: approved === undefined ? 'unknown' : approved ? 'approved' : 'rejected',
      approved,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      source: 'critic_event',
      timestamp: event.timestamp,
    })
  }

  return reviews.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
