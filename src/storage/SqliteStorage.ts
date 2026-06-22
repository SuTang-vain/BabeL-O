import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
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
import { EventRepository } from './EventRepository.js'
import { TaskRepository } from './TaskRepository.js'
import { AuditRepository } from './AuditRepository.js'
import { ToolTraceRepository } from './ToolTraceRepository.js'
import { SessionChannelRepository } from './SessionChannelRepository.js'
import { AgentJobRepository } from './AgentJobRepository.js'
import { ExecutionMetricsRepository } from './ExecutionMetricsRepository.js'
import { LoopPaneRepository } from './LoopPaneRepository.js'

type Row = Record<string, unknown>

export class SqliteStorage implements NexusStorage {
  private readonly db: DatabaseSync
  private readonly eventRepository: EventRepository
  private readonly taskRepository: TaskRepository
  private readonly auditRepository: AuditRepository
  private readonly toolTraceRepository: ToolTraceRepository
  private readonly sessionChannelRepository: SessionChannelRepository
  private readonly agentJobRepository: AgentJobRepository
  private readonly executionMetricsRepository: ExecutionMetricsRepository
  private readonly loopPaneRepository: LoopPaneRepository

  constructor(private readonly databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true })
    }
    this.db = new DatabaseSync(databasePath)
    this.initialize()
    this.eventRepository = new EventRepository(this.db, {
      sequencedEventKey,
      onToolStarted: async (sessionId, event) => {
        const trace: ToolTrace = {
          toolUseId: event.toolUseId,
          sessionId,
          name: event.name,
          input: event.input,
          startedAt: event.timestamp,
        }
        await this.saveToolTrace(trace)
      },
      onToolCompleted: async (sessionId, event) => {
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
            remoteRunner: event.remoteRunner,
          }
          await this.saveToolTrace(updated)
        }
      },
      onToolDenied: async (sessionId, event) => {
        if (!event.toolUseId) return
        const existing = await this.getToolTrace(event.toolUseId)
        if (existing) {
          const completedAt = event.timestamp
          const durationMs = new Date(completedAt).getTime() - new Date(existing.startedAt).getTime()
          const updated: ToolTrace = {
            ...existing,
            output: {
              code: 'TOOL_DENIED',
              message: event.message,
              denialKind: event.denialKind,
              recoverable: event.recoverable,
              terminal: event.terminal,
            },
            success: false,
            completedAt,
            durationMs,
          }
          await this.saveToolTrace(updated)
        }
      },
      onExecutionMetrics: async (sessionId, event) => {
        const embeddedMetrics = executionMetricsFromEvent(sessionId, event)
        if (embeddedMetrics) {
          await this.saveExecutionMetrics(embeddedMetrics)
        }
      },
    })
    this.taskRepository = new TaskRepository(this.db)
    this.auditRepository = new AuditRepository(this.db)
    this.toolTraceRepository = new ToolTraceRepository(this.db)
    this.sessionChannelRepository = new SessionChannelRepository(this.db)
    this.agentJobRepository = new AgentJobRepository(this.db)
    this.executionMetricsRepository = new ExecutionMetricsRepository(this.db)
    this.loopPaneRepository = new LoopPaneRepository(this.db)
  }

  async saveSession(session: SessionSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions (
          session_id, cwd, prompt, phase, created_at, updated_at, result,
          error, last_user_input,
          queue_id, parent_session_id, assigned_agent_id, current_task_id,
          failure_reason, terminal_reason, pending_input, metadata, origin_cwd
        ) VALUES (
          :sessionId, :cwd, :prompt, :phase, :createdAt, :updatedAt, :result,
          :error, :lastUserInput,
          :queueId, :parentSessionId, :assignedAgentId, :currentTaskId,
          :failureReason, :terminalReason, :pendingInput, :metadata, :originCwd
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
         ORDER BY s.updated_at DESC, s.session_id ASC, e.event_seq ASC, e.event_key ASC`,
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
    return this.eventRepository.listEvents(sessionId, options)
  }

  async appendEvent(sessionId: string, event: NexusEvent): Promise<void> {
    await this.eventRepository.appendEvent(sessionId, event)
  }

  async saveTask(task: NexusTask): Promise<void> {
    await this.taskRepository.saveTask(task)
  }

  async getTask(taskId: string): Promise<NexusTask | null> {
    return this.taskRepository.getTask(taskId)
  }

  async listTasks(sessionId: string): Promise<NexusTask[]> {
    return this.taskRepository.listTasks(sessionId)
  }

  async saveAgentJob(job: AgentJob): Promise<void> {
    await this.agentJobRepository.saveAgentJob(job)
  }

  async getAgentJob(jobId: string): Promise<AgentJob | null> {
    return this.agentJobRepository.getAgentJob(jobId)
  }

  async listAgentJobs(filter: AgentJobFilter = {}): Promise<AgentJob[]> {
    return this.agentJobRepository.listAgentJobs(filter)
  }

  async close(): Promise<void> {
    this.db.close()
  }

  async upsertLoopPane(pane: LoopPaneState): Promise<LoopPaneState> {
    return this.loopPaneRepository.upsertLoopPane(pane)
  }

  async listLoopPanes(filter: LoopPaneFilter = {}): Promise<LoopPaneState[]> {
    return this.loopPaneRepository.listLoopPanes(filter)
  }

  async deleteLoopPane(paneId: string): Promise<boolean> {
    return this.loopPaneRepository.deleteLoopPane(paneId)
  }

  async updateLoopPaneRev(
    paneId: string,
    lastRev: number,
    updatedAt: string,
  ): Promise<LoopPaneState | null> {
    return this.loopPaneRepository.updateLoopPaneRev(paneId, lastRev, updatedAt)
  }

  async saveToolTrace(trace: ToolTrace): Promise<void> {
    await this.toolTraceRepository.saveToolTrace(trace)
  }

  async getToolTrace(toolUseId: string): Promise<ToolTrace | null> {
    return this.toolTraceRepository.getToolTrace(toolUseId)
  }

  async listToolTraces(
    sessionId: string,
    options: ToolTraceListOptions = {},
  ): Promise<ToolTraceListResult> {
    return this.toolTraceRepository.listToolTraces(sessionId, options)
  }

  async saveSessionChannel(channel: SessionChannel): Promise<void> {
    await this.sessionChannelRepository.saveSessionChannel(channel)
  }

  async getSessionChannel(channelId: string): Promise<SessionChannel | null> {
    return this.sessionChannelRepository.getSessionChannel(channelId)
  }

  async listSessionChannels(options: SessionChannelListOptions = {}): Promise<SessionChannel[]> {
    return this.sessionChannelRepository.listSessionChannels(options)
  }

  async saveSessionMessage(message: SessionMessage): Promise<void> {
    await this.sessionChannelRepository.saveSessionMessage(message)
  }

  async getSessionMessage(messageId: string): Promise<SessionMessage | null> {
    return this.sessionChannelRepository.getSessionMessage(messageId)
  }

  async listSessionMessages(
    channelId: string,
    options: SessionMessageListOptions = {},
  ): Promise<SessionMessageListResult> {
    return this.sessionChannelRepository.listSessionMessages(channelId, options)
  }

  async listSessionInbox(
    sessionId: string,
    options: SessionInboxOptions = {},
  ): Promise<SessionMessage[]> {
    return this.sessionChannelRepository.listSessionInbox(sessionId, options)
  }

  async acknowledgeSessionMessage(messageId: string, acknowledgedAt: string): Promise<SessionMessage | null> {
    return this.sessionChannelRepository.acknowledgeSessionMessage(messageId, acknowledgedAt)
  }

  async savePermissionAudit(audit: PermissionAudit): Promise<void> {
    await this.auditRepository.savePermissionAudit(audit)
  }

  async listPermissionAudits(sessionId: string): Promise<PermissionAudit[]> {
    return this.auditRepository.listPermissionAudits(sessionId)
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
          event_json TEXT NOT NULL,
          event_seq INTEGER
        );

        CREATE INDEX IF NOT EXISTS events_session_timestamp_idx
          ON events(session_id, timestamp ASC);

        CREATE INDEX IF NOT EXISTS events_session_key_idx
          ON events(session_id, event_key ASC);

        CREATE INDEX IF NOT EXISTS events_session_seq_idx
          ON events(session_id, event_seq ASC);

        CREATE UNIQUE INDEX IF NOT EXISTS events_session_event_seq_unique
          ON events(session_id, event_seq)
          WHERE event_seq IS NOT NULL;

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
          duration_ms INTEGER,
          remote_runner TEXT
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
        { name: 'metadata', type: 'TEXT' },
        { name: 'origin_cwd', type: 'TEXT' },
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

      this.ensureEventSequenceSchema()

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
      version = 6
    }

    if (version < 7) {
      const executionMetricsColumns = (this.db.prepare(`PRAGMA table_info(execution_metrics)`).all() as Row[]).map(r => String(r.name))
      const addColumn = (name: string, definition: string) => {
        if (!executionMetricsColumns.includes(name)) {
          this.db.exec(`ALTER TABLE execution_metrics ADD COLUMN ${name} ${definition}`)
        }
      }
      addColumn('prefix_cache_immutable_ratio', 'REAL')
      addColumn('prefix_cache_volatile_content_last', 'INTEGER')
      addColumn('prefix_cache_fingerprint', 'TEXT')
      this.db.exec('PRAGMA user_version = 7;')
      version = 7
    }

    if (version < 8) {
      const toolTraceColumns = (this.db.prepare(`PRAGMA table_info(tool_traces)`).all() as Row[]).map(r => String(r.name))
      if (!toolTraceColumns.includes('remote_runner')) {
        this.db.exec(`ALTER TABLE tool_traces ADD COLUMN remote_runner TEXT`)
      }
      const executionMetricsColumns = (this.db.prepare(`PRAGMA table_info(execution_metrics)`).all() as Row[]).map(r => String(r.name))
      const addColumn = (name: string, definition: string) => {
        if (!executionMetricsColumns.includes(name)) {
          this.db.exec(`ALTER TABLE execution_metrics ADD COLUMN ${name} ${definition}`)
        }
      }
      addColumn('remote_tool_call_count', 'INTEGER')
      addColumn('remote_tool_runner_duration_ms', 'REAL')
      this.db.exec('PRAGMA user_version = 8;')
      version = 8
    }

    if (version < 9) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_jobs (
          job_id TEXT PRIMARY KEY,
          parent_session_id TEXT NOT NULL,
          child_session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          agent_type TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          job_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS agent_jobs_parent_session_idx
          ON agent_jobs(parent_session_id, created_at ASC, job_id ASC);

        CREATE INDEX IF NOT EXISTS agent_jobs_status_idx
          ON agent_jobs(status, created_at ASC, job_id ASC);

        CREATE INDEX IF NOT EXISTS agent_jobs_agent_type_idx
          ON agent_jobs(agent_type, created_at ASC, job_id ASC);
      `)
      this.db.exec('PRAGMA user_version = 9;')
      version = 9
    }

    if (version < 10) {
      const executionMetricsColumns = (this.db.prepare(`PRAGMA table_info(execution_metrics)`).all() as Row[]).map(r => String(r.name))
      const addColumn = (name: string, definition: string) => {
        if (!executionMetricsColumns.includes(name)) {
          this.db.exec(`ALTER TABLE execution_metrics ADD COLUMN ${name} ${definition}`)
        }
      }
      addColumn('model_context_window', 'INTEGER')
      addColumn('reserved_output_tokens', 'INTEGER')
      addColumn('provider_safety_buffer_tokens', 'INTEGER')
      addColumn('env_max_context_tokens', 'INTEGER')
      addColumn('context_policy_source', 'TEXT')
      addColumn('context_warning_threshold_percent', 'REAL')
      addColumn('context_compact_threshold_percent', 'REAL')
      addColumn('context_warning_threshold_tokens', 'INTEGER')
      addColumn('context_compact_threshold_tokens', 'INTEGER')
      addColumn('context_blocking_limit_tokens', 'INTEGER')
      this.db.exec('PRAGMA user_version = 10;')
      version = 10
    }

    if (version < 11) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_channels (
          channel_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          participant_session_ids TEXT NOT NULL,
          created_by_session_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL,
          policy_json TEXT NOT NULL,
          metadata_json TEXT
        );

        CREATE INDEX IF NOT EXISTS session_channels_created_at_idx
          ON session_channels(created_at ASC, channel_id ASC);

        CREATE TABLE IF NOT EXISTS session_messages (
          message_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          from_session_id TEXT NOT NULL,
          to_session_id TEXT,
          broadcast INTEGER NOT NULL DEFAULT 0,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          evidence_json TEXT,
          priority TEXT NOT NULL,
          created_at TEXT NOT NULL,
          delivered_at TEXT,
          acknowledged_at TEXT,
          status TEXT NOT NULL,
          metadata_json TEXT
        );

        CREATE INDEX IF NOT EXISTS session_messages_channel_created_at_idx
          ON session_messages(channel_id, created_at ASC, message_id ASC);

        CREATE INDEX IF NOT EXISTS session_messages_created_at_idx
          ON session_messages(created_at ASC, message_id ASC);
      `)
      this.db.exec('PRAGMA user_version = 11;')
      version = 11
    }

    if (version < 12) {
      this.ensureEventSequenceSchema()
      this.db.exec('PRAGMA user_version = 12;')
      version = 12
    }

    if (version < 13) {
      this.ensureEventSequenceSchema()
      this.db.exec('PRAGMA user_version = 13;')
      version = 13
    }

    if (version < 14) {
      // bbl loop Phase 1b: per-pane workspace/tab/pane ↔ session
      // mapping. One row per pane; lastRev tracks the highest
      // event_seq the client has consumed so the loop can
      // resume across server restarts.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS loop_state (
          pane_id      TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          tab_id       TEXT NOT NULL,
          session_id   TEXT NOT NULL,
          agent        TEXT NOT NULL,
          cwd          TEXT NOT NULL,
          label        TEXT,
          last_rev     INTEGER NOT NULL DEFAULT 0,
          updated_at   TEXT NOT NULL,
          PRIMARY KEY (pane_id)
        );

        CREATE INDEX IF NOT EXISTS loop_state_session_idx
          ON loop_state(session_id);
        CREATE INDEX IF NOT EXISTS loop_state_workspace_idx
          ON loop_state(workspace_id, tab_id, pane_id);
      `)
      this.db.exec('PRAGMA user_version = 14;')
      version = 14
    }

    if (version < 15) {
      // Bug 2 (context-cwd-drift plan §13.4): immutable origin_cwd column.
      // Written once at session creation (launcher body.cwd / Nexus
      // defaultCwd), never overwritten by per-turn session.cwd mutations
      // (saveSession's ON CONFLICT clause does not touch origin_cwd). Phase
      // B continuity uses it to pull a drifted requestCwd back to the
      // project root. Backfills existing rows with their current cwd as a
      // best-effort origin (pre-Bug-2 sessions have no recorded origin).
      const sessionsColumns = (this.db.prepare(`PRAGMA table_info(sessions)`).all() as Row[]).map(r => String(r.name))
      if (!sessionsColumns.includes('origin_cwd')) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN origin_cwd TEXT`)
      }
      // Backfill is unconditional + idempotent (WHERE origin_cwd IS NULL):
      // the column may already exist via the v1 dynamic ALTER above, in
      // which case the ADD COLUMN is skipped but pre-existing NULL rows
      // still need backfilling.
      this.db.exec(`UPDATE sessions SET origin_cwd = cwd WHERE origin_cwd IS NULL`)
      this.db.exec('PRAGMA user_version = 15;')
      version = 15
    }
  }

  private ensureEventSequenceSchema(): void {
    const eventColumns = (this.db.prepare(`PRAGMA table_info(events)`).all() as Row[]).map(r => String(r.name))
    if (!eventColumns.includes('event_seq')) {
      this.db.exec(`ALTER TABLE events ADD COLUMN event_seq INTEGER`)
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS events_session_seq_idx
        ON events(session_id, event_seq ASC);
    `)
    this.backfillEventSequence()
    this.repairDuplicateEventSequences()
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS events_session_event_seq_unique
        ON events(session_id, event_seq)
        WHERE event_seq IS NOT NULL;
    `)
  }

  private backfillEventSequence(): void {
    const sessions = this.db
      .prepare(`SELECT DISTINCT session_id FROM events WHERE event_seq IS NULL ORDER BY session_id ASC`)
      .all() as Row[]
    if (sessions.length === 0) return

    const selectRows = this.db.prepare(`
      SELECT event_key FROM events
      WHERE session_id = ? AND event_seq IS NULL
      ORDER BY timestamp ASC,
        CASE event_type
          WHEN 'session_started' THEN 10
          WHEN 'user_message' THEN 20
          WHEN 'user_intake_guidance' THEN 30
          WHEN 'task_scope_declared' THEN 40
          WHEN 'assistant_delta' THEN 50
          WHEN 'thinking_delta' THEN 55
          WHEN 'tool_started' THEN 60
          WHEN 'permission_request' THEN 70
          WHEN 'permission_response' THEN 80
          WHEN 'tool_completed' THEN 90
          WHEN 'context_grounding_confirmed' THEN 100
          WHEN 'result' THEN 200
          WHEN 'error' THEN 210
          ELSE 150
        END ASC,
        event_key ASC
    `)
    const maxSeqStmt = this.db.prepare(`SELECT COALESCE(MAX(event_seq), 0) AS max_seq FROM events WHERE session_id = ?`)
    const updateStmt = this.db.prepare(`UPDATE events SET event_seq = ? WHERE event_key = ?`)
    this.db.exec('BEGIN')
    try {
      for (const sessionId of sessions.map(row => String(row.session_id))) {
        const maxRow = maxSeqStmt.get(sessionId) as Row | undefined
        let seq = Number(maxRow?.max_seq ?? 0)
        const rows = selectRows.all(sessionId) as Row[]
        for (const row of rows) {
          seq += 1
          updateStmt.run(seq, String(row.event_key))
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private repairDuplicateEventSequences(): void {
    const sessions = this.db
      .prepare(`SELECT session_id FROM events WHERE event_seq IS NOT NULL GROUP BY session_id, event_seq HAVING COUNT(*) > 1`)
      .all() as Row[]
    const sessionIds = Array.from(new Set(sessions.map(row => String(row.session_id))))
    if (sessionIds.length === 0) return

    const selectRows = this.db.prepare(`
      SELECT event_key FROM events
      WHERE session_id = ?
      ORDER BY event_seq ASC,
        timestamp ASC,
        CASE event_type
          WHEN 'session_started' THEN 10
          WHEN 'user_message' THEN 20
          WHEN 'user_intake_guidance' THEN 30
          WHEN 'task_scope_declared' THEN 40
          WHEN 'assistant_delta' THEN 50
          WHEN 'thinking_delta' THEN 55
          WHEN 'tool_started' THEN 60
          WHEN 'permission_request' THEN 70
          WHEN 'permission_response' THEN 80
          WHEN 'tool_completed' THEN 90
          WHEN 'context_grounding_confirmed' THEN 100
          WHEN 'result' THEN 200
          WHEN 'error' THEN 210
          ELSE 150
        END ASC,
        event_key ASC
    `)
    const clearStmt = this.db.prepare(`UPDATE events SET event_seq = NULL WHERE session_id = ?`)
    const updateStmt = this.db.prepare(`UPDATE events SET event_seq = ? WHERE event_key = ?`)
    this.db.exec('BEGIN')
    try {
      for (const sessionId of sessionIds) {
        const rows = selectRows.all(sessionId) as Row[]
        clearStmt.run(sessionId)
        let seq = 0
        for (const row of rows) {
          seq += 1
          updateStmt.run(seq, String(row.event_key))
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
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
         ORDER BY event_seq ASC, event_key ASC`,
      )
      .all(sessionId) as Row[]
    return rows.map(row => JSON.parse(String(row.event_json)) as NexusEvent)
  }

  async saveExecutionMetrics(metrics: ExecutionMetrics): Promise<void> {
    await this.executionMetricsRepository.saveExecutionMetrics(metrics)
  }

  async getExecutionMetrics(sessionId: string): Promise<ExecutionMetrics | null> {
    return this.executionMetricsRepository.getExecutionMetrics(sessionId)
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
    metadata: session.metadata ? JSON.stringify(session.metadata) : null,
    originCwd: session.originCwd ?? null,
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
    originCwd: nullableString(row.origin_cwd),
  }
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

function sequencedEventKey(sessionId: string, eventSeq: number, eventJson: string, event: NexusEvent): string {
  const digest = createHash('sha256').update(eventJson).digest('hex').slice(0, 12)
  return `${sessionId}:${String(eventSeq).padStart(12, '0')}:${event.timestamp}:${event.type}:${eventIndexPayload(event)}:${digest}`
}

function eventIndexPayload(event: NexusEvent): string {
  if ('toolUseId' in event && event.toolUseId !== undefined) return String(event.toolUseId)
  if ('taskId' in event && event.taskId !== undefined) return String(event.taskId)
  if ('code' in event && event.code !== undefined) return String(event.code)
  if ('eventId' in event && event.eventId !== undefined) return String(event.eventId)
  return ''
}
