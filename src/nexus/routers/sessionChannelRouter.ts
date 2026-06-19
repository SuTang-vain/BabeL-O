import { z } from 'zod'
import { evaluateSessionMemoryCandidate } from '../../runtime/memoryCandidateGovernance.js'
import { createId, nowIso } from '../../shared/id.js'
import {
  DEFAULT_SESSION_CHANNEL_POLICY,
  type SessionChannel,
  type SessionChannelPolicy,
  type SessionMessage,
} from '../../shared/sessionChannel.js'
import type { FeatureRouter } from '../router.js'

const booleanQuery = (defaultValue: boolean) =>
  z.preprocess(value => {
    if (value === undefined) return defaultValue
    if (value === true || value === 'true' || value === '1') return true
    if (value === false || value === 'false' || value === '0') return false
    return value
  }, z.boolean())

const sessionMessageTypeSchema = z.enum(['question', 'answer', 'finding', 'request_review', 'request_validation', 'hypothesis', 'decision', 'blocked', 'memory_candidate', 'handoff'])

const sessionChannelPolicySchema = z.object({
  allowedMessageTypes: z.array(sessionMessageTypeSchema).min(1).default(DEFAULT_SESSION_CHANNEL_POLICY.allowedMessageTypes),
  maxMessageChars: z.number().int().positive().max(20_000).default(DEFAULT_SESSION_CHANNEL_POLICY.maxMessageChars),
  maxEvidenceRefs: z.number().int().min(0).max(50).default(DEFAULT_SESSION_CHANNEL_POLICY.maxEvidenceRefs),
  allowBroadcast: z.boolean().default(DEFAULT_SESSION_CHANNEL_POLICY.allowBroadcast),
  allowMemoryWriteRequests: z.boolean().default(DEFAULT_SESSION_CHANNEL_POLICY.allowMemoryWriteRequests),
  requireUserApprovalForExternalProject: z.boolean().default(DEFAULT_SESSION_CHANNEL_POLICY.requireUserApprovalForExternalProject),
  contextInjectionMode: z.enum(['none', 'unread_summary', 'recent_messages', 'manual_only']).default(DEFAULT_SESSION_CHANNEL_POLICY.contextInjectionMode),
})

const createSessionChannelSchema = z.object({
  kind: z.enum(['direct', 'group', 'parent_child', 'workspace_pair', 'project_bridge']).default('direct').optional(),
  participantSessionIds: z.array(z.string().min(1)).min(2).max(16),
  createdBySessionId: z.string().min(1),
  policy: sessionChannelPolicySchema.partial().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const sessionChannelListQuerySchema = z.object({
  sessionId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
})

const sessionMessageListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
})

const evidenceRefSchema = z.object({
  type: z.enum(['session_event', 'tool_trace', 'file', 'url', 'note']),
  ref: z.string().min(1),
  label: z.string().optional(),
})

const createSessionMessageSchema = z.object({
  fromSessionId: z.string().min(1),
  toSessionId: z.string().min(1).optional(),
  broadcast: z.boolean().optional(),
  type: sessionMessageTypeSchema,
  content: z.string().min(1).max(20_000),
  evidence: z.array(evidenceRefSchema).optional(),
  priority: z.enum(['low', 'normal', 'high']).default('normal').optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const sessionInboxQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  includeAcknowledged: booleanQuery(false),
})

