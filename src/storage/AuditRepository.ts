/**
 * Phase 3B-22 slice — `AuditRepository.ts`
 *
 * Extracted from `src/storage/SqliteStorage.ts`. Contains
 * the `AuditRepository` class that owns the
 * `permission_audits` table operations:
 * `savePermissionAudit`, `listPermissionAudits`.
 *
 * The repository is constructed with a `DatabaseSync`
 * handle (the same one the `SqliteStorage` class uses)
 * and is wired into `SqliteStorage` as a field so the
 * public `savePermissionAudit` / `listPermissionAudits`
 * methods on `SqliteStorage` delegate to the repository.
 * Future slices (ToolTraceRepository,
 * SessionChannelRepository, AgentJobRepository,
 * ExecutionMetricsRepository, LoopPaneRepository) will
 * follow the same construction pattern.
 *
 * Why extracted:
 *
 * - `SqliteStorage.ts` is a ~1600-line file that
 *   manages all SQLite table initializations,
 *   schemas, transaction locks, serialization maps,
 *   and per-domain data. Each table's operations form
 *   an independent reviewable boundary, but they are
 *   currently all inline in one class.
 * - Permission audits are a distinct domain
 *   (scope-boundary / tool-call / approval / denial
 *   trail) with its own column shape (`audit_id`,
 *   `tool_use_id`, `tool_name`, `tool_risk`,
 *   `tool_input` JSON column, `decision`,
 *   `reason?`, `timestamp`) and its own read path
 *   (`listPermissionAudits(sessionId)` ordered by
 *   timestamp ASC). Pulling the operations out makes
 *   the audit boundary explicit.
 * - Future slices (ToolTraceRepository,
 *   SessionChannelRepository, AgentJobRepository,
 *   ExecutionMetricsRepository, LoopPaneRepository)
 *   will follow the same construction pattern.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: same SQL UPSERT
 *   statement, same `JSON.stringify` for `toolInput`,
 *   same ordering (`timestamp ASC`), same
 *   `nullableString` mapping for the optional
 *   `reason` column.
 * - Eliminate ~50 lines of inline code from
 *   `SqliteStorage.ts`.
 *
 * Non-goals:
 *
 * - Do not change the SQL schema (column order,
 *   constraint, or default).
 * - Do not change the `PermissionAudit` shape or the
 *   `decision` enum ('approved' | 'denied') — those
 *   are owned by `src/storage/Storage.ts`.
 * - Do not change the scope-boundary / approval /
 *   denial semantics; this slice only moves the
 *   storage boundary.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { PermissionAudit } from './Storage.js'

type Row = Record<string, unknown>

export class AuditRepository {
  constructor(private readonly db: DatabaseSync) {}

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
          timestamp = excluded.timestamp`,
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
         ORDER BY timestamp ASC`,
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
}

// ─── helpers ─────────────────────────────────────────────

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}
