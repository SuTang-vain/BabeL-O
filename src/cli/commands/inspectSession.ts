import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'
import { Command } from 'commander'
import { DatabaseSync } from 'node:sqlite'
import {
  projectAgentTrace,
  traceToJsonl,
  traceToJson,
  type AgentTrace,
} from '../../runtime/agentTrace.js'
import {
  deriveResumableState,
  type DerivedResumableState,
} from '../../runtime/runCheckpoint.js'
import type { NexusEvent } from '../../shared/events.js'
import type { TaskSessionTerminalReason } from '../../shared/session.js'

const TERMINAL_REASON_CATEGORIES = ['error', 'timeout', 'cancelled', 'provider', 'runtime', 'unknown'] as const

/**
 * Phase 0 of `docs/nexus/reference/go-tui-session-observability-governance-plan.md`:
 * `bbl inspect-session <id>` CLI for diagnosing Go TUI session persistence
 * issues. Tries both `session_go_<unixnano>` and `session_<uuid>` formats in
 * the local SQLite storage; falls back to scanning
 * `~/.babel-o/log/embedded-nexus.log` and `~/.babel-o/log/go-tui-session.log`
 * for client-side hints.
 *
 * Three-tier hint model:
 *   1. (a) Found in SQLite with events       → render events + metadata
 *   2. (b) Found in client log but not SQLite → "embedded Nexus crashed before save"
 *   3. (c) Not found anywhere                 → "session not persisted"
 *      (+ recent embedded-nexus start log entries for context)
 *
 * Hard invariants (per memory `babel-o-test-config-isolation.md` and the
 * governance plan §4 non-goals):
 *  - Never reads / writes the user's real `~/.babel-o/config.json`; uses
 *    `DEFAULT_CONFIG_DIR` (which honours `BABEL_O_CONFIG_DIR` /
 *    `BABEL_O_CONFIG_FILE` env vars) for test isolation.
 *  - Never silently mutates storage; inspect-session is read-only.
 *  - Never opens a writeable handle to the SQLite DB (uses `:memory:` mode
 *    in tests to avoid lock contention with the running Nexus).
 *  - Never invokes a provider or makes an HTTP call; this CLI is purely
 *    local file / SQLite inspection.
 */

export type InspectSessionTier =
  | { tier: 'found-in-sqlite'; row: SessionRow }
  | { tier: 'found-in-client-log-only'; clientHits: ClientLogHit[] }
  | { tier: 'not-found'; clientHits: ClientLogHit[]; recentEmbeddedStarts: EmbeddedNexusStart[] }

export type SessionRow = {
  sessionId: string
  phase: string | null
  cwd: string | null
  createdAt: string | null
  updatedAt: string | null
  prompt: string | null
  result: string | null
  error: string | null
  eventCount: number
  compactBoundaries: CompactBoundaryInspection[]
  // clientSessionId is the Go TUI Phase 1 back-reference
  // (typically `session_go_<unixnano>`) stored in the server
  // session row's metadata column. Empty when the client
  // didn't set one (bbl chat, curl, older Go TUI) or when
  // the metadata column is missing.
  clientSessionId: string | null
}

export type CompactBoundaryInspection = {
  type: 'compact_boundary' | 'context_compact_boundary'
  timestamp: string | null
  trigger: string | null
  boundaryId: string | null
  beforeEventCount: number | null
  afterEventCount: number | null
  preTokens: number | null
  postTokens: number | null
  estimatedTokensSaved: number | null
  summaryChars: number | null
  snippedToolResults: number | null
  messagesSummarized: number | null
  droppedItemCount: number | null
  retainedItemCount: number | null
  retainedEventCount: number | null
  preservedTailEventId: string | null
  retainedSegmentHash: string | null
  userVisibleSummary: string | null
}

export type ClientLogHit = {
  logPath: string
  matchedLine: string
  lineNumber: number
}

export type EmbeddedNexusStart = {
  logPath: string
  matchedLine: string
  lineNumber: number
  pid: number | null
  storage: string | null
  cwd: string | null
  startedAt: string | null
}

/**
 * Resolve the active Babel-O config directory at call time. Reads
 * `BABEL_O_CONFIG_DIR` and `BABEL_O_CONFIG_FILE` env vars every time
 * rather than relying on the module-level `DEFAULT_CONFIG_DIR`
 * constant (which is captured at import time and would defeat
 * test isolation).
 */
