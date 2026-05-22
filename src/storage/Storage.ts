import type { NexusEvent } from '../shared/events.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'

export type StorageListOptions = {
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

export interface NexusStorage {
  saveSession(session: SessionSnapshot): Promise<void>
  getSession(
    sessionId: string,
    options?: SessionGetOptions,
  ): Promise<SessionSnapshot | null>
  listSessions(options?: StorageListOptions): Promise<SessionSnapshot[]>
  listEvents(sessionId: string, options?: EventListOptions): Promise<EventListResult>
  appendEvent(sessionId: string, event: NexusEvent): Promise<void>
  saveTask(task: NexusTask): Promise<void>
  getTask(taskId: string): Promise<NexusTask | null>
  listTasks(sessionId: string): Promise<NexusTask[]>
  close?(): Promise<void>
}
