import type { AgentJob, AgentJobFilter } from '../shared/agentJob.js'
import type { NexusEvent } from '../shared/events.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { SessionChannel, SessionMessage } from '../shared/sessionChannel.js'
import type { NexusTask } from '../shared/task.js'
import type { ToolTrace } from '../shared/toolTrace.js'

export type StorageListOptions = {
  limit?: number
  includeEvents?: boolean
}

export type ChildSessionListOptions = {
  limit?: number
  includeEvents?: boolean
}

export type SessionGetOptions = {
  includeEvents?: boolean
}

export type EventListOptions = {
  limit?: number
  cursor?: string
  order?: 'asc' | 'desc'
}

export type EventListResult = {
  events: NexusEvent[]
  nextCursor?: string
  /**
   * Highest monotonically-increasing revision observed in this
   * page. For SQLite this is `MAX(event_seq)` from the rows;
   * MemoryStorage falls back to the cursor index it consumed.
   * Used by the bbl-loop `wait` endpoint to advance revision
   * without re-parsing rows.
   */
  lastSeq?: number
}

export type ToolTraceListOptions = {
  limit?: number
  cursor?: string
  order?: 'asc' | 'desc'
}

export type ToolTraceListResult = {
  traces: ToolTrace[]
  nextCursor?: string
}

export type SessionChannelListOptions = {
  sessionId?: string
  limit?: number
}

export type SessionMessageListOptions = {
  limit?: number
  cursor?: string
  order?: 'asc' | 'desc'
}

export type SessionMessageListResult = {
  messages: SessionMessage[]
  nextCursor?: string
}

export type SessionInboxOptions = {
  limit?: number
  includeAcknowledged?: boolean
}

export type PermissionAudit = {
  auditId: string
  sessionId: string
  toolUseId: string
  toolName: string
  toolRisk: string
  toolInput: unknown
  decision: 'approved' | 'denied'
  reason?: string
  timestamp: string
}

export type ExecutionMetrics = {
  metricId: string
  sessionId: string
  executeDurationMs?: number
  providerFirstTokenMs?: number
  providerRequestDurationMs?: number
  streamDeltaCount?: number
  toolCallCount?: number
  toolRoundtripDurationMs?: number
  contextCharsIn?: number
  contextCharsOut?: number
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  modelContextWindow?: number
  reservedOutputTokens?: number
  providerSafetyBufferTokens?: number
  effectiveContextCeiling?: number
  legacyContextCeiling?: number
  envMaxContextTokens?: number
  contextPolicySource?: 'legacy' | 'large_context' | 'env_cap'
  contextWarningThresholdPercent?: number
  contextCompactThresholdPercent?: number
  contextWarningThresholdTokens?: number
  contextCompactThresholdTokens?: number
  contextBlockingLimitTokens?: number
  cacheReadRatio?: number
  cachePreservationMode?: boolean
  longContextUtilizationMode?: boolean
  prefixCacheImmutableRatio?: number
  prefixCacheVolatileContentLast?: boolean
  prefixCacheFingerprint?: string
  compactSummaryLatencyMs?: number
  remoteToolCallCount?: number
  remoteToolRunnerDurationMs?: number
  timestamp: string
}

export interface NexusStorage {
  saveSession(session: SessionSnapshot): Promise<void>
  getSession(
    sessionId: string,
    options?: SessionGetOptions,
  ): Promise<SessionSnapshot | null>
  listSessions(options?: StorageListOptions): Promise<SessionSnapshot[]>
  listChildSessions(
    parentSessionId: string,
    options?: ChildSessionListOptions,
  ): Promise<SessionSnapshot[]>
  listEvents(sessionId: string, options?: EventListOptions): Promise<EventListResult>
  appendEvent(sessionId: string, event: NexusEvent): Promise<void>
  saveTask(task: NexusTask): Promise<void>
  getTask(taskId: string): Promise<NexusTask | null>
  listTasks(sessionId: string): Promise<NexusTask[]>
  saveAgentJob(job: AgentJob): Promise<void>
  getAgentJob(jobId: string): Promise<AgentJob | null>
  listAgentJobs(filter?: AgentJobFilter): Promise<AgentJob[]>
  saveToolTrace(trace: ToolTrace): Promise<void>
  getToolTrace(toolUseId: string): Promise<ToolTrace | null>
  listToolTraces(
    sessionId: string,
    options?: ToolTraceListOptions,
  ): Promise<ToolTraceListResult>
  saveSessionChannel(channel: SessionChannel): Promise<void>
  getSessionChannel(channelId: string): Promise<SessionChannel | null>
  listSessionChannels(options?: SessionChannelListOptions): Promise<SessionChannel[]>
  saveSessionMessage(message: SessionMessage): Promise<void>
  getSessionMessage(messageId: string): Promise<SessionMessage | null>
  listSessionMessages(
    channelId: string,
    options?: SessionMessageListOptions,
  ): Promise<SessionMessageListResult>
  listSessionInbox(
    sessionId: string,
    options?: SessionInboxOptions,
  ): Promise<SessionMessage[]>
  acknowledgeSessionMessage(messageId: string, acknowledgedAt: string): Promise<SessionMessage | null>
  savePermissionAudit(audit: PermissionAudit): Promise<void>
  listPermissionAudits(sessionId: string): Promise<PermissionAudit[]>
  saveExecutionMetrics(metrics: ExecutionMetrics): Promise<void>
  getExecutionMetrics(sessionId: string): Promise<ExecutionMetrics | null>
  upsertLoopPane(pane: LoopPaneState): Promise<LoopPaneState>
  listLoopPanes(filter?: LoopPaneFilter): Promise<LoopPaneState[]>
  deleteLoopPane(paneId: string): Promise<boolean>
  updateLoopPaneRev(paneId: string, lastRev: number, updatedAt: string): Promise<LoopPaneState | null>
  close?(): Promise<void>
}

export type LoopPaneState = {
  paneId: string
  workspaceId: string
  tabId: string
  sessionId: string
  agent: string
  cwd: string
  label: string | null
  lastRev: number
  updatedAt: string
}

export type LoopPaneFilter = {
  workspaceId?: string
  tabId?: string
  paneId?: string
  sessionId?: string
}
