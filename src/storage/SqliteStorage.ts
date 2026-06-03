import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { NexusEvent } from '../shared/events.js'
import type { SessionSnapshot } from '../shared/session.js'
import type { NexusTask } from '../shared/task.js'
import type { ToolTrace } from '../shared/toolTrace.js'
import type {
  ChildSessionListOptions,
  EventListOptions,
  EventListResult,
  NexusStorage,
  SessionGetOptions,
  StorageListOptions,
  ToolTraceListOptions,
  ToolTraceListResult,
  PermissionAudit,
  ExecutionMetrics,
} from './Storage.js'
import { executionMetricsFromEvent } from './executionMetricsEvent.js'

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
          failure_reason, terminal_reason, pending_input, metadata
        ) VALUES (
          :sessionId, :cwd, :prompt, :phase, :createdAt, :updatedAt, :result,
          :error, :lastUserInput,
          :queueId, :parentSessionId, :assignedAgentId, :currentTaskId,
          :failureReason, :terminalReason, :pendingInput, :metadata
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
          pending_input = excluded.pending_input,
          metadata = excluded.metadata`,
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
    const limit = options.limit ?? 50
    const includeEvents = options.includeEvents ?? false

    if (!includeEvents) {
      const rows = this.db
        .prepare(
          `SELECT * FROM sessions
           ORDER BY updated_at DESC, session_id ASC
           LIMIT ?`,
        )
        .all(limit) as Row[]
      return rows.map(row => rowToSession(row, []))
    }

    // 采用 LEFT JOIN 一次性检索出所有的 sessions 及其 events，避免 N+1 查询
    const rows = this.db
      .prepare(
        `SELECT s.*, e.event_json FROM sessions s
         LEFT JOIN events e ON s.session_id = e.session_id
         WHERE s.session_id IN (
           SELECT session_id FROM sessions
           ORDER BY updated_at DESC, session_id ASC
           LIMIT ?
         )
         ORDER BY s.updated_at DESC, s.session_id ASC, e.timestamp ASC, e.event_key ASC`,
      )
      .all(limit) as Row[]

    // 记录正确的顺序
    const orderedSessionIds = this.db
      .prepare(
        `SELECT session_id FROM sessions
         ORDER BY updated_at DESC, session_id ASC
         LIMIT ?`,
      )
      .all(limit) as Row[]

    const sessionMap = new Map<string, { row: Row; events: NexusEvent[] }>()
    for (const row of rows) {
      const sid = String(row.session_id)
      let entry = sessionMap.get(sid)
      if (!entry) {
        entry = { row, events: [] }
        sessionMap.set(sid, entry)
      }
      if (row.event_json !== null && row.event_json !== undefined) {
        entry.events.push(JSON.parse(String(row.event_json)) as NexusEvent)
      }
    }

    const result: SessionSnapshot[] = []
    for (const osid of orderedSessionIds) {
      const sid = String(osid.session_id)
      const entry = sessionMap.get(sid)
      if (entry) {
        result.push(rowToSession(entry.row, entry.events))
      }
    }
    return result
  }

  async listChildSessions(
    parentSessionId: string,
    options: ChildSessionListOptions = {},
  ): Promise<SessionSnapshot[]> {
    const limit = options.limit ?? 50
    const includeEvents = options.includeEvents ?? false

    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE parent_session_id = ?
         ORDER BY created_at ASC, session_id ASC
         LIMIT ?`,
      )
      .all(parentSessionId, limit) as Row[]

    if (!includeEvents) return rows.map(row => rowToSession(row, []))

    const result: SessionSnapshot[] = []
    for (const row of rows) {
      const sessionId = String(row.session_id)
      result.push(rowToSession(row, await this.listAllEvents(sessionId)))
    }
    return result
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

    if (event.type === 'session_started') {
      this.db
        .prepare(`UPDATE sessions SET cwd = ?, updated_at = ? WHERE session_id = ?`)
        .run(event.cwd, event.timestamp, sessionId)
    }

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

    const embeddedMetrics = executionMetricsFromEvent(sessionId, event)
    if (embeddedMetrics) {
      await this.saveExecutionMetrics(embeddedMetrics)
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
          pending_input TEXT,
          metadata TEXT
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
          ON tool_traces(session_id, started_at ASC, tool_use_id ASC);
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
        { name: 'pending_input', type: 'TEXT' },
        { name: 'metadata', type: 'TEXT' }
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

    if (version < 3) {
      this.db.exec(`
        DROP INDEX IF EXISTS tool_traces_session_started_at_idx;
        CREATE INDEX IF NOT EXISTS tool_traces_session_started_at_idx
          ON tool_traces(session_id, started_at ASC, tool_use_id ASC);
      `)
      this.db.exec('PRAGMA user_version = 3;')
      version = 3
    }

    if (version < 4) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS execution_metrics (
          metric_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          execute_duration_ms REAL,
          provider_first_token_ms REAL,
          provider_request_duration_ms REAL,
          stream_delta_count INTEGER,
          tool_call_count INTEGER,
          tool_roundtrip_duration_ms REAL,
          context_chars_in INTEGER,
          context_chars_out INTEGER,
          timestamp TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS execution_metrics_session_idx
          ON execution_metrics(session_id);
      `)
      this.db.exec('PRAGMA user_version = 4;')
      version = 4
    }

    if (version < 5) {
      const sessionsColumns = (this.db.prepare(`PRAGMA table_info(sessions)`).all() as Row[]).map(r => String(r.name))
      if (!sessionsColumns.includes('metadata')) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN metadata TEXT`)
      }
      this.db.exec('PRAGMA user_version = 5;')
      version = 5
    }

    if (version < 6) {
      const executionMetricsColumns = (this.db.prepare(`PRAGMA table_info(execution_metrics)`).all() as Row[]).map(r => String(r.name))
      const addColumn = (name: string, definition: string) => {
        if (!executionMetricsColumns.includes(name)) {
          this.db.exec(`ALTER TABLE execution_metrics ADD COLUMN ${name} ${definition}`)
        }
      }
      addColumn('input_tokens', 'INTEGER')
      addColumn('output_tokens', 'INTEGER')
      addColumn('cache_creation_input_tokens', 'INTEGER')
      addColumn('cache_read_input_tokens', 'INTEGER')
      addColumn('effective_context_ceiling', 'INTEGER')
      addColumn('legacy_context_ceiling', 'INTEGER')
      addColumn('cache_read_ratio', 'REAL')
      addColumn('cache_preservation_mode', 'INTEGER')
      addColumn('long_context_utilization_mode', 'INTEGER')
      addColumn('compact_summary_latency_ms', 'REAL')
      this.db.exec('PRAGMA user_version = 6;')
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

  async saveExecutionMetrics(metrics: ExecutionMetrics): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO execution_metrics (
          metric_id, session_id, execute_duration_ms, provider_first_token_ms,
          provider_request_duration_ms, stream_delta_count, tool_call_count,
          tool_roundtrip_duration_ms, context_chars_in, context_chars_out,
          input_tokens, output_tokens, cache_creation_input_tokens,
          cache_read_input_tokens, effective_context_ceiling,
          legacy_context_ceiling, cache_read_ratio, cache_preservation_mode,
          long_context_utilization_mode, compact_summary_latency_ms, timestamp
        ) VALUES (
          :metricId, :sessionId, :executeDurationMs, :providerFirstTokenMs,
          :providerRequestDurationMs, :streamDeltaCount, :toolCallCount,
          :toolRoundtripDurationMs, :contextCharsIn, :contextCharsOut,
          :inputTokens, :outputTokens, :cacheCreationInputTokens,
          :cacheReadInputTokens, :effectiveContextCeiling,
          :legacyContextCeiling, :cacheReadRatio, :cachePreservationMode,
          :longContextUtilizationMode, :compactSummaryLatencyMs, :timestamp
        )
        ON CONFLICT(metric_id) DO UPDATE SET
          execute_duration_ms = excluded.execute_duration_ms,
          provider_first_token_ms = excluded.provider_first_token_ms,
          provider_request_duration_ms = excluded.provider_request_duration_ms,
          stream_delta_count = excluded.stream_delta_count,
          tool_call_count = excluded.tool_call_count,
          tool_roundtrip_duration_ms = excluded.tool_roundtrip_duration_ms,
          context_chars_in = excluded.context_chars_in,
          context_chars_out = excluded.context_chars_out,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_creation_input_tokens = excluded.cache_creation_input_tokens,
          cache_read_input_tokens = excluded.cache_read_input_tokens,
          effective_context_ceiling = excluded.effective_context_ceiling,
          legacy_context_ceiling = excluded.legacy_context_ceiling,
          cache_read_ratio = excluded.cache_read_ratio,
          cache_preservation_mode = excluded.cache_preservation_mode,
          long_context_utilization_mode = excluded.long_context_utilization_mode,
          compact_summary_latency_ms = excluded.compact_summary_latency_ms,
          timestamp = excluded.timestamp`
      )
      .run({
        metricId: metrics.metricId,
        sessionId: metrics.sessionId,
        executeDurationMs: metrics.executeDurationMs ?? null,
        providerFirstTokenMs: metrics.providerFirstTokenMs ?? null,
        providerRequestDurationMs: metrics.providerRequestDurationMs ?? null,
        streamDeltaCount: metrics.streamDeltaCount ?? null,
        toolCallCount: metrics.toolCallCount ?? null,
        toolRoundtripDurationMs: metrics.toolRoundtripDurationMs ?? null,
        contextCharsIn: metrics.contextCharsIn ?? null,
        contextCharsOut: metrics.contextCharsOut ?? null,
        inputTokens: metrics.inputTokens ?? null,
        outputTokens: metrics.outputTokens ?? null,
        cacheCreationInputTokens: metrics.cacheCreationInputTokens ?? null,
        cacheReadInputTokens: metrics.cacheReadInputTokens ?? null,
        effectiveContextCeiling: metrics.effectiveContextCeiling ?? null,
        legacyContextCeiling: metrics.legacyContextCeiling ?? null,
        cacheReadRatio: metrics.cacheReadRatio ?? null,
        cachePreservationMode: booleanToDb(metrics.cachePreservationMode),
        longContextUtilizationMode: booleanToDb(metrics.longContextUtilizationMode),
        compactSummaryLatencyMs: metrics.compactSummaryLatencyMs ?? null,
        timestamp: metrics.timestamp,
      })
  }

  async getExecutionMetrics(sessionId: string): Promise<ExecutionMetrics | null> {
    const row = this.db
      .prepare(`SELECT * FROM execution_metrics WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`)
      .get(sessionId) as Row | undefined
    if (!row) return null
    return {
      metricId: String(row.metric_id),
      sessionId: String(row.session_id),
      executeDurationMs: row.execute_duration_ms !== null && row.execute_duration_ms !== undefined ? Number(row.execute_duration_ms) : undefined,
      providerFirstTokenMs: row.provider_first_token_ms !== null && row.provider_first_token_ms !== undefined ? Number(row.provider_first_token_ms) : undefined,
      providerRequestDurationMs: row.provider_request_duration_ms !== null && row.provider_request_duration_ms !== undefined ? Number(row.provider_request_duration_ms) : undefined,
      streamDeltaCount: row.stream_delta_count !== null && row.stream_delta_count !== undefined ? Number(row.stream_delta_count) : undefined,
      toolCallCount: row.tool_call_count !== null && row.tool_call_count !== undefined ? Number(row.tool_call_count) : undefined,
      toolRoundtripDurationMs: row.tool_roundtrip_duration_ms !== null && row.tool_roundtrip_duration_ms !== undefined ? Number(row.tool_roundtrip_duration_ms) : undefined,
      contextCharsIn: row.context_chars_in !== null && row.context_chars_in !== undefined ? Number(row.context_chars_in) : undefined,
      contextCharsOut: row.context_chars_out !== null && row.context_chars_out !== undefined ? Number(row.context_chars_out) : undefined,
      inputTokens: row.input_tokens !== null && row.input_tokens !== undefined ? Number(row.input_tokens) : undefined,
      outputTokens: row.output_tokens !== null && row.output_tokens !== undefined ? Number(row.output_tokens) : undefined,
      cacheCreationInputTokens: row.cache_creation_input_tokens !== null && row.cache_creation_input_tokens !== undefined ? Number(row.cache_creation_input_tokens) : undefined,
      cacheReadInputTokens: row.cache_read_input_tokens !== null && row.cache_read_input_tokens !== undefined ? Number(row.cache_read_input_tokens) : undefined,
      effectiveContextCeiling: row.effective_context_ceiling !== null && row.effective_context_ceiling !== undefined ? Number(row.effective_context_ceiling) : undefined,
      legacyContextCeiling: row.legacy_context_ceiling !== null && row.legacy_context_ceiling !== undefined ? Number(row.legacy_context_ceiling) : undefined,
      cacheReadRatio: row.cache_read_ratio !== null && row.cache_read_ratio !== undefined ? Number(row.cache_read_ratio) : undefined,
      cachePreservationMode: dbToBoolean(row.cache_preservation_mode),
      longContextUtilizationMode: dbToBoolean(row.long_context_utilization_mode),
      compactSummaryLatencyMs: row.compact_summary_latency_ms !== null && row.compact_summary_latency_ms !== undefined ? Number(row.compact_summary_latency_ms) : undefined,
      timestamp: String(row.timestamp),
    }
  }
}

function booleanToDb(value: boolean | undefined): number | null {
  if (value === undefined) return null
  return value ? 1 : 0
}

function dbToBoolean(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined
  return Number(value) === 1
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
    metadata: session.metadata ? JSON.stringify(session.metadata) : null,
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
    metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
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
  if ('toolUseId' in event && event.toolUseId !== undefined) return String(event.toolUseId)
  if ('taskId' in event && event.taskId !== undefined) return String(event.taskId)
  if ('code' in event && event.code !== undefined) return String(event.code)
  if ('eventId' in event && event.eventId !== undefined) return String(event.eventId)
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
