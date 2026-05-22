import type { NexusEvent } from '../shared/events.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import type { ToolTrace } from '../shared/toolTrace.js'
import type {
  EventListOptions,
  EventListResult,
  NexusStorage,
  SessionGetOptions,
  StorageListOptions,
  ToolTraceListOptions,
  ToolTraceListResult,
  PermissionAudit,
} from './Storage.js'

export class MemoryStorage implements NexusStorage {
  private readonly sessions = new Map<string, SessionSnapshot>()
  private readonly tasks = new Map<string, NexusTask>()
  private readonly toolTraces = new Map<string, ToolTrace>()
  private readonly permissionAudits = new Map<string, PermissionAudit[]>()

  async saveSession(session: SessionSnapshot): Promise<void> {
    const cloned = structuredClone(session)
    const existing = this.sessions.get(session.sessionId)
    if (existing && cloned.events.length === 0) {
      cloned.events = structuredClone(existing.events)
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
    }
  }

  async appendEvent(sessionId: string, event: NexusEvent): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.events.push(structuredClone(event))
    session.updatedAt = event.timestamp

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
      }
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

  async savePermissionAudit(audit: PermissionAudit): Promise<void> {
    const list = this.permissionAudits.get(audit.sessionId) ?? []
    list.push(structuredClone(audit))
    this.permissionAudits.set(audit.sessionId, list)
  }

  async listPermissionAudits(sessionId: string): Promise<PermissionAudit[]> {
    const list = this.permissionAudits.get(sessionId) ?? []
    return structuredClone(list)
  }

  async close(): Promise<void> {}
}

function cloneSession(
  session: SessionSnapshot,
  includeEvents: boolean,
): SessionSnapshot {
  const cloned = structuredClone(session)
  if (!includeEvents) cloned.events = []
  return cloned
}
