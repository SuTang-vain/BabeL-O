import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  inspectSession,
  reverseResolveClientSessionId,
} from '../src/cli/commands/inspectSession.js'

/**
 * Phase 3 of `docs/nexus/reference/go-tui-session-observability-governance-plan.md`:
 * Server-side startup log + client→server reverse-resolve.
 *
 * What this file covers:
 *   1. `reverseResolveClientSessionId` parses the
 *      `[RFC3339]\tclientSessionId=...\tserverSessionId=...` format
 *      and returns the server uuid (or `null` if not found).
 *   2. `inspectSession` Tier 1 reverse-resolves `session_go_xxx`
 *      client ids to their server-allocated uuid and re-runs
 *      the inspection against the sqlite row, so the operator
 *      can `bbl inspect-session session_go_<unixnano>` and get
 *      the same data as if they'd passed the server uuid
 *      directly.
 *
 * Hard invariants:
 *  - All tests use `mkdtempSync` + `BABEL_O_CONFIG_DIR` injection
 *    + `try/finally` env restore, never touching the real
 *    `~/.babel-o/`.
 *  - Reverse-resolve must NOT crash on malformed log lines.
 */

function withTempConfigDir<T>(fn: (configDir: string) => T): T
function withTempConfigDir<T>(fn: (configDir: string) => Promise<T>): Promise<T>
function withTempConfigDir<T>(fn: (configDir: string) => T | Promise<T>): T | Promise<T> {
  const prev = process.env.BABEL_O_CONFIG_DIR
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-o-phase3-'))
  process.env.BABEL_O_CONFIG_DIR = tempDir
  const cleanup = () => {
    if (prev === undefined) delete process.env.BABEL_O_CONFIG_DIR
    else process.env.BABEL_O_CONFIG_DIR = prev
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  try {
    const result = fn(tempDir)
    if (result && typeof (result as Promise<T>).then === 'function') {
      return (result as Promise<T>).finally(cleanup)
    }
    cleanup()
    return result
  } catch (err) {
    cleanup()
    throw err
  }
}

/** Write a file to <configDir>/<relPath>, creating parent dirs. */
function writeAt(configDir: string, relPath: string, content: string): void {
  const absPath = join(configDir, relPath)
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, content)
}

test('reverseResolveClientSessionId returns server uuid for a matching client id', () => {
  withTempConfigDir((configDir) => {
    const logPath = join(configDir, 'log', 'go-tui-session.log')
    writeAt(
      configDir,
      'log/go-tui-session.log',
      [
        '[2026-06-11T10:52:39+08:00]\tclientSessionId=session_go_old\tserverSessionId=session_old_uuid',
        '[2026-06-11T10:55:00+08:00]\tclientSessionId=session_go_1781146359507755000\tserverSessionId=session_a1b2c3d4-5981-4024-bb0b-2b5229fbc150',
      ].join('\n'),
    )
    const got = reverseResolveClientSessionId(logPath, 'session_go_1781146359507755000')
    assert.equal(got, 'session_a1b2c3d4-5981-4024-bb0b-2b5229fbc150')
  })
})

test('reverseResolveClientSessionId returns the most recent match (reverse chronological)', () => {
  withTempConfigDir((configDir) => {
    const logPath = join(configDir, 'log', 'go-tui-session.log')
    writeAt(
      configDir,
      'log/go-tui-session.log',
      [
        '[2026-06-11T10:00:00+08:00]\tclientSessionId=session_go_x\tserverSessionId=session_first_uuid',
        '[2026-06-11T11:00:00+08:00]\tclientSessionId=session_go_x\tserverSessionId=session_second_uuid',
        '[2026-06-11T12:00:00+08:00]\tclientSessionId=session_go_x\tserverSessionId=session_third_uuid',
      ].join('\n'),
    )
    // Newest line should win, matching operator intuition that
    // the most recent server allocation is the one that
    // actually persisted.
    const got = reverseResolveClientSessionId(logPath, 'session_go_x')
    assert.equal(got, 'session_third_uuid')
  })
})

test('reverseResolveClientSessionId returns null for missing log file', () => {
  withTempConfigDir(() => {
    const got = reverseResolveClientSessionId('/nonexistent/log.log', 'session_go_anything')
    assert.equal(got, null)
  })
})

test('reverseResolveClientSessionId returns null for non-matching client id', () => {
  withTempConfigDir((configDir) => {
    writeAt(configDir, 'log/go-tui-session.log', '[2026-06-11T10:00:00+08:00]\tclientSessionId=session_go_a\tserverSessionId=session_uuid_a')
    const got = reverseResolveClientSessionId(
      join(configDir, 'log', 'go-tui-session.log'),
      'session_go_zzz',
    )
    assert.equal(got, null)
  })
})

