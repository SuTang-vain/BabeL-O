import type { NexusEvent } from '../shared/events.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import type {
  EventListOptions,
  EventListResult,
  NexusStorage,
  SessionGetOptions,
  StorageListOptions,
} from './Storage.js'

export class MemoryStorage implements NexusStorage {
  private readonly sessions = new Map<string, SessionSnapshot>()
  private readonly tasks = new Map<string, NexusTask>()

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
