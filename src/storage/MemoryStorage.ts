import type { AgentJob, AgentJobFilter } from '../shared/agentJob.js'
import type { NexusEvent } from '../shared/events.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { SessionChannel, SessionMessage } from '../shared/sessionChannel.js'
import type { NexusTask } from '../shared/task.js'
import type { ToolTrace } from '../shared/toolTrace.js'
import type {
  ChildSessionListOptions,
  EventListOptions,
  EventListResult,
  LoopPaneFilter,
  LoopPaneState,
  NexusStorage,
  SessionGetOptions,
  StorageListOptions,
  ToolTraceListOptions,
  ToolTraceListResult,
  PermissionAudit,
  ExecutionMetrics,
  SessionChannelListOptions,
  SessionInboxOptions,
  SessionMessageListOptions,
  SessionMessageListResult,
} from './Storage.js'
import { executionMetricsFromEvent } from './executionMetricsEvent.js'

export class MemoryStorage implements NexusStorage {
  private readonly sessions = new Map<string, SessionSnapshot>()
  private readonly tasks = new Map<string, NexusTask>()
  private readonly agentJobs = new Map<string, AgentJob>()
  private readonly toolTraces = new Map<string, ToolTrace>()
  private readonly sessionChannels = new Map<string, SessionChannel>()
  private readonly sessionMessages = new Map<string, SessionMessage>()
  private readonly permissionAudits = new Map<string, PermissionAudit[]>()
  private readonly executionMetricsMap = new Map<string, ExecutionMetrics>()

  async saveSession(session: SessionSnapshot): Promise<void> {
    const cloned = structuredClone(session)
    const existing = this.sessions.get(session.sessionId)
    if (existing && cloned.events.length === 0) {
      cloned.events = structuredClone(existing.events)
    }
    // Bug 2 (context-cwd-drift plan §13.4): originCwd is immutable. Once
    // set at session creation it must survive subsequent saveSession calls
    // even if the caller's SessionSnapshot omits it (e.g. an older caller
    // that doesn't know the field) or carries a different value (drift
    // must not propagate to origin). Mirrors SqliteStorage's ON CONFLICT
    // clause which does not update origin_cwd.
    if (existing?.originCwd && !cloned.originCwd) {
      cloned.originCwd = existing.originCwd
    }
    this.sessions.set(session.sessionId, cloned)
  }

  async getSession(
    sessionId: string,
    options: SessionGetOptions = {},
  ): Promise<SessionSnapshot | null> {
    const session = this.sessions.get(sessionId)
    return session ? cloneSession(session, options.includeEvents ?? true) : null
  }

  async listSessions(options: StorageListOptions = {}): Promise<SessionSnapshot[]> {
    const limit = options.limit ?? 50
    const includeEvents = options.includeEvents ?? false
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(session => cloneSession(session, includeEvents))
  }

  async listChildSessions(
    parentSessionId: string,
    options: ChildSessionListOptions = {},
  ): Promise<SessionSnapshot[]> {
    const limit = options.limit ?? 50
    const includeEvents = options.includeEvents ?? false
    return [...this.sessions.values()]
      .filter(session => session.parentSessionId === parentSessionId)
      .sort((a, b) => {
        const cmp = a.createdAt.localeCompare(b.createdAt)
        if (cmp !== 0) return cmp
        return a.sessionId.localeCompare(b.sessionId)
      })
      .slice(0, limit)
      .map(session => cloneSession(session, includeEvents))
  }

  async listEvents(
    sessionId: string,
    options: EventListOptions = {},
  ): Promise<EventListResult> {
    const session = this.sessions.get(sessionId)
    if (!session) return { events: [] }

    const limit = options.limit ?? 100
    const order = options.order ?? 'asc'
    const startIndex = options.cursor ? Number(options.cursor) : 0
    const orderedEvents =
      order === 'asc' ? session.events : [...session.events].reverse()
    const events = orderedEvents.slice(startIndex, startIndex + limit)
    const nextIndex = startIndex + events.length
    return {
      events: structuredClone(events),
      nextCursor: nextIndex < orderedEvents.length ? String(nextIndex) : undefined,
      lastSeq:
        events.length > 0
          ? Number(options.cursor ?? 0) + events.length
          : undefined,
    }
  }

  async appendEvent(sessionId: string, event: NexusEvent): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.events.push(structuredClone(event))
    session.updatedAt = event.timestamp
    if (event.type === 'session_started') {
      session.cwd = event.cwd
    }

