import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
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
          error, last_user_input,
          queue_id, parent_session_id, assigned_agent_id, current_task_id,
          failure_reason, terminal_reason, pending_input
        ) VALUES (
          :sessionId, :cwd, :prompt, :phase, :createdAt, :updatedAt, :result,
          :error, :lastUserInput,
          :queueId, :parentSessionId, :assignedAgentId, :currentTaskId,
          :failureReason, :terminalReason, :pendingInput
        )
        ON CONFLICT(session_id) DO UPDATE SET
          cwd = excluded.cwd,
          prompt = excluded.prompt,
          phase = excluded.phase,
          updated_at = excluded.updated_at,
          result = excluded.result,
          error = excluded.error,
          last_user_input = excluded.last_user_input,
          queue_id = excluded.queue_id,
          parent_session_id = excluded.parent_session_id,
          assigned_agent_id = excluded.assigned_agent_id,
          current_task_id = excluded.current_task_id,
          failure_reason = excluded.failure_reason,
          terminal_reason = excluded.terminal_reason,
          pending_input = excluded.pending_input`,
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

    if (event.type === 'tool_started') {
      const trace: ToolTrace = {
        toolUseId: event.toolUseId,
        sessionId,
        name: event.name,
        input: event.input,
        startedAt: event.timestamp,
      }
      await this.saveToolTrace(trace)
    } else if (event.type === 'tool_completed') {
      const existing = await this.getToolTrace(event.toolUseId)
      if (existing) {
        const completedAt = event.timestamp
        const durationMs = new Date(completedAt).getTime() - new Date(existing.startedAt).getTime()
        const updated: ToolTrace = {
          ...existing,
          output: event.output,
          success: event.success,
          completedAt,
          durationMs,
        }
        await this.saveToolTrace(updated)
      }
    }
  }

  async saveTask(task: NexusTask): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tasks (
          task_id, session_id, title, status, created_at, updated_at, result,
          description, owner_agent_id, created_by_session_id, source,
          depends_on, blocks, retry_count, review, metadata
        ) VALUES (
          :taskId, :sessionId, :title, :status, :createdAt, :updatedAt, :result,
          :description, :ownerAgentId, :createdBySessionId, :source,
          :dependsOn, :blocks, :retryCount, :review, :metadata
        )
        ON CONFLICT(task_id) DO UPDATE SET
          session_id = excluded.session_id,
          title = excluded.title,
          status = excluded.status,
          updated_at = excluded.updated_at,
          result = excluded.result,
          description = excluded.description,
          owner_agent_id = excluded.owner_agent_id,
          created_by_session_id = excluded.created_by_session_id,
          source = excluded.source,
          depends_on = excluded.depends_on,
          blocks = excluded.blocks,
          retry_count = excluded.retry_count,
          review = excluded.review,
          metadata = excluded.metadata`,
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

  async saveToolTrace(trace: ToolTrace): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tool_traces (
          tool_use_id, session_id, name, input, output, success,
          started_at, completed_at, duration_ms
        ) VALUES (
          :toolUseId, :sessionId, :name, :input, :output, :success,
          :startedAt, :completedAt, :durationMs
        )
        ON CONFLICT(tool_use_id) DO UPDATE SET
          session_id = excluded.session_id,
          name = excluded.name,
          input = excluded.input,
          output = excluded.output,
          success = excluded.success,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          duration_ms = excluded.duration_ms`,
      )
      .run(toolTraceParams(trace))
  }

  async getToolTrace(toolUseId: string): Promise<ToolTrace | null> {
    const row = this.db
      .prepare(`SELECT * FROM tool_traces WHERE tool_use_id = ?`)
      .get(toolUseId) as Row | undefined
    return row ? rowToToolTrace(row) : null
  }

  async listToolTraces(
    sessionId: string,
    options: ToolTraceListOptions = {},
  ): Promise<ToolTraceListResult> {
    const limit = options.limit ?? 100
    const order = options.order ?? 'asc'
    const direction = order === 'asc' ? 'ASC' : 'DESC'

    let rows: Row[]
    if (options.cursor) {
      const lastPipeIndex = options.cursor.lastIndexOf('|')
      const cursorStartedAt = lastPipeIndex !== -1 ? options.cursor.substring(0, lastPipeIndex) : options.cursor
      const cursorToolUseId = lastPipeIndex !== -1 ? options.cursor.substring(lastPipeIndex + 1) : ''

      const comparisonQuery = order === 'asc'
        ? `(started_at > :cursorStartedAt OR (started_at = :cursorStartedAt AND tool_use_id > :cursorToolUseId))`
        : `(started_at < :cursorStartedAt OR (started_at = :cursorStartedAt AND tool_use_id < :cursorToolUseId))`

      rows = this.db
        .prepare(
          `SELECT * FROM tool_traces
           WHERE session_id = :sessionId AND ${comparisonQuery}
           ORDER BY started_at ${direction}, tool_use_id ${direction}
           LIMIT :limit`,
        )
        .all({
          sessionId,
          cursorStartedAt,
          cursorToolUseId,
          limit: limit + 1,
        }) as Row[]
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM tool_traces
           WHERE session_id = ?
           ORDER BY started_at ${direction}, tool_use_id ${direction}
           LIMIT ?`,
        )
        .all(sessionId, limit + 1) as Row[]
    }

    const page = rows.slice(0, limit)
    let nextCursor: string | undefined
    if (rows.length > limit) {
      const lastTrace = page[page.length - 1]
      if (lastTrace) {
        nextCursor = `${String(lastTrace.started_at)}|${String(lastTrace.tool_use_id)}`
      }
    }

    return {
      traces: page.map(rowToToolTrace),
      nextCursor,
    }
  }

  async savePermissionAudit(audit: PermissionAudit): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO permission_audits (
          audit_id, session_id, tool_use_id, tool_name, tool_risk,
          tool_input, decision, reason, timestamp
        ) VALUES (
          :auditId, :sessionId, :toolUseId, :toolName, :toolRisk,
          :toolInput, :decision, :reason, :timestamp
        )
        ON CONFLICT(audit_id) DO UPDATE SET
          session_id = excluded.session_id,
          tool_use_id = excluded.tool_use_id,
          tool_name = excluded.tool_name,
          tool_risk = excluded.tool_risk,
          tool_input = excluded.tool_input,
          decision = excluded.decision,
          reason = excluded.reason,
          timestamp = excluded.timestamp`
      )
      .run({
        auditId: audit.auditId,
        sessionId: audit.sessionId,
        toolUseId: audit.toolUseId,
        toolName: audit.toolName,
        toolRisk: audit.toolRisk,
        toolInput: JSON.stringify(audit.toolInput),
        decision: audit.decision,
        reason: audit.reason ?? null,
        timestamp: audit.timestamp,
      })
  }

  async listPermissionAudits(sessionId: string): Promise<PermissionAudit[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM permission_audits
         WHERE session_id = ?
         ORDER BY timestamp ASC`
      )
      .all(sessionId) as Row[]

    return rows.map(row => ({
      auditId: String(row.audit_id),
      sessionId: String(row.session_id),
      toolUseId: String(row.tool_use_id),
      toolName: String(row.tool_name),
      toolRisk: String(row.tool_risk),
      toolInput: JSON.parse(String(row.tool_input)),
      decision: String(row.decision) as 'approved' | 'denied',
      reason: nullableString(row.reason),
      timestamp: String(row.timestamp),
    }))
  }

  private initialize(): void {
    this.db.exec('PRAGMA journal_mode = WAL;')

    // Get current version
    const res = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    let version = res ? res.user_version : 0

    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          prompt TEXT NOT NULL,
          phase TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          result TEXT,
          error TEXT,
          last_user_input TEXT,
          queue_id TEXT,
          parent_session_id TEXT,
          assigned_agent_id TEXT,
          current_task_id TEXT,
          failure_reason TEXT,
          terminal_reason TEXT,
          pending_input TEXT
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
          result TEXT,
          description TEXT,
          owner_agent_id TEXT,
          created_by_session_id TEXT,
          source TEXT,
          depends_on TEXT,
          blocks TEXT,
          retry_count INTEGER,
          review TEXT,
          metadata TEXT
        );

        CREATE INDEX IF NOT EXISTS tasks_session_created_at_idx
          ON tasks(session_id, created_at ASC);

        CREATE TABLE IF NOT EXISTS tool_traces (
          tool_use_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          name TEXT NOT NULL,
          input TEXT NOT NULL,
          output TEXT,
          success INTEGER,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          duration_ms INTEGER
        );

        CREATE INDEX IF NOT EXISTS tool_traces_session_started_at_idx
          ON tool_traces(session_id, started_at ASC);
      `)

      // Dynamically alter schemas if columns do not exist
      const sessionsColumns = (this.db.prepare(`PRAGMA table_info(sessions)`).all() as Row[]).map(r => String(r.name))
      const expectedSessions = [
        { name: 'queue_id', type: 'TEXT' },
        { name: 'parent_session_id', type: 'TEXT' },
        { name: 'assigned_agent_id', type: 'TEXT' },
        { name: 'current_task_id', type: 'TEXT' },
        { name: 'failure_reason', type: 'TEXT' },
        { name: 'terminal_reason', type: 'TEXT' },
        { name: 'pending_input', type: 'TEXT' }
      ]
      for (const col of expectedSessions) {
        if (!sessionsColumns.includes(col.name)) {
          this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col.name} ${col.type}`)
        }
      }

      const tasksColumns = (this.db.prepare(`PRAGMA table_info(tasks)`).all() as Row[]).map(r => String(r.name))
      const expectedTasks = [
        { name: 'description', type: 'TEXT' },
        { name: 'owner_agent_id', type: 'TEXT' },
        { name: 'created_by_session_id', type: 'TEXT' },
        { name: 'source', type: 'TEXT' },
        { name: 'depends_on', type: 'TEXT' },
        { name: 'blocks', type: 'TEXT' },
        { name: 'retry_count', type: 'INTEGER' },
        { name: 'review', type: 'TEXT' },
        { name: 'metadata', type: 'TEXT' }
      ]
      for (const col of expectedTasks) {
        if (!tasksColumns.includes(col.name)) {
          this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col.name} ${col.type}`)
        }
      }

      this.db.exec('PRAGMA user_version = 1;')
      version = 1
    }

    if (version < 2) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS permission_audits (
          audit_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tool_use_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          tool_risk TEXT NOT NULL,
          tool_input TEXT NOT NULL,
          decision TEXT NOT NULL,
          reason TEXT,
          timestamp TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS permission_audits_session_idx
          ON permission_audits(session_id, timestamp ASC);
      `)
      this.db.exec('PRAGMA user_version = 2;')
      version = 2
    }
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
    queueId: session.queueId ?? null,
    parentSessionId: session.parentSessionId ?? null,
    assignedAgentId: session.assignedAgentId ?? null,
    currentTaskId: session.currentTaskId ?? null,
    failureReason: session.failureReason ?? null,
    terminalReason: session.terminalReason ? JSON.stringify(session.terminalReason) : null,
    pendingInput: session.pendingInput ? JSON.stringify(session.pendingInput) : null,
  }
}

