export type EvidenceRef = {
  type: 'session_event' | 'tool_trace' | 'file' | 'url' | 'note'
  ref: string
  label?: string
}

export type SessionChannelKind =
  | 'direct'
  | 'group'
  | 'parent_child'
  | 'workspace_pair'
  | 'project_bridge'

export type SessionChannelStatus = 'open' | 'closed' | 'archived'

export type SessionMessageType =
  | 'question'
  | 'answer'
  | 'finding'
  | 'request_review'
  | 'request_validation'
  | 'hypothesis'
  | 'decision'
  | 'blocked'
  | 'memory_candidate'
  | 'handoff'

export type SessionMessagePriority = 'low' | 'normal' | 'high'

export type SessionMessageStatus = 'queued' | 'delivered' | 'acknowledged' | 'expired'

export type SessionChannelPolicy = {
  allowedMessageTypes: SessionMessageType[]
  maxMessageChars: number
  maxEvidenceRefs: number
  allowBroadcast: boolean
  allowMemoryWriteRequests: boolean
  requireUserApprovalForExternalProject: boolean
  contextInjectionMode: 'none' | 'unread_summary' | 'recent_messages' | 'manual_only'
}

export type SessionChannel = {
  channelId: string
  kind: SessionChannelKind
  participantSessionIds: string[]
  createdBySessionId: string
  createdAt: string
  status: SessionChannelStatus
  policy: SessionChannelPolicy
  metadata?: Record<string, unknown>
}

export type SessionMessage = {
  messageId: string
  channelId: string
  fromSessionId: string
  toSessionId?: string
  broadcast?: boolean
  type: SessionMessageType
  content: string
  evidence?: EvidenceRef[]
  priority: SessionMessagePriority
  createdAt: string
  deliveredAt?: string
  acknowledgedAt?: string
  status: SessionMessageStatus
  metadata?: Record<string, unknown>
}

export const DEFAULT_SESSION_CHANNEL_POLICY: SessionChannelPolicy = {
  allowedMessageTypes: [
    'question',
    'answer',
    'finding',
    'request_review',
    'request_validation',
    'hypothesis',
    'decision',
    'blocked',
    'memory_candidate',
    'handoff',
  ],
  maxMessageChars: 4_000,
  maxEvidenceRefs: 8,
  allowBroadcast: true,
  allowMemoryWriteRequests: false,
  requireUserApprovalForExternalProject: true,
  contextInjectionMode: 'recent_messages',
}
