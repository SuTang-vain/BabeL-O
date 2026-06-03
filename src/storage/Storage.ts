import type { NexusEvent } from '../shared/events.js'
import type { SessionSnapshot } from '../shared/session.js'
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
  effectiveContextCeiling?: number
  legacyContextCeiling?: number
  cacheReadRatio?: number
  cachePreservationMode?: boolean
  longContextUtilizationMode?: boolean
  compactSummaryLatencyMs?: number
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
  saveToolTrace(trace: ToolTrace): Promise<void>
  getToolTrace(toolUseId: string): Promise<ToolTrace | null>
  listToolTraces(
    sessionId: string,
    options?: ToolTraceListOptions,
  ): Promise<ToolTraceListResult>
  savePermissionAudit(audit: PermissionAudit): Promise<void>
  listPermissionAudits(sessionId: string): Promise<PermissionAudit[]>
  saveExecutionMetrics(metrics: ExecutionMetrics): Promise<void>
  getExecutionMetrics(sessionId: string): Promise<ExecutionMetrics | null>
  close?(): Promise<void>
}
