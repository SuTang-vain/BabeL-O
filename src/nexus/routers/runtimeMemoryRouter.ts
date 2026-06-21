import type { NexusEvent } from '../../shared/events.js'
import type { SessionMessage } from '../../shared/sessionChannel.js'
import { createId } from '../../shared/id.js'
import type { EverCoreMessage } from '../../runtime/everCoreClient.js'
import { extractEverCoreMemoryHits, formatMemoryProviderHits } from '../../runtime/memoryProvider.js'
import { computeMemoryQualityMetrics } from '../../runtime/memoryMetrics.js'
import type { NexusStorage } from '../../storage/Storage.js'
import type { EverCoreRuntimeConfig, EverCoreStatus } from '../everCoreConfig.js'
import type { FeatureRouter } from '../router.js'
import { z } from 'zod'

const booleanQuery = (defaultValue: boolean) =>
  z.preprocess(value => {
    if (value === undefined) return defaultValue
    if (value === true || value === 'true' || value === '1') return true
    if (value === false || value === 'false' || value === '0') return false
    return value
  }, z.boolean())

const memoryCandidatesQuerySchema = z.object({
  sessionId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  includeRejected: booleanQuery(true),
})

const memorySearchSchema = z.object({
  query: z.string().min(1).max(2_000),
  topK: z.number().int().positive().max(20).optional(),
  method: z.enum(['keyword', 'vector', 'hybrid', 'agentic']).optional(),
  maxChars: z.number().int().positive().max(20_000).optional(),
  maxHitChars: z.number().int().positive().max(4_000).optional(),
})

const memoryApprovalSchema = z.object({
  approved: z.boolean().optional(),
  confirmation: z.string().optional(),
  reason: z.string().optional(),
})

const memorySaveNoteSchema = memoryApprovalSchema.extend({
  note: z.string().min(1).max(4_000),
  sessionId: z.string().min(1).optional(),
  candidateMessageId: z.string().min(1).optional(),
})

const memoryFlushSchema = memoryApprovalSchema.extend({
  sessionId: z.string().min(1),
})

const memoryRestartSchema = memoryApprovalSchema

type MemoryApprovalResult = { approved: true } | { approved: false; response: Record<string, unknown> }

function isEverCoreAvailable(status: EverCoreStatus): boolean {
  return status.enabled && status.healthy
}

function memoryUnavailablePayload(status: EverCoreStatus) {
  return {
    type: 'error',
    code: 'EVERCORE_MEMORY_UNAVAILABLE',
    message: 'Long-term memory is not available for this runtime.',
    everCore: status,
  }
}

function requireMemoryApproval(
  action: 'save-note' | 'flush' | 'restart',
  input: {
    approved?: boolean
    confirmation?: string
    reason?: string
  },
): MemoryApprovalResult {
  const confirmation = input.confirmation?.trim().toLowerCase()
  const confirmed = input.approved === true || confirmation === action || confirmation === `memory:${action}`
  if (confirmed) return { approved: true }
  return {
    approved: false,
    response: {
      type: 'memory_action_approval_required',
      action,
      approved: false,
      risk: action === 'restart' ? 'lifecycle_execute' : 'write_lifecycle',
      requiredConfirmation: action,
      guidance:
        action === 'save-note'
          ? 'Memory save is write-risk. Re-submit with approved=true or confirmation="save-note" after user approval.'
          : `Memory ${action} is a lifecycle operation. Re-submit with approved=true or confirmation="${action}" after explicit user confirmation.`,
      ...(input.reason && { reason: input.reason }),
    },
  }
}

function buildApprovedMemoryNoteMessages(input: { note: string; config: EverCoreRuntimeConfig }): EverCoreMessage[] {
  const timestamp = Date.now()
  return [
    {
      sender_id: input.config.userId ?? 'local-user',
      sender_name: 'User',
      role: 'user',
      timestamp,
      content: input.note,
    },
    {
      sender_id: input.config.agentId,
      sender_name: 'BabeL-O',
      role: 'assistant',
      timestamp: timestamp + 1,
      content: `Approved long-term memory note saved: ${input.note}`,
    },
  ]
}

async function listRecentMemoryRetrievalEvents(
  storage: NexusStorage,
  options: { limit: number; eventsPerSession?: number },
): Promise<NexusEvent[]> {
  const eventsPerSession = options.eventsPerSession ?? 100
  try {
    const sessions = await storage.listSessions()
    const perSession: NexusEvent[] = []
    for (const session of sessions) {
      const page = await storage.listEvents(session.sessionId, {
        order: 'desc',
        limit: eventsPerSession,
      })
      for (const event of page.events) {
        if (event.type === 'memory_retrieval') perSession.push(event)
      }
    }
    perSession.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    return perSession.slice(0, options.limit)
  } catch {
    return []
  }
}