test('reverseResolveClientSessionId does not crash on malformed lines', () => {
  withTempConfigDir((configDir) => {
    const logPath = join(configDir, 'log', 'go-tui-session.log')
    writeAt(
      configDir,
      'log/go-tui-session.log',
      [
        'this is not a valid log line',
        '[broken-rfc3339]\tclientSessionId=session_go_bad\tserverSessionId=session_uuid_bad',
        '',
        '[2026-06-11T10:00:00+08:00] missing-tabs clientSessionId=session_go_x serverSessionId=session_uuid_x',
        '[2026-06-11T11:00:00+08:00]\tclientSessionId=session_go_target\tserverSessionId=session_uuid_target',
      ].join('\n'),
    )
    const got = reverseResolveClientSessionId(logPath, 'session_go_target')
    assert.equal(got, 'session_uuid_target')
  })
})

test('inspectSession Tier 1 reverse-resolves session_go_xxx to server uuid', async () => {
  // End-to-end: operator runs `bbl inspect-session
  // session_go_1781146359507755000` and inspectSession transparently
  // finds the server-allocated uuid in the client log, then
  // returns the sqlite row.
  await withTempConfigDir(async (configDir) => {
    // 1. Write the client log mapping
    writeAt(configDir, 'log/go-tui-session.log', '[2026-06-11T10:55:00+08:00]\tclientSessionId=session_go_1781146359507755000\tserverSessionId=session_a1b2c3d4-5981-4024-bb0b-2b5229fbc150')
    // 2. Seed sqlite with the server uuid's row
    const DatabaseSync = (await import('node:sqlite')).DatabaseSync
    const dbPath = join(configDir, 'db.sqlite')
    mkdirSync(join(dbPath, '..'), { recursive: true })
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        prompt TEXT NOT NULL,
        phase TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        result TEXT,
        error TEXT
      )`)
      db.prepare(`INSERT INTO sessions (session_id, cwd, prompt, phase, created_at, updated_at, result, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('session_a1b2c3d4-5981-4024-bb0b-2b5229fbc150', '/tmp', 'git status', 'completed', '2026-06-11T10:55:00.000Z', '2026-06-11T10:55:30.000Z', 'clean', null)
    } finally {
      db.close()
    }
    // Sanity check: re-open the db and verify the row exists.
    {
      const db2 = new DatabaseSync(dbPath, { readOnly: true })
      const probe = db2.prepare(`SELECT session_id FROM sessions WHERE session_id = ?`)
        .get('session_a1b2c3d4-5981-4024-bb0b-2b5229fbc150') as { session_id: string } | undefined
      db2.close()
      if (!probe) throw new Error('sanity check failed: row not findable in fresh DB handle')
    }
    // 3. Inspect the client id — should return the sqlite row.
    const result = inspectSession('session_go_1781146359507755000')
    assert.equal(result.tier, 'found-in-sqlite')
    if (result.tier === 'found-in-sqlite') {
      assert.equal(result.row.sessionId, 'session_a1b2c3d4-5981-4024-bb0b-2b5229fbc150')
      assert.equal(result.row.phase, 'completed')
    }
  })
})

test('inspectSession Tier 1: client log points to a server uuid that is NOT in sqlite', () => {
  // This is the most important Phase 3 fix: even when the embedded
  // Nexus died BEFORE persisting, the client log tells us which
  // server uuid was *attempted*, and the operator can manually
  // investigate (e.g. via /v1/sessions?limit=200 list).
  withTempConfigDir((configDir) => {
    writeAt(configDir, 'log/go-tui-session.log', '[2026-06-11T10:55:00+08:00]\tclientSessionId=session_go_1781146359507755000\tserverSessionId=session_orphan_uuid_no_sqlite_row')
    // No sqlite row exists for the server uuid. The client log
    // still mentions the server uuid as a value of
    // `serverSessionId=...`, so Tier 2 (`found-in-client-log-only`)
    // fires after the Tier 1 reverse-resolve re-runs. The
    // operator sees "the log mentions this id" which is the
    // signal they need: "this is the server uuid we tried, the
    // Nexus crashed before persisting, here's the log line that
    // proves it."
    const result = inspectSession('session_go_1781146359507755000')
    assert.equal(result.tier, 'found-in-client-log-only')
    if (result.tier === 'found-in-client-log-only') {
      assert.ok(result.clientHits.length >= 1)
      assert.ok(
        result.clientHits[0].matchedLine.includes('session_orphan_uuid_no_sqlite_row'),
      )
    }
  })
})

test('inspectSession Tier 1: malformed client log does not crash', () => {
  withTempConfigDir((configDir) => {
    writeAt(configDir, 'log/go-tui-session.log', 'completely\nbroken\nlog\nlines\n')
    const result = inspectSession('session_go_anything')
    // No match in client log → Tier 3 (not-found), no embedded
    // start log → empty recentEmbeddedStarts.
    assert.equal(result.tier, 'not-found')
  })
})