export function resolveConfigDir(): string {
  const fromDir = process.env.BABEL_O_CONFIG_DIR
  if (fromDir) return fromDir
  const fromFile = process.env.BABEL_O_CONFIG_FILE
  if (fromFile) return join(fromFile, '..')
  // Fall back to the user default (`~/.babel-o`) for non-test paths.
  // We avoid importing the module-level `DEFAULT_CONFIG_DIR` so
  // tests that mutate `BABEL_O_CONFIG_DIR` mid-process take effect.
  return join(homedir(), '.babel-o')
}

/**
 * Resolve the SQLite database path. Honours `BABEL_O_CONFIG_FILE` /
 * `BABEL_O_CONFIG_DIR` (read at call time) so tests can redirect to
 * a temp directory.
 */
export function resolveSqlitePath(): string {
  return join(resolveConfigDir(), 'db.sqlite')
}

/**
 * Resolve the client log paths. Tries both the legacy `go-tui-session.log`
 * (the Phase 1 client-side session-id map) and `embedded-nexus.log` (the
 * Phase 3 server-side start log). Either may be missing.
 */
export function resolveLogPaths(): {
  clientLogPath: string
  embeddedNexusLogPath: string
} {
  const base = resolveConfigDir()
  return {
    clientLogPath: join(base, 'log', 'go-tui-session.log'),
    embeddedNexusLogPath: join(base, 'log', 'embedded-nexus.log'),
  }
}

/**
 * Try to find a session row in the local SQLite storage. Looks up by
 * exact session_id match. Returns `null` if the file is missing, locked,
 * or no row matches.
 *
 * Pure function: callers can substitute an in-memory database by setting
 * the `BABEL_O_CONFIG_DIR` env var to a temp directory containing a
 * pre-seeded `db.sqlite`.
 */
