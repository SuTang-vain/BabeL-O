/**
 * Phase 3B-23 slice — `ToolTraceRepository.ts`
 *
 * Extracted from `src/storage/SqliteStorage.ts`. Contains
 * the `ToolTraceRepository` class that owns the
 * `tool_traces` table operations: `saveToolTrace`,
 * `getToolTrace`, `listToolTraces`, plus the inline
 * `toolTraceParams` / `rowToToolTrace` mapping helpers
 * those methods depend on.
 *
 * The repository is constructed with a `DatabaseSync`
 * handle (the same one the `SqliteStorage` class uses)
 * and is wired into `SqliteStorage` as a field so the
 * public `saveToolTrace` / `getToolTrace` /
 * `listToolTraces` methods on `SqliteStorage` delegate
 * to the repository.
 *
 * Why extracted:
 *
 * - `SqliteStorage.ts` is a ~1600-line file that
 *   manages all SQLite table initializations,
 *   schemas, transaction locks, serialization maps,
 *   and per-domain data. Each table's operations form
 *   an independent reviewable boundary, but they are
 *   currently all inline in one class.
 * - Tool traces are a distinct domain (per-tool-call
 *   execution record with started/completed timing,
 *   input / output capture, success flag, and optional
 *   remote-runner diagnostics) with its own column
 *   shape and its own read path
 *   (`listToolTraces({ sessionId, cursor, limit, order })`
 *   with a composite `started_at | tool_use_id` cursor).
 * - The composite cursor pagination is a reviewable
 *   feature on its own — pulling the operations out
 *   makes the boundary explicit and lets future
 *   cursor optimizations stay isolated from the
 *   storage class.
 * - Future slices (SessionChannelRepository,
 *   AgentJobRepository, ExecutionMetricsRepository,
 *   LoopPaneRepository) will follow the same
 *   construction pattern.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: same SQL UPSERT
 *   statement, same `JSON.stringify` for `input`,
 *   same conditional `output` serialization (string
 *   vs JSON, with `null` when omitted), same
 *   `success` boolean→0/1 conversion, same composite
 *   `started_at | tool_use_id` cursor semantics, same
 *   `nextCursor` return shape.
 * - Eliminate ~90 lines of inline code + 2 helper
 *   functions from `SqliteStorage.ts`.
 *
 * Non-goals:
 *
 * - Do not change the SQL schema (column order,
 *   constraint, or default).
 * - Do not change the `ToolTrace` shape or the
 *   composite cursor encoding — those are owned by
 *   the storage interface contract.
 * - Do not change the `EventRepository.onToolStarted`
 *   / `EventRepository.onToolCompleted` callbacks
 *   that already drive `saveToolTrace` updates; this
 *   slice only moves the storage boundary.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { ToolTrace } from '../shared/toolTrace.js'
import type { ToolTraceListOptions, ToolTraceListResult } from './Storage.js'

type Row = Record<string, unknown>

export class ToolTraceRepository {
  constructor(private readonly db: DatabaseSync) {}

  async saveToolTrace(trace: ToolTrace): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tool_traces (
          tool_use_id, session_id, name, input, output, success,
          started_at, completed_at, duration_ms, remote_runner
        ) VALUES (
          :toolUseId, :sessionId, :name, :input, :output, :success,
          :startedAt, :completedAt, :durationMs, :remoteRunner
        )
        ON CONFLICT(tool_use_id) DO UPDATE SET
          session_id = excluded.session_id,
          name = excluded.name,
          input = excluded.input,
          output = excluded.output,
          success = excluded.success,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          duration_ms = excluded.duration_ms,
          remote_runner = excluded.remote_runner`,
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
}

// ─── helpers ─────────────────────────────────────────────

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
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
    remoteRunner: trace.remoteRunner ? JSON.stringify(trace.remoteRunner) : null,
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
    remoteRunner: row.remote_runner ? JSON.parse(String(row.remote_runner)) : undefined,
  }
}