    if (event.type === 'tool_started') {
      const trace: ToolTrace = {
        toolUseId: event.toolUseId,
        sessionId,
        name: event.name,
        input: event.input,
        startedAt: event.timestamp,
      }
      this.toolTraces.set(event.toolUseId, trace)
    } else if (event.type === 'tool_completed') {
      const existing = this.toolTraces.get(event.toolUseId)
      if (existing) {
        existing.output = event.output
        existing.success = event.success
        existing.completedAt = event.timestamp
        existing.durationMs =
          new Date(event.timestamp).getTime() - new Date(existing.startedAt).getTime()
        existing.remoteRunner = event.remoteRunner
      }
    } else if (event.type === 'tool_denied' && event.toolUseId) {
      const existing = this.toolTraces.get(event.toolUseId)
      if (existing) {
        existing.output = {
          code: 'TOOL_DENIED',
          message: event.message,
          denialKind: event.denialKind,
          recoverable: event.recoverable,
          terminal: event.terminal,
        }
        existing.success = false
        existing.completedAt = event.timestamp
        existing.durationMs =
          new Date(event.timestamp).getTime() - new Date(existing.startedAt).getTime()
      }
    }

    const embeddedMetrics = executionMetricsFromEvent(sessionId, event)
    if (embeddedMetrics) {
      await this.saveExecutionMetrics(embeddedMetrics)
    }
  }

  async saveTask(task: NexusTask): Promise<void> {
    this.tasks.set(task.taskId, structuredClone(task))
  }

  async getTask(taskId: string): Promise<NexusTask | null> {
    const task = this.tasks.get(taskId)
    return task ? structuredClone(task) : null
  }

  async listTasks(sessionId: string): Promise<NexusTask[]> {
    return [...this.tasks.values()]
      .filter(task => task.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(task => structuredClone(task))
  }

  async saveAgentJob(job: AgentJob): Promise<void> {
    this.agentJobs.set(job.jobId, structuredClone(job))
  }

  async getAgentJob(jobId: string): Promise<AgentJob | null> {
    const job = this.agentJobs.get(jobId)
    return job ? structuredClone(job) : null
  }

  async listAgentJobs(filter: AgentJobFilter = {}): Promise<AgentJob[]> {
    return [...this.agentJobs.values()]
      .filter(job => matchesAgentJobFilter(job, filter))
      .sort((a, b) => {
        const cmp = a.createdAt.localeCompare(b.createdAt)
        if (cmp !== 0) return cmp
        return a.jobId.localeCompare(b.jobId)
      })
      .map(job => structuredClone(job))
  }

  async saveToolTrace(trace: ToolTrace): Promise<void> {
    this.toolTraces.set(trace.toolUseId, structuredClone(trace))
  }

  async getToolTrace(toolUseId: string): Promise<ToolTrace | null> {
    const trace = this.toolTraces.get(toolUseId)
    return trace ? structuredClone(trace) : null
  }

  async listToolTraces(
    sessionId: string,
    options: ToolTraceListOptions = {},
  ): Promise<ToolTraceListResult> {
    const limit = options.limit ?? 100
    const order = options.order ?? 'asc'
    const startIndex = options.cursor ? Number(options.cursor) : 0
    const allTraces = [...this.toolTraces.values()]
      .filter(t => t.sessionId === sessionId)
      .sort((a, b) => {
        const cmp = a.startedAt.localeCompare(b.startedAt)
        if (cmp !== 0) return cmp
        return a.toolUseId.localeCompare(b.toolUseId)
      })

    const orderedTraces = order === 'asc' ? allTraces : [...allTraces].reverse()
    const page = orderedTraces.slice(startIndex, startIndex + limit)
    const nextIndex = startIndex + page.length
    return {
      traces: structuredClone(page),
      nextCursor: nextIndex < orderedTraces.length ? String(nextIndex) : undefined,
    }
  }

  async saveSessionChannel(channel: SessionChannel): Promise<void> {
    this.sessionChannels.set(channel.channelId, structuredClone(channel))
  }

  async getSessionChannel(channelId: string): Promise<SessionChannel | null> {
    const channel = this.sessionChannels.get(channelId)
    return channel ? structuredClone(channel) : null
  }

  async listSessionChannels(options: SessionChannelListOptions = {}): Promise<SessionChannel[]> {
    const limit = options.limit ?? 100
    return [...this.sessionChannels.values()]
      .filter(channel => !options.sessionId || channel.participantSessionIds.includes(options.sessionId))
      .sort((a, b) => {
        const cmp = a.createdAt.localeCompare(b.createdAt)
        if (cmp !== 0) return cmp
        return a.channelId.localeCompare(b.channelId)
      })
      .slice(0, limit)
      .map(channel => structuredClone(channel))
  }

  async saveSessionMessage(message: SessionMessage): Promise<void> {
    this.sessionMessages.set(message.messageId, structuredClone(message))
  }

  async getSessionMessage(messageId: string): Promise<SessionMessage | null> {
    const message = this.sessionMessages.get(messageId)
    return message ? structuredClone(message) : null
  }

  async listSessionMessages(
    channelId: string,
    options: SessionMessageListOptions = {},
  ): Promise<SessionMessageListResult> {
    const limit = options.limit ?? 100
    const order = options.order ?? 'asc'
    const startIndex = options.cursor ? Number(options.cursor) : 0
    const messages = [...this.sessionMessages.values()]
      .filter(message => message.channelId === channelId)
      .sort(compareMessages)
    const orderedMessages = order === 'asc' ? messages : [...messages].reverse()
    const page = orderedMessages.slice(startIndex, startIndex + limit)
    const nextIndex = startIndex + page.length
    return {
      messages: structuredClone(page),
      nextCursor: nextIndex < orderedMessages.length ? String(nextIndex) : undefined,
    }
  }

  async listSessionInbox(
    sessionId: string,
    options: SessionInboxOptions = {},
  ): Promise<SessionMessage[]> {
    const limit = options.limit ?? 20
    const messages = [...this.sessionMessages.values()]
      .filter(message => isInboxMessage(message, sessionId, this.sessionChannels.get(message.channelId), options.includeAcknowledged ?? false))
      .sort(compareMessages)
    return structuredClone(messages.slice(Math.max(0, messages.length - limit)))
  }

  async acknowledgeSessionMessage(messageId: string, acknowledgedAt: string): Promise<SessionMessage | null> {
    const message = this.sessionMessages.get(messageId)
    if (!message) return null
    const acknowledged: SessionMessage = {
      ...message,
      acknowledgedAt,
      status: 'acknowledged',
    }
    this.sessionMessages.set(messageId, structuredClone(acknowledged))
    return structuredClone(acknowledged)
  }

  async savePermissionAudit(audit: PermissionAudit): Promise<void> {
    const list = this.permissionAudits.get(audit.sessionId) ?? []
    list.push(structuredClone(audit))
    this.permissionAudits.set(audit.sessionId, list)
  }

  async listPermissionAudits(sessionId: string): Promise<PermissionAudit[]> {
    const list = this.permissionAudits.get(sessionId) ?? []
    return structuredClone(list)
  }

  async saveExecutionMetrics(metrics: ExecutionMetrics): Promise<void> {
    this.executionMetricsMap.set(metrics.sessionId, structuredClone(metrics))
  }

  async getExecutionMetrics(sessionId: string): Promise<ExecutionMetrics | null> {
    const metrics = this.executionMetricsMap.get(sessionId)
    return metrics ? structuredClone(metrics) : null
  }

  async close(): Promise<void> {}

  private readonly loopPanes = new Map<string, LoopPaneState>()

  async upsertLoopPane(pane: LoopPaneState): Promise<LoopPaneState> {
    this.loopPanes.set(pane.paneId, { ...pane })
    return { ...pane }
  }

  async listLoopPanes(filter: LoopPaneFilter = {}): Promise<LoopPaneState[]> {
    const rows: LoopPaneState[] = []
    for (const pane of this.loopPanes.values()) {
      if (filter.workspaceId && pane.workspaceId !== filter.workspaceId) continue
      if (filter.tabId && pane.tabId !== filter.tabId) continue
      if (filter.paneId && pane.paneId !== filter.paneId) continue
      if (filter.sessionId && pane.sessionId !== filter.sessionId) continue
      rows.push({ ...pane })
    }
    rows.sort((a, b) => {
      if (a.workspaceId !== b.workspaceId) return a.workspaceId < b.workspaceId ? -1 : 1
      if (a.tabId !== b.tabId) return a.tabId < b.tabId ? -1 : 1
      return a.paneId < b.paneId ? -1 : 1
    })
    return rows
  }

  async deleteLoopPane(paneId: string): Promise<boolean> {
    return this.loopPanes.delete(paneId)
  }

  async updateLoopPaneRev(
    paneId: string,
    lastRev: number,
    updatedAt: string,
  ): Promise<LoopPaneState | null> {
    const current = this.loopPanes.get(paneId)
    if (!current) return null
    const next: LoopPaneState = { ...current, lastRev, updatedAt }
    this.loopPanes.set(paneId, next)
    return { ...next }
  }
}

function cloneSession(
  session: SessionSnapshot,
  includeEvents: boolean,
): SessionSnapshot {
  const cloned = structuredClone(session)
  if (!includeEvents) cloned.events = []
  return cloned
}

function matchesAgentJobFilter(job: AgentJob, filter: AgentJobFilter): boolean {
  if (filter.parentSessionId !== undefined && job.parentSessionId !== filter.parentSessionId) return false
  if (filter.status !== undefined && job.status !== filter.status) return false
  if (filter.agentType !== undefined && job.agentType !== filter.agentType) return false
  return true
}

function compareMessages(left: SessionMessage, right: SessionMessage): number {
  const cmp = left.createdAt.localeCompare(right.createdAt)
  if (cmp !== 0) return cmp
  return left.messageId.localeCompare(right.messageId)
}

function isInboxMessage(
  message: SessionMessage,
  sessionId: string,
  channel: SessionChannel | undefined,
  includeAcknowledged: boolean,
): boolean {
  if (!channel || !channel.participantSessionIds.includes(sessionId)) return false
  if (message.fromSessionId === sessionId) return false
  if (!includeAcknowledged && message.acknowledgedAt) return false
  if (message.toSessionId) return message.toSessionId === sessionId
  return message.broadcast === true
}