export const runtimeMemoryRouter: FeatureRouter = {
  name: 'runtime-memory',
  register(app, context) {
    app.get('/v1/runtime/memory/status', async () => {
      const everCore = context.everCoreStatus()
      const capabilityAvailable = isEverCoreAvailable(everCore)
      const recentRetrievals = await listRecentMemoryRetrievalEvents(context.options.storage, { limit: 500 })
      const counters = context.memoryApprovalCounters ?? { approved: 0, denied: 0, pendingReview: 0 }
      const quality = computeMemoryQualityMetrics(recentRetrievals, {
        memoryNoteApprovals: counters.approved,
        memoryNoteDenials: counters.denied,
        memoryNotePendingReviews: counters.pendingReview,
      })
      return {
        type: 'memory_status',
        capability: {
          available: capabilityAvailable,
          longTermMemory: capabilityAvailable,
          autoSearch: 'cue-driven',
          save: 'permission-gated',
          authoritative: false,
        },
        everCore,
        quality: {
          ...quality,
          truncationRate: quality.retrievalCount > 0
            ? quality.truncatedRetrievalCount / quality.retrievalCount
            : 0,
          retrievalHitRate: quality.retrievalCount > 0
            ? quality.retrievalsWithHits / quality.retrievalCount
            : 0,
          autoSearchTriggerRate: quality.retrievalCount > 0
            ? quality.autoSearchTriggeredCount / quality.retrievalCount
            : 0,
          averageSearchLatencyMs: quality.retrievalLatencySampleCount > 0
            ? quality.totalSearchLatencyMs / quality.retrievalLatencySampleCount
            : 0,
          saveApprovalRate: (quality.memoryNoteApprovalCount + quality.memoryNoteDenialCount) > 0
            ? quality.memoryNoteApprovalCount / (quality.memoryNoteApprovalCount + quality.memoryNoteDenialCount)
            : 0,
          windowSize: recentRetrievals.length,
        },
        guidance: {
          memoryIsHint: true,
          projectFactsRequireWorkspaceEvidence: true,
          candidatesAutoWrite: false,
          flushRuntimeOwned: true,
        },
        actions: {
          status: 'read',
          search: 'read',
          candidates: 'read',
          saveNote: 'write_permission_gated',
          flush: 'lifecycle_permission_gated',
          restart: 'lifecycle_permission_gated',
        },
      }
    })

    app.get('/v1/runtime/memory/candidates', async request => {
      const query = memoryCandidatesQuerySchema.parse(request.query)
      const channels = await context.options.storage.listSessionChannels({
        sessionId: query.sessionId,
        limit: Math.max(query.limit, 100),
      })
      const candidates: SessionMessage[] = []
      for (const channel of channels) {
        const page = await context.options.storage.listSessionMessages(channel.channelId, {
          limit: query.limit,
          order: 'desc',
        })
        for (const message of page.messages) {
          if (message.type !== 'memory_candidate') continue
          const governance = message.metadata?.memoryCandidateGovernance as Record<string, unknown> | undefined
          if (!query.includeRejected && governance?.decision === 'rejected') continue
          candidates.push(message)
        }
      }
      candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.messageId.localeCompare(a.messageId))
      const limited = candidates.slice(0, query.limit)
      return {
        type: 'memory_candidates',
        candidates: limited.map(message => ({
          messageId: message.messageId,
          channelId: message.channelId,
          fromSessionId: message.fromSessionId,
          toSessionId: message.toSessionId,
          broadcast: message.broadcast,
          content: message.content,
          evidence: message.evidence ?? [],
          priority: message.priority,
          createdAt: message.createdAt,
          status: message.status,
          governance: message.metadata?.memoryCandidateGovernance ?? null,
        })),
        limit: query.limit,
        includeRejected: query.includeRejected,
        guidance: {
          autoWrite: false,
          reviewOnly: true,
          saveRequiresApproval: true,
        },
      }
    })

    app.post('/v1/runtime/memory/search', async (request, reply) => {
      const body = memorySearchSchema.parse(request.body ?? {})
      const everCore = context.everCoreStatus()
      if (!isEverCoreAvailable(everCore) || !context.options.everCoreClient || !context.options.everCoreConfig) {
        return reply.code(503).send(memoryUnavailablePayload(everCore))
      }
      const config = context.options.everCoreConfig
      const topK = body.topK ?? config.topK
      const maxChars = body.maxChars ?? config.maxContentChars ?? 4_000
      const maxHitChars = body.maxHitChars ?? 800
      const started = context.metrics.now()
      const envelope = await context.options.everCoreClient.search({
        query: body.query,
        appId: config.appId,
        projectId: config.projectId,
        userId: config.userId,
        agentId: config.userId ? undefined : config.agentId,
        method: body.method ?? config.retrieveMethod,
        topK,
      })
      const hits = extractEverCoreMemoryHits(envelope)
      const formatted = formatMemoryProviderHits(hits, {
        maxContextChars: maxChars,
        maxHitChars,
        maxHits: topK,
      })
      return {
        type: 'memory_search_result',
        query: body.query,
        provider: 'evercore',
        hitCount: formatted.hitCount,
        totalExtractedHits: hits.length,
        injectedChars: formatted.content.length,
        budgetChars: maxChars,
        maxHitChars,
        truncated: formatted.truncated,
        searchLatencyMs: Math.round(context.metrics.now() - started),
        method: body.method ?? config.retrieveMethod,
        topK,
        content: formatted.content,
        hits: hits.slice(0, topK).map(hit => ({
          content: hit.content.length > maxHitChars ? `${hit.content.slice(0, maxHitChars)}...` : hit.content,
          ...(hit.source && { source: hit.source }),
          ...(hit.score !== undefined && { score: hit.score }),
        })),
        guidance: {
          memoryIsHint: true,
          projectFactsRequireWorkspaceEvidence: true,
        },
      }
    })

    app.post('/v1/runtime/memory/save-note', async (request, reply) => {
      const body = memorySaveNoteSchema.parse(request.body ?? {})
      const approval = requireMemoryApproval('save-note', body)
      if (!approval.approved) {
        // §3.5: user did not (yet) approve the save. The SessionChannel
        // governance record is durable; this counter is the recent-window signal.
        if (context.memoryApprovalCounters) context.memoryApprovalCounters.denied += 1
        return reply.code(202).send(approval.response)
      }
      const everCore = context.everCoreStatus()
      if (!isEverCoreAvailable(everCore) || !context.options.everCoreClient || !context.options.everCoreConfig) {
        return reply.code(503).send(memoryUnavailablePayload(everCore))
      }
      const sessionId = body.sessionId ?? createId('memory_note')
      const note = body.note.trim()
      const messages = buildApprovedMemoryNoteMessages({
        note,
        config: context.options.everCoreConfig,
      })
      const envelope = await context.options.everCoreClient.addAgentMessages({
        sessionId,
        appId: context.options.everCoreConfig.appId,
        projectId: context.options.everCoreConfig.projectId,
        messages,
      })
      if (context.memoryApprovalCounters) context.memoryApprovalCounters.approved += 1
      return {
        type: 'memory_note_saved',
        provider: 'evercore',
        sessionId,
        candidateMessageId: body.candidateMessageId,
        savedMessages: messages.length,
        savedChars: note.length,
        envelope,
        guidance: {
          searchCacheInvalidated: true,
          memoryIsHint: true,
        },
      }
    })

    app.post('/v1/runtime/memory/flush', async (request, reply) => {
      const body = memoryFlushSchema.parse(request.body ?? {})
      const approval = requireMemoryApproval('flush', body)
      if (!approval.approved) return reply.code(202).send(approval.response)
      const everCore = context.everCoreStatus()
      if (!isEverCoreAvailable(everCore) || !context.options.everCoreClient || !context.options.everCoreConfig) {
        return reply.code(503).send(memoryUnavailablePayload(everCore))
      }
      const envelope = await context.options.everCoreClient.flushAgentSession({
        sessionId: body.sessionId,
        appId: context.options.everCoreConfig.appId,
        projectId: context.options.everCoreConfig.projectId,
      })
      return {
        type: 'memory_session_flushed',
        provider: 'evercore',
        sessionId: body.sessionId,
        flushed: true,
        envelope,
        guidance: {
          searchCacheInvalidated: true,
          runtimeOwned: true,
        },
      }
    })

    app.post('/v1/runtime/memory/restart', async (request, reply) => {
      const body = memoryRestartSchema.parse(request.body ?? {})
      const approval = requireMemoryApproval('restart', body)
      if (!approval.approved) return reply.code(202).send(approval.response)
      return reply.code(501).send({
        type: 'error',
        code: 'MEMORY_RESTART_NOT_IMPLEMENTED',
        message: 'Memory restart is permission-gated but not implemented in this runtime yet.',
        guidance: {
          restartRequiresRuntimeManagerOwnership: true,
          useProcessRestartForNow: true,
        },
      })
    })
  },
}
