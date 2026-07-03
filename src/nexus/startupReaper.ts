/**
 * Startup orphan reaper.
 *
 * Phase 2 of
 * `docs/nexus/proposals/daemon-graceful-shutdown-and-orphan-reaper-plan.md`.
 *
 * A daemon crash (kill -9, OOM, reboot) leaves two kinds of persisted
 * state stranded:
 *   - Sessions in an in-flight phase (executing / reviewing / waiting_user
 *     / waiting_permission). Before this reaper they stayed in their
 *     in-flight phase forever and the UI showed a frozen badge.
 *   - Agent jobs in `running` (or queued / waiting_permission) status.
 *     The registry's `loadPersistedJobs` rehydrates job records but never
 *     transitions stale `running` jobs to terminal (`AgentScheduler.ts:236`),
 *     so a reaped job would block a fresh daemon's `listAgents`.
 *
 * The reaper runs once on startup, after storage is open and before the
 * server accepts traffic. It is **non-fatal**: a failure (schema mismatch,
 * concurrent boot) is logged and the daemon still starts. The next boot
 * will re-run the reaper and clean up anything that survived.
 *
 * Phase transitions:
 *   - Session `executing|reviewing|waiting_user|waiting_permission`
 *     → `interrupted` (recoverable terminal; distinct from `failed`).
 *   - Agent job `running` → `failed` (reason `orphaned_on_restart`),
 *     with the child session finalized to terminal.
 *
 * `interrupted` was added to `SessionPhase` and to the three TERMINAL
 * sets (taskSession / sessionLifecycle / sessionTaskMutationRouter) in
 * the preceding commit.
 */

import type { ExploreAgentScheduler } from './agents/AgentScheduler.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { SessionPhase, SessionSnapshot } from '../shared/session.js'
import { logger } from '../shared/logger.js'
import { nowIso } from '../shared/id.js'

/**
 * In-flight session phases that the reaper transitions to `interrupted`.
 * Anything in a terminal phase (completed / failed / cancelled /
 * interrupted) is left alone.
 */
const IN_FLIGHT_SESSION_PHASES: ReadonlySet<SessionPhase> = new Set<SessionPhase>([
  'created',
  'planning',
  'executing',
  'reviewing',
  'waiting_user',
  'waiting_permission',
])

const ORPHAN_SESSION_TERMINAL_REASON = {
  category: 'runtime' as const,
  code: 'daemon_restart_orphan',
  message:
    'Session was in an in-flight phase when the Nexus daemon was last killed; reaped on startup so reconnecting clients see a clean terminal state instead of a frozen in-flight badge.',
}

export type ReaperReport = {
  reapedSessions: number
  reapedAgentJobs: number
  /** Set when the reaper itself failed; the daemon still proceeds to start. */
  error?: string
}

/**
 * Run the startup orphan reaper. Best-effort: any failure is captured in
 * the returned `error` field rather than thrown, so the daemon can still
 * start. The next boot will re-run the reaper against whatever survived.
 */
export async function runStartupReaper(options: {
  storage: NexusStorage
  agentScheduler: ExploreAgentScheduler
  /**
   * Per-boot override for `listSessions` paging. The reaper fetches
   * every session to filter in-flight ones in memory; the limit is a
   * defensive ceiling that should be far above any realistic tree size
   * in the daemon's primary use cases. Default 100,000.
   */
  sessionListLimit?: number
  now?: () => string
}): Promise<ReaperReport> {
  const now = options.now ?? nowIso
  const limit = options.sessionListLimit ?? 100_000
  const report: ReaperReport = {
    reapedSessions: 0,
    reapedAgentJobs: 0,
  }

  try {
    report.reapedSessions = await reapInFlightSessions(options.storage, now, limit)
  } catch (error) {
    report.error = describeError(error)
    logger.error('startup reaper: session reaping failed (non-fatal)', { error })
  }

  try {
    report.reapedAgentJobs = await options.agentScheduler.reapOrphanedJobsOnStartup()
  } catch (error) {
    // The session-error field already holds the first failure; keep the
    // first one (avoids losing signal if both fail) but log the second.
    if (!report.error) report.error = describeError(error)
    logger.error('startup reaper: agent-job reaping failed (non-fatal)', { error })
  }

  logger.info('startup reaper: complete', {
    reapedSessions: report.reapedSessions,
    reapedAgentJobs: report.reapedAgentJobs,
    error: report.error,
  })
  return report
}

async function reapInFlightSessions(
  storage: NexusStorage,
  now: () => string,
  limit: number,
): Promise<number> {
  const allSessions = await storage.listSessions({ limit, includeEvents: false })
  const orphans = allSessions.filter(session => IN_FLIGHT_SESSION_PHASES.has(session.phase))
  if (orphans.length === 0) return 0

  const reapedAt = now()
  for (const session of orphans) {
    // Mutate a copy so the in-memory list (if any) is not affected. The
    // on-disk row is what matters; the in-memory list is the agent-loop
    // path's source of truth and is wiped on every daemon boot anyway.
    const reaped: SessionSnapshot = {
      ...session,
      phase: 'interrupted',
      updatedAt: reapedAt,
      terminalReason: ORPHAN_SESSION_TERMINAL_REASON,
      error: ORPHAN_SESSION_TERMINAL_REASON.message,
    }
    await storage.saveSession(reaped)
  }
  return orphans.length
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