function taskParams(task: NexusTask): Record<string, string | number | null> {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    result: task.result ?? null,
    description: task.description ?? null,
    ownerAgentId: task.ownerAgentId ?? null,
    createdBySessionId: task.createdBySessionId ?? null,
    source: task.source ?? null,
    dependsOn: JSON.stringify(task.dependsOn),
    blocks: JSON.stringify(task.blocks),
    retryCount: task.retryCount,
    review: task.review ? JSON.stringify(task.review) : null,
    metadata: task.metadata ? JSON.stringify(task.metadata) : null,
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
    queueId: nullableString(row.queue_id),
    parentSessionId: nullableString(row.parent_session_id),
    assignedAgentId: nullableString(row.assigned_agent_id),
    currentTaskId: nullableString(row.current_task_id),
    failureReason: nullableString(row.failure_reason),
    terminalReason: row.terminal_reason ? JSON.parse(String(row.terminal_reason)) : undefined,
    pendingInput: row.pending_input ? JSON.parse(String(row.pending_input)) : undefined,
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
    description: nullableString(row.description),
    ownerAgentId: nullableString(row.owner_agent_id),
    createdBySessionId: nullableString(row.created_by_session_id),
    source: (nullableString(row.source) as NexusTask['source']) ?? undefined,
    dependsOn: row.depends_on ? JSON.parse(String(row.depends_on)) : [],
    blocks: row.blocks ? JSON.parse(String(row.blocks)) : [],
    retryCount: row.retry_count !== null && row.retry_count !== undefined ? Number(row.retry_count) : 0,
    review: row.review ? JSON.parse(String(row.review)) : undefined,
    metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
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

function toolTraceParams(trace: ToolTrace): Record<string, string | number | null> {
  return {
    toolUseId: trace.toolUseId,
    sessionId: trace.sessionId,
    name: trace.name,
    input: JSON.stringify(trace.input),
    output: trace.output !== undefined ? (typeof trace.output === 'string' ? trace.output : JSON.stringify(trace.output)) : null,
    success: trace.success !== undefined ? (trace.success ? 1 : 0) : null,
    startedAt: trace.startedAt,
    completedAt: trace.completedAt ?? null,
    durationMs: trace.durationMs ?? null,
  }
}

function rowToToolTrace(row: Row): ToolTrace {
  let outputParsed: unknown = undefined
  if (row.output !== null && row.output !== undefined) {
    const rawOutput = String(row.output)
    try {
      outputParsed = JSON.parse(rawOutput)
    } catch {
      outputParsed = rawOutput
    }
  }

  return {
    toolUseId: String(row.tool_use_id),
    sessionId: String(row.session_id),
    name: String(row.name),
    input: JSON.parse(String(row.input)),
    output: outputParsed,
    success: row.success !== null && row.success !== undefined ? Boolean(row.success) : undefined,
    startedAt: String(row.started_at),
    completedAt: nullableString(row.completed_at),
    durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : undefined,
  }
}