export const sessionChannelRouter: FeatureRouter = {
  name: 'sessionChannelRouter',
  register(app, context) {
    app.post('/v1/session-channels', async (request, reply) => {
      const body = createSessionChannelSchema.parse(request.body)
      const participantSessionIds = [...new Set(body.participantSessionIds)]
      if (!participantSessionIds.includes(body.createdBySessionId)) {
        return reply.code(400).send({
          type: 'error',
          code: 'INVALID_SESSION_CHANNEL',
          message: 'createdBySessionId must be one of participantSessionIds',
        })
      }
      for (const sessionId of participantSessionIds) {
        const session = await context.options.storage.getSession(sessionId, {
          includeEvents: false,
        })
        if (!session) return reply.code(404).send(createSessionNotFoundPayload(sessionId))
      }
      const channel: SessionChannel = {
        channelId: createId('channel'),
        kind: body.kind ?? 'direct',
        participantSessionIds,
        createdBySessionId: body.createdBySessionId,
        createdAt: nowIso(),
        status: 'open',
        policy: mergeSessionChannelPolicy(body.policy),
        metadata: body.metadata,
      }
      await context.options.storage.saveSessionChannel(channel)
      return {
        type: 'session_channel_created',
        channel,
      }
    })

    app.get('/v1/session-channels', async request => {
      const query = sessionChannelListQuerySchema.parse(request.query)
      return {
        type: 'session_channels',
        channels: await context.options.storage.listSessionChannels(query),
        limit: query.limit,
      }
    })

    app.get('/v1/session-channels/:channelId', async (request, reply) => {
      const params = z.object({ channelId: z.string() }).parse(request.params)
      const channel = await context.options.storage.getSessionChannel(params.channelId)
      if (!channel) return reply.code(404).send(createSessionChannelNotFoundPayload(params.channelId))
      return {
        type: 'session_channel',
        channel,
      }
    })

    app.post('/v1/session-channels/:channelId/messages', async (request, reply) => {
      const params = z.object({ channelId: z.string() }).parse(request.params)
      const body = createSessionMessageSchema.parse(request.body)
      const channel = await context.options.storage.getSessionChannel(params.channelId)
      if (!channel) return reply.code(404).send(createSessionChannelNotFoundPayload(params.channelId))
      const channelError = validateSessionChannelMessage(channel, body)
      if (channelError) return reply.code(400).send(channelError)
      const createdAt = nowIso()
      const message: SessionMessage = withMemoryCandidateGovernance(channel, {
        messageId: createId('msg'),
        channelId: params.channelId,
        fromSessionId: body.fromSessionId,
        toSessionId: body.toSessionId,
        broadcast: body.broadcast ?? body.toSessionId === undefined,
        type: body.type,
        content: body.content,
        evidence: body.evidence,
        priority: body.priority ?? 'normal',
        createdAt,
        deliveredAt: createdAt,
        status: 'delivered',
        metadata: body.metadata,
      })
      await context.options.storage.saveSessionMessage(message)
      return {
        type: 'session_message_created',
        message,
      }
    })

    app.get('/v1/session-channels/:channelId/messages', async (request, reply) => {
      const params = z.object({ channelId: z.string() }).parse(request.params)
      const query = sessionMessageListQuerySchema.parse(request.query)
      const channel = await context.options.storage.getSessionChannel(params.channelId)
      if (!channel) return reply.code(404).send(createSessionChannelNotFoundPayload(params.channelId))
      const page = await context.options.storage.listSessionMessages(params.channelId, query)
      return {
        type: 'session_messages',
        channelId: params.channelId,
        messages: page.messages,
        nextCursor: page.nextCursor,
        order: query.order,
        limit: query.limit,
      }
    })

    app.get('/v1/sessions/:sessionId/inbox', async (request, reply) => {
      const params = z.object({ sessionId: z.string() }).parse(request.params)
      const query = sessionInboxQuerySchema.parse(request.query)
      const session = await context.options.storage.getSession(params.sessionId, {
        includeEvents: false,
      })
      if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
      return {
        type: 'session_inbox',
        sessionId: params.sessionId,
        messages: await context.options.storage.listSessionInbox(params.sessionId, query),
        limit: query.limit,
        includeAcknowledged: query.includeAcknowledged,
      }
    })

    app.post('/v1/sessions/:sessionId/inbox/:messageId/ack', async (request, reply) => {
      const params = z.object({ sessionId: z.string(), messageId: z.string() }).parse(request.params)
      const session = await context.options.storage.getSession(params.sessionId, {
        includeEvents: false,
      })
      if (!session) return reply.code(404).send(createSessionNotFoundPayload(params.sessionId))
      const message = await context.options.storage.getSessionMessage(params.messageId)
      if (!message) return reply.code(404).send(createSessionMessageNotFoundPayload(params.messageId))
      const channel = await context.options.storage.getSessionChannel(message.channelId)
      if (!isSessionMessageRecipient(message, params.sessionId, channel)) {
        return reply.code(404).send(createSessionMessageNotFoundPayload(params.messageId))
      }
      const acknowledged = await context.options.storage.acknowledgeSessionMessage(params.messageId, nowIso())
      return {
        type: 'session_message_acknowledged',
        sessionId: params.sessionId,
        message: acknowledged,
      }
    })
  },
}

