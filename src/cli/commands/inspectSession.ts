import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import { DatabaseSync } from 'node:sqlite'

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
  const os = require('node:os') as typeof import('node:os')
  return join(os.homedir(), '.babel-o')
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
    const row = db
      .prepare(
        `SELECT session_id, phase, cwd, created_at, updated_at,
                substr(coalesce(prompt, ''), 1, 200) AS prompt,
                result, error
           FROM sessions
          WHERE session_id = ?
          LIMIT 1`,
      )
      .get(sessionId) as
      | {
          session_id: string
          phase: string | null
          cwd: string | null
          created_at: string | null
          updated_at: string | null
          prompt: string | null
          result: string | null
          error: string | null
        }
      | undefined
    if (!row) return null

    // Count events (separate query so we can return the row even when
    // the events table is empty).
    let eventCount = 0
    try {
      const countRow = db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ?`)
        .get(sessionId) as { n: number } | undefined
      eventCount = countRow?.n ?? 0
    } catch {
      // events table missing → 0
    }

    return {
      sessionId: row.session_id,
      phase: row.phase,
      cwd: row.cwd,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      prompt: row.prompt,
      result: row.result,
      error: row.error,
      eventCount,
    }
  } catch {
    return null
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
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
    .option('--sqlite-path <path>', 'Override local SQLite path (for tests)')
    .action(async (
      sessionId: string,
      options: { json?: boolean; sqlitePath?: string },
    ) => {
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
        console.log(`  phase      : ${row.phase ?? '<unknown>'}`)
        console.log(`  cwd        : ${row.cwd ?? '<unknown>'}`)
        console.log(`  created_at : ${row.createdAt ?? '<unknown>'}`)
        console.log(`  updated_at : ${row.updatedAt ?? '<unknown>'}`)
        console.log(`  events     : ${row.eventCount}`)
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
