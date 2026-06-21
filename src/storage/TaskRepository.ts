/**
 * Phase 3B-21 slice — `TaskRepository.ts`
 *
 * Extracted from `src/storage/SqliteStorage.ts`. Contains
 * the `TaskRepository` class that owns the `tasks` table
 * operations: `saveTask`, `getTask`, `listTasks`, plus
 * the inline `taskParams` / `rowToTask` mapping helpers
 * those methods depend on.
 *
 * The repository is constructed with a `DatabaseSync`
 * handle (the same one the `SqliteStorage` class uses)
 * and is wired into `SqliteStorage` as a field so the
 * public `saveTask` / `getTask` / `listTasks` methods
 * on `SqliteStorage` delegate to the repository.
 * Future slices (AuditRepository, ToolTraceRepository)
 * will follow the same pattern.
 *
 * Why extracted:
 *
 * - `SqliteStorage.ts` is a ~1700-line file that
 *   manages all SQLite table initializations,
 *   schemas, transaction locks, serialization maps,
 *   event logging, task storage, and audit logs.
 *   Changes to different data models are coupled in
 *   this file, making testing of isolated entities
 *   harder and increasing merge-conflict risk.
 * - Tasks are a distinct domain (agent-coordination
 *   task DAG, planning-loop state) with its own
 *   serialization rules (`dependsOn` / `blocks` /
 *   `review` / `metadata` are JSON columns) and its
 *   own read paths (`listTasks(sessionId)` ordered by
 *   created_at). Pulling the operations out makes the
 *   task boundary explicit and lets the rest of the
 *   storage evolve independently.
 * - Future slices (AuditRepository,
 *   ToolTraceRepository, SessionChannelRepository)
 *   will follow the same construction pattern.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: same SQL UPSERT
 *   statement, same `JSON.parse` / `JSON.stringify`
 *   semantics for `dependsOn` / `blocks` / `review` /
 *   `metadata`, same ordering (`created_at ASC,
 *   task_id ASC`), same `nullableString` mapping for
 *   optional columns.
 * - Eliminate ~50 lines of inline code + 2 helper
 *   functions from `SqliteStorage.ts`.
 *
 * Non-goals:
 *
 * - Do not change the SQL schema (column order,
 *   constraint, or default).
 * - Do not change the task status enum or the
 *   `NexusTask` shape — those are owned by
 *   `src/shared/task.ts`.
 * - Do not change the agent-coordination retry /
 *   review semantics; this slice only moves the
 *   storage boundary.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { NexusTask } from '../shared/task.js'

type Row = Record<string, unknown>

export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

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
}

// ─── helpers ─────────────────────────────────────────────

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
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