export function findSessionInSqlite(
  sessionId: string,
  options: { sqlitePath?: string } = {},
): SessionRow | null {
  const dbPath = options.sqlitePath ?? resolveSqlitePath()
  if (!existsSync(dbPath)) return null

  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    // Locked by a running Nexus, corrupt, or non-SQLite file.
    return null
  }

  try {
    // Probe: the `sessions` table is created by `SqliteStorage` (see
    // `src/storage/SqliteStorage.ts`). If the schema is missing, we
    // treat it as "no row" rather than throwing.
    //
    // Phase 1 tier (a) upgrade: also select `metadata` so the Go TUI
    // back-reference (body.metadata.clientSessionId) can be surfaced.
    // Pre-Phase-1 databases may lack the `metadata` column entirely;
    // we fall back to the same query without it rather than crashing.
    const queryWithMeta =
      `SELECT session_id, phase, cwd, created_at, updated_at,
              substr(coalesce(prompt, ''), 1, 200) AS prompt,
              result, error, metadata
         FROM sessions
        WHERE session_id = ?
        LIMIT 1`
    const queryWithoutMeta =
      `SELECT session_id, phase, cwd, created_at, updated_at,
              substr(coalesce(prompt, ''), 1, 200) AS prompt,
              result, error
         FROM sessions
        WHERE session_id = ?
        LIMIT 1`

    let row: Record<string, string | null> | undefined
    try {
      row = db.prepare(queryWithMeta).get(sessionId) as Record<string, string | null> | undefined
    } catch {
      // metadata column missing (pre-Phase-1 schema) — retry without it.
      row = db.prepare(queryWithoutMeta).get(sessionId) as Record<string, string | null> | undefined
    }
    if (!row) return null

    // Phase 1 tier (a) upgrade: read body.metadata.clientSessionId
    // so `bbl inspect-session <server uuid>` can also surface the
    // Go TUI Phase 1 back-reference (typically session_go_<unixnano>).
    // Defensive parse: SqliteStorage stores metadata as JSON;
    // a malformed blob (e.g. written by an older Nexus) must NOT
    // break the rest of the row's rendering. The fallback query
    // (without metadata column) leaves this null — correct for
    // pre-Phase-1 databases.
    let clientSessionId: string | null = null
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata) as { clientSessionId?: unknown }
        if (typeof parsed.clientSessionId === 'string' && parsed.clientSessionId) {
          clientSessionId = parsed.clientSessionId
        }
      } catch {
        // Malformed metadata: leave clientSessionId null; the rest
        // of the row still renders normally.
      }
    }

    // Count events (separate query so we can return the row even when
    // the events table is empty).
    let eventCount = 0
    let compactBoundaries: CompactBoundaryInspection[] = []
    try {
      const countRow = db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ?`)
        .get(sessionId) as { n: number } | undefined
      eventCount = countRow?.n ?? 0
      compactBoundaries = listCompactBoundaryInspections(db, sessionId)
    } catch {
      // events table missing → 0
    }

    return {
      sessionId: row.session_id ?? '',
      phase: row.phase,
      cwd: row.cwd,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      prompt: row.prompt,
      result: row.result,
      error: row.error,
      eventCount,
      compactBoundaries,
      clientSessionId,
    }
  } catch {
    return null
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function listCompactBoundaryInspections(
  db: DatabaseSync,
  sessionId: string,
): CompactBoundaryInspection[] {
  const rows = db
    .prepare(
      `SELECT timestamp, event_json FROM events
       WHERE session_id = ?
         AND event_type IN ('compact_boundary', 'context_compact_boundary')
       ORDER BY timestamp ASC, event_key ASC
       LIMIT 20`,
    )
    .all(sessionId) as { timestamp: string | null; event_json: string | null }[]
  const boundaries: CompactBoundaryInspection[] = []
  for (const row of rows) {
    if (!row.event_json) continue
    let event: Record<string, unknown>
    try {
      const parsed = JSON.parse(row.event_json)
      if (!parsed || typeof parsed !== 'object') continue
      event = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (event.type !== 'compact_boundary' && event.type !== 'context_compact_boundary') continue
    const retainedSegment = event.retainedSegment && typeof event.retainedSegment === 'object'
      ? event.retainedSegment as Record<string, unknown>
      : undefined
    const retainedEvents = Array.isArray(event.retainedEvents) ? event.retainedEvents : undefined
    const retainedCount = numericField(event, 'retainedEventCount')
      ?? numericField(event, 'retainedItemCount')
      ?? numericField(retainedSegment, 'retainedCount')
      ?? (retainedEvents ? retainedEvents.length : null)
    boundaries.push({
      type: event.type,
      timestamp: stringOrNull(event.timestamp) ?? row.timestamp,
      trigger: stringOrNull(event.trigger),
      boundaryId: stringOrNull(event.boundaryId) ?? stringOrNull(retainedSegment?.boundaryId),
      beforeEventCount: numericField(event, 'beforeEventCount'),
      afterEventCount: numericField(event, 'afterEventCount'),
      preTokens: numericField(event, 'preTokens'),
      postTokens: numericField(event, 'postTokens'),
      estimatedTokensSaved: numericField(event, 'estimatedTokensSaved'),
      summaryChars: numericField(event, 'summaryChars'),
      snippedToolResults: numericField(event, 'snippedToolResults'),
      messagesSummarized: numericField(event, 'messagesSummarized'),
      droppedItemCount: numericField(event, 'droppedItemCount'),
      retainedItemCount: numericField(event, 'retainedItemCount') ?? retainedCount,
      retainedEventCount: numericField(event, 'retainedEventCount') ?? retainedCount,
      preservedTailEventId: stringOrNull(event.preservedTailEventId) ?? stringOrNull(retainedSegment?.lastEventId),
      retainedSegmentHash: stringOrNull(event.retainedSegmentHash) ?? stringOrNull(retainedSegment?.hash),
      userVisibleSummary: truncatePlain(stringOrNull(event.userVisibleSummary) ?? stringOrNull(event.summary), 200),
    })
  }
  return boundaries
}

function numericField(record: Record<string, unknown> | undefined, key: string): number | null {
  if (!record) return null
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function truncatePlain(value: string | null, maxChars: number): string | null {
  if (!value) return null
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Grep a single log file for the given session id, returning the matched
 * lines with line numbers. Caps at `maxLines` to avoid blowing up on huge
 * logs. Pure: does not modify the filesystem.
 */
export function grepLogForSessionId(
  logPath: string,
  sessionId: string,
  options: { maxLines?: number; maxLineLength?: number } = {},
): ClientLogHit[] {
  const maxLines = options.maxLines ?? 50
  const maxLineLength = options.maxLineLength ?? 400
  if (!existsSync(logPath)) return []
  let content: string
  try {
    content = readFileSync(logPath, 'utf-8')
  } catch {
    return []
  }
  const hits: ClientLogHit[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length && hits.length < maxLines; i++) {
    if (lines[i].includes(sessionId)) {
      hits.push({
        logPath,
        matchedLine:
          lines[i].length > maxLineLength
            ? `${lines[i].slice(0, maxLineLength)}…`
            : lines[i],
        lineNumber: i + 1,
      })
    }
  }
  return hits
}

/**
 * Grep the embedded-nexus start log for the most recent N starts. Used
 * when the session can't be found anywhere — gives the operator
 * context about which Nexus instance might have been responsible.
 *
 * Line format (planned for Phase 3): `... bbl-go[pid=NNNN] starting
 * embedded Nexus storage=<path> cwd=<cwd>`. We accept the start
 * marker even if other fields are missing.
 */
export function grepRecentEmbeddedNexusStarts(
  logPath: string,
  options: { maxLines?: number } = {},
): EmbeddedNexusStart[] {
  const maxLines = options.maxLines ?? 20
  if (!existsSync(logPath)) return []
  let content: string
  try {
    content = readFileSync(logPath, 'utf-8')
  } catch {
    return []
  }
  const starts: EmbeddedNexusStart[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/bbl-go\[pid=|nexus\[pid=|starting embedded Nexus/i.test(lines[i])) continue
    starts.push({
      logPath,
      matchedLine: lines[i],
      lineNumber: i + 1,
      pid: extractPid(lines[i]),
      storage: extractField(lines[i], 'storage'),
      cwd: extractField(lines[i], 'cwd'),
      startedAt: extractTimestamp(lines[i]),
    })
    if (starts.length >= maxLines) break
  }
  return starts
}

function extractPid(line: string): number | null {
  const m = line.match(/\[pid=(\d+)\]/)
  return m ? Number(m[1]) : null
}

function extractField(line: string, key: string): string | null {
  const m = line.match(new RegExp(`${key}=([^\\s]+)`))
  return m ? m[1] : null
}

function extractTimestamp(line: string): string | null {
  // ISO 8601 prefix: `[YYYY-MM-DDTHH:MM:SS+ZZ:ZZ]`
  const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)?)\]/)
  return m ? m[1] : null
}

/**
 * Top-level inspect-session entry point. Pure (no I/O outside
 * `~/.babel-o` + SQLite read) so the test suite can call it with
 * `BABEL_O_CONFIG_DIR` pointed at a temp dir.
 */
export function inspectSession(sessionId: string): InspectSessionTier {
  const sqlitePath = resolveSqlitePath()
  const { clientLogPath, embeddedNexusLogPath } = resolveLogPaths()

  const row = findSessionInSqlite(sessionId, { sqlitePath })
  if (row) {
    return { tier: 'found-in-sqlite', row }
  }

  // Tier 1: client-session log reverse-lookup (Phase 3). If the
  // operator passed a `session_go_<unixnano>` id, scan the
  // client log to find the server-allocated `session_<uuid>`
  // it maps to, then re-run the inspection against that uuid.
  // This makes `bbl inspect-session session_go_1781146359507755000`
  // "just work" when the embedded Nexus successfully persisted
  // the session under its server-allocated uuid.
  if (sessionId.startsWith('session_go_')) {
    const serverId = reverseResolveClientSessionId(clientLogPath, sessionId)
    if (serverId) {
      return inspectSession(serverId)
    }
  }

  // Tier 2: client log mentions this sessionId but SQLite doesn't.
  // That matches the Phase 2 root cause: embedded Nexus died before
  // persisting.
  const clientLogPathExists = existsSync(clientLogPath)
  const clientHits = clientLogPathExists
    ? grepLogForSessionId(clientLogPath, sessionId)
    : []
  if (clientHits.length > 0) {
    return { tier: 'found-in-client-log-only', clientHits }
  }

  // Tier 3: not found anywhere. Try the embedded-nexus start log for
  // a recent-Nexus hint.
  const recentEmbeddedStarts = grepRecentEmbeddedNexusStarts(embeddedNexusLogPath)
  return { tier: 'not-found', clientHits: [], recentEmbeddedStarts }
}

/**
 * Phase 3 reverse-resolve: given a `session_go_<unixnano>` client
 * id, look it up in `~/.babel-o/log/go-tui-session.log` (the
 * Phase 1 client-side mapping log written by
 * `appendClientSessionLog`) and return the server-allocated
 * `session_<uuid>` it maps to, or `null` if not found.
 *
 * Pure function: read-only, no I/O outside the given log path.
 */
function formatCompactBoundaryInspection(boundary: CompactBoundaryInspection): string {
  const counts = `${boundary.beforeEventCount ?? '?'} -> ${boundary.afterEventCount ?? '?'} events`
  const tokens = boundary.preTokens !== null || boundary.postTokens !== null
    ? ` tokens=${boundary.preTokens ?? '?'}/${boundary.postTokens ?? '?'}`
    : ''
  const saved = boundary.estimatedTokensSaved !== null ? ` saved=${boundary.estimatedTokensSaved}` : ''
  const retained = boundary.retainedEventCount !== null ? ` retained=${boundary.retainedEventCount}` : ''
  const tail = boundary.preservedTailEventId ? ` tail=${boundary.preservedTailEventId}` : ''
  const summary = boundary.userVisibleSummary ? ` summary="${boundary.userVisibleSummary}"` : ''
  return `${boundary.type} trigger=${boundary.trigger ?? 'unknown'} ${counts}${tokens}${saved}${retained}${tail}${summary}`
}

/**
 * Render a `DerivedResumableState` as a human-readable resume diagnostic.
 * The block is the operator-facing answer to "where did this run stop and what
 * next" — paired with `--json` for the machine-readable form. Coloring follows
 * the rest of the inspect-session output: green for resumable, yellow for
 * recoverable/conditional, red for cannot-resume.
 */
export function formatResumeState(
  sessionId: string,
  state: import('../../runtime/runCheckpoint.js').DerivedResumableState,
): string {
  const lines: string[] = []
  const s = state.state
  const stateColor =
    s.state === 'resume_possible' || s.state === 'retry_from_provider_turn' || s.state === 'terminal_failed_recoverable'
      ? chalk.green
      : s.state === 'waiting_permission'
        ? chalk.yellow
        : chalk.red
  lines.push(stateColor(`▶ ${s.state}`))
  lines.push(`  session_id : ${sessionId}`)
  lines.push(`  boundary   : ${s.boundary ?? '<none>'}`)
  lines.push(`  reason     : ${s.reason}`)
  if (s.state === 'waiting_permission' && (s as { toolUseId?: string }).toolUseId) {
    lines.push(`  tool_use_id: ${(s as { toolUseId?: string }).toolUseId}`)
  }
  lines.push(`  continuation_snapshot: ${state.hasContinuationSnapshot}`)
  if (state.pendingPermissionToolUseId) {
    lines.push(`  pending_permission   : ${state.pendingPermissionToolUseId}`)
  }
  if (state.warnings.length > 0) {
    lines.push(`  warnings:`)
    for (const w of state.warnings) lines.push(`    - ${w}`)
  }
  // Honest "next action" hint — kept aligned with the v1 governance rule that
  // pending permission is only durable if a continuation snapshot exists.
  const next =
    s.state === 'resume_possible'
      ? 'next: resume from this boundary in the live process'
      : s.state === 'retry_from_provider_turn'
        ? 'next: retry from the provider turn; the in-flight tool call was not completed'
        : s.state === 'waiting_permission'
          ? state.hasContinuationSnapshot
            ? 'next: approve or deny the pending permission to resume'
            : 'next: re-issue the approval; the live pending entry was not recovered (process-local only)'
          : s.state === 'terminal_failed_recoverable'
            ? 'next: re-run the prompt; the run ended with a failed terminal event'
            : 'next: cannot resume — re-run the prompt to start a fresh continuation'
  lines.push(`  ${stateColor(next)}`)
  // Always add the process-local caveat when the caller didn't supply a
  // continuation snapshot (the CLI's default). Operators reading this output
  // should know the durability gap.
  if (!state.hasContinuationSnapshot) {
    lines.push(chalk.gray(
      `  note: derived without a continuation snapshot; v1 does not persist one, so ` +
        `only waiting_permission + a re-issued approval are actually recoverable across restart.`,
    ))
  }
  return lines.join('\n')
}

export function reverseResolveClientSessionId(
  clientLogPath: string,
  clientSessionId: string,
): string | null {
  if (!existsSync(clientLogPath)) return null
  let content: string
  try {
    content = readFileSync(clientLogPath, 'utf-8')
  } catch {
    return null
  }
  // Each line: `[RFC3339]\tclientSessionId=<id>\tserverSessionId=<id>`.
  // We scan the file in reverse chronological order (newest first)
  // because the most recent mapping is the most likely to be
  // relevant. The log is small (a few lines per Go TUI session),
  // so a linear scan is fine.
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes(`clientSessionId=${clientSessionId}`)) continue
    const m = line.match(/serverSessionId=(\S+)/)
    if (m) return m[1]
  }
  return null
}

/**
 * Agent Trace Schema export (agent-runtime-architecture-maturity-plan.md §3.1).
 *
 * Reads the full ordered event stream for a session from local SQLite (raw SQL,
 * read-only — same access pattern as `findSessionInSqlite`), then projects it
 * into an `AgentTrace` via the pure `projectAgentTrace` projector.
 *
 * Hard invariants (same as the rest of inspect-session):
 *  - Read-only; opens the DB with `readOnly: true`.
 *  - No provider / HTTP / config writes; purely local SQLite + projection.
 *  - Returns `null` when the DB or `events` table is absent or the session has
 *    no events — callers emit an honest "no trace" message rather than a partial
 *    one.
 *
 * `session_go_<unixnano>` ids are reverse-resolved to the server uuid via the
 * client log, mirroring `inspectSession`, so `bbl inspect-session <go id>
 * --trace` works the same as the non-trace path.
 */
export function exportSessionTrace(
  sessionId: string,
  options: { sqlitePath?: string } = {},
): AgentTrace | null {
  const trace = exportSessionTraceDirect(sessionId, options)
  if (trace) return trace
  if (sessionId.startsWith('session_go_')) {
    const { clientLogPath } = resolveLogPaths()
    const serverId = reverseResolveClientSessionId(clientLogPath, sessionId)
    if (serverId) return exportSessionTraceDirect(serverId, options)
  }
  return null
}

export function exportSessionTraceDirect(
  sessionId: string,
  options: { sqlitePath?: string },
): AgentTrace | null {
  const events = readOrderedEvents(sessionId, options)
  if (events === null) return null
  if (events.length === 0) return null
  return projectAgentTrace(events)
}

/**
 * Durable Run Checkpoint / Resume export (agent-runtime-architecture-maturity-plan.md §3.3).
 *
 * Derives the resumable execution state of a run from persisted data: the
 * session row (phase + terminal reason) plus the ordered event stream. Returns
 * a `DerivedResumableState` that lets `bbl inspect-session <id> --resume` report
 * where the run stopped, whether it can resume, and what should happen next.
 *
 * Same invariants as the rest of inspect-session: read-only, no provider/HTTP,
 * `session_go_<unixnano>` reverse-resolved via the client log. Returns `null`
 * when the session is absent (no row + no events).
 *
 * Governance (plan §3.3 acceptance #2): the derived state honestly reports
 * `hasContinuationSnapshot: false` — v1 persists no in-process continuation
 * snapshot, so a pending permission is NOT described as durable unless a live
 * caller upgrades the flag. The CLI always passes the default (false), matching
 * a post-restart inspection.
 */
export function exportSessionResumeState(
  sessionId: string,
  options: { sqlitePath?: string; pendingPermissionToolUseId?: string | null } = {},
): DerivedResumableState | null {
  const direct = exportSessionResumeStateDirect(sessionId, options)
  if (direct) return direct
  if (sessionId.startsWith('session_go_')) {
    const { clientLogPath } = resolveLogPaths()
    const serverId = reverseResolveClientSessionId(clientLogPath, sessionId)
    if (serverId) return exportSessionResumeStateDirect(serverId, options)
  }
  return null
}

function exportSessionResumeStateDirect(
  sessionId: string,
  options: { sqlitePath?: string; pendingPermissionToolUseId?: string | null },
): DerivedResumableState | null {
  const events = readOrderedEvents(sessionId, options)
  if (events === null) return null
  // The session row gives us phase + terminal reason. When the row is absent
  // but events exist (e.g. events without a sessions row), fall back to a
  // permissive phase so the event-stream derivation still runs.
  const sessionRow = readSessionPhaseRow(sessionId, options)
  const phase = (sessionRow?.phase ?? 'executing') as 'created' | 'planning' | 'executing' | 'reviewing' | 'waiting_user' | 'waiting_permission' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  return deriveResumableState({
    session: {
      phase,
      terminalReason: sessionRow?.terminalReason,
      error: sessionRow?.error ?? undefined,
    },
    events,
    pendingPermissionToolUseId: options.pendingPermissionToolUseId ?? null,
    hasContinuationSnapshot: false,
  })
}

type ResumableSessionRow = {
  phase: string | null
  error: string | null
  terminalReason?: TaskSessionTerminalReason
}

function readSessionPhaseRow(
  sessionId: string,
  options: { sqlitePath?: string },
): ResumableSessionRow | null {
  const dbPath = options.sqlitePath ?? resolveSqlitePath()
  if (!existsSync(dbPath)) return null
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
  try {
    const row = db
      .prepare(`SELECT phase, error, terminal_reason FROM sessions WHERE session_id = ? LIMIT 1`)
      .get(sessionId) as { phase: string | null; error: string | null; terminal_reason: string | null } | undefined
    if (!row) return null
    let terminalReason: ResumableSessionRow['terminalReason']
    if (row.terminal_reason) {
      try {
        const parsed = JSON.parse(row.terminal_reason) as { category?: string; code?: string; message?: string }
        if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') {
          const category = (TERMINAL_REASON_CATEGORIES as readonly string[]).includes(parsed.category ?? '')
            ? (parsed.category as TaskSessionTerminalReason['category'])
            : 'unknown'
          terminalReason = {
            category,
            code: parsed.code,
            message: typeof parsed.message === 'string' ? parsed.message : '',
          }
        }
      } catch {
        // malformed terminal_reason blob — leave undefined; derivation still runs on phase + events
      }
    }
    return { phase: row.phase, error: row.error, ...(terminalReason ? { terminalReason } : {}) }
  } catch {
    // sessions table missing or unreadable
    return null
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/**
 * Read the full ordered event stream for a session from local SQLite.
 * Shared by `exportSessionTrace` and `exportSessionResumeState`. Returns `null`
 * when the DB / events table is absent (honest "no data"); returns `[]` when
 * the session row region exists but has zero events.
 */
function readOrderedEvents(
  sessionId: string,
  options: { sqlitePath?: string },
): NexusEvent[] | null {
  const dbPath = options.sqlitePath ?? resolveSqlitePath()
  if (!existsSync(dbPath)) return null
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
  try {
    const rows = db
      .prepare(
        `SELECT event_json FROM events
          WHERE session_id = ?
          ORDER BY event_seq ASC, event_key ASC`,
      )
      .all(sessionId) as { event_json: string | null }[]
    const events: NexusEvent[] = []
    for (const row of rows) {
      if (!row.event_json) continue
      try {
        const parsed = JSON.parse(row.event_json)
        if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
          events.push(parsed as NexusEvent)
        }
      } catch {
        // Skip malformed event row; projectors are defensive anyway.
      }
    }
    return events
  } catch {
    // events table missing or unreadable.
    return null
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

export function registerInspectSessionCommand(program: Command): void {
  program
    .command('inspect-session')
    .description(
      'Diagnose where a Go TUI / Nexus session was persisted (or why it was not). ' +
        'Tries both `session_go_<unixnano>` and `session_<uuid>` formats in the local SQLite; ' +
        'falls back to client-side log hints.',
    )
    .argument('<sessionId>', 'Session id (e.g. `session_go_1781146359507755000`)')
    .option('--json', 'Print raw JSON output')
    .option('--trace', 'Export the session as a machine-readable agent trace (Agent Trace Schema §3.1)')
    .option('--resume', 'Report the resumable execution state of the run (Agent Runtime Maturity §3.3)')
    .option('--sqlite-path <path>', 'Override local SQLite path (for tests)')
    .action(async (
      sessionId: string,
      options: { json?: boolean; trace?: boolean; resume?: boolean; sqlitePath?: string },
    ) => {
      // --trace short-circuits the persistence-tier diagnostic and emits a
      // machine-readable agent trajectory instead. `--json` selects a single
      // pretty JSON blob; the default is JSONL (one record per line) which is
      // append/export friendly.
      if (options.trace) {
        const trace = exportSessionTrace(sessionId, { sqlitePath: options.sqlitePath })
        if (!trace) {
          console.error(chalk.red(
            `✗ No events found for session ${sessionId} in local SQLite` +
              (options.sqlitePath ? ` (${options.sqlitePath})` : ` (${resolveSqlitePath()})`) +
              `. Cannot build a trace without a persisted event stream.`,
          ))
          process.exitCode = 1
          return
        }
        console.log(options.json ? traceToJson(trace) : traceToJsonl(trace))
        return
      }
      // --resume reports the §3.3 Durable Run Checkpoint / Resume state:
      // where the run stopped, whether it can resume, and what should
      // happen next. `--json` emits the raw DerivedResumableState; the
      // default renders a human-readable block. The CLI always passes
      // `hasContinuationSnapshot: false` (post-restart inspection) and
      // no live pending-permission id — the derivation is honest about
      // v1 not persisting a continuation snapshot.
      if (options.resume) {
        const resumeState = exportSessionResumeState(sessionId, { sqlitePath: options.sqlitePath })
        if (!resumeState) {
          console.error(chalk.red(
            `✗ No events found for session ${sessionId} in local SQLite` +
              (options.sqlitePath ? ` (${options.sqlitePath})` : ` (${resolveSqlitePath()})`) +
              `. Cannot derive a resume state without a persisted event stream.`,
          ))
          process.exitCode = 1
          return
        }
        if (options.json) {
          console.log(JSON.stringify(resumeState, null, 2))
          return
        }
        console.log(formatResumeState(sessionId, resumeState))
        return
      }
      const result = options.sqlitePath
        ? (() => {
            const row = findSessionInSqlite(sessionId, { sqlitePath: options.sqlitePath })
            if (row) return { tier: 'found-in-sqlite' as const, row }
            const { clientLogPath, embeddedNexusLogPath } = resolveLogPaths()
            const clientHits = grepLogForSessionId(clientLogPath, sessionId)
            if (clientHits.length > 0) {
              return { tier: 'found-in-client-log-only' as const, clientHits }
            }
            return {
              tier: 'not-found' as const,
              clientHits: [],
              recentEmbeddedStarts: grepRecentEmbeddedNexusStarts(embeddedNexusLogPath),
            }
          })()
        : inspectSession(sessionId)

      if (options.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      if (result.tier === 'found-in-sqlite') {
        const row = result.row
        console.log(chalk.green(`✓ Found session in local SQLite`))
        console.log(`  session_id : ${row.sessionId}`)
        // Phase 1 tier (a) upgrade: show the Go TUI
        // back-reference when present, so the operator
        // can pivot from a server uuid back to a
        // session_go_<unixnano> (or any other client
        // marker) without grepping the client log.
        if (row.clientSessionId) {
          console.log(`  client_id  : ${row.clientSessionId}`)
        }
        console.log(`  phase      : ${row.phase ?? '<unknown>'}`)
        console.log(`  cwd        : ${row.cwd ?? '<unknown>'}`)
        console.log(`  created_at : ${row.createdAt ?? '<unknown>'}`)
        console.log(`  updated_at : ${row.updatedAt ?? '<unknown>'}`)
        console.log(`  events     : ${row.eventCount}`)
        if (row.compactBoundaries.length > 0) {
          console.log(`  compact boundaries:`)
          for (const boundary of row.compactBoundaries.slice(-5)) {
            console.log(`    - ${formatCompactBoundaryInspection(boundary)}`)
          }
        }
        if (row.prompt) {
          console.log(`  prompt     : ${row.prompt.slice(0, 100)}${row.prompt.length > 100 ? '…' : ''}`)
        }
        if (row.result) console.log(`  result     : ${row.result.slice(0, 200)}`)
        if (row.error) console.log(`  error      : ${row.error.slice(0, 200)}`)
        return
      }

      if (result.tier === 'found-in-client-log-only') {
        console.log(chalk.yellow(
          `⚠ Found ${result.clientHits.length} log line(s) mentioning this sessionId, but SQLite has no row.`,
        ))
        console.log(chalk.dim(
          '  Most likely: embedded Nexus used MemoryStorage and exited before persisting. ' +
            'See `docs/nexus/reference/go-tui-session-observability-governance-plan.md` Phase 2.',
        ))
        for (const hit of result.clientHits.slice(0, 5)) {
          console.log(`  ${chalk.cyan(hit.logPath)}:${hit.lineNumber}: ${hit.matchedLine}`)
        }
        return
      }

      // tier === 'not-found'
      console.log(chalk.red(
        `✗ Session not found in local SQLite (${resolveSqlitePath()}) ` +
          `or in client log (${resolveLogPaths().clientLogPath}).`,
      ))
      console.log(chalk.dim(
        '  Suggested next steps:',
      ))
      console.log(chalk.dim(
        '  1. Confirm the sessionId is correct (typos are common; Go TUI uses `session_go_<unixnano>`,',
      ))
      console.log(chalk.dim(
        '     Nexus server uses `session_<uuid>`; this tool tries both but accepts only exact matches).',
      ))
      console.log(chalk.dim(
        '  2. Check whether the session ran against a remote Nexus service (storage is local-only here).',
      ))
      console.log(chalk.dim(
        '  3. If the session ran inside `bbl go` embedded mode and exited recently, the embedded',
      ))
      console.log(chalk.dim(
        '     Nexus may have used MemoryStorage (lost on exit) — see the governance plan Phase 2.',
      ))

      if (result.recentEmbeddedStarts.length > 0) {
        console.log(chalk.dim(`\n  Recent embedded-nexus starts (${result.recentEmbeddedStarts.length}):`))
        for (const start of result.recentEmbeddedStarts.slice(0, 5)) {
          const when = start.startedAt ? chalk.gray(start.startedAt) : chalk.gray('<no-ts>')
          const pid = start.pid !== null ? `pid=${start.pid}` : '<no-pid>'
          const storage = start.storage ? `storage=${start.storage}` : '<default>'
          console.log(`  ${when} ${chalk.cyan(start.logPath)}:${start.lineNumber} ${pid} ${storage}`)
        }
      } else {
        console.log(chalk.dim(
          `\n  No embedded-nexus start log at ${resolveLogPaths().embeddedNexusLogPath} yet. ` +
            'This CLI will populate it as soon as Phase 3 of the governance plan lands.',
        ))
      }
    })
}
