import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
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

type Row = Record<string, unknown>

export class SqliteStorage implements NexusStorage {
  private readonly db: DatabaseSync

  constructor(private readonly databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true })
    }
    this.db = new DatabaseSync(databasePath)
    this.initialize()
  }

  async saveSession(session: SessionSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions (
          session_id, cwd, prompt, phase, created_at, updated_at, result,
          error, last_user_input
        ) VALUES (
          :sessionId, :cwd, :prompt, :phase, :createdAt, :updatedAt, :result,
          :error, :lastUserInput
        )
        ON CONFLICT(session_id) DO UPDATE SET
          cwd = excluded.cwd,
          prompt = excluded.prompt,
          phase = excluded.phase,
          updated_at = excluded.updated_at,
          result = excluded.result,
          error = excluded.error,
          last_user_input = excluded.last_user_input`,
      )
      .run(sessionParams(session))

    for (const event of session.events) {
      await this.appendEvent(session.sessionId, event)
    }
  }

  async getSession(
    sessionId: string,
    options: SessionGetOptions = {},
  ): Promise<SessionSnapshot | null> {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get(sessionId) as Row | undefined
    if (!row) return null
    return rowToSession(
      row,
      options.includeEvents ?? true ? await this.listAllEvents(sessionId) : [],
    )
  }

  async listSessions(options: StorageListOptions = {}): Promise<SessionSnapshot[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         ORDER BY updated_at DESC, session_id ASC
         LIMIT ?`,
      )
      .all(options.limit ?? 50) as Row[]
    const includeEvents = options.includeEvents ?? false

    return Promise.all(
      rows.map(row =>
        rowToSession(
          row,
          includeEvents ? this.listEventsSync(String(row.session_id)) : [],
        ),
      ),
    )
  }

  async listEvents(
    sessionId: string,
    options: EventListOptions = {},
  ): Promise<EventListResult> {
    const limit = options.limit ?? 100
    const order = options.order ?? 'asc'
    const comparison = order === 'asc' ? '>' : '<'
    const direction = order === 'asc' ? 'ASC' : 'DESC'
    const rows = options.cursor
      ? (this.db
          .prepare(
            `SELECT event_key, event_json FROM events
             WHERE session_id = ? AND event_key ${comparison} ?
             ORDER BY event_key ${direction}
             LIMIT ?`,
          )
          .all(sessionId, options.cursor, limit + 1) as Row[])
      : (this.db
          .prepare(
            `SELECT event_key, event_json FROM events
             WHERE session_id = ?
             ORDER BY event_key ${direction}
             LIMIT ?`,
          )
          .all(sessionId, limit + 1) as Row[])

    const page = rows.slice(0, limit)
    return {
      events: page.map(row => JSON.parse(String(row.event_json)) as NexusEvent),
      nextCursor:
        rows.length > limit ? String(page.at(-1)?.event_key ?? '') : undefined,
    }
  }

  async appendEvent(sessionId: string, event: NexusEvent): Promise<void> {
    const eventKey = `${sessionId}:${event.timestamp}:${event.type}:${eventIndexPayload(event)}`
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events (
          event_key, session_id, timestamp, event_type, event_json
        ) VALUES (
          :eventKey, :sessionId, :timestamp, :eventType, :eventJson
        )`,
      )
      .run({
        eventKey,
        sessionId,
        timestamp: event.timestamp,
        eventType: event.type,
        eventJson: JSON.stringify(event),
      })

    this.db
      .prepare(`UPDATE sessions SET updated_at = ? WHERE session_id = ?`)
      .run(event.timestamp, sessionId)
  }

  async saveTask(task: NexusTask): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tasks (
          task_id, session_id, title, status, created_at, updated_at, result
        ) VALUES (
          :taskId, :sessionId, :title, :status, :createdAt, :updatedAt, :result
        )
        ON CONFLICT(task_id) DO UPDATE SET
          session_id = excluded.session_id,
          title = excluded.title,
          status = excluded.status,
          updated_at = excluded.updated_at,
          result = excluded.result`,
      )
      .run(taskParams(task))
  }

  async getTask(taskId: string): Promise<NexusTask | null> {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
      .get(taskId) as Row | undefined
    return row ? rowToTask(row) : null
  }

  async listTasks(sessionId: string): Promise<NexusTask[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE session_id = ?
         ORDER BY created_at ASC, task_id ASC`,
      )
      .all(sessionId) as Row[]
    return rows.map(rowToTask)
  }

  async close(): Promise<void> {
    this.db.close()
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        prompt TEXT NOT NULL,
        phase TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        result TEXT,
        error TEXT,
        last_user_input TEXT
      );

      CREATE INDEX IF NOT EXISTS sessions_updated_at_idx
        ON sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        event_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_session_timestamp_idx
        ON events(session_id, timestamp ASC);

      CREATE INDEX IF NOT EXISTS events_session_key_idx
        ON events(session_id, event_key ASC);

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        result TEXT
      );

      CREATE INDEX IF NOT EXISTS tasks_session_created_at_idx
        ON tasks(session_id, created_at ASC);
    `)
  }

  private async listAllEvents(sessionId: string): Promise<NexusEvent[]> {
    return this.listEventsSync(sessionId)
  }

  private listEventsSync(sessionId: string): NexusEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_json FROM events
         WHERE session_id = ?
         ORDER BY timestamp ASC, event_key ASC`,
      )
      .all(sessionId) as Row[]
    return rows.map(row => JSON.parse(String(row.event_json)) as NexusEvent)
  }
}

function sessionParams(session: SessionSnapshot): Record<string, string | null> {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    prompt: session.prompt,
    phase: session.phase,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    result: session.result ?? null,
    error: session.error ?? null,
    lastUserInput: session.lastUserInput ?? null,
  }
}

function taskParams(task: NexusTask): Record<string, string | null> {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    result: task.result ?? null,
  }
}

function rowToSession(row: Row, events: NexusEvent[]): SessionSnapshot {
  return {
    sessionId: String(row.session_id),
    cwd: String(row.cwd),
    prompt: String(row.prompt),
    phase: String(row.phase) as SessionSnapshot['phase'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    result: nullableString(row.result),
    error: nullableString(row.error),
    lastUserInput: nullableString(row.last_user_input),
    events,
  }
}

function rowToTask(row: Row): NexusTask {
  return {
    taskId: String(row.task_id),
    sessionId: String(row.session_id),
    title: String(row.title),
    status: String(row.status) as NexusTask['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    result: nullableString(row.result),
  }
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

function eventIndexPayload(event: NexusEvent): string {
  if ('toolUseId' in event) return event.toolUseId
  if ('taskId' in event) return event.taskId
  if ('code' in event) return event.code
  return ''
}
