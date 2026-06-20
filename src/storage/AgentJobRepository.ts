/**
 * Phase 3B-25 slice — `AgentJobRepository.ts`
 *
 * Extracted from `src/storage/SqliteStorage.ts`. Contains
 * the `AgentJobRepository` class that owns the
 * `agent_jobs` table operations: `saveAgentJob`,
 * `getAgentJob`, `listAgentJobs`, plus the inline
 * `agentJobParams` mapping helper those methods depend
 * on.
 *
 * The repository is constructed with a `DatabaseSync`
 * handle (the same one the `SqliteStorage` class uses)
 * and is wired into `SqliteStorage` as a field so the
 * public `saveAgentJob` / `getAgentJob` /
 * `listAgentJobs` methods on `SqliteStorage` delegate
 * to the repository.
 *
 * Why extracted:
 *
 * - `SqliteStorage.ts` is a ~1250-line file that
 *   manages all SQLite table initializations,
 *   schemas, transaction locks, serialization maps,
 *   and per-domain data. Each table's operations form
 *   an independent reviewable boundary, but they are
 *   currently all inline in one class.
 * - Agent jobs are a distinct domain (sub-agent
 *   dispatch records with parent/child session ids,
 *   status state machine, governance metadata, and
 *   full transcript JSON snapshots) with their own
 *   indexed query path
 *   (`listAgentJobs({ parentSessionId, status, agentType })`).
 * - The dual-storage shape (`job_json` plus indexed
 *   scalar columns for filter predicates) is a
 *   reviewable design on its own — pulling the
 *   operations out makes the boundary explicit and
 *   lets future governance / fork-mode fields stay
 *   isolated from the storage class.
 * - Future slices (ExecutionMetricsRepository,
 *   LoopPaneRepository) will follow the same
 *   construction pattern.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: same SQL UPSERT
 *   statement, same `JSON.stringify(job)` for
 *   `job_json`, same conditional WHERE clause for
 *   optional filters (parentSessionId, status,
 *   agentType), same `ORDER BY created_at ASC,
 *   job_id ASC`.
 * - Eliminate ~55 lines of inline code + 1 helper
 *   function from `SqliteStorage.ts`.
 *
 * Non-goals:
 *
 * - Do not change the SQL schema (column order,
 *   constraint, default, or index set).
 * - Do not change the `AgentJob` shape or the
 *   `AgentJobFilter` shape — those are owned by the
 *   storage interface contract.
 * - Do not change the dual-storage design (the full
 *   job JSON is still snapshotted into `job_json`
 *   while scalar fields are still indexed for query
 *   predicates); this slice only moves the storage
 *   boundary.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { AgentJob, AgentJobFilter } from '../shared/agentJob.js'

type Row = Record<string, unknown>

export class AgentJobRepository {
  constructor(private readonly db: DatabaseSync) {}

  async saveAgentJob(job: AgentJob): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_jobs (
          job_id, parent_session_id, child_session_id, status, agent_type,
          created_at, updated_at, completed_at, job_json
        ) VALUES (
          :jobId, :parentSessionId, :childSessionId, :status, :agentType,
          :createdAt, :updatedAt, :completedAt, :jobJson
        )
        ON CONFLICT(job_id) DO UPDATE SET
          parent_session_id = excluded.parent_session_id,
          child_session_id = excluded.child_session_id,
          status = excluded.status,
          agent_type = excluded.agent_type,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          job_json = excluded.job_json`,
      )
      .run(agentJobParams(job))
  }

  async getAgentJob(jobId: string): Promise<AgentJob | null> {
    const row = this.db
      .prepare(`SELECT job_json FROM agent_jobs WHERE job_id = ?`)
      .get(jobId) as Row | undefined
    return row ? JSON.parse(String(row.job_json)) as AgentJob : null
  }

  async listAgentJobs(filter: AgentJobFilter = {}): Promise<AgentJob[]> {
    const conditions: string[] = []
    const params: Record<string, string> = {}
    if (filter.parentSessionId !== undefined) {
      conditions.push('parent_session_id = :parentSessionId')
      params.parentSessionId = filter.parentSessionId
    }
    if (filter.status !== undefined) {
      conditions.push('status = :status')
      params.status = filter.status
    }
    if (filter.agentType !== undefined) {
      conditions.push('agent_type = :agentType')
      params.agentType = filter.agentType
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT job_json FROM agent_jobs
         ${where}
         ORDER BY created_at ASC, job_id ASC`,
      )
      .all(params) as Row[]
    return rows.map(row => JSON.parse(String(row.job_json)) as AgentJob)
  }
}

// ─── helpers ─────────────────────────────────────────────

function agentJobParams(job: AgentJob): Record<string, string | null> {
  return {
    jobId: job.jobId,
    parentSessionId: job.parentSessionId,
    childSessionId: job.childSessionId,
    status: job.status,
    agentType: job.agentType,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt ?? null,
    jobJson: JSON.stringify(job),
  }
}