function createSessionNotFoundPayload(sessionId: string): {
  type: 'error'
  code: string
  message: string
} {
  return {
    type: 'error',
    code: 'SESSION_NOT_FOUND',
    message: `Session not found: ${sessionId}`,
  }
}

function createSessionChannelNotFoundPayload(channelId: string): {
  type: 'error'
  code: string
  message: string
} {
  return {
    type: 'error',
    code: 'SESSION_CHANNEL_NOT_FOUND',
    message: `Session channel not found: ${channelId}`,
  }
}

function createSessionMessageNotFoundPayload(messageId: string): {
  type: 'error'
  code: string
  message: string
} {
  return {
    type: 'error',
    code: 'SESSION_MESSAGE_NOT_FOUND',
    message: `Session message not found: ${messageId}`,
  }
}

function mergeSessionChannelPolicy(policy: Partial<SessionChannelPolicy> | undefined): SessionChannelPolicy {
  return {
    ...DEFAULT_SESSION_CHANNEL_POLICY,
    ...(policy ?? {}),
    allowedMessageTypes: policy?.allowedMessageTypes ?? DEFAULT_SESSION_CHANNEL_POLICY.allowedMessageTypes,
  }
}

function withMemoryCandidateGovernance(channel: SessionChannel, message: SessionMessage): SessionMessage {
  if (message.type !== 'memory_candidate') return message
  const governance = evaluateSessionMemoryCandidate({ channel, message })
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      memoryCandidateGovernance: governance,
    },
  }
}

function validateSessionChannelMessage(channel: SessionChannel, body: z.infer<typeof createSessionMessageSchema>): { type: 'error'; code: string; message: string } | undefined {
  if (channel.status !== 'open') {
    return {
      type: 'error',
      code: 'SESSION_CHANNEL_CLOSED',
      message: `Session channel is not open: ${channel.channelId}`,
    }
  }
  if (!channel.participantSessionIds.includes(body.fromSessionId)) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: 'fromSessionId must be a channel participant',
    }
  }
  if (body.toSessionId && !channel.participantSessionIds.includes(body.toSessionId)) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: 'toSessionId must be a channel participant',
    }
  }
  if (body.toSessionId === body.fromSessionId) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: 'Session messages cannot target the sending session',
    }
  }
  const broadcast = body.broadcast ?? body.toSessionId === undefined
  if (broadcast && !channel.policy.allowBroadcast) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: 'Broadcast messages are disabled for this channel',
    }
  }
  if (!broadcast && !body.toSessionId) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: 'Non-broadcast messages require toSessionId',
    }
  }
  if (!channel.policy.allowedMessageTypes.includes(body.type)) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: `Message type is not allowed for this channel: ${body.type}`,
    }
  }
  if (body.content.length > channel.policy.maxMessageChars) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: `Message content exceeds channel maxMessageChars: ${channel.policy.maxMessageChars}`,
    }
  }
  if ((body.evidence?.length ?? 0) > channel.policy.maxEvidenceRefs) {
    return {
      type: 'error',
      code: 'INVALID_SESSION_MESSAGE',
      message: `Message evidence exceeds channel maxEvidenceRefs: ${channel.policy.maxEvidenceRefs}`,
    }
  }
  return undefined
}

function isSessionMessageRecipient(message: SessionMessage, sessionId: string, channel: SessionChannel | null): boolean {
  if (!channel || !channel.participantSessionIds.includes(sessionId)) return false
  if (message.fromSessionId === sessionId) return false
  if (message.toSessionId) return message.toSessionId === sessionId
  return message.broadcast === true
}
