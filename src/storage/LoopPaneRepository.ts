/**
 * Phase 3B-27 slice — `LoopPaneRepository.ts`
 *
 * Extracted from `src/storage/SqliteStorage.ts`. Contains
 * the `LoopPaneRepository` class that owns the
 * `loop_state` table operations: `upsertLoopPane`,
 * `listLoopPanes`, `deleteLoopPane`,
 * `updateLoopPaneRev`, plus the inline `rowToLoopPane`
 * mapping helper those methods depend on.
 *
 * The repository is constructed with a `DatabaseSync`
 * handle (the same one the `SqliteStorage` class uses)
 * and is wired into `SqliteStorage` as a field so the
 * public `upsertLoopPane` / `listLoopPanes` /
 * `deleteLoopPane` / `updateLoopPaneRev` methods on
 * `SqliteStorage` delegate to the repository.
 *
 * Why extracted:
 *
 * - `SqliteStorage.ts` is a ~1045-line file that
 *   manages all SQLite table initializations,
 *   schemas, transaction locks, serialization maps,
 *   and per-domain data. Each table's operations form
 *   an independent reviewable boundary, but they are
 *   currently all inline in one class.
 * - Loop panes are a distinct domain (per-pane UI
 *   state for the loop client: workspace / tab /
 *   session coordinates, agent identity, working
 *   directory, optional human-readable label, and a
 *   `last_rev` cursor that lets the client resume
 *   mid-loop across server restarts) with its own
 *   indexed query path
 *   (`listLoopPanes({ workspaceId, tabId, paneId, sessionId })`).
 * - The `updateLoopPaneRev` read-modify-write is
 *   coupled to `listLoopPanes` (read) and a
 *   `last_rev` write — keeping those two operations in
 *   the same file makes the boundary explicit.
 * - The `updateLoopPaneRev` upsert pattern (read →
 *   mutate → write) is the only such composite write
 *   in Stream G; documenting the boundary here makes
 *   that pattern easier to audit in future review.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: same UPSERT
 *   statement, same filter composition (workspaceId,
 *   tabId, paneId, sessionId in that conditional
 *   order), same `ORDER BY workspace_id ASC,
 *   tab_id ASC, pane_id ASC`, same `last_rev ?? 0`
 *   fallback, same `row.label == null ? null : String(...)`
 *   ternary.
 * - Eliminate ~100 lines of inline code from
 *   `SqliteStorage.ts`.
 *
 * Non-goals:
 *
 * - Do not change the SQL schema (column order,
 *   constraint, default, or index set).
 * - Do not change the `LoopPaneState` / `LoopPaneFilter`
 *   shape — those are owned by the storage interface
 *   contract.
 * - Do not change the schema-migration block that
 *   creates the `loop_state` table (still owned by
 *   `SqliteStorage.initialize`); this slice only moves
 *   the per-row operations boundary.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { LoopPaneFilter, LoopPaneState } from './Storage.js'

type Row = Record<string, unknown>

export class LoopPaneRepository {
  constructor(private readonly db: DatabaseSync) {}

  async upsertLoopPane(pane: LoopPaneState): Promise<LoopPaneState> {
    this.db
      .prepare(
        `INSERT INTO loop_state (
          pane_id, workspace_id, tab_id, session_id,
          agent, cwd, label, last_rev, updated_at
        ) VALUES (
          @paneId, @workspaceId, @tabId, @sessionId,
          @agent, @cwd, @label, @lastRev, @updatedAt
        )
        ON CONFLICT(pane_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          tab_id = excluded.tab_id,
          session_id = excluded.session_id,
          agent = excluded.agent,
          cwd = excluded.cwd,
          label = excluded.label,
          last_rev = excluded.last_rev,
          updated_at = excluded.updated_at`,
      )
      .run({
        paneId: pane.paneId,
        workspaceId: pane.workspaceId,
        tabId: pane.tabId,
        sessionId: pane.sessionId,
        agent: pane.agent,
        cwd: pane.cwd,
        label: pane.label,
        lastRev: pane.lastRev,
        updatedAt: pane.updatedAt,
      })
    return pane
  }

  async listLoopPanes(filter: LoopPaneFilter = {}): Promise<LoopPaneState[]> {
    const conditions: string[] = []
    const params: Record<string, string> = {}
    if (filter.workspaceId) {
      conditions.push('workspace_id = @workspaceId')
      params.workspaceId = filter.workspaceId
    }
    if (filter.tabId) {
      conditions.push('tab_id = @tabId')
      params.tabId = filter.tabId
    }
    if (filter.paneId) {
      conditions.push('pane_id = @paneId')
      params.paneId = filter.paneId
    }
    if (filter.sessionId) {
      conditions.push('session_id = @sessionId')
      params.sessionId = filter.sessionId
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT pane_id, workspace_id, tab_id, session_id,
                agent, cwd, label, last_rev, updated_at
         FROM loop_state
         ${where}
         ORDER BY workspace_id ASC, tab_id ASC, pane_id ASC`,
      )
      .all(params) as Row[]
    return rows.map(rowToLoopPane)
  }

  async deleteLoopPane(paneId: string): Promise<boolean> {
    const result = this.db
      .prepare('DELETE FROM loop_state WHERE pane_id = ?')
      .run(paneId)
    return Number(result.changes ?? 0) > 0
  }

  async updateLoopPaneRev(
    paneId: string,
    lastRev: number,
    updatedAt: string,
  ): Promise<LoopPaneState | null> {
    const existing = await this.listLoopPanes({ paneId })
    const current = existing[0]
    if (!current) return null
    const next: LoopPaneState = { ...current, lastRev, updatedAt }
    this.db
      .prepare(
        'UPDATE loop_state SET last_rev = ?, updated_at = ? WHERE pane_id = ?',
      )
      .run(lastRev, updatedAt, paneId)
    return next
  }
}

// ─── helpers ─────────────────────────────────────────────

function rowToLoopPane(row: Row): LoopPaneState {
  return {
    paneId: String(row.pane_id),
    workspaceId: String(row.workspace_id),
    tabId: String(row.tab_id),
    sessionId: String(row.session_id),
    agent: String(row.agent),
    cwd: String(row.cwd),
    label: row.label == null ? null : String(row.label),
    lastRev: Number(row.last_rev ?? 0),
    updatedAt: String(row.updated_at),
  }
}
